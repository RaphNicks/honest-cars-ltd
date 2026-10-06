'use strict';

/**
 * Human-readable reference ids — HC-2481, HC-BK-0001, HC-ORD-0001.
 *
 * These are shown to customers and printed in WhatsApp hand-offs, so they have
 * to be unique and gap-tolerant (§6.5 tracking ids, §6.8 orders). Two rules:
 *
 *   1. the MAX() read is a locking read (`FOR UPDATE`) so two concurrent
 *      submissions can never compute the same next number;
 *   2. every insert still retries on a duplicate-key error, because the real
 *      guard is the UNIQUE index in MySQL, not our arithmetic.
 *
 * Table and column names come from a frozen allowlist — never from a caller —
 * so building the statement by interpolation is safe here.
 */

const SPECS = Object.freeze({
  request: { table: 'service_requests', column: 'tracking_id', prefix: 'HC-', pad: 0, floor: 2481 },
  booking: { table: 'bookings', column: 'reference', prefix: 'HC-BK-', pad: 4, floor: 1 },
  order: { table: 'orders', column: 'order_no', prefix: 'HC-ORD-', pad: 4, floor: 1 },
  hire: { table: 'hire_bookings', column: 'reference', prefix: 'HC-HIRE-', pad: 4, floor: 1 },
  addon: { table: 'dealer_purchases', column: 'reference', prefix: 'HC-ADD-', pad: 4, floor: 1 },
});

/** Next unused reference for a key in SPECS. Must be called inside a transaction. */
async function nextId(conn, key) {
  const spec = SPECS[key];
  if (!spec) throw new Error(`Unknown reference series: ${key}`);
  const { table, column, prefix, pad, floor } = spec;

  const [rows] = await conn.query(
    `SELECT ${column} AS ref FROM ${table}
      WHERE ${column} LIKE ?
      ORDER BY CAST(SUBSTRING(${column}, ${prefix.length + 1}) AS UNSIGNED) DESC
      LIMIT 1
      FOR UPDATE`,
    [`${prefix}%`],
  );

  const last = rows[0] ? Number.parseInt(String(rows[0].ref).slice(prefix.length), 10) : 0;
  const next = Math.max(floor, (Number.isFinite(last) ? last : 0) + 1);
  return `${prefix}${pad ? String(next).padStart(pad, '0') : next}`;
}

function isDuplicate(error) {
  return Boolean(error) && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);
}

/**
 * Run `work()` until it stops colliding with an existing reference.
 * `work` is expected to perform its own transaction.
 */
async function uniqueRetry(work, { attempts = 5 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      lastError = error;
      // Jittered backoff keeps two colliding writers from re-syncing.
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1) + Math.floor(Math.random() * 25)));
    }
  }
  throw lastError;
}

/**
 * The series key for a table that already has a row in SPECS, or null.
 * `hire.js` and `addons.js` both want “the next HC-x reference” without each
 * re-implementing the transaction dance.
 */
function seriesFor(key) {
  return SPECS[key] || null;
}

/**
 * Convenience for callers that are not already inside a transaction: opens one,
 * takes the next id, and commits. Callers that *are* transacting (the payment
 * seam) pass their own connection to `nextId` instead.
 */
async function next(key, { conn = null } = {}) {
  const { nextId: take, uniqueRetry: retry } = module.exports;
  if (conn) return take(conn, key);
  const pool = require('./pool');
  return retry(async () => pool.transaction((tx) => take(tx, key)));
}

module.exports = { SPECS, nextId, next, seriesFor, isDuplicate, uniqueRetry };
