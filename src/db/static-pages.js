'use strict';

/**
 * Build bookkeeping for the hybrid renderer. Every static page we write is
 * recorded here so ops can see what was generated, when, and from which view.
 */

const { query } = require('./pool');

async function record(entries) {
  if (!entries || !entries.length) return;
  // One statement per row keeps this portable between MySQL 5.7 and MariaDB
  // (no multi-row upsert with UNKNOWN values) and the build is not hot-path.
  for (const entry of entries) {
    await query(
      `INSERT INTO static_pages (path, view, content_hash, bytes, rendered_at, status)
       VALUES (?, ?, ?, ?, ?, 'ok')
       ON DUPLICATE KEY UPDATE
         view = VALUES(view), content_hash = VALUES(content_hash),
         bytes = VALUES(bytes), rendered_at = VALUES(rendered_at), status = 'ok'`,
      [entry.path, entry.view, entry.hash, entry.bytes, new Date(entry.renderedAt)],
    );
  }
}

async function all() {
  return query('SELECT path, view, bytes, rendered_at FROM static_pages ORDER BY path');
}

module.exports = { record, all };
