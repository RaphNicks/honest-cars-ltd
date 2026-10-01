'use strict';

/**
 * Accounts — §7.1. Phone-first: the phone number is the account key, the
 * email is optional, and everything else in the dashboard (requests, bookings,
 * orders, subscriptions) is read straight off the tables the public site
 * already writes, matched by phone.
 *
 * Nothing in here sees a raw OTP or a raw session token: the service layer
 * hashes both before they reach this module, and the database only ever stores
 * the hash plus an expiry.
 */

const { query, queryOne, transaction } = require('./pool');

const USER_STATUSES = ['active', 'blocked', 'deleted'];

function shapeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    name: row.name || null,
    email: row.email || null,
    marketingOptIn: Boolean(row.marketing_opt_in),
    status: row.status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    // What the header shows — never render a full phone number back at the user.
    shortName: row.name ? String(row.name).split(/\s+/)[0] : 'Account',
    maskedPhone: maskPhone(row.phone),
  };
}

/** +2348031234567 → +234 803 ••• 4567 (log-safe, page-safe). */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return '•••';
  return `${phone.startsWith('+') ? '+' : ''}${digits.slice(0, 3)} ${digits.slice(3, 6)} ••• ${digits.slice(-4)}`;
}

async function findByPhone(phone) {
  return shapeUser(await queryOne('SELECT * FROM `users` WHERE phone = ? LIMIT 1', [phone]));
}

async function findById(id) {
  return shapeUser(await queryOne('SELECT * FROM `users` WHERE id = ? LIMIT 1', [id]));
}

/**
 * Every successful OTP verify upserts: the first login creates the account.
 * A name supplied on the login form is only used when we do not have one.
 */
async function upsertByPhone({ phone, name = null }) {
  const existing = await queryOne('SELECT * FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  if (existing) {
    await query('UPDATE `users` SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [existing.id]);
    if (!existing.name && name) {
      await query('UPDATE `users` SET name = ? WHERE id = ?', [String(name).slice(0, 120), existing.id]);
    }
    return shapeUser(await queryOne('SELECT * FROM `users` WHERE id = ? LIMIT 1', [existing.id]));
  }

  const result = await query(
    'INSERT INTO `users` (phone, name, last_seen_at) VALUES (?, ?, UTC_TIMESTAMP())',
    [phone, name ? String(name).slice(0, 120) : null],
  );
  return findById(result.insertId);
}

async function updateProfile(userId, { name, email, marketingOptIn }) {
  const fields = [];
  const params = [];
  if (name !== undefined) {
    fields.push('name = ?');
    params.push(name ? String(name).trim().slice(0, 120) : null);
  }
  if (email !== undefined) {
    fields.push('email = ?');
    params.push(email ? String(email).trim().toLowerCase().slice(0, 160) : null);
  }
  if (marketingOptIn !== undefined) {
    fields.push('marketing_opt_in = ?');
    params.push(marketingOptIn ? 1 : 0);
  }
  if (fields.length) {
    params.push(userId);
    await query(`UPDATE \`users\` SET ${fields.join(', ')} WHERE id = ?`, params);
  }
  return findById(userId);
}

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------
async function createCode({ phone, codeHash, channel, expiresAt, ip, maxAttempts }) {
  // A new code supersedes any live one for the same phone.
  await query('UPDATE `auth_codes` SET consumed_at = UTC_TIMESTAMP() WHERE phone = ? AND consumed_at IS NULL', [phone]);
  const result = await query(
    `INSERT INTO auth_codes (phone, code_hash, channel, expires_at, ip, max_attempts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [phone, codeHash, channel, expiresAt, ip || null, maxAttempts],
  );
  return result.insertId;
}

async function findActiveCode(phone) {
  const row = await queryOne(
    `SELECT * FROM auth_codes
      WHERE phone = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP()
      ORDER BY id DESC LIMIT 1`,
    [phone],
  );
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    codeHash: row.code_hash,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    expiresAt: row.expires_at,
    channel: row.channel,
  };
}

async function registerAttempt(codeId) {
  await query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?', [codeId]);
  return (await queryOne('SELECT attempts FROM auth_codes WHERE id = ?', [codeId])).attempts;
}

async function consumeCode(codeId) {
  await query('UPDATE auth_codes SET consumed_at = UTC_TIMESTAMP() WHERE id = ?', [codeId]);
}

/** Requests in the last hour — the per-phone rate limit (§12.2). */
async function countRecentCodes(phone, { withinMinutes = 60 } = {}) {
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM auth_codes
      WHERE phone = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [phone, withinMinutes],
  );
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function createSession({ userId, tokenHash, expiresAt, ip, userAgent }) {
  await query(
    'INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
    [userId, tokenHash, expiresAt, ip || null, userAgent ? String(userAgent).slice(0, 200) : null],
  );
}

/** Returns the session + its user, or null when missing/expired/revoked. */
async function findSession(tokenHash) {
  const row = await queryOne(
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at, u.*
       FROM sessions s
       JOIN \`users\` u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
      LIMIT 1`,
    [tokenHash],
  );
  if (!row) return null;
  return { sessionId: row.session_id, expiresAt: row.expires_at, user: shapeUser(row) };
}

async function revokeSession(tokenHash) {
  await query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND revoked_at IS NULL', [tokenHash]);
}

async function revokeAllForUser(userId) {
  await query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

/** Housekeeping: drop expired/revoked rows older than a day. */
async function pruneSessions() {
  const result = await query(
    'DELETE FROM sessions WHERE (expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) OR revoked_at IS NOT NULL) AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)',
  );
  return result.affectedRows || 0;
}

// ---------------------------------------------------------------------------
// Saved cars & searches
// ---------------------------------------------------------------------------
async function savedCarIds(userId) {
  const rows = await query('SELECT listing_id FROM saved_cars WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map((row) => Number(row.listing_id));
}

async function savedCars(userId) {
  const rows = await query(
    `SELECT s.listing_id, s.note, s.created_at AS saved_at
       FROM saved_cars s
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC`,
    [userId],
  );
  if (!rows.length) return [];

  const ids = rows.map((row) => Number(row.listing_id));
  const listings = await require('./listings').byIds(ids, { limit: 60 });
  const byId = new Map(listings.map((listing) => [listing.id, listing]));

  return rows
    .map((row) => {
      const listing = byId.get(Number(row.listing_id));
      return listing ? { ...listing, savedAt: row.saved_at, note: row.note || null } : null;
    })
    .filter(Boolean);
}

async function addSavedCar(userId, listingId, note = null) {
  await query(
    `INSERT INTO saved_cars (user_id, listing_id, note) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE note = VALUES(note)`,
    [userId, listingId, note ? String(note).slice(0, 200) : null],
  );
  return savedCarIds(userId);
}

async function removeSavedCar(userId, listingId) {
  await query('DELETE FROM saved_cars WHERE user_id = ? AND listing_id = ?', [userId, listingId]);
  return savedCarIds(userId);
}

async function isSaved(userId, listingId) {
  const row = await queryOne('SELECT id FROM saved_cars WHERE user_id = ? AND listing_id = ? LIMIT 1', [userId, listingId]);
  return Boolean(row);
}

function shapeSearch(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    query: row.query,
    alertsEnabled: Boolean(row.alerts_enabled),
    lastAlertedAt: row.last_alerted_at,
    createdAt: row.created_at,
    url: `/cars${String(row.query || '').startsWith('?') ? row.query : row.query ? `?${row.query}` : ''}`,
  };
}

async function savedSearches(userId) {
  const rows = await query('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [userId]);
  return rows.map(shapeSearch);
}

async function addSavedSearch(userId, { label, query: queryString, alertsEnabled = true }) {
  const existing = await queryOne('SELECT id FROM saved_searches WHERE user_id = ? AND query = ? LIMIT 1', [userId, queryString]);
  if (existing) {
    await query('UPDATE saved_searches SET label = ?, alerts_enabled = ? WHERE id = ?', [label, alertsEnabled ? 1 : 0, existing.id]);
    return shapeSearch(await queryOne('SELECT * FROM saved_searches WHERE id = ?', [existing.id]));
  }
  const result = await query(
    'INSERT INTO saved_searches (user_id, label, query, alerts_enabled) VALUES (?, ?, ?, ?)',
    [userId, label, queryString, alertsEnabled ? 1 : 0],
  );
  return shapeSearch(await queryOne('SELECT * FROM saved_searches WHERE id = ?', [result.insertId]));
}

async function setSearchAlerts(userId, id, enabled) {
  await query('UPDATE saved_searches SET alerts_enabled = ? WHERE id = ? AND user_id = ?', [enabled ? 1 : 0, id, userId]);
}

async function deleteSavedSearch(userId, id) {
  await query('DELETE FROM saved_searches WHERE id = ? AND user_id = ?', [id, userId]);
}

// ---------------------------------------------------------------------------
// Dashboard reads — the public site's own records, matched by phone (§7.1)
// ---------------------------------------------------------------------------
async function dashboard(user) {
  const phone = user.phone;
  const [requests, bookings, orders, subscriptions, savedCarList, searches] = await Promise.all([
    require('./requests').listRequestsForPhone(phone),
    require('./requests').listBookingsForPhone(phone),
    require('./commerce').listForPhone(phone),
    require('./commerce').subscriptionsForPhone(phone),
    savedCars(user.id),
    savedSearches(user.id),
  ]);

  return {
    requests,
    bookings,
    orders,
    subscriptions,
    savedCars: savedCarList,
    savedSearches: searches,
    hireRequests: requests.filter((request) => request.type === 'hire'),
    counts: {
      requests: requests.length,
      bookings: bookings.length,
      orders: orders.length,
      subscriptions: subscriptions.length,
      savedCars: savedCarList.length,
      savedSearches: searches.length,
    },
  };
}

/** NDPA right of access — everything we hold, as one JSON object. */
async function exportData(userId) {
  const user = await findById(userId);
  if (!user) return null;
  const data = await dashboard(user);
  return {
    exportedAt: new Date().toISOString(),
    account: {
      phone: user.phone,
      name: user.name,
      email: user.email,
      marketingOptIn: user.marketingOptIn,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
    },
    requests: data.requests,
    bookings: data.bookings,
    orders: data.orders,
    subscriptions: data.subscriptions,
    savedCars: data.savedCars.map((listing) => ({ id: listing.id, title: listing.title, url: listing.url, status: listing.status })),
    savedSearches: data.savedSearches,
    note: 'This export covers everything keyed to your phone number on honestcarsltd.com. Analytics events carry no personal data.',
  };
}

/**
 * NDPA right to erasure. The account row and its cascades go; the operational
 * records (requests, bookings, orders, leads) are anonymised rather than
 * deleted, because finance and warranty need the transaction history to
 * survive without the person attached to it.
 */
async function deleteAccount(userId) {
  const user = await findById(userId);
  if (!user) return false;
  const redacted = `DELETED-${user.id}`;

  await transaction(async (conn) => {
    for (const table of ['service_requests', 'bookings', 'orders', 'leads']) {
      await conn.query(
        `UPDATE ${table} SET phone = ?, name = 'Deleted account' WHERE phone = ?`,
        [redacted, user.phone],
      );
    }
    await conn.query('DELETE FROM `users` WHERE id = ?', [user.id]);
  });
  return true;
}

module.exports = {
  USER_STATUSES,
  maskPhone,
  shapeUser,
  findByPhone,
  findById,
  upsertByPhone,
  updateProfile,
  createCode,
  findActiveCode,
  registerAttempt,
  consumeCode,
  countRecentCodes,
  createSession,
  findSession,
  revokeSession,
  revokeAllForUser,
  pruneSessions,
  savedCarIds,
  savedCars,
  addSavedCar,
  removeSavedCar,
  isSaved,
  savedSearches,
  addSavedSearch,
  setSearchAlerts,
  deleteSavedSearch,
  dashboard,
  exportData,
  deleteAccount,
};
