'use strict';

/**
 * Dealer API credentials — FR-33, the “API key per lot” half.
 *
 * Kept apart from `services/imports.js` (which knows what a listing is) so the
 * credential rules stay readable on their own: generate, hash, hand back the
 * plaintext once, and never again.
 */

const crypto = require('node:crypto');
const db = require('../db');

/** `hc_live_` + 32 hex characters. The prefix is what the console displays. */
const KEY_PREFIX = 'hc_live_';
const KEY_BYTES = 16;

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * Issue a key for a lot. The plaintext is returned exactly once and is not
 * retrievable afterwards — a dealer who loses it revokes it and makes another.
 */
async function issue(dealerId, { label, actorId = null } = {}) {
  const clean = String(label || '').trim().slice(0, 80) || 'Integration';
  const key = `${KEY_PREFIX}${crypto.randomBytes(KEY_BYTES).toString('hex')}`;
  const row = await db.dealerKeys.create({
    dealerId,
    label: clean,
    prefix: key.slice(0, 12),
    hash: hashKey(key),
    actorId,
  });
  return { ok: true, key, keyInfo: row };
}

function keysFor(dealerId, options = {}) {
  return db.dealerKeys.listFor(dealerId, options);
}

async function revoke(dealerId, keyId, { actorId = null } = {}) {
  const result = await db.dealerKeys.revoke(Number(keyId), { dealerId, actorId });
  if (result.ok && actorId && !result.already) {
    await db.admin
      .recordAudit({ actorId, action: 'dealer.api_key.revoked', entity: 'dealer_api_key', entityId: Number(keyId), detail: { dealerId } })
      .catch(() => {});
  }
  return result;
}

/**
 * Resolve the `x-api-key` header to a lot. Every failure mode is a sentence,
 * because this is the one endpoint a developer hits without a browser and the
 * response body is the only documentation they will read.
 */
async function fromRequest(req) {
  const raw = req.get('x-api-key') || req.get('X-API-Key') || '';
  const key = String(raw).trim();
  if (!key) {
    return { ok: false, status: 401, error: 'Send the key in an x-api-key header.' };
  }
  if (!key.startsWith(KEY_PREFIX)) {
    return { ok: false, status: 401, error: `That does not look like a HonestCars key — they begin ${KEY_PREFIX}.` };
  }
  const row = await db.dealerKeys.byHash(hashKey(key));
  if (!row) {
    return { ok: false, status: 401, error: 'That key is not recognised, or it has been revoked.' };
  }
  await db.dealerKeys.touch(row.id);
  const lot = await db.dealers.byId(row.dealerId);
  if (!lot) {
    return { ok: false, status: 401, error: 'That key belongs to a lot that no longer exists.' };
  }
  return { ok: true, key: row, lot };
}

module.exports = { KEY_PREFIX, hashKey, issue, keysFor, revoke, fromRequest };
