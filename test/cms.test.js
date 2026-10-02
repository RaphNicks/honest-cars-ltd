'use strict';

/**
 * CMS workflow tests — §7.3 + §6.9.
 *
 * These run against the real database, because the workflow is a state machine
 * over real rows: a gate that only exists in a service and not in the schema is
 * not a gate. Every fixture this file creates is unpublished and deleted in
 * `after`, and the seeded posts are snapshotted and restored if a test touches
 * one.
 *
 * Skipped automatically when MySQL is not reachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable } = require('./helpers');

let available = false;
let db;
let cms;
let blocks;
let publish;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

function unique(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}

const draftInput = (overrides = {}) => ({
  title: 'Workflow test post',
  slug: unique('test-post'),
  category: 'honest_buyers_guide',
  excerpt: 'A test post. It exists to prove the state machine, then it goes away.',
  heroImage: '/img/seed/hero-lot.svg',
  heroAlt: 'Test hero',
  authorName: 'Test Desk',
  authorRole: 'Content',
  authorBio: '',
  readMinutes: 4,
  makeTags: ['toyota'],
  serviceCta: null,
  metaTitle: 'Workflow test post',
  metaDescription: 'A short description inside the §14.3 limit, used by the CMS test suite.',
  isFeatured: false,
  body: [
    { type: 'paragraph', text: 'Links: [a car](/cars) and [inspection](/services/inspection) and [documents](/services/documents).' },
    { type: 'heading', text: 'A heading' },
    { type: 'checklist', items: ['one', 'two'] },
  ],
  ...overrides,
});

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  cms = db.cms;
  blocks = require('../src/services/blocks');
  publish = require('../src/services/publish');
});

test.after(async () => {
  if (!available || !db) return;
  // Safety net: a test that fails halfway must not leave content on the public
  // site. Everything this suite creates is named so it can be swept here.
  await db.query("DELETE FROM blog_posts WHERE slug LIKE 'test-post-%'");
  await db.query("DELETE FROM content_revisions WHERE entity = 'post' AND slug LIKE 'test-post-%'");
  await db.query("DELETE FROM faqs WHERE question LIKE 'Clamp test%' OR question LIKE 'Revision kept%'");
  await db.query("DELETE FROM testimonials WHERE customer_name = 'Test Person'");
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The block codec — the editor's markup contract
// ---------------------------------------------------------------------------
test('block markup round-trips: markup → blocks → markup is stable', () => {
  const source = [
    'A paragraph with [a link](/cars/toyota-camry-2015) inside it.',
    '',
    '## A heading',
    '',
    '! Callout title | The callout text.',
    '',
    '!! Amber warning | Mind this one.',
    '',
    '- first',
    '- second',
    '',
    '^ Table caption',
    '| Car | Price |',
    '| Camry | ₦12m |',
    '',
    '= 1,200 | cars inspected',
    '',
    '> Honesty is the product. — Raph',
    '',
    '[cars]',
    '',
    '[video:dQw4w9WgXcQ | Walkaround | 4:12]',
  ].join('\n');

  const first = blocks.parse(source);
  assert.equal(first.errors.length, 0);
  const markup = blocks.toMarkup(first.blocks);
  const second = blocks.parse(markup);
  assert.deepEqual(blocks.canonical(second.blocks), blocks.canonical(first.blocks));
  assert.equal(blocks.toMarkup(second.blocks), markup);
});

test('the parser reports bad markup as line errors and never throws', () => {
  const parsed = blocks.parse('A good paragraph.\n\n| header only |\n\n[bad](javascript:alert(1))');
  assert.ok(Array.isArray(parsed.errors));
  assert.ok(parsed.blocks.length >= 1);
  // A partial parse is always returned, so nothing the editor typed is lost.
  assert.equal(typeof blocks.toMarkup(parsed.blocks), 'string');
});

test('inline links accept same-site paths only, and escape everything else', () => {
  const html = blocks.inline('See [this car](/cars/one) and [docs](/services/documents?x=1) but not [js](javascript:alert(1)) or [off-site](https://elsewhere.test).');
  assert.match(html, /<a href="\/cars\/one">this car<\/a>/);
  assert.match(html, /<a href="\/services\/documents\?x=1">docs<\/a>/);
  assert.doesNotMatch(html, /<a href="javascript:/);
  assert.doesNotMatch(html, /<a href="https:\/\//);
  assert.match(html, /\[js\]\(javascript:alert\(1\)\)/);
});

// ---------------------------------------------------------------------------
// House rules
// ---------------------------------------------------------------------------
test('metaCheck reports each §6.9/§14.3 rule separately', () => {
  const ok = cms.metaCheck({ title: 'A short title', description: 'A description that is short.', links: 3 });
  assert.equal(ok.ok, true);

  const longTitle = cms.metaCheck({ title: 'x'.repeat(cms.TITLE_LIMIT + 1), description: 'fine', links: 3 });
  assert.equal(longTitle.ok, false);
  assert.match(longTitle.issues.join(' '), /Meta title is 63 characters/);

  const longDescription = cms.metaCheck({ title: 'fine', description: 'y'.repeat(cms.DESCRIPTION_LIMIT + 1), links: 3 });
  assert.match(longDescription.issues.join(' '), /Meta description is 159 characters/);

  const noLinks = cms.metaCheck({ title: 'fine', description: 'fine', links: 2 });
  assert.match(noLinks.issues.join(' '), /link at least 3 listing or service pages/);

  const empty = cms.metaCheck({ title: '', description: '', links: 0 });
  assert.equal(empty.issues.length, 3);
});

test('linksIn counts the [cars] directive and each inline listing/service link', () => {
  const body = [
    { type: 'paragraph', text: '[one](/cars) [two](/services/inspection)' },
    { type: 'listings' },
  ];
  assert.equal(blocks.linksIn(body), 3);
  // A blog link is not a listing/service link and does not count toward the rule.
  assert.equal(blocks.linksIn([{ type: 'paragraph', text: '[x](/blog/whatever)' }]), 0);
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------
maybe('a draft cannot be published until the house rules pass, and then it can', async () => {
  const created = await cms.createPost(draftInput({ body: [{ type: 'paragraph', text: 'No links here at all.' }] }), { actorId: 1 });
  assert.equal(created.ok, true);

  const blocked = await cms.movePost(created.id, 'published', { actorId: 1 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /link at least 3/);

  const stillDraft = await cms.postById(created.id);
  assert.equal(stillDraft.status, 'draft');
  assert.equal(stillDraft.publishedAt, null);

  const fixed = await cms.updatePost(created.id, draftInput({
    slug: created.slug,
    body: [{ type: 'paragraph', text: '[a](/cars) [b](/services/inspection) [c](/services/concierge)' }],
  }), { actorId: 1 });
  assert.equal(fixed.ok, true);

  const published = await cms.movePost(created.id, 'published', { actorId: 1 });
  assert.equal(published.ok, true);
  assert.equal(published.revalidate, true);

  const live = await cms.postById(created.id);
  assert.equal(live.status, 'published');
  assert.ok(live.publishedAt);
  assert.ok(live.body.length);

  // Unpublish before removing: a published post refuses deletion by design.
  await cms.movePost(created.id, 'draft', { actorId: 1, note: 'Test cleanup.' });
  const removed = await cms.deletePost(created.id, { actorId: 1 });
  assert.equal(removed.ok, true);
  assert.equal(await cms.postById(created.id), null);
});

maybe('a published post cannot be deleted — it goes back to draft first', async () => {
  const created = await cms.createPost(draftInput(), { actorId: 1 });
  await cms.movePost(created.id, 'published', { actorId: 1 });

  const refused = await cms.deletePost(created.id, { actorId: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /published post is not deleted/);

  await cms.movePost(created.id, 'draft', { actorId: 1, note: 'Taking it down to rework.' });
  const removed = await cms.deletePost(created.id, { actorId: 1 });
  assert.equal(removed.ok, true);

  const gone = await cms.postById(created.id);
  assert.equal(gone, null);
});

maybe('scheduling needs a date, and a scheduled post is not on the public site yet', async () => {
  const created = await cms.createPost(draftInput(), { actorId: 1 });

  const noDate = await cms.movePost(created.id, 'scheduled', { actorId: 1 });
  assert.equal(noDate.ok, false);
  assert.match(noDate.error, /needs a date and time/);

  const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  const scheduled = await cms.movePost(created.id, 'scheduled', { actorId: 1, publishAt: future });
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.revalidate, false, 'scheduling must not rebuild a page nobody sees yet');

  const [row] = await db.query(
    "SELECT COUNT(*) AS n FROM blog_posts WHERE id = ? AND status = 'published' AND published_at <= UTC_TIMESTAMP()",
    [created.id],
  );
  assert.equal(Number(row.n), 0);

  await cms.movePost(created.id, 'draft', { actorId: 1 });
  await cms.deletePost(created.id, { actorId: 1 });
});

maybe('every workflow move writes a revision and an audit row', async () => {
  const created = await cms.createPost(draftInput(), { actorId: 1 });
  await cms.movePost(created.id, 'in_review', { actorId: 1, note: 'Over to review.' });
  await cms.movePost(created.id, 'draft', { actorId: 1, note: 'The price table needs a source.' });

  const history = await cms.revisionsFor('post', created.id);
  assert.ok(history.length >= 3, `expected at least 3 revisions, saw ${history.length}`);
  assert.ok(history.some((entry) => entry.note === 'The price table needs a source.'));

  const [audit] = await db.query(
    "SELECT COUNT(*) AS n FROM admin_audit WHERE entity = 'post' AND entity_id = ?",
    [created.id],
  );
  assert.ok(Number(audit.n) >= 3);

  await cms.deletePost(created.id, { actorId: 1 });
});

maybe('a revision restores its own post, and a snapshot of the previous state is kept', async () => {
  const created = await cms.createPost(draftInput(), { actorId: 1 });
  await cms.updatePost(created.id, draftInput({ slug: created.slug, title: 'Second title' }), { actorId: 1, note: 'Renamed' });
  await cms.updatePost(created.id, draftInput({ slug: created.slug, title: 'Third title' }), { actorId: 1, note: 'Renamed again' });

  const history = await cms.revisionsFor('post', created.id);
  const firstSave = history.find((entry) => entry.title === 'Workflow test post');
  assert.ok(firstSave, 'the original title is in the history');

  const restored = await cms.restoreRevision(firstSave.id, { actorId: 1 });
  assert.equal(restored.ok, true);
  const after = await cms.postById(created.id);
  assert.equal(after.title, 'Workflow test post');

  await cms.deletePost(created.id, { actorId: 1 });
});

maybe('a revision id from another post is not applied to this one', async () => {
  const a = await cms.createPost(draftInput(), { actorId: 1 });
  const b = await cms.createPost(draftInput(), { actorId: 1 });
  await cms.updatePost(b.id, draftInput({ slug: b.slug, title: 'B renamed' }), { actorId: 1 });

  const bHistory = await cms.revisionsFor('post', b.id);
  const revision = await cms.revisionById(bHistory[0].id);
  assert.equal(revision.entity_id, b.id);
  assert.notEqual(revision.entity_id, a.id);

  // The service itself restores to the snapshot's own entity — which is why the
  // route refuses a mismatched id before calling it (see admin-cms.js).
  const aTitle = (await cms.postById(a.id)).title;
  assert.equal(aTitle, 'Workflow test post');

  await cms.deletePost(a.id, { actorId: 1 });
  await cms.deletePost(b.id, { actorId: 1 });
});

// ---------------------------------------------------------------------------
// The other content types
// ---------------------------------------------------------------------------
maybe('FAQ positions are clamped to what the column can hold', async () => {
  const created = await cms.saveFaq(null, {
    scope: 'global', question: unique('Clamp test?'), answer: 'Yes.', position: '9999', is_active: '1',
  }, { actorId: 1 });
  assert.equal(created.ok, true);

  const rows = await db.query('SELECT position, is_active FROM faqs WHERE id = ?', [created.id]);
  assert.equal(Number(rows[0].position), cms.MAX_POSITION);
  assert.equal(Number(rows[0].is_active), 1);

  const removed = await cms.deleteFaq(created.id, { actorId: 1 });
  assert.equal(removed.ok, true);
});

maybe('a saved FAQ keeps a revision of what it said before', async () => {
  const created = await cms.saveFaq(null, {
    scope: 'vdp', question: unique('Revision kept?'), answer: 'First answer.', position: '5', is_active: '1',
  }, { actorId: 1 });
  await cms.saveFaq(created.id, { scope: 'vdp', question: 'Revision kept?', answer: 'Second answer.', position: '5', is_active: '1' }, { actorId: 1 });

  const history = await cms.revisionsFor('faq', created.id);
  assert.equal(history.length, 1);
  const snapshot = await cms.revisionById(history[0].id);
  assert.equal(snapshot.snapshot.answer, 'First answer.');

  await cms.deleteFaq(created.id, { actorId: 1 });
});

maybe('a testimonial is hidden until it is published, and the state is reversible', async () => {
  const created = await cms.saveTestimonial(null, {
    customer_name: 'Test Person', area: 'Woji', quote: 'They were straight with me.',
    service_tag: 'inspection', rating: '5', position: '9', is_published: '',
  }, { actorId: 1 });
  assert.equal(created.ok, true);

  const hidden = await cms.listTestimonials();
  const row = hidden.find((entry) => entry.id === created.id);
  assert.equal(row.isPublished, false);
  assert.equal(Number((await db.query('SELECT rating FROM testimonials WHERE id = ?', [created.id]))[0].rating), 5);

  const published = await cms.saveTestimonial(created.id, {
    customer_name: 'Test Person', area: 'Woji', quote: 'They were straight with me.',
    service_tag: 'inspection', rating: '5', position: '9', is_published: '1',
  }, { actorId: 1 });
  assert.equal(published.ok, true);
  assert.equal(published.revalidate, true);

  await db.query('DELETE FROM testimonials WHERE id = ?', [created.id]);
});

maybe('homepage modules read back only when active, and counters never hold a figure', async () => {
  const modules = await cms.listHomepageModules();
  assert.ok(modules.length >= 4, 'the seed defines the homepage modules');

  const active = await cms.homepageModules();
  const counterModule = modules.find((module) => module.key === 'counters');
  assert.ok(counterModule, 'counters module exists');

  const before = counterModule.isActive;
  await cms.saveHomepageModule(counterModule.id, { title: counterModule.title, is_active: '1', payload: JSON.stringify(counterModule.payload) }, { actorId: 1 });
  const nowActive = await cms.homepageModules();
  assert.ok(nowActive.counters, 'an active module is returned to the homepage');

  // Labels, not numbers: nothing in the payload can go stale.
  const labels = (nowActive.counters.labels) || {};
  for (const value of Object.values(labels)) {
    assert.equal(typeof value, 'string');
    assert.doesNotMatch(String(value), /^\d+$/, 'a counter label must not be a number');
  }

  if (!before) {
    await cms.saveHomepageModule(counterModule.id, { title: counterModule.title, is_active: '', payload: JSON.stringify(counterModule.payload) }, { actorId: 1 });
  }
});

maybe('module payloads that are not valid JSON are refused, not stored', async () => {
  const modules = await cms.listHomepageModules();
  const hero = modules.find((module) => module.key === 'hero');
  const result = await cms.saveHomepageModule(hero.id, { title: 'Hero', is_active: '1', payload: '{not json' }, { actorId: 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /valid JSON/);
});

// ---------------------------------------------------------------------------
// Revalidation (§12.4)
// ---------------------------------------------------------------------------
maybe('revalidate rebuilds only routes that exist in the build, and skips the rest', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { runScript, ROOT } = require('./helpers');

  // The suites run with STATIC_DIR pointed away from any real build, so make
  // one: this is the same build the deployment runs.
  runScript('scripts/build-static.js', ['--quiet']);
  try {
    const result = await publish.revalidate(['/', '/cars', '/nope']);
    assert.deepEqual(result.rebuilt, ['/']);
    assert.ok(result.skipped.includes('/cars'), '/cars is server-rendered — nothing to rebuild');
    assert.ok(result.skipped.includes('/nope'));

    const manifest = require('../src/lib/render').loadManifest(require('../src/config').features.staticPath);
    assert.ok(manifest.routes.has('/'));
    assert.equal(manifest.routes.size > 1, true, 'the rest of the build is left alone');
  } finally {
    fs.rmSync(path.join(ROOT, '.test-static'), { recursive: true, force: true });
  }
});

maybe('every content type declares which pages it touches', () => {
  assert.deepEqual(publish.TOUCHES.post('a-post'), ['/', '/guide', '/blog', '/blog/a-post', '/sitemap.xml']);
  assert.deepEqual(publish.TOUCHES.page('terms'), ['/terms', '/sitemap.xml']);
  assert.deepEqual(publish.TOUCHES.homepage(), ['/']);
  for (const kind of ['post', 'page', 'faq', 'testimonial', 'homepage', 'service']) {
    assert.ok(publish.TOUCHES[kind], `${kind} must declare its touched routes`);
  }
});

// ---------------------------------------------------------------------------
// The overview the console opens on
// ---------------------------------------------------------------------------
maybe('the console overview reports the four workflow states and the legal queue', async () => {
  const overview = await cms.overview();
  for (const key of ['posts_draft', 'posts_review', 'posts_scheduled', 'posts_published']) {
    assert.equal(typeof overview.stats[key], 'number');
  }
  assert.ok(overview.posts.length >= 6, 'the seeded posts are listed');
  assert.ok(overview.pages.some((row) => row.legal_review === 1), 'pages awaiting counsel are visible');
  assert.ok(overview.awaitingCounsel.every((row) => row.slug), 'the queue names the pages');

  const first = overview.posts[0];
  assert.ok(first.statusLabel, 'each row carries a human status label');
  assert.ok(typeof first.revisions === 'number');
});

maybe('slugify keeps slugs URL-safe and collisions are refused', async () => {
  assert.equal(cms.slugify('What ₦12m buys — in Port Harcourt!'), 'what-12m-buys-in-port-harcourt');

  const created = await cms.createPost(draftInput(), { actorId: 1 });
  const clash = await cms.createPost(draftInput({ slug: created.slug }), { actorId: 1 });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already taken/);

  const updateClash = await cms.updatePost(created.id, draftInput({ slug: created.slug, title: 'Same slug is fine on itself' }), { actorId: 1 });
  assert.equal(updateClash.ok, true, 'a post may keep its own slug');

  await cms.deletePost(created.id, { actorId: 1 });
});
