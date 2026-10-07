'use strict';

/**
 * TOTP — RFC 6238, and nothing else (§12.2 "MFA for admin roles").
 *
 * Written out rather than pulled in, for the same reason the money and phone
 * helpers are: it is thirty lines of arithmetic, it is a security primitive, and
 * a dependency would mean trusting a package to do the one thing this file has
 * to get exactly right. The implementation is checked against the RFC's own test
 * vectors in `test/mfa.test.js` — including the 8-digit ones, truncated the way
 * the RFC specifies — so "it produces codes" is not a matter of opinion.
 *
 * What it deliberately does **not** do:
 *
 *   • it does not decide whether a code may be *used*. Replay is a property of
 *     the account, not of the arithmetic, so `mfa.js` records the step each
 *     successful verification consumed and refuses an older one. A code that
 *     verifies is not the same thing as a code that is still valid.
 *   • it does not store anything. Secrets live in `users.totp_secret`, pending
 *     or confirmed, and only `mfa.js` touches them.
 *
 * The defaults are the ones authenticator apps assume: SHA-1, 6 digits, 30
 * seconds. Deviating would mean most phones quietly produce the wrong code.
 */

const crypto = require('node:crypto');

const DIGITS = 6;
const STEP_SECONDS = 30;
const ALGORITHM = 'SHA1';
/** 160 bits, the RFC's recommendation for HMAC-SHA-1. */
const SECRET_BYTES = 20;
/** How many steps either side of "now" a code is accepted for. One step = 30s. */
const DEFAULT_WINDOW = 1;

// ---------------------------------------------------------------------------
// base32 (RFC 4648, no padding) — what every authenticator app speaks
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Decode base32. Forgiving about the things people paste — spaces, lower case,
 * `=` padding, a hyphen from a printed recovery sheet — and strict about
 * everything else: an unreadable secret must throw here rather than silently
 * become a different secret and reject every code the user types.
 */
function base32Decode(input) {
  const text = String(input || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!text) throw new Error('Empty secret');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

/** A fresh 160-bit secret, base32 so it can be typed or scanned. */
function generateSecret(bytes = SECRET_BYTES) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** Which time-step a moment belongs to. Exposed because replay is decided on it. */
function stepAt(time = Date.now(), step = STEP_SECONDS) {
  return Math.floor(Number(time) / 1000 / step);
}

/**
 * The code for a given secret and step (or moment).
 * @returns {string} zero-padded to `digits`
 */
function codeForStep(secret, step, { digits = DIGITS } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = crypto.createHmac(ALGORITHM.toLowerCase(), key).update(counter).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks
  // the four bytes to read, and the top bit is masked off.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function code(secret, { time = Date.now(), digits = DIGITS, step = STEP_SECONDS } = {}) {
  return codeForStep(secret, stepAt(time, step), { digits });
}

/**
 * Check a submitted code.
 *
 * Returns the step it matched, or `null` — never a bare boolean, because the
 * caller needs to know *which* step was consumed in order to refuse it twice.
 *
 * `window` allows one step either side of now, which covers the clock drift
 * every phone has and the seconds a code spends in a WhatsApp paste. It is not
 * a licence to widen the window: each extra step is another 30 seconds a
 * shoulder-surfed code stays usable.
 */
function verify(secret, token, { time = Date.now(), window = DEFAULT_WINDOW, step = STEP_SECONDS, digits = DIGITS } = {}) {
  const submitted = String(token || '').replace(/\D/g, '');
  if (submitted.length !== digits) return null;
  const now = stepAt(time, step);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = now + offset;
    const expected = codeForStep(secret, candidate, { digits });
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) return candidate;
  }
  return null;
}

/**
 * The `otpauth://` URI an authenticator app reads.
 *
 * The label carries the account's phone number (masked to nothing — it is the
 * person's own account, on their own screen) and the issuer is the business, so
 * the entry in their app says which site it is for.
 */
function otpauthUrl({ secret, account, issuer = 'HonestCars', digits = DIGITS, step = STEP_SECONDS }) {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({
    secret: String(secret).toUpperCase(),
    issuer,
    algorithm: ALGORITHM,
    digits: String(digits),
    period: String(step),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * Group a secret for reading aloud or typing: `GEZD GNBV GY3T QOJQ`. Cosmetic
 * only — `base32Decode` strips the spaces back out.
 */
function formatSecret(secret) {
  return String(secret).toUpperCase().replace(/(.{4})/g, '$1 ').trim();
}

module.exports = {
  DIGITS,
  STEP_SECONDS,
  ALGORITHM,
  DEFAULT_WINDOW,
  base32Encode,
  base32Decode,
  generateSecret,
  stepAt,
  codeForStep,
  code,
  verify,
  otpauthUrl,
  formatSecret,
};
