'use strict';

/**
 * Curated facet repository (§14.1).
 *
 * Rule of the road: raw filter combinations are NEVER indexable. Only rows in
 * `facets` — hand-curated with their own H1, intro copy and canonical — get an
 * indexable URL. Everything else renders with <meta name="robots"
 * content="noindex,follow"> and a canonical back to /cars.
 */

const { query, queryOne } = require('./pool');
const { parseJson } = require('./shape');

function shapeFacet(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    pageType: row.page_type,
    parentSlug: row.parent_slug,
    h1: row.h1,
    title: row.title,
    introCopy: row.intro_copy,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    rules: parseJson(row.rules, {}) || {},
    canonicalPath: row.canonical_path,
    indexable: Boolean(row.indexable),
    position: row.position,
  };
}

async function findBySlug(slug) {
  const row = await queryOne('SELECT * FROM facets WHERE slug = ? LIMIT 1', [slug]);
  return shapeFacet(row);
}

/** All indexable facets — used by the sitemap and the static build. */
async function allIndexable() {
  const rows = await query(
    'SELECT * FROM facets WHERE indexable = 1 ORDER BY position ASC, slug ASC',
  );
  return rows.map(shapeFacet);
}

/** Child facets for breadcrumbs and internal linking (e.g. Toyota → Camry). */
async function childrenOf(parentSlug) {
  const rows = await query(
    'SELECT * FROM facets WHERE parent_slug = ? ORDER BY position ASC, slug ASC',
    [parentSlug],
  );
  return rows.map(shapeFacet);
}

/** Top-level facet pages for the footer / listing cross-links. */
async function topLevel(limit = 12) {
  const rows = await query(
    'SELECT * FROM facets WHERE indexable = 1 AND parent_slug IS NULL ORDER BY position ASC, slug ASC LIMIT ?',
    [String(limit)],
  );
  return rows.map(shapeFacet);
}

/** Breadcrumb trail by walking parent_slug, cheapest possible (≤ 3 levels). */
async function breadcrumbTrail(slug) {
  const trail = [];
  let current = await findBySlug(slug);
  let guard = 0;
  while (current && guard < 5) {
    trail.unshift(current);
    current = current.parentSlug ? await findBySlug(current.parentSlug) : null;
    guard += 1;
  }
  return trail;
}

module.exports = { shapeFacet, findBySlug, allIndexable, childrenOf, topLevel, breadcrumbTrail };
