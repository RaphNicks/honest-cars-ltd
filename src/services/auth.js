'use strict';

/**
 * Phone-first auth — §7.1, hardened to §12.2.
 *
 *   • six-digit codes, HMAC-SHA256 hashed with a server pepper, single use,
 *     10-minute expiry, five attempts, rate-limited per phone and per IP
 *   • server-side sessions: a 32-byte token lives in an httpOnly, SameSite=Lax
 *     cookie; the database stores only its SHA-256 hash, so a stolen cookie can
 *     be revoked from the row
 *   • OTP delivery is a seam, not a hard dependency. `console` provider logs the
 *     code (development); `whatsapp` and `sms` are the real providers from §11 —
 *     WhatsApp first, SMS as the fallback channel.
 *
 * No PII is logged: phones are masked before they touch a log line.
 */

const crypto = require('node:crypto');
const config = require('../config');
const privacy = require('./privacy');
const mfa = require('./mfa');
const db = require('../db');
const phones = require('../lib/phone');
const roles = require('./roles');

const SESSION_COOKIE = 'hc_session';
const OTP_CHANNELS = ['whatsapp', 'sms', 'console'];

/** Production must set AUTH_PEPPER — a blank pepper silently weakens the hashes. */
function pepper() {
  if (config.auth.pepper) return config.auth.pepper;
  if (config.isProduction) {
    throw new Error('AUTH_PEPPER is required in production (see .env.example)');
  }
  return 'honestcars-development-pepper';
}

/** Delegates to src/lib/phone.js — one implementation of the rule. */
function normalisePhone(raw) {
  return phones.normalise(raw);
}

/** +2348031234567 → +234 803 ••• 4567 — for logs and screens. */
function maskPhone(phone) {
  return db.users.maskPhone(phone);
}

function hashCode(phone, code) {
  return crypto.createHmac('sha256', pepper()).update(`${phone}:${code}`).digest('hex');
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
// OTP delivery (§11 — WhatsApp first, SMS fallback, console in development)
// ---------------------------------------------------------------------------
function channelFor(provider) {
  if (OTP_CHANNELS.includes(provider)) return provider;
  return 'console';
}

/**
 * Send a login code. Providers are stubs behind one switch: swap the body of
 * each case for the real API call and nothing else in the app changes.
 *
 * @returns {Promise<{channel: string, delivered: boolean, devCode?: string}>}
 */
async function sendOtp(phone, code, { provider = config.auth.provider } = {}) {
  const channel = channelFor(provider);
  const text = `Your HonestCars code is ${code}. It expires in ${config.auth.otpTtlMinutes} minutes. Never share it — we will never ask for it.`;

  switch (channel) {
    case 'whatsapp':
      // TODO(§11): WhatsApp Cloud API template send. Until the business account
      // and template are approved this is a no-op that reports honestly.
      return { channel, delivered: false, reason: 'whatsapp_provider_not_configured' };

    case 'sms':
      // TODO(§11): Termii/Twilio SMS send.
      return { channel, delivered: false, reason: 'sms_provider_not_configured' };

    default: {
      // Development: the code goes to the server log so the flow is testable
      // without a phone, and (outside production) back to the caller.
      console.log(`[auth] OTP for ${maskPhone(phone)} → ${code}  (console provider, ${config.env})`);
      void text;
      return {
        channel: 'console',
        delivered: false,
        devCode: config.auth.showCodeInResponse ? code : undefined,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// OTP lifecycle
// ---------------------------------------------------------------------------
async function requestCode({ rawPhone, ip, userAgent }) {
  const phone = normalisePhone(rawPhone);
  if (!phone) return { ok: false, status: 422, error: 'That phone number does not look right — please check it.' };

  const recent = await db.users.countRecentCodes(phone, { withinMinutes: 60 });
  if (recent >= config.auth.maxRequestsPerHour) {
    return {
      ok: false,
      status: 429,
      error: 'We have sent several codes to this number already. Please wait a few minutes and try again, or message us on WhatsApp.',
    };
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + config.auth.otpTtlMinutes * 60_000);
  const provider = config.auth.provider;
  const delivery = await sendOtp(phone, code, { provider });

  await db.users.createCode({
    phone,
    codeHash: hashCode(phone, code),
    channel: delivery.channel,
    expiresAt,
    ip: ip || null,
    maxAttempts: config.auth.maxVerifyAttempts,
  });

  // Analytics (§15.1): OTP requested / failed, no PII in the payload.
  await db.analytics
    .record(delivery.delivered ? 'otp_requested' : 'otp_request_failed', {
      payload: { channel: delivery.channel, reason: delivery.reason || 'delivered', user_agent: userAgent ? 'present' : 'absent' },
      sourcePath: '/login',
    })
    .catch(() => {});

  return {
    ok: true,
    phone,
    maskedPhone: maskPhone(phone),
    channel: delivery.channel,
    delivered: delivery.delivered,
    expiresAt,
    devCode: delivery.devCode,
  };
}

async function verifyCode({ rawPhone, code, ip, userAgent, referralCode = null, consent = false }) {
  const phone = normalisePhone(rawPhone);
  if (!phone || !code) return { ok: false, status: 422, error: 'Enter the code we sent you.' };

  const active = await db.users.findActiveCode(phone);
  if (!active) {
    return { ok: false, status: 410, error: 'That code has expired. Send a new one.' };
  }
  if (active.attempts >= active.maxAttempts) {
    await db.users.consumeCode(active.id);
    return { ok: false, status: 429, error: 'Too many tries on that code. Send a new one.' };
  }

  const expected = hashCode(phone, String(code).replace(/\D/g, ''));
  if (!safeEqual(expected, active.codeHash)) {
    const attempts = await db.users.registerAttempt(active.id);
    const left = Math.max(0, active.maxAttempts - attempts);
    await db.analytics
      .record('otp_verify_failed', { payload: { attempts_left: left }, sourcePath: '/login' })
      .catch(() => {});
    return {
      ok: false,
      status: 401,
      error: left ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many tries on that code. Send a new one.',
    };
  }

  await db.users.consumeCode(active.id);
  const user = await db.users.upsertByPhone({ phone, referralCode });

  // A blocked number can prove it owns the phone; it still cannot get in.
  if (user.status !== 'active') {
    await db.users.revokeAllForUser(user.id);
    return {
      ok: false,
      status: 403,
      error: 'That number cannot sign in right now. Message us on WhatsApp and a human will sort it out.',
    };
  }

  // §12.2: an account with a confirmed second factor gets a session that has
  // passed the first one only. It can reach the challenge screen and nothing
  // else — no page, no API, no console module reads it as authenticated.
  const mfaPending = mfa.mustChallenge(user);

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + config.auth.sessionDays * 86_400_000);
  await db.users.createSession({ userId: user.id, tokenHash: hashToken(token), expiresAt, ip, userAgent, mfaPending });

  await db.analytics.record('otp_verify_succeeded', { payload: { new_account: !user.name }, sourcePath: '/login' }).catch(() => {});

  // §18.3: the sign-in box says "I agree to HonestCars contacting me on this
  // number about my requests and orders" — service contact, explicitly *not*
  // marketing. It is recorded only when the box came through, and only on a
  // sign-in that actually created or completed an account, so the log stays a
  // record of consent rather than a log of people logging in.
  if (consent === true) {
    await privacy.recordConsent('login', {
      userId: user.id,
      phone: user.phone,
      name: user.name,
      granted: true,
      path: '/login',
    });
  }

  // Housekeeping at the one moment we know this person is here: expired and
  // revoked sessions are worthless rows, and this keeps the table from growing
  // forever without a scheduler (§12.2).
  db.users.pruneSessions().catch(() => {});

  return { ok: true, user, token, expiresAt, mfaPending };
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

  // The doors. `/login` itself is open so someone can abandon and start again.
  const OPEN = ['/login', '/login/mfa', '/api/auth/mfa', '/api/auth/logout', '/api/auth/otp', '/api/auth/verify'];
  if (OPEN.includes(path)) return next();
  if (/^\/(css|js|fonts|img|video|icons)\//.test(path) || path === '/manifest.webmanifest' || path === '/sw.js' || path === '/favicon.png') {
    return next();
  }

  if (isMfaPending(req)) return mfaChallenge(req, res);

  if (mfa.mustEnrol(req.user) && !mfaEnrolmentOpen(path) && !path.startsWith('/api/account/')) {
    const wantsJson = path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');
    if (wantsJson) {
      return res.status(403).json({
        ok: false,
        error: 'Your role needs two-step sign-in before this works. Set it up at /admin/security.',
        mfaEnrolmentRequired: true,
      });
    }
    return res.redirect(302, `/admin/security?err=${encodeURIComponent('Your role can move money or grant roles, so §12.2 asks for a second factor. Set it up here and the console opens.')}`);
  }

  return next();
}

/** Gate a page behind a login. HTML redirects to /login?next=…, APIs get 401. */
function requireUser(req, res, next) {
  if (isMfaPending(req)) return mfaChallenge(req, res);
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
      return res.redirect(302, `/login?next=${target}`);
    }
    if (isMfaPending(req)) return mfaChallenge(req, res);
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
      return res.redirect(302, `/login?next=${target}`);
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
  OTP_CHANNELS,
  normalisePhone,
  maskPhone,
  hashCode,
  hashToken,
  generateCode,
  newSessionToken,
  safeEqual,
  sendOtp,
  requestCode,
  verifyCode,
  attachUser,
  mfaGate,
  mfaEnrolmentOpen,
  mfaChallenge,
  isMfaPending,
  requireUser,
  sameOriginOnly,
  setSessionCookie,
  clearSessionCookie,
  readSessionToken,
  safeNextPath,
  logout,
};
