'use strict';

/**
 * Accounts — verified customer email identities with legacy phone sign-in.
 * A login phone remains on `users.phone`; a contact number is stored separately
 * in `users.contact_phone` and never grants access to phone-keyed history. Email
 * credentials are kept in `user_email_identities`, separate from legacy profile
 * emails that have not been verified.
 *
 * Nothing in here sees a raw OTP or a raw session token: the service layer
 * hashes both before they reach this module, and the database only ever stores
 * the hash plus an expiry.
 */

const crypto = require('node:crypto');
const { query, queryOne, transaction } = require('./pool');
const phones = require('../lib/phone');

const USER_STATUSES = ['active', 'blocked', 'deleted'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normaliseEmail(email) {
  const address = String(email || '').trim().toLowerCase();
  if (address.length > 160 || !EMAIL_PATTERN.test(address)) return null;
  return address;
}

function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function shapeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone || null,
    contactPhone: row.contact_phone || null,
    name: row.name || null,
    email: row.email || null,
    emailVerified: Boolean(row.email_verified_at),
    emailVerifiedAt: row.email_verified_at || null,
    googleLinked: Boolean(row.google_linked),
    marketingOptIn: Boolean(row.marketing_opt_in),
    status: row.status,
    // §7.4 — 'customer' unless a staff role was granted in the console.
    role: row.role || 'customer',
    watchlisted: Boolean(row.watchlisted),
    referralCode: row.referral_code || null,
    referredBy: row.referred_by || null,
    // FR-28: when the referral started to count, and the desk's note on it.
    referralQualifiedAt: row.referral_qualified_at || null,
    referralNote: row.referral_note || null,
    // §12.2: never the secret itself — only whether a *confirmed* factor exists,
    // so a half-finished enrolment reads as unprotected everywhere.
    mfaEnrolled: Boolean(row.totp_confirmed_at),
    mfaPending: Boolean(row.totp_secret) && !row.totp_confirmed_at,
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

const USER_SELECT = `SELECT u.*, ei.verified_at AS email_verified_at,
                              EXISTS (SELECT 1 FROM user_email_identities gi
                                       WHERE gi.user_id = u.id AND gi.google_subject IS NOT NULL) AS google_linked
                         FROM \`users\` u
                         LEFT JOIN user_email_identities ei
                           ON ei.user_id = u.id AND ei.email = u.email`;

async function findByPhone(phone) {
  return shapeUser(await queryOne(`${USER_SELECT} WHERE u.phone = ? LIMIT 1`, [phone]));
}

async function findById(id) {
  return shapeUser(await queryOne(`${USER_SELECT} WHERE u.id = ? LIMIT 1`, [id]));
}

async function findByVerifiedEmail(email) {
  const address = normaliseEmail(email);
  if (!address) return null;
  const row = await queryOne(
    `SELECT u.*, ei.verified_at AS email_verified_at, ei.email AS authenticated_email,
            EXISTS (SELECT 1 FROM user_email_identities gi WHERE gi.user_id = u.id AND gi.google_subject IS NOT NULL) AS google_linked
       FROM user_email_identities ei
       JOIN \`users\` u ON u.id = ei.user_id
      WHERE ei.email = ? LIMIT 1`,
    [address],
  );
  return shapeUser(row);
}

async function findByGoogleSubject(subject) {
  const googleSubject = String(subject || '').trim().slice(0, 255);
  if (!googleSubject) return null;
  const row = await queryOne(
    `SELECT u.*, ei.verified_at AS email_verified_at, ei.email AS authenticated_email, 1 AS google_linked
       FROM user_email_identities ei
       JOIN \`users\` u ON u.id = ei.user_id
      WHERE ei.google_subject = ? LIMIT 1`,
    [googleSubject],
  );
  return shapeUser(row);
}

async function findLegacyEmailOwner(email) {
  const address = normaliseEmail(email);
  if (!address) return null;
  return queryOne(
    `SELECT u.id, u.role, u.status
       FROM \`users\` u
      WHERE u.email = ? AND u.status <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM user_email_identities ei
           WHERE ei.user_id = u.id AND ei.email = u.email
        )
      ORDER BY u.id LIMIT 1`,
    [address],
  );
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
    return findById(existing.id);
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
      if (raced) return findById(raced.id);
    }
  }
  if (!inserted) throw new Error('Could not allocate a referral code');

  const referrerId = await findReferrer(referralCode, inserted.insertId);
  if (referrerId) {
    await query('UPDATE `users` SET referred_by = ? WHERE id = ?', [referrerId, inserted.insertId]);
  }
  return findById(inserted.insertId);
}

/** Create a new customer after an email or Google identity has been verified. */
async function createEmailAccount({ email, name, referralCode = null, googleSubject = null }) {
  const address = normaliseEmail(email);
  if (!address) throw identityError('INVALID_EMAIL', 'Enter a valid email address.');
  const cleanName = String(name || '').trim().slice(0, 120);
  if (cleanName.length < 2) throw identityError('NAME_REQUIRED', 'Tell us your name to open an account.');
  const subject = String(googleSubject || '').trim().slice(0, 255) || null;

  const userId = await transaction(async (conn) => {
    const [emailRows] = await conn.query(
      'SELECT user_id FROM user_email_identities WHERE email = ? LIMIT 1 FOR UPDATE',
      [address],
    );
    if (emailRows.length) throw identityError('EMAIL_IDENTITY_EXISTS', 'That verified email is already linked to an account.');

    if (subject) {
      const [subjectRows] = await conn.query(
        'SELECT user_id FROM user_email_identities WHERE google_subject = ? LIMIT 1 FOR UPDATE',
        [subject],
      );
      if (subjectRows.length) throw identityError('GOOGLE_IDENTITY_EXISTS', 'That Google account is already linked.');
    }

    // An older profile email is not proof of ownership. The person must sign in
    // to that phone account and verify the address there instead of creating a
    // duplicate or inheriting its phone-keyed history.
    const [legacyRows] = await conn.query(
      "SELECT id FROM `users` WHERE email = ? AND status <> 'deleted' ORDER BY id LIMIT 1 FOR UPDATE",
      [address],
    );
    if (legacyRows.length) {
      throw identityError('LEGACY_EMAIL_REQUIRES_PHONE_LINK', 'Sign in to your existing phone account first, then verify this email from your account.');
    }

    let inserted = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
      try {
        const [result] = await conn.query(
          'INSERT INTO `users` (phone, name, email, referral_code, last_seen_at) VALUES (NULL, ?, ?, ?, UTC_TIMESTAMP())',
          [cleanName, address, newReferralCode()],
        );
        inserted = result;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
      }
    }
    if (!inserted) throw new Error('Could not allocate a referral code');

    await conn.query(
      'INSERT INTO user_email_identities (user_id, email, google_subject, verified_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
      [inserted.insertId, address, subject],
    );

    const cleanReferral = String(referralCode || '').trim().toUpperCase().slice(0, 16);
    if (cleanReferral) {
      const [referrers] = await conn.query(
        "SELECT id FROM `users` WHERE referral_code = ? AND status = 'active' LIMIT 1",
        [cleanReferral],
      );
      if (referrers.length && Number(referrers[0].id) !== Number(inserted.insertId)) {
        await conn.query('UPDATE `users` SET referred_by = ? WHERE id = ?', [referrers[0].id, inserted.insertId]);
      }
    }
    return inserted.insertId;
  });

  return findById(userId);
}

/**
 * Link a verified email to the account that is already authenticated. This is
 * the only path that can connect an unverified legacy profile email to its old
 * phone-keyed account.
 */
async function linkVerifiedEmail(userId, email, { googleSubject = null } = {}) {
  const address = normaliseEmail(email);
  if (!address) throw identityError('INVALID_EMAIL', 'Enter a valid email address.');
  const subject = String(googleSubject || '').trim().slice(0, 255) || null;

  await transaction(async (conn) => {
    const [users] = await conn.query(
      'SELECT id, role, status FROM `users` WHERE id = ? LIMIT 1 FOR UPDATE',
      [userId],
    );
    const account = users[0];
    if (!account) throw identityError('ACCOUNT_NOT_FOUND', 'That account no longer exists.');
    if (account.role !== 'customer') throw identityError('CUSTOMER_ONLY', 'This sign-in method is for customer accounts.');
    if (account.status !== 'active') throw identityError('ACCOUNT_NOT_ACTIVE', 'That account cannot be linked right now.');

    const [emailRows] = await conn.query(
      'SELECT id, user_id, google_subject FROM user_email_identities WHERE email = ? LIMIT 1 FOR UPDATE',
      [address],
    );
    const emailIdentity = emailRows[0] || null;
    if (emailIdentity && Number(emailIdentity.user_id) !== Number(userId)) {
      throw identityError('EMAIL_IN_USE', 'That verified email is already linked to another account.');
    }

    const [legacyOwners] = await conn.query(
      "SELECT id FROM `users` WHERE email = ? AND id <> ? AND status <> 'deleted' ORDER BY id LIMIT 1 FOR UPDATE",
      [address, userId],
    );
    if (legacyOwners.length) {
      throw identityError(
        'LEGACY_EMAIL_REQUIRES_PHONE_LINK',
        'That email is on an existing phone account. Sign in to that account before linking it.',
      );
    }

    let subjectIdentity = null;
    if (subject) {
      const [subjectRows] = await conn.query(
        'SELECT id, user_id, email FROM user_email_identities WHERE google_subject = ? LIMIT 1 FOR UPDATE',
        [subject],
      );
      subjectIdentity = subjectRows[0] || null;
      if (subjectIdentity && (Number(subjectIdentity.user_id) !== Number(userId) || subjectIdentity.email !== address)) {
        throw identityError('GOOGLE_IDENTITY_IN_USE', 'That Google account is already linked.');
      }
    }

    if (emailIdentity) {
      if (subject && emailIdentity.google_subject && emailIdentity.google_subject !== subject) {
        throw identityError('GOOGLE_IDENTITY_IN_USE', 'A different Google account is already linked to this email.');
      }
      if (subject && !emailIdentity.google_subject) {
        await conn.query('UPDATE user_email_identities SET google_subject = ? WHERE id = ?', [subject, emailIdentity.id]);
      }
    } else {
      await conn.query(
        'INSERT INTO user_email_identities (user_id, email, google_subject, verified_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
        [userId, address, subject],
      );
    }

    // The profile displays the most recently verified address; older verified
    // addresses stay attached and remain usable for sign-in.
    await conn.query('UPDATE `users` SET email = ? WHERE id = ?', [address, userId]);
  });

  return findById(userId);
}

/**
 * Shown on the dashboard: the link, how many people used it, what they bought,
 * and — FR-28 — whether it counted and where the reward is.
 *
 * The whole tally comes from `db.referrals.listForReferrer`, so the card, the
 * console and the reward queue can never disagree about the same person. It
 * stays here because §7.1 calls it a dashboard card and exportData reads it.
 */
async function referralStats(user) {
  if (!user || !user.referralCode) return null;
  const referrals = require('./referrals');
  const people = await referrals.listForReferrer(user.id);
  const counts = referrals.tally(people);
  return {
    code: user.referralCode,
    path: `/login?ref=${user.referralCode}`,
    joined: counts.joined,
    orders: counts.orders,
    qualified: counts.qualified,
    pending: counts.pending,
    approved: counts.approved,
    paid: counts.paid,
    voided: counts.voided,
    approvedKobo: counts.approvedKobo,
    paidKobo: counts.paidKobo,
    note: user.referralNote || null,
    qualifiedAt: user.referralQualifiedAt || null,
    people,
  };
}

async function updateContactPhone(userId, phone) {
  const contact = phone ? phones.canonical(phone, { fallback: '' }) : null;
  await query('UPDATE `users` SET contact_phone = ? WHERE id = ?', [contact, userId]);
  return findById(userId);
}

async function touchUser(userId) {
  await query('UPDATE `users` SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [userId]);
  return findById(userId);
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

const EMAIL_CODE_PURPOSES = ['sign_in', 'link'];

async function createEmailCode({ email, purpose = 'sign_in', userId = null, codeHash, expiresAt, ip, maxAttempts }) {
  const address = normaliseEmail(email);
  if (!address) throw identityError('INVALID_EMAIL', 'Enter a valid email address.');
  if (!EMAIL_CODE_PURPOSES.includes(purpose)) throw identityError('INVALID_EMAIL_CODE_PURPOSE', 'That email code request is not valid.');
  const ownerId = purpose === 'link' ? Number(userId) || 0 : null;
  if (purpose === 'link' && !ownerId) throw identityError('EMAIL_CODE_OWNER_REQUIRED', 'Sign in again before linking an email.');
  await query(
    'UPDATE email_auth_codes SET consumed_at = UTC_TIMESTAMP() WHERE email = ? AND purpose = ? AND user_id <=> ? AND consumed_at IS NULL',
    [address, purpose, ownerId],
  );
  const result = await query(
    `INSERT INTO email_auth_codes (email, purpose, user_id, code_hash, expires_at, ip, max_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [address, purpose, ownerId, codeHash, expiresAt, ip || null, maxAttempts],
  );
  return result.insertId;
}

async function findActiveEmailCode(email, purpose = 'sign_in', userId = null) {
  const address = normaliseEmail(email);
  if (!address || !EMAIL_CODE_PURPOSES.includes(purpose)) return null;
  const ownerId = purpose === 'link' ? Number(userId) || 0 : null;
  if (purpose === 'link' && !ownerId) return null;
  const row = await queryOne(
    `SELECT * FROM email_auth_codes
      WHERE email = ? AND purpose = ? AND user_id <=> ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP()
      ORDER BY id DESC LIMIT 1`,
    [address, purpose, ownerId],
  );
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    purpose: row.purpose,
    userId: row.user_id,
    codeHash: row.code_hash,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    expiresAt: row.expires_at,
  };
}

async function registerEmailAttempt(codeId) {
  await query('UPDATE email_auth_codes SET attempts = attempts + 1 WHERE id = ?', [codeId]);
  const row = await queryOne('SELECT attempts FROM email_auth_codes WHERE id = ?', [codeId]);
  return row ? Number(row.attempts) : 1;
}

async function consumeEmailCode(codeId) {
  await query('UPDATE email_auth_codes SET consumed_at = UTC_TIMESTAMP() WHERE id = ?', [codeId]);
}

async function countRecentEmailCodes(email, purpose = 'sign_in', userId = null, { withinMinutes = 60 } = {}) {
  const address = normaliseEmail(email);
  if (!address || !EMAIL_CODE_PURPOSES.includes(purpose)) return 0;
  void userId; // rate-limit across account ids so link requests cannot bypass the per-address cap
  const row = await queryOne(
    `SELECT COUNT(*) AS n FROM email_auth_codes
      WHERE email = ? AND purpose = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)`,
    [address, purpose, withinMinutes],
  );
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
async function createSession({ userId, tokenHash, expiresAt, ip, userAgent, mfaPending = false }) {
  await query(
    'INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, mfa_pending) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, tokenHash, expiresAt, ip || null, userAgent ? String(userAgent).slice(0, 200) : null, mfaPending ? 1 : 0],
  );
}

/**
 * §12.2: the second factor, once given, is part of the session — not a cookie
 * or a flag the browser holds. Clearing it is what turns a half-signed-in
 * session into a real one, and it is written here so no route can do it by
 * accident.
 */
async function clearSessionMfa(sessionId) {
  await query('UPDATE sessions SET mfa_pending = 0, mfa_attempts = 0 WHERE id = ?', [sessionId]);
  return { ok: true };
}

/**
 * Count a wrong second factor against the session and return how many have
 * failed. Six digits is a million possibilities: without this ceiling a
 * patient attacker with a stolen first factor simply types until it opens.
 */
async function recordMfaFailure(sessionId) {
  await query('UPDATE sessions SET mfa_attempts = mfa_attempts + 1 WHERE id = ?', [sessionId]);
  const row = await queryOne('SELECT mfa_attempts FROM sessions WHERE id = ? LIMIT 1', [sessionId]);
  return row ? Number(row.mfa_attempts) : 1;
}

/** Returns the session + its user, or null when missing/expired/revoked. */
async function findSession(tokenHash) {
  const row = await queryOne(
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at, s.mfa_pending, s.mfa_attempts,
            u.*, ei.verified_at AS email_verified_at,
            EXISTS (SELECT 1 FROM user_email_identities gi WHERE gi.user_id = u.id AND gi.google_subject IS NOT NULL) AS google_linked
       FROM sessions s
       JOIN \`users\` u ON u.id = s.user_id
       LEFT JOIN user_email_identities ei ON ei.user_id = u.id AND ei.email = u.email
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
      LIMIT 1`,
    [tokenHash],
  );
  if (!row) return null;
  return {
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    // §12.2: a session that has not cleared the second factor carries a real
    // user and no authority — every gate reads this before anything else.
    mfaPending: Boolean(row.mfa_pending),
    mfaAttempts: Number(row.mfa_attempts) || 0,
    user: shapeUser(row),
  };
}

async function revokeSessionById(sessionId) {
  await query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked_at IS NULL', [sessionId]);
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

/** Saved cars with the price watched and the price now — FR-25. */
async function savedCars(userId) {
  const rows = await query(
    `SELECT s.listing_id, s.note, s.created_at AS saved_at,
            s.last_price_kobo, s.last_alerted_at
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
      if (!listing) return null;
      const watchedKobo = row.last_price_kobo === null || row.last_price_kobo === undefined
        ? null
        : Number(row.last_price_kobo);
      return {
        ...listing,
        savedAt: row.saved_at,
        note: row.note || null,
        // FR-25: what the saver last saw, and whether it has moved since.
        watchedKobo,
        priceDropKobo: watchedKobo !== null && listing.priceKobo < watchedKobo ? watchedKobo - listing.priceKobo : 0,
        alertSentAt: row.last_alerted_at,
      };
    })
    .filter(Boolean);
}

async function addSavedCar(userId, listingId, note = null) {
  // FR-25: record the price the saver is looking at. The alert sweep measures
  // every future drop from here, so saving a car is never itself an alert.
  await query(
    `INSERT INTO saved_cars (user_id, listing_id, note, last_price_kobo)
     VALUES (?, ?, ?, (SELECT asking_price_kobo FROM vehicle_listings WHERE id = ?))
     ON DUPLICATE KEY UPDATE
       note = VALUES(note),
       last_price_kobo = COALESCE(last_price_kobo, VALUES(last_price_kobo))`,
    [userId, listingId, note ? String(note).slice(0, 200) : null, listingId],
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
  // FR-25: the watermark starts now, so saving a search does not immediately
  // mail you the entire current inventory. From here on, "new" means new.
  const result = await query(
    `INSERT INTO saved_searches (user_id, label, query, alerts_enabled, alert_price_drop, alert_new_match, last_alerted_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
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
// Dashboard reads — customer-owned rows by user ID, with a legacy sign-in-phone fallback (§7.1)
// ---------------------------------------------------------------------------
async function dashboard(user) {
  const phone = user.phone;
  const userId = user.id;
  const [requests, bookings, orders, subscriptions, savedCarList, searches, referral, paymentRows, escrow, hires] = await Promise.all([
    require('./requests').listRequestsForPhone(phone, { userId }),
    require('./requests').listBookingsForPhone(phone, { userId }),
    require('./commerce').listForPhone(phone, { userId }),
    require('./subscriptions').forPhone(phone, { limit: 20, userId }),
    savedCars(user.id),
    savedSearches(user.id),
    referralStats(user),
    require('./payments').listForPhone(phone, { limit: 20, userId }),
    require('./payments').milestonesForPhone(phone, { userId }),

    // FR-22: the customer's own hires, keyed to their phone like everything else.
    // Appended last so the destructuring above keeps its order — a hire query
    // in the middle of this list silently gave `savedCarList` the hires.
    require('./hire').bookingsForPhone(phone, { limit: 20, userId }),
  ]);

  // §7.1 lists hire separately from the other requests. A hire that has been
  // quoted is a booking (with a price, dates and a car) and shows as one; a
  // request with no quote yet still shows as “with the ops desk”.
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
    hires,
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
      hires: hires.length,
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
      contactPhone: user.contactPhone,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      googleLinked: user.googleLinked,
      marketingOptIn: user.marketingOptIn,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      referralCode: user.referralCode,
    },
    requests: data.requests,
    hireRequests: data.hireRequests,
    hires: data.hires,
    bookings: data.bookings,
    orders: data.orders,
    subscriptions: data.subscriptions,
    documents: data.documents,
    referrals: data.referral,
    savedCars: data.savedCars.map((listing) => ({ id: listing.id, title: listing.title, url: listing.url, status: listing.status })),
    savedSearches: data.savedSearches,
    note: 'This export covers records linked to your customer account and, for older phone accounts, legacy records keyed to that verified sign-in phone. A contact phone alone does not provide access to anyone’s history.'
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
  const personalTables = [
    ['service_requests', 'phone', 'name'],
    ['bookings', 'phone', 'name'],
    ['orders', 'phone', 'name'],
    ['leads', 'phone', 'name'],
    ['hire_bookings', 'client_phone', 'client_name'],
    ['subscriptions', 'customer_phone', 'customer_name'],
    ['payments', 'customer_phone', 'customer_name'],
    ['payment_milestones', 'customer_phone', 'customer_name'],
    ['financing_leads', 'phone', 'name'],
  ];

  await transaction(async (conn) => {
    for (const [table, phoneColumn, nameColumn] of personalTables) {
      await conn.query(
        `UPDATE ${table} SET ${phoneColumn} = ?, ${nameColumn} = 'Deleted account', user_id = NULL WHERE user_id = ?`,
        [redacted, user.id],
      );
      if (user.phone) {
        await conn.query(
          `UPDATE ${table} SET ${phoneColumn} = ?, ${nameColumn} = 'Deleted account' WHERE user_id IS NULL AND ${phoneColumn} = ?`,
          [redacted, user.phone],
        );
      }
    }
    await conn.query('UPDATE financing_leads SET email = NULL WHERE user_id IS NULL AND email = ?', [user.email]);
    await conn.query('UPDATE financing_leads SET email = NULL WHERE user_id IS NULL AND email IN (SELECT email FROM user_email_identities WHERE user_id = ?)', [user.id]);
    await conn.query(
      `DELETE FROM email_auth_codes
        WHERE user_id = ? OR email = ? OR email IN (SELECT email FROM user_email_identities WHERE user_id = ?)`,
      [user.id, user.email, user.id],
    );
    await conn.query('DELETE FROM `users` WHERE id = ?', [user.id]);
  });
  return true;
}

module.exports = {
  USER_STATUSES,
  maskPhone,
  shapeUser,
  normaliseEmail,
  findByPhone,
  findById,
  findByVerifiedEmail,
  findByGoogleSubject,
  findLegacyEmailOwner,
  upsertByPhone,
  createEmailAccount,
  linkVerifiedEmail,
  updateContactPhone,
  touchUser,
  updateProfile,
  createCode,
  findActiveCode,
  registerAttempt,
  consumeCode,
  countRecentCodes,
  createEmailCode,
  findActiveEmailCode,
  registerEmailAttempt,
  consumeEmailCode,
  countRecentEmailCodes,
  createSession,
  findSession,
  revokeSession,
  revokeSessionById,
  clearSessionMfa,
  recordMfaFailure,
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
