#!/usr/bin/env node
'use strict';

/**
 * Push CMS page content from scripts/seed-content.js into an existing database
 * without touching anything else — the content-only counterpart of db:setup.
 *
 *   npm run db:sync-pages
 *
 * Use it after editing page copy in scripts/seed-content.js: it upserts every
 * page defined there (keyed by slug) and leaves listings, leads, accounts and
 * all other data alone. `npm run db:setup` re-seeds the full demo world; this
 * is the surgical one for a live or already-purged database.
 */

const CONTENT = require('./seed-content');
const { query, pool } = require('../src/db/pool');

const UPSERT = `
  INSERT INTO pages (slug, title, h1, hero_copy, meta_title, meta_description, body, indexable, legal_review)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    title = VALUES(title),
    h1 = VALUES(h1),
    hero_copy = VALUES(hero_copy),
    meta_title = VALUES(meta_title),
    meta_description = VALUES(meta_description),
    body = VALUES(body),
    indexable = VALUES(indexable),
    legal_review = VALUES(legal_review)
`;

async function main() {
  const entries = Object.entries(CONTENT.PAGES);
  for (const [slug, page] of entries) {
    await query(UPSERT, [
      slug,
      page.title,
      page.h1,
      page.hero || null,
      page.metaTitle,
      page.metaDescription,
      JSON.stringify(page.body || []),
      page.legal ? 0 : 1,
      page.legal ? 1 : 0,
    ]);
    console.log(`✓ /${slug}`);
  }
  await pool.end();
  console.log(`\nDone — ${entries.length} pages upserted from scripts/seed-content.js.`);
  console.log('Restart the app (or run "npm run build:static") so the new copy is served.');
}

main().catch((error) => {
  console.error(`! ${error.message}`);
  process.exit(1);
});
