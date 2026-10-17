'use strict';

/**
 * Sessions, access gates and code primitives — §12.2. Sign-in credentials
 * themselves live in `src/services/signin.js` (email OTP or Google, every
 * audience); this module holds the machinery around them:
 *
 *   • server-side sessions: a 32-byte token lives in an httpOnly, SameSite=Lax
 *     cookie; the database stores only its SHA-256 hash, so a stolen cookie can
 *     be revoked from the row
 *   • code hashing: HMAC-SHA256 with a server pepper, compared in constant time
 *   • the §12.2 gates: staff roles, the TOTP challenge, same-origin checks
 *
 * No PII is logged. Phone numbers on `users` are contact data only — they are
 * never a sign-in credential anywhere in this build.
 */

const crypto = require('node:crypto');
const config = require('../config');
const mfa = require('./mfa');
const db = require('../db');
const roles = require('./roles');

const SESSION_COOKIE = 'hc_session';

/** Production must set AUTH_PEPPER — a blank pepper silently weakens the hashes. */
function pepper() {
  if (config.auth.pepper) return config.auth.pepper;
  if (config.isProduction) {
    throw new Error('AUTH_PEPPER is required in production (see .env.example)');
  }
  return 'honestcars-development-pepper';
}

function hashEmailCode(email, purpose, code) {
  return crypto.createHmac('sha256', pepper()).update(`email:${purpose}:${email}:${code}`).digest('hex');
}

function signAuthState(value) {
  return crypto.createHmac('sha256', pepper()).update(String(value)).digest('base64url');
}

function generateCode() {
  const length = Math.max(4, Math.min(8, config.auth.otpLength));
  let code = '';
  for (let i = 0; i < length; i += 1) code += crypto.randomInt(0, 10);
  return code;
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHmac('sha256', pepper()).update(String(token)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Password hashing (first factor for staff + dealer accounts, migration 038).
// scrypt with a per-password random salt; the stored form is
// `scrypt$<salt-hex>$<hash-hex>`. A slow KDF, not a fast HMAC, because this is
// a secret a person types -- the usual online guessing target.
// ---------------------------------------------------------------------------
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return safeEqual(derived.toString('hex'), hash);
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------
function cookieOptions({ maxAgeMs } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

function setSessionCookie(res, token, { expiresAt } = {}) {
  const maxAgeMs = expiresAt ? new Date(expiresAt).getTime() - Date.now() : config.auth.sessionDays * 86_400_000;
  res.cookie(SESSION_COOKIE, token, cookieOptions({ maxAgeMs }));
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

function readSessionToken(req) {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Express middleware — attaches req.user/res.locals.user when a session is live. */
async function attachUser(req, res, next) {
  req.user = null;
  req.session = null;
  const token = readSessionToken(req);
  if (!token) return next();

  try {
    const session = await db.users.findSession(hashToken(token));
    if (session && session.user.status === 'active') {
      req.user = session.user;
      req.session = {
        id: session.sessionId,
        expiresAt: session.expiresAt,
        token,
        // §12.2: a session that has passed the first factor and not the second
        // is a real session with no authority. Every gate below reads this.
        mfaPending: Boolean(session.mfaPending),
        mfaAttempts: session.mfaAttempts || 0,
      };
      res.locals.user = session.user;
      return next();
    }

    // The cookie is there but it no longer buys anything: expired, revoked, or
    // the account was blocked or deleted. Clear it and let the page that needed
    // the visitor explain why they are back at /login.
    if (session) await db.users.revokeAllForUser(session.user.id);
    clearSessionCookie(res);
    req.sessionEnded = true;
    return next();
  } catch (error) {
    // A database blip must never take the public site down with it.
    console.error('[auth] session lookup failed:', error.message);
    return next();
  }
}

/**
 * §12.2 — a session that has cleared the one-time code but not the second
 * factor. It exists so the challenge page has something to attach to; it opens
 * nothing else.
 */
function isMfaPending(req) {
  return Boolean(req.user && req.session && req.session.mfaPending);
}

/**
 * §12.2 / 038 — a session that has proven its email but not yet set a password.
 * Like an MFA-pending session it carries a user and no authority: the one door
 * is the endpoint that stores the password.
 */
function isPasswordPending(req) {
  return Boolean(req.user && req.session && req.session.passwordPending);
}

/** Send a half-signed-in session to the challenge, remembering where they were going. */
function mfaChallenge(req, res) {
  const wantsJson = req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');
  if (wantsJson) {
    return res.status(401).json({ ok: false, error: 'Two-step sign-in: enter the code from your authenticator app.', mfa: true });
  }
  const target = encodeURIComponent(req.originalUrl || '/account');
  // A redirect whose target names the page someone was trying to reach is not
  // for a shared cache to keep.
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  return res.redirect(302, `/login/mfa?next=${target}`);
}

/**
 * §12.2 / 038 — send a password-pending session to the sign-in surface for its
 * role, where the "set your password" step lives. The session is remembered, so
 * that surface opens straight on the password step rather than the email code.
 */
function passwordChallenge(req, res) {
  const role = (req.user && req.user.role) || 'customer';
  const next_ = encodeURIComponent(req.originalUrl || '');
  let loginPath;
  if (role === 'dealer') loginPath = '/dealer/login';
  else if (roles.isStaff(role)) loginPath = config.admin.enforceHost ? '/login' : '/admin/login';
  else loginPath = '/login';
  const wantsJson = req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');
  if (wantsJson) {
    return res.status(401).json({ ok: false, error: 'Set a password to finish signing in.' });
  }
  return res.redirect(302, `${loginPath}${next_ ? `?next=${next_}` : ''}`);
}

/**
 * §12.2 — the whole-request gate, applied before any route.
 *
 * Two rules, and both of them have exactly one door so nobody is trapped:
 *
 *   • a required role without a second factor may reach the enrolment screen
 *     and nothing else — a wall with no door would mean a promoted account is
 *     simply locked out of its own console;
 *   • a session waiting on the second factor may reach the challenge and
 *     nothing else.
 *
 * Anything that is not an HTML page and not an API call (fonts, CSS, the
 * manifest, the service worker) is left alone: a half-signed-in session has no
 * authority, so there is nothing to protect there, and blocking them would just
 * render a broken sign-in screen.
 */
/**
 * The paths an un-enrolled required role may still use: the screen that fixes
 * the problem, and the posts it makes. Both gates read this one function, so
 * the person who has to enrol can always reach the page that lets them — a
 * second gate that forgot the exception would bounce them at the door they
 * were just sent to.
 */
/** The path as the visitor typed it: inside a mounted router `req.path` drops
 *  the mount point, and `/security` is not the page anyone asked for. */
function fullPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

function mfaEnrolmentOpen(path) {
  return path === '/admin/security' || path.startsWith('/admin/security/');
}

function mfaGate(req, res, next) {
  if (!req.user) return next();
  const path = req.path;

  // The doors. `/login` itself is open so someone can abandon and start again —
  // and starting again means either first factor: the email code or Google.
  const OPEN = [
    '/login',
    '/login/mfa',
    '/api/auth/mfa',
    '/api/auth/password/set',
    '/api/auth/logout',
    '/api/auth/email/otp',
    '/api/auth/email/verify',
    '/api/auth/google',
    '/api/auth/google/callback',
  ];
  if (OPEN.includes(path)) return next();
  if (/^\/(css|js|fonts|img|video|icons)\//.test(path) || path === '/manifest.webmanifest' || path === '/sw.js' || path === '/favicon.png') {
    return next();
  }

  if (isMfaPending(req)) return mfaChallenge(req, res);
  if (isPasswordPending(req)) return passwordChallenge(req, res);

  if (mfa.mustEnrol(req.user) && !mfaEnrolmentOpen(path) && !path.startsWith('/api/account/')) {
    const wantsJson = path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');
    if (wantsJson) {
      return res.status(403).json({
        ok: false,
        error: 'Your role needs two-step sign-in before this works. Set it up at /admin/security.',
        mfaEnrolmentRequired: true,
      });
    }
    return res.redirect(302, `/admin/security?err=${encodeURIComponent('Your role can move money or grant roles, so two-step sign-in is required. Set it up here to continue.')}`);
  }

  return next();
}

/** Gate a page behind a login. HTML redirects to /login?next=…, APIs get 401. */
function requireUser(req, res, next) {
  if (isMfaPending(req)) return mfaChallenge(req, res);
  if (isPasswordPending(req)) return passwordChallenge(req, res);
  if (req.user) return next();
  const wantsJson = req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');
  if (wantsJson) return res.status(401).json({ ok: false, error: 'Sign in to continue.' });
  const next_ = encodeURIComponent(req.originalUrl || '/account');
  return res.redirect(302, `/login?next=${next_}`);
}

/**
 * Rendered rather than a bare status code: a member of staff who opens a
 * module they do not hold, and a signed-in customer who guesses /admin, both
 * get a page that says which role they hold — never a blank response.
 */
function forbidden(req, res) {
  const respond = require('../lib/respond');
  return respond.sendPage(req, res, {
    view: 'error',
    status: 403,
    cache: 'no-store',
    page: {
      title: 'No access',
      metaTitle: 'No access | HonestCars',
      canonical: '/admin',
      robots: 'noindex,nofollow',
    },
    data: { reason: 'forbidden', role: (req.user && req.user.role) || 'customer' },
  });
}

/**
 * §7.4 — the console gate. Two steps: someone with a staff role, then someone
 * who holds the capability this screen or action needs. A signed-in customer
 * gets the honest 403 page, not a redirect loop.
 */
function requireStaff(options = {}) {
  const capability = typeof options === 'string' ? options : options.capability || null;
  return (req, res, next) => {
    if (!req.user) {
      const target = encodeURIComponent(req.originalUrl || '/admin');
      const loginPath = config.admin.enforceHost ? '/login' : '/admin/login';
      return res.redirect(302, `${loginPath}?next=${target}`);
    }
    if (isMfaPending(req)) return mfaChallenge(req, res);
    if (isPasswordPending(req)) return passwordChallenge(req, res);
    if (mfa.mustEnrol(req.user) && !mfaEnrolmentOpen(fullPath(req))) {
      return res.redirect(302, `/admin/security?err=${encodeURIComponent('Set up two-step sign-in first — this role can move money or grant roles.')}`);
    }
    if (!roles.isStaff(req.user.role)) return forbidden(req, res);
    if (capability && !roles.can(req.user.role, capability)) return forbidden(req, res);
    return next();
  };
}

/**
 * Same gate, but for the screens two different roles legitimately share — the
 * inspection report is opened by the inspector who filed it *and* by dispatch.
 * Holds when the role has any one of the listed capabilities.
 */
function requireAnyStaff(capabilities) {
  const list = (Array.isArray(capabilities) ? capabilities : [capabilities]).filter(Boolean);
  return (req, res, next) => {
    if (!req.user) {
      const target = encodeURIComponent(req.originalUrl || '/admin');
      const loginPath = config.admin.enforceHost ? '/login' : '/admin/login';
      return res.redirect(302, `${loginPath}?next=${target}`);
    }
    if (!roles.isStaff(req.user.role)) return forbidden(req, res);
    if (list.length && !list.some((capability) => roles.can(req.user.role, capability))) return forbidden(req, res);
    return next();
  };
}

/**
 * CSRF defence for state-changing requests: SameSite=Lax cookies plus a
 * same-origin check on the Origin/Sec-Fetch-Site headers (§12.2).
 */
function sameOriginOnly(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();

  const site = req.get('sec-fetch-site');
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) {
    return res.status(403).json({ ok: false, error: 'Cross-site request blocked.' });
  }

  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).json({ ok: false, error: 'Cross-site request blocked.' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'Cross-site request blocked.' });
    }
  }
  return next();
}

/**
 * Only same-site paths are honoured after login — an attacker cannot turn
 * /login into an open redirector.
 */
function safeNextPath(value) {
  const next = String(value || '').trim();
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next.slice(0, 300);
}

function logout(req, res) {
  const token = (req.session && req.session.token) || readSessionToken(req);
  clearSessionCookie(res);
  if (!token) return Promise.resolve();
  return db.users.revokeSession(hashToken(token));
}

module.exports = {
  requireStaff,
  requireAnyStaff,
  SESSION_COOKIE,
  hashEmailCode,
  signAuthState,
  hashToken,
  hashPassword,
  verifyPassword,
  generateCode,
  newSessionToken,
  safeEqual,
  attachUser,
  mfaGate,
  mfaEnrolmentOpen,
  mfaChallenge,
  isMfaPending,
  isPasswordPending,
  passwordChallenge,
  requireUser,
  sameOriginOnly,
  setSessionCookie,
  clearSessionCookie,
  readSessionToken,
  safeNextPath,
  logout,
};
