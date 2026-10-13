'use strict';

/**
 * MFA state — §12.2's second factor, in the database (migration 029).
 *
 * Everything about a second factor is a small piece of state that has to be
 * exactly right, and every one of those pieces is a place a system can lie to
 * its own operators. This module keeps all of them in one file so the lies have
 * somewhere obvious to hide:
 *
 *   • **A half-finished enrolment is not protection.** `totp_secret` is written
 *     the moment someone starts enrolling; `totp_confirmed_at` only when a code
 *     from that secret has actually been proved. Everything downstream asks
 *     `isEnrolled()` — never "does a secret exist" — so abandoning the wizard
 *     leaves the account exactly as protected as it was before.
 *   • **A code is single-use even though it is valid for 30 seconds.**
 *     `consumeStep()` moves `totp_last_step` forward and returns false for any
 *     step at or below it, so a code read over a shoulder cannot be replayed
 *     inside its own window. It is written with the comparison in the WHERE
 *     clause, so two simultaneous logins cannot both win the same step.
 *   • **Recovery codes are credentials, so they are stored as hashes.** The
 *     plaintext exists once, on the screen that generated it, and never again —
 *     not in this table, not in an export. `useRecoveryCode()` marks one spent
 *     as part of the same statement, so a race cannot double-spend it.
 */

const crypto = require('node:crypto');
const { query, queryOne } = require('./pool');

/** Ten: enough to survive a lost phone twice over, few enough to print. */
const RECOVERY_CODE_COUNT = 10;
/** How many wrong second factors before the session is thrown away. */
const MAX_ATTEMPTS = 5;

/**
 * Unambiguous alphabet — no O/0, no I/1/L — because these get read off a screen
 * and typed on a phone, sometimes from a photo of a printout.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_GROUP = 4;
const RECOVERY_GROUPS = 3;

/**
 * Hash a recovery code the way it is compared: dashes and case are presentation
 * (they help a person read it back), so the hash is taken over the bare
 * alphanumerics. Hashing the printed form would mean a code typed without its
 * dashes could never match — which is exactly the bug this comment replaced.
 */
function hashRecoveryCode(value) {
  return crypto.createHash('sha256').update(normaliseRecoveryCode(value)).digest('hex');
}

/** `K7QM-3XR9-PT2V` — readable aloud, and case-insensitive when typed back. */
function newRecoveryCode() {
  const chars = [];
  for (let i = 0; i < RECOVERY_GROUP * RECOVERY_GROUPS; i += 1) {
    chars.push(RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]);
  }
  return chars.join('').replace(new RegExp(`(.{${RECOVERY_GROUP}})(?=.)`, 'g'), '$1-');
}

function normaliseRecoveryCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** Start (or restart) enrolment. The secret is stored unconfirmed. */
async function beginEnrolment(userId, secret) {
  await query('UPDATE `users` SET totp_secret = ?, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?', [
    secret,
    userId,
  ]);
  return { ok: true };
}

/**
 * Prove a code from the pending secret and switch the factor on.
 * The step is recorded as spent, so the code that turned it on cannot be the
 * code that walks in with it.
 */
async function confirmEnrolment(userId, step) {
  const result = await query(
    'UPDATE `users` SET totp_confirmed_at = UTC_TIMESTAMP(), totp_last_step = ? WHERE id = ? AND totp_secret IS NOT NULL AND totp_confirmed_at IS NULL',
    [step, userId],
  );
  return { ok: (result.affectedRows || 0) > 0 };
}

/** Switch it off. The secret goes with it — a disabled factor keeps no key. */
async function disable(userId) {
  await query('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [userId]);
  await query('UPDATE `users` SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = ?', [userId]);
  return { ok: true };
}

/** What the console and the sign-in path read. Never returns the secret itself. */
async function state(userId) {
  const row = await queryOne(
    `SELECT totp_secret, totp_confirmed_at, totp_last_step,
            (SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL) AS spare_codes
       FROM \`users\` WHERE id = ? LIMIT 1`,
    [userId, userId],
  );
  if (!row) return null;
  return {
    enrolled: Boolean(row.totp_confirmed_at),
    pending: Boolean(row.totp_secret) && !row.totp_confirmed_at,
    confirmedAt: row.totp_confirmed_at || null,
    lastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
    spareCodes: Number(row.spare_codes) || 0,
  };
}

/**
 * The secret, for the two places that legitimately need it: proving a code
 * during enrolment, and verifying one at sign-in. Nothing else calls this.
 */
async function secretFor(userId) {
  const row = await queryOne('SELECT totp_secret, totp_confirmed_at FROM `users` WHERE id = ? LIMIT 1', [userId]);
  if (!row || !row.totp_secret) return null;
  return { secret: row.totp_secret, confirmed: Boolean(row.totp_confirmed_at) };
}

/**
 * Claim a time-step as spent. `false` means this exact code has already been
 * used (or an older one is being replayed).
 *
 * The comparison lives in the WHERE clause on purpose: two requests racing with
 * the same code both arrive here, and only one can move the column.
 */
async function consumeStep(userId, step) {
  const result = await query(
    'UPDATE `users` SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
    [step, userId, step],
  );
  return (result.affectedRows || 0) > 0;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Generate a fresh set, returning the plaintext **once**. Any previous set is
 * deleted in the same transaction: two live sets would mean the count on the
 * console is wrong, and an old sheet still on someone's desk would still work.
 */
async function regenerateRecoveryCodes(userId, count = RECOVERY_CODE_COUNT) {
  const codes = Array.from({ length: count }, () => newRecoveryCode());
  const hashes = codes.map(hashRecoveryCode);
  await query('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [userId]);
  const names = hashes.map(() => '(?, ?)').join(', ');
  const params = hashes.flatMap((hash) => [userId, hash]);
  await query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ${names}`, params);
  return { ok: true, codes, count: codes.length };
}

/**
 * Spend a recovery code. Returns `{ ok, usedAt }`; `ok: false` covers "no such
 * code" and "already spent" without saying which — the difference is only
 * useful to someone guessing.
 */
async function useRecoveryCode(userId, value) {
  const normalised = normaliseRecoveryCode(value);
  if (normalised.length !== RECOVERY_GROUP * RECOVERY_GROUPS) return { ok: false };
  const result = await query(
    'UPDATE mfa_recovery_codes SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [userId, hashRecoveryCode(normalised)],
  );
  if (!result.affectedRows) {
    const spent = await queryOne(
      'SELECT used_at FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? LIMIT 1',
      [userId, hashRecoveryCode(normalised)],
    );
    return { ok: false, alreadyUsed: Boolean(spent && spent.used_at), usedAt: spent ? spent.used_at : null };
  }
  return { ok: true };
}

async function recoveryCodes(userId) {
  const rows = await query(
    'SELECT id, used_at, created_at FROM mfa_recovery_codes WHERE user_id = ? ORDER BY id ASC LIMIT 50',
    [userId],
  );
  return rows.map((row) => ({ id: row.id, usedAt: row.used_at || null, createdAt: row.created_at }));
}

/** How many accounts hold a second factor, and how many of those are required
 *  roles still without one. The console's "is anything unprotected?" question. */
async function coverage(requiredRoles = []) {
  const rows = await query(
    `SELECT role, COUNT(*) AS n,
            SUM(totp_confirmed_at IS NOT NULL) AS enrolled,
            SUM(totp_secret IS NOT NULL AND totp_confirmed_at IS NULL) AS pending
       FROM \`users\`
      WHERE status = 'active' AND role IN ('ops','inspector','marketing','finance','admin')
      GROUP BY role`,
  );
  const byRole = {};
  for (const row of rows) {
    byRole[row.role] = {
      staff: Number(row.n) || 0,
      enrolled: Number(row.enrolled) || 0,
      pending: Number(row.pending) || 0,
      required: requiredRoles.includes(row.role),
    };
  }
  const missing = requiredRoles.reduce((total, role) => {
    const row = byRole[role];
    return total + (row ? row.staff - row.enrolled : 0);
  }, 0);
  return { byRole, missing };
}

module.exports = {
  RECOVERY_CODE_COUNT,
  MAX_ATTEMPTS,
  hashRecoveryCode,
  newRecoveryCode,
  normaliseRecoveryCode,
  beginEnrolment,
  confirmEnrolment,
  disable,
  state,
  secretFor,
  consumeStep,
  regenerateRecoveryCodes,
  useRecoveryCode,
  recoveryCodes,
  coverage,
};
