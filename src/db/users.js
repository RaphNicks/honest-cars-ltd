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

const crypto = require('node:crypto');
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
    // §7.4 — 'customer' unless a staff role was granted in the console.
    role: row.role || 'customer',
    watchlisted: Boolean(row.watchlisted),
    referralCode: row.referral_code || null,
    referredBy: row.referred_by || null,
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
 * The referral code on a personal link (§7.1 “Referrals”). Readable alphabet
 * — no I/O/0/1 — because people read these aloud and type them by hand.
 */
const REFERRAL_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newReferralCode() {
  const bytes = crypto.randomBytes(7);
  let code = '';
  for (let i = 0; i < 6; i += 1) code += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  return code;
}

/** Resolve an invitation code to the account that owns it — never the inviter. */
async function findReferrer(code, excludeUserId = null) {
  const clean = String(code || '').trim().toUpperCase().slice(0, 16);
  if (!clean) return null;
  const row = await queryOne('SELECT id, status FROM `users` WHERE referral_code = ? LIMIT 1', [clean]);
  if (!row || row.status !== 'active') return null;
  if (excludeUserId && Number(row.id) === Number(excludeUserId)) return null;
  return row.id;
}

/**
 * Every successful OTP verify upserts: the first login creates the account.
 * A name supplied on the login form is only used when we do not have one.
 * A referral code is only ever recorded once, at creation.
 */
async function upsertByPhone({ phone, name = null, referralCode = null }) {
  const existing = await queryOne('SELECT * FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  if (existing) {
    await query('UPDATE `users` SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [existing.id]);
    if (!existing.name && name) {
      await query('UPDATE `users` SET name = ? WHERE id = ?', [String(name).slice(0, 120), existing.id]);
    }
    return shapeUser(await queryOne('SELECT * FROM `users` WHERE id = ? LIMIT 1', [existing.id]));
  }

  // Unique index on referral_code: retry the (unlikely) collision.
  let inserted = null;
  for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
    try {
      inserted = await query(
        'INSERT INTO `users` (phone, name, referral_code, last_seen_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
        [phone, name ? String(name).slice(0, 120) : null, newReferralCode()],
      );
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      // Either the phone (a race) or the code: only the code is worth retrying.
      const raced = await queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [phone]);
      if (raced) return shapeUser(await queryOne('SELECT * FROM `users` WHERE id = ? LIMIT 1', [raced.id]));
    }
  }
  if (!inserted) throw new Error('Could not allocate a referral code');

  const referrerId = await findReferrer(referralCode, inserted.insertId);
  if (referrerId) {
    await query('UPDATE `users` SET referred_by = ? WHERE id = ?', [referrerId, inserted.insertId]);
  }
  return findById(inserted.insertId);
}

/** Shown on the dashboard: the link, how many people used it, what they bought. */
async function referralStats(user) {
  if (!user || !user.referralCode) return null;
  const [joined] = await query(
    'SELECT COUNT(*) AS n FROM `users` WHERE referred_by = ? AND status <> ?',
    [user.id, 'deleted'],
  );
  const [ordered] = await query(
    `SELECT COUNT(DISTINCT o.id) AS n
       FROM orders o
       JOIN \`users\` u ON u.phone = o.phone
      WHERE u.referred_by = ? AND o.status <> 'cancelled'`,
    [user.id],
  );
  return {
    code: user.referralCode,
    path: `/login?ref=${user.referralCode}`,
    joined: Number(joined ? joined.n : 0),
    orders: Number(ordered ? ordered.n : 0),
  };
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
    priceDrop: Boolean(row.alert_price_drop),
    newMatch: Boolean(row.alert_new_match),
    lastAlertedAt: row.last_alerted_at,
    createdAt: row.created_at,
    url: `/cars${String(row.query || '').startsWith('?') ? row.query : row.query ? `?${row.query}` : ''}`,
  };
}

async function savedSearches(userId) {
  const rows = await query('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [userId]);
  return rows.map(shapeSearch);
}

async function addSavedSearch(userId, { label, query: queryString, alertsEnabled = true, priceDrop = true, newMatch = true }) {
  const existing = await queryOne('SELECT id FROM saved_searches WHERE user_id = ? AND query = ? LIMIT 1', [userId, queryString]);
  const master = alertsEnabled && (priceDrop || newMatch);
  if (existing) {
    await query(
      'UPDATE saved_searches SET label = ?, alerts_enabled = ?, alert_price_drop = ?, alert_new_match = ? WHERE id = ?',
      [label, master ? 1 : 0, priceDrop ? 1 : 0, newMatch ? 1 : 0, existing.id],
    );
    return shapeSearch(await queryOne('SELECT * FROM saved_searches WHERE id = ?', [existing.id]));
  }
  const result = await query(
    `INSERT INTO saved_searches (user_id, label, query, alerts_enabled, alert_price_drop, alert_new_match)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, label, queryString, master ? 1 : 0, priceDrop ? 1 : 0, newMatch ? 1 : 0],
  );
  return shapeSearch(await queryOne('SELECT * FROM saved_searches WHERE id = ?', [result.insertId]));
}

/** Toggle the alert switches. `alerts_enabled` is derived: any switch on. */
async function setSearchAlerts(userId, id, { priceDrop, newMatch } = {}) {
  const fields = [];
  const params = [];
  if (priceDrop !== undefined) {
    fields.push('alert_price_drop = ?');
    params.push(priceDrop ? 1 : 0);
  }
  if (newMatch !== undefined) {
    fields.push('alert_new_match = ?');
    params.push(newMatch ? 1 : 0);
  }
  if (!fields.length) return;
  params.push(userId, id);
  await query(`UPDATE saved_searches SET ${fields.join(', ')} WHERE user_id = ? AND id = ?`, params);
  await query(
    'UPDATE saved_searches SET alerts_enabled = (alert_price_drop OR alert_new_match) WHERE user_id = ? AND id = ?',
    [userId, id],
  );
}

async function deleteSavedSearch(userId, id) {
  await query('DELETE FROM saved_searches WHERE id = ? AND user_id = ?', [id, userId]);
}

// ---------------------------------------------------------------------------
// Dashboard reads — the public site's own records, matched by phone (§7.1)
// ---------------------------------------------------------------------------
async function dashboard(user) {
  const phone = user.phone;
  const [requests, bookings, orders, subscriptions, savedCarList, searches, referral, paymentRows, escrow] = await Promise.all([
    require('./requests').listRequestsForPhone(phone),
    require('./requests').listBookingsForPhone(phone),
    require('./commerce').listForPhone(phone),
    require('./commerce').subscriptionsForPhone(phone),
    savedCars(user.id),
    savedSearches(user.id),
    referralStats(user),
    require('./payments').listForPhone(phone, { limit: 20 }),
    require('./payments').milestonesForPhone(phone),
  ]);

  // §7.1 lists hire separately from the other requests, and the briefing
  // fields are what a customer with a booking actually wants to see.
  const hireRequests = requests.filter((request) => request.type === 'hire');

  // §7.1 “Documents” — the two things a customer actually keeps: the receipt
  // for money paid (payments, not orders, so a refund shows the refunded
  // amount) and the inspection report PDF once the checklist is filed.
  const receipts = paymentRows.map((payment) => ({
    id: `payment-${payment.id}`,
    kind: 'Receipt',
    title: `${payment.reference} — ${payment.purpose}${payment.orderNo ? ` · ${payment.orderNo}` : payment.bookingReference ? ` · ${payment.bookingReference}` : ''}`,
    amountKobo: payment.amountKobo,
    refundKobo: payment.refundKobo,
    status: payment.status,
    createdAt: payment.paidAt || payment.createdAt,
    url: `/account/receipts/${payment.reference}`,
  }));

  const reports = bookings
    .filter((booking) => booking.hasReport)
    .map((booking) => ({
      id: `report-${booking.id}`,
      kind: 'Inspection report',
      title: `${booking.reference} — ${booking.vehicle && booking.vehicle.make ? `${booking.vehicle.year} ${booking.vehicle.make} ${booking.vehicle.model}` : 'pre-purchase inspection'}`,
      amountKobo: booking.amountKobo,
      status: booking.verdictLabel || booking.verdict || booking.status,
      createdAt: booking.completedAt || booking.updatedAt || booking.slotAt,
      url: `/account/reports/${booking.reference}`,
    }));

  const documents = [...reports, ...receipts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    requests,
    hireRequests,
    bookings,
    orders,
    subscriptions,
    payments: paymentRows,
    escrow,
    receipts,
    reports,
    documents,
    savedCars: savedCarList,
    savedSearches: searches,
    referral,
    counts: {
      allRequests: requests.length,
      requests: requests.length - hireRequests.length,
      hireRequests: hireRequests.length,
      bookings: bookings.length,
      orders: orders.length,
      subscriptions: subscriptions.length,
      savedCars: savedCarList.length,
      savedSearches: searches.length,
      documents: documents.length,
      receipts: receipts.length,
      reports: reports.length,
      escrow: escrow.length,
    },
  };
}

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
      referralCode: user.referralCode,
    },
    requests: data.requests,
    hireRequests: data.hireRequests,
    bookings: data.bookings,
    orders: data.orders,
    subscriptions: data.subscriptions,
    documents: data.documents,
    referrals: data.referral,
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
  newReferralCode,
  findReferrer,
  referralStats,
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
