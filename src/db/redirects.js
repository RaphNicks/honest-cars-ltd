'use strict';

/**
 * 301 map. The sold-archive hand-off (§14.1) and any legacy Next.js URL that
 * needs to keep its equity.
 */

const { query, queryOne } = require('./pool');

async function findByPath(fromPath) {
  const row = await queryOne('SELECT from_path, to_path, status_code FROM redirects WHERE from_path = ? LIMIT 1', [fromPath]);
  if (!row) return null;
  return { from: row.from_path, to: row.to_path, statusCode: Number(row.status_code) };
}

async function all() {
  return query('SELECT from_path, to_path, status_code, reason FROM redirects ORDER BY id ASC');
}

/** Materialise a 90-day hand-off so it survives restarts and is auditable. */
async function upsert(fromPath, toPath, reason = 'sold_archive_90_days') {
  await query(
    `INSERT INTO redirects (from_path, to_path, status_code, reason)
     VALUES (?, ?, 301, ?)
     ON DUPLICATE KEY UPDATE to_path = VALUES(to_path), reason = VALUES(reason)`,
    [fromPath, toPath, reason],
  );
}

module.exports = { findByPath, all, upsert };
