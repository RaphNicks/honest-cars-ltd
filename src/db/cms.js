'use strict';

/**
 * Content workflow — §7.3 “CMS” and §6.9 “Publishing & governance”.
 *
 * The console edits the same rows the public site renders: blog posts, CMS
 * pages, FAQs, testimonials, homepage modules and the service price cards.
 * What this module adds is the part a CMS is actually for:
 *
 *   • the workflow — draft → in review → scheduled → published, plus back to
 *     draft with the reviewer's reason kept on the row
 *   • revision history — one immutable snapshot per save, restorable
 *   • the §6.9 house rules, checked and reported (≥ 3 listing/service links,
 *     a title and description inside §14.3 limits, a category, an excerpt)
 *   • publish-time side effects — the revalidation hook and the audit row, so
 *     publishing actually refreshes the static pages rather than only setting
 *     a flag in a table
 *
 * Every write takes `actorId` and lands in admin_audit: who published what,
 * and what it looked like before, is never guesswork.
 */

const { query, queryOne, transaction } = require('./pool');
const { parseJson } = require('./shape');
const blocksService = require('../services/blocks');

const WORKFLOW = ['draft', 'in_review', 'scheduled', 'published'];
const STATUS_LABELS = {
  draft: 'Draft',
  in_review: 'In review',
  scheduled: 'Scheduled',
  published: 'Published',
};

const ENTITIES = ['post', 'page', 'faq', 'testimonial', 'homepage', 'service'];
const PAGE_SLUGS = ['about', 'how-it-works', 'terms', 'privacy', 'refunds', 'disclaimer', 'verification', 'contact'];
const FAQ_SCOPES = ['global', 'vdp', 'facet', 'services', 'shop', 'hire', 'contact'];

const TITLE_LIMIT = 62;       // §14.3 patterns
const DESCRIPTION_LIMIT = 158;
const MIN_LINKS = 3;          // §6.9 house rule
const MAX_REVISIONS = 40;     // per entity, oldest pruned
const MAX_POSITION = 127;     // `position` is TINYINT on faqs/testimonials/homepage_modules

/** Keep a sort order inside what the column can actually store. */
function clampPosition(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_POSITION, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
async function recordRevision({ entity, entityId, slug, title, status, snapshot, note = null, actorId = null }) {
  await query(
    `INSERT INTO content_revisions (entity, entity_id, slug, title, status, snapshot, note, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entity, entityId, slug || null, title || null, status || null, JSON.stringify(snapshot),
      note ? String(note).slice(0, 240) : null, actorId],
  );
  // Keep the history useful rather than enormous.
  const keep = await query(
    `SELECT id FROM content_revisions WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?`,
    [entity, entityId, MAX_REVISIONS],
  );
  if (keep.length) {
    await query('DELETE FROM content_revisions WHERE entity = ? AND entity_id = ? AND id <= ?', [entity, entityId, keep[0].id]);
  }
}

async function audit({ actorId, action, entity, entityId, detail }) {
  await query(
    'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    [actorId || null, action, entity, entityId, detail ? JSON.stringify(detail) : null],
  );
}

function slugify(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** §14.3 limits, as a result the editor can display rather than a surprise. */
function metaCheck({ title, description, links = null }) {
  const issues = [];
  const length = (value) => String(value || '').length;
  if (!title) issues.push('There is no meta title.');
  else if (length(title) > TITLE_LIMIT) issues.push(`Meta title is ${length(title)} characters — ${TITLE_LIMIT} is the ceiling in the search results.`);
  if (!description) issues.push('There is no meta description.');
  else if (length(description) > DESCRIPTION_LIMIT) issues.push(`Meta description is ${length(description)} characters — aim for ${DESCRIPTION_LIMIT} or fewer.`);
  if (links !== null && links < MIN_LINKS) {
    issues.push(`A post must link at least ${MIN_LINKS} listing or service pages (§6.9) — this one links ${links}.`);
  }
  return { ok: issues.length === 0, issues, titleLength: length(title), descriptionLength: length(description), links };
}

// ---------------------------------------------------------------------------
// The dashboard: everything the CMS owns, with what each item needs next
// ---------------------------------------------------------------------------
async function counts() {
  const row = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM blog_posts WHERE status = 'draft')     AS posts_draft,
       (SELECT COUNT(*) FROM blog_posts WHERE status = 'in_review') AS posts_review,
       (SELECT COUNT(*) FROM blog_posts WHERE status = 'scheduled') AS posts_scheduled,
       (SELECT COUNT(*) FROM blog_posts WHERE status = 'published') AS posts_published,
       (SELECT COUNT(*) FROM pages)                                 AS pages_total,
       (SELECT COUNT(*) FROM pages WHERE legal_review = 1)          AS pages_awaiting_counsel,
       (SELECT COUNT(*) FROM faqs WHERE is_active = 1)              AS faqs_active,
       (SELECT COUNT(*) FROM testimonials WHERE is_published = 1)   AS testimonials_live,
       (SELECT COUNT(*) FROM testimonials WHERE is_published = 0)   AS testimonials_hidden,
       (SELECT COUNT(*) FROM homepage_modules WHERE is_active = 1)  AS modules_active,
       (SELECT COUNT(*) FROM content_revisions)                     AS revisions`,
  );
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)]));
}

async function overview() {
  const [stats, posts, pages, awaitingCounsel, recent] = await Promise.all([
    counts(),
    query(
      `SELECT p.id, p.slug, p.title, p.category, p.status, p.excerpt, p.hero_image, p.published_at, p.updated_at,
              p.review_note, p.meta_title, p.meta_description, p.read_minutes, p.is_featured,
              u.name AS updated_by_name,
              (SELECT COUNT(*) FROM content_revisions r WHERE r.entity = 'post' AND r.entity_id = p.id) AS revisions
         FROM blog_posts p
         LEFT JOIN \`users\` u ON u.id = p.updated_by
        ORDER BY FIELD(p.status,'in_review','scheduled','draft','published'), p.updated_at DESC
        LIMIT 200`,
    ),
    query(`SELECT slug, title, meta_title, meta_description, legal_review, indexable, updated_at FROM pages ORDER BY legal_review DESC, slug`),
    query(`SELECT slug, title FROM pages WHERE legal_review = 1 ORDER BY slug`),
    query(
      `SELECT r.id, r.entity, r.entity_id, r.slug, r.title, r.status, r.note, r.created_at, u.name AS actor_name
         FROM content_revisions r
         LEFT JOIN \`users\` u ON u.id = r.actor_id
        ORDER BY r.id DESC LIMIT 12`,
    ),
  ]);

  return {
    stats,
    posts: posts.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      category: row.category,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] || row.status,
      excerpt: row.excerpt,
      heroImage: row.hero_image,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
      reviewNote: row.review_note,
      readMinutes: Number(row.read_minutes || 0),
      isFeatured: Boolean(row.is_featured),
      metaTitle: row.meta_title || null,
      metaDescription: row.meta_description || null,
      updatedByName: row.updated_by_name || null,
      revisions: Number(row.revisions || 0),
      url: `/blog/${row.slug}`,
    })),
    pages,
    awaitingCounsel,
    recent,
  };
}

// ---------------------------------------------------------------------------
// Blog posts
// ---------------------------------------------------------------------------
async function postById(id) {
  const row = await queryOne(
    `SELECT p.*, u.name AS updated_by_name, pb.name AS published_by_name, a.slug AS author_slug
       FROM blog_posts p
       LEFT JOIN \`users\` u ON u.id = p.updated_by
       LEFT JOIN \`users\` pb ON pb.id = p.published_by
       LEFT JOIN blog_authors a ON a.id = p.author_id
      WHERE p.id = ? LIMIT 1`,
    [id],
  );
  if (!row) return null;
  const body = parseJson(row.body, []) || [];
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    excerpt: row.excerpt,
    heroImage: row.hero_image,
    heroAlt: row.hero_alt,
    authorName: row.author_name,
    authorRole: row.author_role,
    authorBio: row.author_bio || '',
    readMinutes: Number(row.read_minutes || 6),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    isFeatured: Boolean(row.is_featured),
    makeTags: parseJson(row.make_tags, []) || [],
    authorId: row.author_id || null,
    authorSlug: row.author_slug || null,
    tagSlugs: (await query(
      'SELECT t.slug FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY t.label',
      [id],
    )).map((tag) => tag.slug),
    serviceCta: row.service_cta || null,
    metaTitle: row.meta_title || '',
    metaDescription: row.meta_description || '',
    reviewNote: row.review_note || null,
    updatedByName: row.updated_by_name || null,
    publishedByName: row.published_by_name || null,
    body,
    markup: blocksService.toMarkup(body),
    words: blocksService.wordCount(body),
    links: blocksService.linksIn(body),
    url: `/blog/${row.slug}`,
  };
}

/** The form payload the console sends, cleaned once here. */
function postInput(form = {}) {
  const parsed = blocksService.parse(form.body_markup || '');
  const tags = String(form.make_tags || '')
    .split(',')
    .map((tag) => tag.trim().toLowerCase().slice(0, 40))
    .filter(Boolean)
    .slice(0, 8);
  const authorId = Number.parseInt(form.author_id, 10);
  const tagSlugs = (Array.isArray(form.tags) ? form.tags : [form.tags])
    .map((tag) => String(tag || '').trim().toLowerCase().slice(0, 80))
    .filter(Boolean)
    .slice(0, 8);
  return {
    input: {
      authorId: Number.isFinite(authorId) && authorId > 0 ? authorId : null,
      tagSlugs,
      title: String(form.title || '').trim().slice(0, 240),
      slug: slugify(form.slug || form.title || ''),
      category: String(form.category || 'honest_buyers_guide').slice(0, 40),
      excerpt: String(form.excerpt || '').trim().slice(0, 400),
      heroImage: String(form.hero_image || '/img/seed/hero-lot.svg').trim().slice(0, 400),
      heroAlt: String(form.hero_alt || '').trim().slice(0, 300),
      authorName: String(form.author_name || 'Honest Cars editorial').trim().slice(0, 120),
      authorRole: String(form.author_role || 'Editorial').trim().slice(0, 120),
      authorBio: String(form.author_bio || '').trim().slice(0, 300),
      readMinutes: Math.min(60, Math.max(1, Number.parseInt(form.read_minutes, 10) || 6)),
      makeTags: tags,
      serviceCta: String(form.service_cta || '').trim().slice(0, 80) || null,
      metaTitle: String(form.meta_title || '').trim().slice(0, 200) || null,
      metaDescription: String(form.meta_description || '').trim().slice(0, 320) || null,
      isFeatured: Boolean(form.is_featured),
      body: parsed.blocks,
      schedule: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(form.publish_at || '')) ? String(form.publish_at).replace('T', ' ') : null,
    },
    errors: parsed.errors,
    words: blocksService.wordCount(parsed.blocks),
    links: blocksService.linksIn(parsed.blocks),
  };
}

/**
 * Replace a post's tags. Delete-then-insert inside one transaction: a save that
 * fails halfway must not leave a post half-filed. Only ids that exist are
 * written, so a stale checkbox cannot break the save.
 */
async function setPostTags(postId, slugs = []) {
  const clean = [...new Set((slugs || []).filter(Boolean))];
  const ids = clean.length
    ? (await query(`SELECT id FROM blog_tags WHERE slug IN (${clean.map(() => '?').join(',')})`, clean)).map((row) => row.id)
    : [];
  await transaction(async (conn) => {
    await conn.query('DELETE FROM blog_post_tags WHERE post_id = ?', [postId]);
    for (const tagId of ids) {
      await conn.query('INSERT IGNORE INTO blog_post_tags (post_id, tag_id) VALUES (?, ?)', [postId, tagId]);
    }
  });
}

async function createPost(input, { actorId } = {}) {
  if (!input.title) return { ok: false, error: 'A post needs a title.' };
  if (!input.slug) return { ok: false, error: 'A post needs a slug.' };
  const clash = await queryOne('SELECT id FROM blog_posts WHERE slug = ? LIMIT 1', [input.slug]);
  if (clash) return { ok: false, error: `The slug “${input.slug}” is already taken — try another.` };
  if (!input.excerpt) return { ok: false, error: 'A post needs an excerpt — it is what the blog card and search results show.' };

  const result = await query(
    `INSERT INTO blog_posts
       (slug, title, category, excerpt, hero_image, hero_alt, author_name, author_role, author_bio, author_id,
        read_minutes, status, make_tags, body, service_cta, meta_title, meta_description, is_featured, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    [input.slug, input.title, input.category, input.excerpt, input.heroImage, input.heroAlt || input.title,
      input.authorName, input.authorRole, input.authorBio || null, input.authorId || null, input.readMinutes,
      JSON.stringify(input.makeTags), JSON.stringify(input.body), input.serviceCta,
      input.metaTitle, input.metaDescription, input.isFeatured ? 1 : 0, actorId || null],
  );
  await setPostTags(result.insertId, input.tagSlugs);
  await recordRevision({ entity: 'post', entityId: result.insertId, slug: input.slug, title: input.title, status: 'draft', snapshot: input, note: 'Created', actorId });
  await audit({ actorId, action: 'cms.post.create', entity: 'post', entityId: result.insertId, detail: { slug: input.slug, title: input.title } });
  return { ok: true, id: result.insertId, slug: input.slug };
}

async function updatePost(id, input, { actorId, note = null } = {}) {
  const before = await postById(id);
  if (!before) return { ok: false, error: 'That post does not exist.' };
  if (!input.title) return { ok: false, error: 'A post needs a title.' };
  if (!input.excerpt) return { ok: false, error: 'A post needs an excerpt.' };
  const clash = await queryOne('SELECT id FROM blog_posts WHERE slug = ? AND id <> ? LIMIT 1', [input.slug, id]);
  if (clash) return { ok: false, error: `The slug “${input.slug}” is already used by another post.` };

  // Saving always writes a snapshot of the *previous* state, so history is the
  // story of how the piece got here.
  await recordRevision({
    entity: 'post',
    entityId: id,
    slug: before.slug,
    title: before.title,
    status: before.status,
    snapshot: { ...before, markup: before.markup },
    note: note || 'Saved',
    actorId,
  });

  await query(
    `UPDATE blog_posts
        SET slug = ?, title = ?, category = ?, excerpt = ?, hero_image = ?, hero_alt = ?,
            author_name = ?, author_role = ?, author_bio = ?, author_id = ?, read_minutes = ?, make_tags = ?,
            body = ?, service_cta = ?, meta_title = ?, meta_description = ?, is_featured = ?, updated_by = ?
      WHERE id = ?`,
    [input.slug, input.title, input.category, input.excerpt, input.heroImage, input.heroAlt || input.title,
      input.authorName, input.authorRole, input.authorBio || null, input.authorId || null, input.readMinutes,
      JSON.stringify(input.makeTags), JSON.stringify(input.body), input.serviceCta,
      input.metaTitle, input.metaDescription, input.isFeatured ? 1 : 0, actorId || null, id],
  );
  await setPostTags(id, input.tagSlugs);
  await audit({
    actorId,
    action: 'cms.post.update',
    entity: 'post',
    entityId: id,
    detail: { slug: input.slug, title: before.title, status: before.status, note },
  });
  return { ok: true, id };
}

/**
 * The workflow transition. This is where the house rules are enforced, because
 * this is the moment copy becomes public (or is queued to).
 */
async function movePost(id, to, { actorId, note = null, publishAt = null } = {}) {
  const post = await postById(id);
  if (!post) return { ok: false, error: 'That post does not exist.' };
  if (to === post.status) return { ok: false, error: `“${post.title}” is already ${STATUS_LABELS[to] || to}.` };
  if (!WORKFLOW.includes(to)) return { ok: false, error: 'Unknown workflow state.' };

  const check = metaCheck({
    title: post.metaTitle || post.title,
    description: post.metaDescription || post.excerpt,
    links: post.links,
  });

  if (to === 'published' || to === 'scheduled') {
    if (!post.body.length) return { ok: false, error: 'A post with no body cannot go out — write something first.' };
    if (!check.ok) {
      return { ok: false, error: `Not ready to publish: ${check.issues.join(' ')}` };
    }
  }
  if (to === 'scheduled' && !publishAt) {
    return { ok: false, error: 'Scheduling needs a date and time.' };
  }
  if (to === 'in_review' && !post.body.length) {
    return { ok: false, error: 'There is nothing to review yet.' };
  }

  if (to === 'published') {
    await query(
      `UPDATE blog_posts
          SET status = 'published',
              published_at = COALESCE(published_at, UTC_TIMESTAMP()),
              published_by = ?, updated_by = ?, review_note = NULL
        WHERE id = ?`,
      [actorId || null, actorId || null, id],
    );
  } else if (to === 'scheduled') {
    await query(
      'UPDATE blog_posts SET status = ?, published_at = ?, updated_by = ?, review_note = ? WHERE id = ?',
      [to, String(publishAt).replace('T', ' '), actorId || null, note ? String(note).slice(0, 300) : null, id],
    );
  } else {
    await query(
      'UPDATE blog_posts SET status = ?, review_note = ?, updated_by = ? WHERE id = ?',
      [to, note ? String(note).slice(0, 300) : null, actorId || null, id],
    );
  }

  await recordRevision({
    entity: 'post', entityId: id, slug: post.slug, title: post.title, status: to,
    snapshot: { ...post, markup: post.markup }, note: note || `Moved to ${STATUS_LABELS[to]}`, actorId,
  });
  await audit({
    actorId,
    action: `cms.post.${to}`,
    entity: 'post',
    entityId: id,
    detail: { slug: post.slug, from: post.status, to, note, publishAt },
  });

  const published = to === 'published';
  return {
    ok: true,
    id,
    status: to,
    meta: check,
    // The caller rebuilds the static pages when this is true.
    revalidate: published,
    message: published
      ? `“${post.title}” is published — the site is being rebuilt so it is live immediately.`
      : `“${post.title}” is now ${STATUS_LABELS[to]}.`,
  };
}

async function deletePost(id, { actorId } = {}) {
  const post = await postById(id);
  if (!post) return { ok: false, error: 'That post does not exist.' };
  if (post.status === 'published') {
    return { ok: false, error: 'A published post is not deleted — move it back to draft first, so the URL can be decided deliberately.' };
  }
  await recordRevision({
    entity: 'post', entityId: id, slug: post.slug, title: post.title, status: 'deleted',
    snapshot: { ...post, markup: post.markup }, note: 'Deleted', actorId,
  });
  await query('DELETE FROM blog_posts WHERE id = ?', [id]);
  await audit({ actorId, action: 'cms.post.delete', entity: 'post', entityId: id, detail: { slug: post.slug, title: post.title } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Revision history
// ---------------------------------------------------------------------------
async function revisionsFor(entity, entityId) {
  const rows = await query(
    `SELECT r.id, r.slug, r.title, r.status, r.note, r.created_at, u.name AS actor_name
       FROM content_revisions r
       LEFT JOIN \`users\` u ON u.id = r.actor_id
      WHERE r.entity = ? AND r.entity_id = ?
      ORDER BY r.id DESC LIMIT 40`,
    [entity, entityId],
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    actorName: row.actor_name || 'system',
  }));
}

async function revisionById(id) {
  const row = await queryOne('SELECT * FROM content_revisions WHERE id = ? LIMIT 1', [id]);
  if (!row) return null;
  return { ...row, snapshot: parseJson(row.snapshot, null) };
}

/** The last few things anyone did, for the hub (§7.3). */
async function recentRevisions(limit = 10) {
  const rows = await query(
    `SELECT r.id, r.entity, r.entity_id, r.slug, r.title, r.status, r.note, r.created_at, u.name AS actor_name
       FROM content_revisions r
       LEFT JOIN \`users\` u ON u.id = r.actor_id
      ORDER BY r.id DESC LIMIT ?`,
    [Math.min(50, Math.max(1, Number(limit) || 10))],
  );
  return rows.map((row) => ({ ...row, actorName: row.actor_name || 'system' }));
}

/** Put a post back to an earlier revision (which is itself a new revision). */
async function restoreRevision(revisionId, { actorId } = {}) {
  const revision = await revisionById(revisionId);
  if (!revision) return { ok: false, error: 'That revision no longer exists.' };
  if (revision.entity !== 'post') return { ok: false, error: 'Only post revisions can be restored from here.' };

  const snapshot = revision.snapshot || {};
  const current = await postById(revision.entity_id);
  if (!current) return { ok: false, error: 'The post this revision belongs to has been deleted.' };

  const input = {
    title: snapshot.title,
    slug: snapshot.slug,
    category: snapshot.category,
    excerpt: snapshot.excerpt,
    heroImage: snapshot.heroImage,
    heroAlt: snapshot.heroAlt,
    authorName: snapshot.authorName,
    authorRole: snapshot.authorRole,
    authorBio: snapshot.authorBio,
    readMinutes: snapshot.readMinutes,
    makeTags: snapshot.makeTags || [],
    serviceCta: snapshot.serviceCta,
    metaTitle: snapshot.metaTitle || null,
    metaDescription: snapshot.metaDescription || null,
    isFeatured: Boolean(snapshot.isFeatured),
    body: blocksService.canonical(snapshot.body || []),
  };
  const result = await updatePost(revision.entity_id, input, {
    actorId,
    note: `Restored revision #${revisionId}`,
  });
  if (!result.ok) return result;
  await audit({ actorId, action: 'cms.post.restore', entity: 'post', entityId: revision.entity_id, detail: { revisionId, slug: input.slug } });
  return { ok: true, id: revision.entity_id, slug: input.slug };
}

// ---------------------------------------------------------------------------
// CMS pages (§6.10) — meta and body the CMS owns
// ---------------------------------------------------------------------------
async function listPages() {
  const rows = await query(
    `SELECT p.id, p.slug, p.title, p.h1, p.meta_title, p.meta_description, p.indexable, p.legal_review, p.updated_at,
            (SELECT COUNT(*) FROM content_revisions r WHERE r.entity = 'page' AND r.entity_id = p.id) AS revisions
       FROM pages p ORDER BY p.legal_review DESC, p.slug`,
  );
  return rows.map((row) => ({ ...row, revisions: Number(row.revisions || 0) }));
}

async function pageById(id) {
  const row = await queryOne('SELECT * FROM pages WHERE id = ? LIMIT 1', [id]);
  if (!row) return null;
  const body = parseJson(row.body, []) || [];
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    h1: row.h1,
    heroCopy: row.hero_copy || '',
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    indexable: Boolean(row.indexable),
    legalReview: Boolean(row.legal_review),
    updatedAt: row.updated_at,
    body,
    markup: blocksService.toMarkup(body),
    url: `/${row.slug}`,
  };
}

async function updatePage(id, form = {}, { actorId } = {}) {
  const before = await pageById(id);
  if (!before) return { ok: false, error: 'That page does not exist.' };
  if (before.legalReview && String(form.legal_review || '') === '1') {
    // Un-ticking counsel review is allowed; re-ticking it must be deliberate
    // and is recorded, because it changes what the public copy claims.
  }
  const parsed = blocksService.parse(form.body_markup || '');
  const metaTitle = String(form.meta_title || '').trim().slice(0, 200);
  const metaDescription = String(form.meta_description || '').trim().slice(0, 320);
  if (!metaTitle) return { ok: false, error: 'A page needs a meta title — it is the blue line in the search results.' };
  if (!metaDescription) return { ok: false, error: 'A page needs a meta description.' };

  const check = metaCheck({ title: metaTitle, description: metaDescription });
  if (!check.ok) return { ok: false, error: check.issues.join(' ') };

  await recordRevision({
    entity: 'page', entityId: id, slug: before.slug, title: before.title, status: 'saved',
    snapshot: before, note: 'Saved', actorId,
  });
  await query(
    `UPDATE pages
        SET h1 = ?, hero_copy = ?, meta_title = ?, meta_description = ?, body = ?, indexable = ?, legal_review = ?
      WHERE id = ?`,
    [String(form.h1 || before.h1).trim().slice(0, 200), String(form.hero_copy || '').trim().slice(0, 2000),
      metaTitle, metaDescription, JSON.stringify(parsed.blocks),
      String(form.indexable || '') === '1' ? 1 : 0, String(form.legal_review || '') === '1' ? 1 : 0, id],
  );
  await audit({
    actorId,
    action: 'cms.page.update',
    entity: 'page',
    entityId: id,
    detail: { slug: before.slug, counselCleared: String(form.legal_review || '') === '1' },
  });
  return { ok: true, id, errors: parsed.errors, revalidate: true, message: `/${before.slug} updated — the site is being rebuilt.` };
}

// ---------------------------------------------------------------------------
// FAQs, testimonials, homepage modules
// ---------------------------------------------------------------------------
async function listFaqs() {
  const rows = await query('SELECT * FROM faqs ORDER BY is_active DESC, scope, position, id LIMIT 300');
  return rows.map((row) => ({
    id: row.id, scope: row.scope, question: row.question, answer: row.answer,
    position: Number(row.position || 0), isActive: Boolean(row.is_active),
  }));
}

async function saveFaq(id, form = {}, { actorId } = {}) {
  const question = String(form.question || '').trim().slice(0, 300);
  const answer = String(form.answer || '').trim().slice(0, 2000);
  const scope = String(form.scope || 'global').trim().slice(0, 80);
  const position = clampPosition(form.position);
  const isActive = String(form.is_active || '') === '1';
  if (!question || !answer) return { ok: false, error: 'A FAQ needs both a question and an answer.' };

  if (id) {
    const before = await queryOne('SELECT * FROM faqs WHERE id = ? LIMIT 1', [id]);
    if (!before) return { ok: false, error: 'That FAQ no longer exists.' };
    await recordRevision({ entity: 'faq', entityId: id, title: before.question, status: 'saved', snapshot: before, note: 'Saved', actorId });
    await query('UPDATE faqs SET scope = ?, question = ?, answer = ?, position = ?, is_active = ? WHERE id = ?', [
      scope, question, answer, position, isActive ? 1 : 0, id,
    ]);
    await audit({ actorId, action: 'cms.faq.update', entity: 'faq', entityId: id, detail: { question } });
    return { ok: true, id, revalidate: true, message: 'FAQ saved — the pages that show it are being rebuilt.' };
  }

  const result = await query('INSERT INTO faqs (scope, question, answer, position, is_active) VALUES (?, ?, ?, ?, ?)', [
    scope, question, answer, position, isActive ? 1 : 0,
  ]);
  await audit({ actorId, action: 'cms.faq.create', entity: 'faq', entityId: result.insertId, detail: { question, scope } });
  return { ok: true, id: result.insertId, revalidate: true, message: 'FAQ added.' };
}

async function deleteFaq(id, { actorId } = {}) {
  const before = await queryOne('SELECT * FROM faqs WHERE id = ? LIMIT 1', [id]);
  if (!before) return { ok: false, error: 'That FAQ no longer exists.' };
  await recordRevision({ entity: 'faq', entityId: id, title: before.question, status: 'deleted', snapshot: before, note: 'Deleted', actorId });
  await query('DELETE FROM faqs WHERE id = ?', [id]);
  await audit({ actorId, action: 'cms.faq.delete', entity: 'faq', entityId: id, detail: { question: before.question } });
  return { ok: true, revalidate: true, message: 'FAQ removed.' };
}

async function listTestimonials() {
  const rows = await query('SELECT * FROM testimonials ORDER BY is_published DESC, position, id LIMIT 200');
  return rows.map((row) => ({
    id: row.id, customerName: row.customer_name, area: row.area, quote: row.quote,
    serviceTag: row.service_tag || '', rating: Number(row.rating || 5),
    position: Number(row.position || 0), isPublished: Boolean(row.is_published),
  }));
}

async function saveTestimonial(id, form = {}, { actorId } = {}) {
  const customerName = String(form.customer_name || '').trim().slice(0, 120);
  const area = String(form.area || '').trim().slice(0, 80);
  const quote = String(form.quote || '').trim().slice(0, 1000);
  const serviceTag = String(form.service_tag || '').trim().slice(0, 60) || null;
  const rating = Math.min(5, Math.max(1, Number.parseInt(form.rating, 10) || 5));
  const position = clampPosition(form.position);
  const isPublished = String(form.is_published || '') === '1';
  if (!customerName || !quote) return { ok: false, error: 'A testimonial needs a name and a quote.' };
  if (!area) return { ok: false, error: 'Say which area the customer is in — “Port Harcourt” is fine.' };

  if (id) {
    const before = await queryOne('SELECT * FROM testimonials WHERE id = ? LIMIT 1', [id]);
    if (!before) return { ok: false, error: 'That testimonial no longer exists.' };
    await recordRevision({ entity: 'testimonial', entityId: id, title: before.customer_name, status: 'saved', snapshot: before, note: 'Saved', actorId });
    await query(
      'UPDATE testimonials SET customer_name = ?, area = ?, quote = ?, service_tag = ?, rating = ?, position = ?, is_published = ? WHERE id = ?',
      [customerName, area, quote, serviceTag, rating, position, isPublished ? 1 : 0, id],
    );
    await audit({ actorId, action: 'cms.testimonial.update', entity: 'testimonial', entityId: id, detail: { customerName, isPublished } });
    return { ok: true, id, revalidate: isPublished, message: 'Testimonial saved.' };
  }

  const result = await query(
    'INSERT INTO testimonials (customer_name, area, quote, service_tag, rating, position, is_published) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [customerName, area, quote, serviceTag, rating, position, isPublished ? 1 : 0],
  );
  await audit({ actorId, action: 'cms.testimonial.create', entity: 'testimonial', entityId: result.insertId, detail: { customerName } });
  return { ok: true, id: result.insertId, revalidate: isPublished, message: 'Testimonial added.' };
}

async function listHomepageModules() {
  const rows = await query('SELECT * FROM homepage_modules ORDER BY position, id');
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title || '',
    payload: parseJson(row.payload, {}) || {},
    isActive: Boolean(row.is_active),
    position: Number(row.position || 0),
    updatedAt: row.updated_at,
  }));
}

async function saveHomepageModule(id, form = {}, { actorId } = {}) {
  const row = await queryOne('SELECT * FROM homepage_modules WHERE id = ? LIMIT 1', [id]);
  if (!row) return { ok: false, error: 'That module does not exist.' };
  const title = String(form.title || '').trim().slice(0, 160);
  const isActive = String(form.is_active || '') === '1';

  let payload = {};
  try {
    payload = form.payload ? JSON.parse(form.payload) : {};
  } catch {
    return { ok: false, error: 'The module settings must be valid JSON — check the braces and quotes.' };
  }

  await recordRevision({ entity: 'homepage', entityId: id, slug: row.key, title: row.title, status: 'saved', snapshot: row, note: 'Saved', actorId });
  await query('UPDATE homepage_modules SET title = ?, payload = ?, is_active = ?, updated_by = ? WHERE id = ?', [
    title, JSON.stringify(payload), isActive ? 1 : 0, actorId || null, id,
  ]);
  await audit({ actorId, action: 'cms.homepage.update', entity: 'homepage', entityId: id, detail: { key: row.key, isActive } });
  return { ok: true, id, revalidate: true, message: `Homepage module “${row.key}” saved.` };
}

/** What the homepage reads. Inactive modules are simply absent (§6.1). */
async function homepageModules() {
  const rows = await query('SELECT * FROM homepage_modules WHERE is_active = 1 ORDER BY position, id');
  const out = {};
  for (const row of rows) out[row.key] = { title: row.title, ...(parseJson(row.payload, {}) || {}) };
  return out;
}

/** Non-active modules, for the console list (nothing should be invisible). */
async function listingCounters() {
  const rows = await query(
    `SELECT make, COUNT(*) AS n FROM vehicle_listings
      WHERE status IN ('live','reserved') AND expires_at > UTC_TIMESTAMP()
      GROUP BY make ORDER BY n DESC LIMIT 8`,
  );
  return rows.map((row) => ({ make: row.make, count: Number(row.n || 0) }));
}

module.exports = {
  setPostTags,
  WORKFLOW,
  STATUS_LABELS,
  ENTITIES,
  PAGE_SLUGS,
  FAQ_SCOPES,
  TITLE_LIMIT,
  DESCRIPTION_LIMIT,
  MIN_LINKS,
  MAX_POSITION,
  clampPosition,
  slugify,
  metaCheck,
  counts,
  overview,
  postById,
  postInput,
  createPost,
  updatePost,
  movePost,
  deletePost,
  revisionsFor,
  revisionById,
  restoreRevision,
  recentRevisions,
  listPages,
  pageById,
  updatePage,
  listFaqs,
  saveFaq,
  deleteFaq,
  listTestimonials,
  saveTestimonial,
  listHomepageModules,
  saveHomepageModule,
  homepageModules,
  listingCounters,
  recordRevision,
  audit,
};
