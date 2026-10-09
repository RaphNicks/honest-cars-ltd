'use strict';

/**
 * Stored settings — §5.1's settings screen (migration 027).
 *
 * One table, one row per setting the desk has changed. A setting nobody has
 * touched has **no row**: the default lives in `src/lib/settings-schema.js` and
 * the environment, which is why a fresh install with an empty table behaves
 * exactly like the site did before this screen existed, and why "Reset to
 * default" is a DELETE rather than a second copy of the default written into the
 * database where it can drift.
 *
 * There is no database-level constraint that a key is one the registry knows:
 * the schema is code, and duplicating the list in SQL would be a second place to
 * update. The loader ignores unknown keys and reports them instead — and the
 * console only ever writes keys that came from the registry.
 */

const { query, queryOne, transaction } = require('./pool');

/** Every override, oldest first — the order the settings page was built in. */
async function all() {
  return query('SELECT setting_key, setting_value, updated_by, updated_at FROM settings ORDER BY setting_key');
}

/** One override, or null. */
async function get(key) {
  const row = await queryOne('SELECT setting_key, setting_value, updated_by, updated_at FROM settings WHERE setting_key = ? LIMIT 1', [key]);
  return row || null;
}

/**
 * Write a batch of settings in one transaction.
 *
 * The console saves a whole group at once, and half a group applied is worse
 * than nothing applied: a retainer changed without its hours would bill the new
 * price against the old promise. `entries` is `[{ key, value }]`, already
 * validated by the service.
 */
async function save(entries, { actorId = null } = {}) {
  if (!entries.length) return [];
  return transaction(async (conn) => {
    for (const entry of entries) {
      // One statement per key, inside one transaction: a group that half-applied
      // would bill a new retainer against the old promise.
      await conn.query(
        `INSERT INTO settings (setting_key, setting_value, updated_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
        [entry.key, String(entry.value), actorId],
      );
    }
    return entries.map((entry) => entry.key);
  });
}

/** Reset back to the registry default — the row goes, the default comes back. */
async function remove(keys) {
  if (!keys.length) return 0;
  const marks = keys.map(() => '?').join(', ');
  const result = await query(`DELETE FROM settings WHERE setting_key IN (${marks})`, keys);
  return result.affectedRows || 0;
}

module.exports = { all, get, save, remove };
