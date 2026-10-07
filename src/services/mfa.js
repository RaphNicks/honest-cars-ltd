'use strict';

/**
 * MFA — §12.2's second factor, policy included.
 *
 * The database module (`db/mfa.js`) knows how to store and spend state; this one
 * decides what the state *means*: who has to have a second factor, what counts
 * as proof, what happens to a session that is halfway through, and what the
 * person is told when a code will not work.
 *
 * Three rules, and each of them exists because the alternative is a system that
 * appears to have two factors and does not:
 *
 *   **Required is decided by role, and the role list is one line.** §12.2 says
 *   "MFA for admin roles". Here that is `admin` and `finance`: the two roles
 *   that can approve money or grant a role. Ops, inspectors and marketing can
 *   enrol and are nudged to; they are not locked out of their shift by it.
 *   `MFA_ROLES` in `services/roles.js` is the whole of the policy.
 *
 *   **An un-enrolled required role is sent to enrol, not refused.** A hard wall
 *   would mean a new ops manager whose role changes to admin is simply locked
 *   out with a 403 and no way forward. The gate lets them reach exactly one
 *   screen — the one that fixes it — and nothing else, and the console says why.
 *
 *   **A code that verifies is not yet a code that is valid.** `verify()` returns
 *   which time-step matched; `consumeStep()` then has to win that step. A code
 *   is single-use even though RFC 6238 makes it valid for its whole window,
 *   which is the difference between a second factor and a second factor that a
 *   shoulder-surfer can reuse.
 */

const crypto = require('node:crypto');
const db = require('../db');
const roles = require('./roles');
const totp = require('../lib/totp');
const validate = require('./validate');
const phones = require('../lib/phone');

/** The issuer name an authenticator app shows. */
const ISSUER = 'HonestCars';

/** What the challenge screen offers, in the order it offers them. */
const FACTORS = ['totp', 'recovery'];

function requiresMfa(role) {
  return roles.MFA_ROLES.includes(role);
}

/** A user has a second factor only when a code from it has been *proved*. */
function isEnrolled(user) {
  return Boolean(user && user.mfaEnrolled);
}

/**
 * Does this account have to prove a second factor at sign-in?
 * Enrolled + required role, or enrolled voluntarily — either way, enrolled.
 */
function mustChallenge(user) {
  return isEnrolled(user);
}

/**
 * May this account use the console before it has enrolled?
 * No if the role requires it — the gate sends them to the enrolment screen.
 */
function mustEnrol(user) {
  return Boolean(user && requiresMfa(user.role) && !isEnrolled(user));
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** Step one: mint a secret and hand back what the app needs to show it. */
async function beginEnrolment(user) {
  const secret = totp.generateSecret();
  await db.mfa.beginEnrolment(user.id, secret);
  return {
    ok: true,
    secret,
    formatted: totp.formatSecret(secret),
    // The label is the account's own number, so a person with three entries in
    // their authenticator knows which is which. It is their own screen.
    account: user.phone,
    uri: totp.otpauthUrl({ secret, account: user.phone, issuer: ISSUER }),
  };
}

/**
 * Step two: prove a code from the pending secret. On success the caller also
 * revokes the account's other sessions — a factor that is switched on while
 * three logged-in devices stay logged in protects nothing.
 */
async function confirmEnrolment(user, token) {
  const pending = await db.mfa.state(user.id);
  if (!pending || !pending.pending) {
    return { ok: false, error: 'Start the setup again — there is no secret waiting to be confirmed.' };
  }
  const secret = await db.mfa.secretFor(user.id);
  if (!secret) return { ok: false, error: 'Start the setup again — there is no secret waiting to be confirmed.' };

  const step = totp.verify(secret.secret, token);
  if (step === null) {
    return { ok: false, error: 'That code did not match. Check your phone’s clock is set automatically, then try the next one.' };
  }
  const confirmed = await db.mfa.confirmEnrolment(user.id, step);
  if (!confirmed.ok) return { ok: false, error: 'That setup was already confirmed. Reload the page.' };

  const codes = await db.mfa.regenerateRecoveryCodes(user.id);
  return { ok: true, recoveryCodes: codes.codes, count: codes.count };
}

/** Switch the factor off. Requires a live code or a recovery code — never a click alone. */
async function disable(user, token) {
  if (!isEnrolled(user)) return { ok: false, error: 'There is no second factor on this account.' };
  const proof = await check(user, token);
  if (!proof.ok) return { ok: false, error: proof.error };
  await db.mfa.disable(user.id);
  return { ok: true, via: proof.via };
}

/** Fresh recovery codes, replacing the old sheet. Requires proof, for the same reason. */
async function regenerateRecoveryCodes(user, token) {
  if (!isEnrolled(user)) return { ok: false, error: 'Turn on two-step sign-in first.' };
  const proof = await check(user, token);
  if (!proof.ok) return { ok: false, error: proof.error };
  const codes = await db.mfa.regenerateRecoveryCodes(user.id);
  return { ok: true, codes: codes.codes, count: codes.count };
}

// ---------------------------------------------------------------------------
// Proving a factor
// ---------------------------------------------------------------------------

/**
 * Check a submitted second factor — a 6-digit code or a recovery code — and
 * spend it. Shared by sign-in, disabling and regenerating, so "a code can only
 * be used once" holds on every screen rather than only the one people think of.
 *
 * @returns {{ok: true, via: 'totp'|'recovery'}|{ok: false, error: string}}
 */
async function check(user, submitted) {
  const value = String(submitted || '').trim();
  if (!value) return { ok: false, error: 'Enter the six-digit code from your authenticator app.' };

  const secret = await db.mfa.secretFor(user.id);
  if (!secret || !secret.confirmed) {
    return { ok: false, error: 'This account has no second factor set up yet.' };
  }

  const digits = value.replace(/\D/g, '');
  if (digits.length === totp.DIGITS && !/\D/.test(value.replace(/[\s-]/g, ''))) {
    const step = totp.verify(secret.secret, digits);
    if (step === null) {
      return { ok: false, error: 'That code is not right. Codes change every 30 seconds — wait for the next one and try again.' };
    }
    const claimed = await db.mfa.consumeStep(user.id, step);
    if (!claimed) {
      // The code is real, and it has already been used. Saying so is better
      // than "wrong code", which sends people to retype a working code.
      return { ok: false, error: 'That code has already been used. Codes work once — use the next one from your app.' };
    }
    return { ok: true, via: 'totp' };
  }

  // Not six digits: treat it as a recovery code.
  const used = await db.mfa.useRecoveryCode(user.id, value);
  if (used.ok) return { ok: true, via: 'recovery' };
  if (used.alreadyUsed) {
    return { ok: false, error: 'That recovery code has already been used. Each one works once.' };
  }
  return { ok: false, error: 'That is not a code we recognise. Check it against your recovery sheet.' };
}

/**
 * The sign-in challenge: check the factor, and spend an attempt when it is
 * wrong. The caller passes the session so failures can be counted against it —
 * a per-IP limiter is no defence against a distributed guess on a six-digit
 * code, and the session is the thing the attacker actually holds.
 */
async function challenge(req, submitted) {
  const result = await check(req.user, submitted);
  if (result.ok) {
    await db.users.clearSessionMfa(req.session.id);
    return result;
  }
  const attempts = await db.users.recordMfaFailure(req.session.id);
  if (attempts >= db.mfa.MAX_ATTEMPTS) {
    // Out of tries: the session dies. The first factor on its own is not a
    // foothold worth leaving open, and a fresh sign-in starts the count again.
    await db.users.revokeSessionById(req.session.id);
    return {
      ok: false,
      exhausted: true,
      error: `Too many wrong codes — this sign-in has been cancelled. Sign in again, and have your app ready.`,
    };
  }
  return { ...result, attemptsLeft: Math.max(0, db.mfa.MAX_ATTEMPTS - attempts) };
}

// ---------------------------------------------------------------------------
// The console's view of it
// ---------------------------------------------------------------------------

/** What /admin/security shows the signed-in member of staff. */
async function view(user) {
  const state = await db.mfa.state(user.id);
  const codes = state && state.enrolled ? await db.mfa.recoveryCodes(user.id) : [];
  const used = codes.filter((code) => code.usedAt).length;
  return {
    state,
    required: requiresMfa(user.role),
    enrolled: Boolean(state && state.enrolled),
    pending: Boolean(state && state.pending),
    codes: {
      total: codes.length,
      used,
      remaining: codes.length - used,
      firstUsedAt: (codes.find((code) => code.usedAt) || {}).usedAt || null,
    },
    recoveryWeek: used > 0,
  };
}

/** How covered the team is — the sentence the console shows when it is not. */
async function coverage() {
  const result = await db.mfa.coverage(roles.MFA_ROLES);
  return {
    ...result,
    // The honest headline: "every account that must have a second factor has one".
    complete: result.missing === 0,
    requiredRoles: roles.MFA_ROLES,
  };
}

/**
 * The scrubbed label for a phone number, so a console screen can name the
 * account without printing a full number back at whoever is looking at it.
 */
function labelledPhone(value) {
  return phones.mask ? phones.mask(value) : value;
}

module.exports = {
  ISSUER,
  FACTORS,
  requiresMfa,
  isEnrolled,
  mustChallenge,
  mustEnrol,
  view,
  coverage,
  beginEnrolment,
  confirmEnrolment,
  disable,
  regenerateRecoveryCodes,
  check,
  challenge,
  labelledPhone,
  sanitiseCode: (value) => validate.text(value, 40),
};
