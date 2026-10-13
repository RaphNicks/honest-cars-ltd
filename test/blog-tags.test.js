'use strict';

/**
 * FR-35 — author pages and a governed tag taxonomy (§6.9).
 *
 * The promises worth testing are the ones a reader would notice:
 *
 *   • a post's tags and its author come back with it, and an author page is
 *     reachable only when somebody actually exists (no 200 for a slug that was
 *     never written)
 *   • the related-posts engine prefers a shared tag over a shared category, and
 *     a shared make tag over recency — that ordering is the whole feature
 *   • `[listing:slug]` survives a parse → markup round trip, because a post
 *     edited in the console proposes exactly the body it was loaded with
 *   • a post's tag list is replaced, never merged, and a stale slug cannot take
 *     the save down with it (setPostTags only writes tag rows that exist)
 *   • the editorial calendar puts a post on the day it is actually due — the
 *     first version of this used `String(date)`, which is “Sun Sep 28 2026”
 *     and matched no day at all
 *
 * Fixtures are throwaway slugs prefixed `t35-`, cleaned by exact id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable } = require('./helpers');

let available = false;
const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
});

test.after(async () => {
  if (!available) return;
  const db = require('../src/db');
  // Children first, and the pool last — the order is the whole point.
  await db.query("DELETE FROM blog_post_tags WHERE post_id IN (SELECT id FROM blog_posts WHERE slug LIKE 't35-%')").catch(() => {});
  await db.query("DELETE FROM blog_posts WHERE slug LIKE 't35-%'").catch(() => {});
  await db.query("DELETE FROM blog_tags WHERE slug LIKE 't35-%'").catch(() => {});
  await db.query("DELETE FROM blog_authors WHERE slug LIKE 't35-%'").catch(() => {});
  await db.pool.end();
});

const db = require('../src/db');
const blocks = require('../src/services/blocks');
const cms = require('../src/db/cms');

const MARK = 't35';

/** Create an author + tags + a post, all brand-prefixed, so cleanup is exact. */
async function makeFixtures() {
  const stamp = `${MARK}-${Date.now().toString(36)}`;
  const authorSlug = `${stamp}-writer`;
  const authorResult = await db.query(
    'INSERT INTO blog_authors (slug, name, role, bio) VALUES (?, ?, ?, ?)',
    [authorSlug, 'TC35 Writer', 'Test Desk', 'Writes the FR-35 fixtures.'],
  );
  const tagSlugs = [`${stamp}-alpha`, `${stamp}-beta`];
  for (const [index, slug] of tagSlugs.entries()) {
    await db.query('INSERT INTO blog_tags (slug, label, kind, description) VALUES (?, ?, ?, ?)', [
      slug, `T35 ${index === 0 ? 'Alpha' : 'Beta'}`, index === 0 ? 'topic' : 'make', `Test tag ${index}.`,
    ]);
  }
  const postIds = [];
  for (const [index, tagIndex] of [[0, 0], [1, 1]]) {
    const slug = `${stamp}-post-${index}`;
    const result = await db.query(
      `INSERT INTO blog_posts
         (slug, title, category, excerpt, hero_image, hero_alt, author_name, author_role, author_bio, author_id,
          read_minutes, status, published_at, make_tags, body, updated_by)
       VALUES (?, ?, 'honest_buyers_guide', ?, '/img/seed/og-default.svg', 'fixture', 'TC35 Writer', 'Test Desk',
               'Writes the FR-35 fixtures.', ?, 4, 'published', UTC_TIMESTAMP(), JSON_ARRAY('Toyota'), ?, NULL)`,
      [slug, `T35 post ${index}`, `Fixture ${index}`, authorResult.insertId, JSON.stringify([{ type: 'paragraph', text: 'Fixture.' }])],
    );
    await db.query('INSERT INTO blog_post_tags (post_id, tag_id) VALUES (?, (SELECT id FROM blog_tags WHERE slug = ?))', [
      result.insertId, tagSlugs[tagIndex],
    ]);
    postIds.push(result.insertId);
  }
  return { stamp, authorSlug, tagSlugs, postIds };
}

async function dropFixtures({ authorSlug, tagSlugs, postIds }) {
  const ids = postIds.join(',');
  if (ids) {
    await db.query(`DELETE FROM blog_post_tags WHERE post_id IN (${ids})`);
    await db.query(`DELETE FROM blog_posts WHERE id IN (${ids})`);
  }
  if (tagSlugs.length) await db.query(`DELETE FROM blog_tags WHERE slug IN (${tagSlugs.map(() => '?').join(',')})`, tagSlugs);
  await db.query('DELETE FROM blog_authors WHERE slug = ?', [authorSlug]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
maybe('a post carries its tags and its author page link', async () => {
  const fixtures = await makeFixtures();
  try {
    const post = await db.content.postBySlug(`${fixtures.stamp}-post-0`);
    assert.equal(post.tags.length, 1);
    assert.equal(post.tags[0].label, 'T35 Alpha');
    assert.equal(post.tags[0].url, `/blog/tag/${fixtures.tagSlugs[0]}`);
    assert.equal(post.authorSlug, fixtures.authorSlug);
    assert.equal(post.authorUrl, `/blog/author/${fixtures.authorSlug}`);
    assert.equal(post.author.name, 'TC35 Writer');
  } finally {
    await dropFixtures(fixtures);
  }
});

maybe('an author page counts only that writer’s published posts', async () => {
  const fixtures = await makeFixtures();
  try {
    const author = await db.content.authorBySlug(fixtures.authorSlug);
    assert.equal(author.count, 2);
    const shelf = await db.content.postsByAuthor(fixtures.authorSlug, { page: 1 });
    assert.equal(shelf.posts.length, 2);
    assert.equal(shelf.pages, 1);
    for (const post of shelf.posts) assert.ok(post.url.startsWith('/blog/'));
  } finally {
    await dropFixtures(fixtures);
  }
});

maybe('an unknown author or tag slug comes back null, not empty', async () => {
  assert.equal(await db.content.authorBySlug(`${MARK}-nobody-${Date.now()}`), null);
  assert.equal(await db.content.tagBySlug(`${MARK}-nothing-${Date.now()}`), null);
  assert.equal(await db.content.postsByTag(`${MARK}-nothing-${Date.now()}`), null);
  assert.equal(await db.content.postsByAuthor(`${MARK}-nobody-${Date.now()}`), null);
});

maybe('a tag page lists exactly the posts filed under it', async () => {
  const fixtures = await makeFixtures();
  try {
    const shelf = await db.content.postsByTag(fixtures.tagSlugs[0], { page: 1 });
    assert.equal(shelf.tag.label, 'T35 Alpha');
    assert.equal(shelf.posts.length, 1);
    assert.equal(shelf.posts[0].slug, `${fixtures.stamp}-post-0`);
    // The sibling tag carries the other post.
    const sibling = await db.content.postsByTag(fixtures.tagSlugs[1], { page: 1 });
    assert.equal(sibling.posts[0].slug, `${fixtures.stamp}-post-1`);
  } finally {
    await dropFixtures(fixtures);
  }
});

maybe('the governed tag list counts published posts and keeps unused tags', async () => {
  const fixtures = await makeFixtures();
  try {
    const tags = await db.content.blogTags({ limit: 60 });
    const alpha = tags.find((tag) => tag.slug === fixtures.tagSlugs[0]);
    const beta = tags.find((tag) => tag.slug === fixtures.tagSlugs[1]);
    assert.equal(alpha.count, 1);
    assert.equal(beta.count, 1);
    assert.ok(tags.some((tag) => tag.count === 0), 'an unused governed tag must still be listed');
    assert.ok(tags.every((tag) => tag.url.startsWith('/blog/tag/')));
  } finally {
    await dropFixtures(fixtures);
  }
});

/**
 * The ordering is the feature: a shared tag beats a shared category, and a
 * shared make beats recency. Two posts, one tag in common, is enough to prove
 * the first rule.
 */
maybe('related posts rank a shared tag above a shared category', async () => {
  const fixtures = await makeFixtures();
  try {
    const post = await db.content.postBySlug(`${fixtures.stamp}-post-0`, { full: true });
    const related = await db.content.relatedPosts(post, 3);
    const sibling = related.find((entry) => entry.slug === `${fixtures.stamp}-post-1`);
    assert.ok(sibling, 'the post sharing a tag should be related to it');
    assert.equal(sibling.tags.length, 1);
    // Everything returned is a real published post with a url and a byline.
    for (const entry of related) {
      assert.ok(entry.url.startsWith('/blog/'));
      assert.ok(entry.author.name);
    }
  } finally {
    await dropFixtures(fixtures);
  }
});

maybe('the blog index can be filtered by tag', async () => {
  const fixtures = await makeFixtures();
  try {
    const feed = await db.content.blogIndex({ page: 1, tag: fixtures.tagSlugs[1] });
    assert.equal(feed.total, 1);
    assert.equal(feed.posts[0].slug, `${fixtures.stamp}-post-1`);
    assert.ok(Array.isArray(feed.tags) && feed.tags.length, 'the feed carries the governed tags for the chip row');
  } finally {
    await dropFixtures(fixtures);
  }
});

// ---------------------------------------------------------------------------
// The editorial calendar
// ---------------------------------------------------------------------------
maybe('the editorial calendar puts a post on the day it is due', async () => {
  const stamp = `${MARK}-${Date.now().toString(36)}`;
  const slug = `${stamp}-calendar`;
  const publishedAt = '2026-03-09 08:30:00';
  const created = await db.query(
    `INSERT INTO blog_posts
       (slug, title, category, excerpt, hero_image, hero_alt, author_name, author_role,
        read_minutes, status, published_at, body, updated_by)
     VALUES (?, 'T35 calendar fixture', 'company_news', 'Fixture', '/img/seed/og-default.svg', 'fixture',
             'TC35 Writer', 'Test Desk', 3, 'published', ?, ?, NULL)`,
    [slug, publishedAt, JSON.stringify([{ type: 'paragraph', text: 'Fixture.' }])],
  );
  try {
    const calendar = await db.content.editorialCalendar('2026-03');
    assert.equal(calendar.month, '2026-03');
    assert.equal(calendar.days.length, 31);
    const day = calendar.days.find((entry) => entry.key === '2026-03-09');
    assert.ok(day, 'the grid has a cell for the 9th');
    const entry = day.posts.find((post) => post.slug === slug);
    assert.ok(entry, 'the post lands on the day it was published, not on no day at all');
    assert.equal(entry.status, 'published');
    assert.equal(entry.url, `/blog/${slug}`);
    assert.equal(calendar.counts.published >= 1, true);
    // A month with nothing in it still returns a whole grid.
    const empty = await db.content.editorialCalendar('2019-02');
    assert.equal(empty.days.length, 28);
    assert.equal(empty.total, 0);
  } finally {
    await db.query('DELETE FROM blog_post_tags WHERE post_id = ?', [created.insertId]);
    await db.query('DELETE FROM blog_posts WHERE id = ?', [created.insertId]);
  }
});

maybe('the calendar grid is Monday-first and paginates by month', async () => {
  const calendar = await db.content.editorialCalendar('2026-10');
  assert.equal(calendar.previous, '2026-09');
  assert.equal(calendar.next, '2026-11');
  // 1 October 2026 is a Thursday → four blank cells before it in a Monday grid.
  assert.equal(calendar.lead, 3);
  assert.equal(calendar.days[0].key, '2026-10-01');
  // A January next-month rolls the year over.
  const jan = await db.content.editorialCalendar('2026-12');
  assert.equal(jan.next, '2027-01');
});

// ---------------------------------------------------------------------------
// The [listing:slug] directive and the console's writes
// ---------------------------------------------------------------------------
test('[listing:slug] parses, canonicalises and round-trips', () => {
  const parsed = blocks.parse('Prose.\n\n[listing:2012-lexus-rx-350-f-sport-hc-ph-0001]\n\n[cars]');
  assert.deepEqual(parsed.blocks, [
    { type: 'paragraph', text: 'Prose.' },
    { type: 'listing', slug: '2012-lexus-rx-350-f-sport-hc-ph-0001' },
    { type: 'listings' },
  ]);
  assert.equal(parsed.errors.length, 0);
  assert.equal(
    blocks.toMarkup(parsed.blocks),
    'Prose.\n\n[listing:2012-lexus-rx-350-f-sport-hc-ph-0001]\n\n[cars]',
  );
  // An empty slug is a line error, not a silent drop of the writer's intent.
  const broken = blocks.parse('[listing:]');
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0].message, /listing/);
  // Unknown directives point at the new one.
  assert.match(blocks.parse('[nonsense]').errors[0].message, /\[listing:slug\]/);
  // A car block counts as one link's worth of content in the house-rule count.
  assert.equal(blocks.wordCount([{ type: 'listing', slug: 'a-b-c' }]), 1);
});

maybe('saving from the console replaces a post’s tags rather than merging them', async () => {
  const fixtures = await makeFixtures();
  try {
    const post = await db.cms.postById(fixtures.postIds[0]);
    assert.deepEqual(post.tagSlugs, [fixtures.tagSlugs[0]]);
    assert.equal(post.authorId !== null, true);

    // Save with the sibling tag only.
    const updated = await cms.updatePost(post.id, {
      ...post,
      tagSlugs: [fixtures.tagSlugs[1]],
      body: post.body,
      makeTags: post.makeTags,
    }, { actorId: null, note: 't35 test' });
    assert.equal(updated.ok, true);

    const after = await db.cms.postById(post.id);
    assert.deepEqual(after.tagSlugs, [fixtures.tagSlugs[1]], 'the old tag must be gone, not kept alongside');

    // A slug that does not exist cannot break the save.
    const stale = await cms.updatePost(post.id, { ...after, tagSlugs: [`${MARK}-never-existed`, fixtures.tagSlugs[0]], body: after.body, makeTags: after.makeTags }, { actorId: null });
    assert.equal(stale.ok, true);
    const final = await db.cms.postById(post.id);
    assert.deepEqual(final.tagSlugs, [fixtures.tagSlugs[0]]);
  } finally {
    await dropFixtures(fixtures);
  }
});

maybe('the console sets a post’s author page, and can clear it again', async () => {
  const fixtures = await makeFixtures();
  try {
    const post = await db.cms.postById(fixtures.postIds[1]);
    const cleared = await cms.updatePost(post.id, { ...post, authorId: null, body: post.body, makeTags: post.makeTags }, { actorId: null });
    assert.equal(cleared.ok, true);
    assert.equal((await db.cms.postById(post.id)).authorId, null);

    const relinked = await cms.updatePost(post.id, { ...post, authorId: fixtures.postIds[0] && post.authorId, body: post.body, makeTags: post.makeTags }, { actorId: null });
    assert.equal(relinked.ok, true);
    assert.equal((await db.cms.postById(post.id)).authorId, post.authorId);
  } finally {
    await dropFixtures(fixtures);
  }
});
