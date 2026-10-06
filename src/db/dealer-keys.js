'use strict';

/**
 * Dealer API keys — FR-33 (migration 023).
 *
 * A key is a credential, so the rules are short and non-negotiable:
 *
 *   • only the SHA-256 hash is stored. The plaintext leaves this module exactly
 *     once, in the response to whoever created it, and is never recoverable.
 *   • `prefix` is stored in the clear so the console can show *which* key is
 *     which without being able to use it.
 *   • revoking is a timestamp, not a delete, so the audit trail keeps saying
 *     what the key used to do.
 *   • every query is scoped to a lot. A key belongs to the lot's stock, not to
 *     the person who set it up.
 */

const { query, queryOne } = require('./pool');

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    dealerId: row.dealer_id,
    dealerName: row.dealer_name || null,
    label: row.label,
    prefix: row.prefix,
    lastUsedAt: row.last_used_at || null,
    requestCount: Number(row.request_count || 0),
    revokedAt: row.revoked_at || null,
    revokedBy: row.revoked_by || null,
    createdAt: row.created_at,
    active: !row.revoked_at,
  };
}

async function create({ dealerId, label, prefix, hash, actorId = null }) {
  const result = await query(
    `INSERT INTO dealer_api_keys (dealer_id, label, \`prefix\`, hash, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [dealerId, label, prefix, hash, actorId],
  );
  return byId(result.insertId);
}

async function byId(id) {
  return shape(await queryOne(
    `SELECT k.*, d.name AS dealer_name FROM dealer_api_keys k
       JOIN dealers d ON d.id = k.dealer_id
      WHERE k.id = ? LIMIT 1`,
    [id],
  ));
}

/** Active keys only — this is the lookup the API does on every request. */
async function byHash(hash) {
  return shape(await queryOne(
    `SELECT k.*, d.name AS dealer_name FROM dealer_api_keys k
       JOIN dealers d ON d.id = k.dealer_id
      WHERE k.hash = ? AND k.revoked_at IS NULL LIMIT 1`,
    [hash],
  ));
}

async function listFor(dealerId, { limit = 50 } = {}) {
  const rows = await query(
    `SELECT k.*, d.name AS dealer_name FROM dealer_api_keys k
       JOIN dealers d ON d.id = k.dealer_id
      WHERE k.dealer_id = ?
      ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC, k.id DESC
      LIMIT ?`,
    [dealerId, Math.min(100, limit)],
  );
  return rows.map(shape);
}

/**
 * Revoke one key. `dealerId` is optional so the console can cut off a key on a
 * lot it is looking at, but when given it is enforced — a lot can only ever
 * revoke its own.
 */
async function revoke(id, { dealerId = null, actorId = null } = {}) {
  const key = await queryOne('SELECT * FROM dealer_api_keys WHERE id = ? LIMIT 1', [id]);
  if (!key) return { ok: false, error: 'That key does not exist.' };
  if (dealerId !== null && Number(key.dealer_id) !== Number(dealerId)) {
    return { ok: false, error: 'That key is not on your lot.' };
  }
  if (key.revoked_at) {
    return { ok: true, already: true, key: await byId(id) };
  }
  await query('UPDATE dealer_api_keys SET revoked_at = UTC_TIMESTAMP(), revoked_by = ? WHERE id = ?', [actorId, id]);
  return { ok: true, key: await byId(id) };
}

/** A request arrived: record when, and how many. Never fatal to the request. */
async function touch(id) {
  await query(
    'UPDATE dealer_api_keys SET last_used_at = UTC_TIMESTAMP(), request_count = request_count + 1 WHERE id = ?',
    [id],
  ).catch(() => {});
}

module.exports = { shape, create, byId, byHash, listFor, revoke, touch };
