'use strict';

/**
 * Auth endpoints — §7.1, mounted at /api/auth.
 *
 *   POST /api/auth/otp      request a phone code for staff/dealer access
 *   POST /api/auth/verify   exchange the code for a session cookie
 *   POST /api/auth/logout   revoke the session and clear the cookie
 *
 * Everything is rate-limited (§12.2 “rate-limited auth/OTP”) and same-origin
 * checked; the code itself never travels in a URL, a log line or an event
 * payload.
 */

const express = require('express');
const rateLimit = require('../lib/rate-limit');
const auth = require('../services/auth');
const customerAuth = require('../services/customer-auth');
const emailService = require('../services/email');
const config = require('../config');
const db = require('../db');
const validate = require('../services/validate');
const roles = require('../services/roles');
const mfa = require('../services/mfa');
const { sendJson } = require('../lib/respond');
const { phoneRoleForHost } = require('../lib/admin-host');

const router = express.Router();

/**
 * §12.2 “rate-limited auth/OTP”. Two layers:
 *   · per IP   — a blunt ceiling so one host cannot enumerate numbers
 *   · per phone — configurable (auth.maxRequestsPerHour), the control that
 *     actually matters, enforced in services/auth.js against the auth_codes
 *     table rather than in memory.
 * The IP ceiling is deliberately generous: Nigerian mobile traffic shares
 * carrier NATs, and a legitimate household must not lock itself out.
 */
const otpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30 });
const verifyLimiter = rateLimit({ windowMs: 15 * 60_000, max: 60 });
// A six-digit code is a million possibilities, so the per-session attempt
// ceiling in services/mfa.js is the real defence; this is the second one, for
// traffic that never gets as far as a session.
const mfaLimiter = rateLimit({ windowMs: 5 * 60_000, max: 30 });
const emailOtpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30 });
const emailVerifyLimiter = rateLimit({ windowMs: 15 * 60_000, max: 60 });
const googleLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30 });

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const part of cookies) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function googleCookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/api/auth/google', maxAge: customerAuth.GOOGLE_STATE_TTL_MS };
}

router.post('/otp', auth.sameOriginOnly, otpLimiter, async (req, res, next) => {
  try {
    const result = await auth.requestCode({
      rawPhone: (req.body || {}).phone,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      roleRequired: phoneRoleForHost(req),
    });

    if (!result.ok) return sendJson(res, { ok: false, error: result.error }, { status: result.status });

    return sendJson(res, {
      ok: true,
      phone: result.phone,
      maskedPhone: result.maskedPhone,
      channel: result.channel,
      delivered: result.delivered,
      expiresInMinutes: Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 60_000),
      // Development only: lets the flow be driven without a phone. Never set
      // outside a non-production environment (see services/auth.js).
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/verify', auth.sameOriginOnly, verifyLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await auth.verifyCode({
      rawPhone: body.phone,
      code: validate.text(body.code, 12),
      // §7.1 referrals: the invitation code rides along from /login?ref=…
      referralCode: validate.text(body.ref, 16),
      ip: req.ip,
      userAgent: req.get('user-agent'),
      roleRequired: phoneRoleForHost(req),
    });

    if (!result.ok) return sendJson(res, { ok: false, error: result.error }, { status: result.status });

    auth.setSessionCookie(res, result.token, { expiresAt: result.expiresAt });
    const defaultRedirect = roles.isStaff(result.user.role)
      ? '/admin'
      : result.user.role === 'dealer'
        ? '/dealer/dashboard'
        : '/account';

    return sendJson(res, {
      ok: true,
      user: {
        name: result.user.name,
        firstName: result.user.shortName,
        maskedPhone: result.user.maskedPhone,
        hasName: Boolean(result.user.name),
      },
      // §12.2: an account with a second factor gets a session that has passed
      // the phone step and nothing else, and is told where to finish.
      mfa: result.mfaPending
        ? { required: true, next: `/login/mfa?next=${encodeURIComponent(auth.safeNextPath(body.next) || defaultRedirect)}` }
        : null,
      redirect: auth.safeNextPath(body.next) || defaultRedirect,
    });
  } catch (error) {
    return next(error);
  }
});

// Customer email OTP — entirely separate from staff phone OTP + TOTP.
router.post('/email/otp', auth.sameOriginOnly, emailOtpLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await customerAuth.requestEmailCode({ rawEmail: body.email, ip: req.ip });
    if (!result.ok) return sendJson(res, { ok: false, error: result.error, code: result.code }, { status: result.status });
    return sendJson(res, {
      ok: true,
      alreadyLinked: Boolean(result.alreadyLinked),
      maskedEmail: emailService.maskEmail(result.email),
      channel: result.channel || 'email',
      delivered: result.delivered !== false,
      expiresInMinutes: result.expiresAt ? Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 60_000) : null,
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/email/verify', auth.sameOriginOnly, emailVerifyLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await customerAuth.verifyEmailCode({
      rawEmail: body.email,
      code: validate.text(body.code, 12),
      name: validate.name(body.name),
      referralCode: validate.text(body.ref, 16),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    if (!result.ok) return sendJson(res, { ok: false, error: result.error, code: result.code }, { status: result.status });

    auth.setSessionCookie(res, result.token, { expiresAt: result.expiresAt });
    return sendJson(res, {
      ok: true,
      user: { name: result.user.name, email: result.user.email, emailVerified: result.user.emailVerified },
      newAccount: Boolean(result.newAccount),
      redirect: auth.safeNextPath(body.next) || '/account',
    });
  } catch (error) {
    return next(error);
  }
});

// Google OpenID Connect. The state cookie is signed, short-lived, SameSite=Lax,
// and includes PKCE + nonce material; only verified customer identities proceed.
router.get('/google', googleLimiter, (req, res) => {
  const intent = String(req.query.intent || '') === 'link' ? 'link' : 'sign_in';
  if (req.user && req.user.role !== 'customer') return res.redirect(302, '/account?auth_error=customer_only#profile');
  if (intent === 'link' && (!req.user || req.user.role !== 'customer')) {
    return res.redirect(302, '/login?auth_error=google_link_session');
  }
  if (intent !== 'link' && req.user && req.user.role === 'customer') {
    return res.redirect(302, auth.safeNextPath(req.query.next) || '/account');
  }

  const result = customerAuth.beginGoogleAuth({
    next: auth.safeNextPath(req.query.next) || (intent === 'link' ? '/account#profile' : '/account'),
    linkUserId: intent === 'link' ? req.user.id : null,
    saveListingId: intent === 'link' ? null : validate.integer(req.query.save, { min: 1, fallback: 0 }),
  });
  if (!result.ok) {
    const path = intent === 'link' ? '/account' : '/login';
    return res.redirect(302, `${path}?auth_error=${encodeURIComponent(result.code.toLowerCase())}${intent === 'link' ? '#profile' : ''}`);
  }
  res.cookie(customerAuth.GOOGLE_STATE_COOKIE, result.cookie, googleCookieOptions());
  return res.redirect(302, result.url);
});

router.get('/google/callback', googleLimiter, async (req, res, next) => {
  const stateCookie = readCookie(req, customerAuth.GOOGLE_STATE_COOKIE);
  res.clearCookie(customerAuth.GOOGLE_STATE_COOKIE, { ...googleCookieOptions(), maxAge: undefined });
  if (req.query.error) {
    return res.redirect(302, req.user && req.user.role === 'customer'
      ? '/account?auth_error=google_cancelled#profile'
      : '/login?auth_error=google_cancelled');
  }

  try {
    const { context, profile } = await customerAuth.verifyGoogleCallback({
      cookie: stateCookie,
      state: req.query.state,
      code: req.query.code,
    });

    if (context.linkUserId) {
      if (!req.user || req.user.role !== 'customer' || Number(req.user.id) !== Number(context.linkUserId)) {
        return res.redirect(302, '/account?auth_error=google_link_session#profile');
      }
      const linked = await customerAuth.linkGoogleIdentity(context.linkUserId, profile);
      if (!linked.ok) return res.redirect(302, `/account?auth_error=${encodeURIComponent(linked.code.toLowerCase())}#profile`);
      return res.redirect(302, auth.safeNextPath(context.next) || '/account#profile');
    }

    const result = await customerAuth.signInWithGoogle(profile, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    if (!result.ok) return res.redirect(302, `/login?auth_error=${encodeURIComponent(result.code.toLowerCase())}`);
    auth.setSessionCookie(res, result.token, { expiresAt: result.expiresAt });
    if (context.saveListingId) {
      await db.users.addSavedCar(result.user.id, context.saveListingId, null).catch(() => {});
    }
    return res.redirect(302, auth.safeNextPath(context.next) || '/account');
  } catch (error) {
    const code = String(error.code || 'google_sign_in_failed').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60);
    const safeCode = encodeURIComponent(code || 'google_sign_in_failed');
    return res.redirect(302, req.user && req.user.role === 'customer'
      ? `/account?auth_error=${safeCode}#profile`
      : `/login?auth_error=${safeCode}`);
  }
});

/**
 * §12.2 — the second factor at sign-in.
 *
 * Only a half-signed-in session can call this: the gate lets such a session
 * reach this one endpoint and nothing else. A wrong code is counted against the
 * session, and running out of tries kills the session outright rather than
 * leaving a first-factor foothold open to keep guessing on.
 */
router.post('/mfa', mfaLimiter, async (req, res, next) => {
  try {
    if (!req.user || !req.session) {
      return sendJson(res, { ok: false, error: 'Sign in again — this session has ended.' }, { status: 401 });
    }
    if (!req.session.mfaPending) {
      // Already cleared it. Answer honestly instead of pretending to check.
      return sendJson(res, {
        ok: true,
        alreadyVerified: true,
        redirect: auth.safeNextPath((req.body || {}).next) || '/account',
      });
    }

    const result = await mfa.challenge(req, (req.body || {}).code);
    if (!result.ok) {
      await db.analytics
        .record('mfa_failed', {
          payload: { attempts_left: result.attemptsLeft ?? 0, exhausted: Boolean(result.exhausted) },
          sourcePath: '/login/mfa',
        })
        .catch(() => {});
      if (result.exhausted) auth.clearSessionCookie(res);
      return sendJson(
        res,
        { ok: false, error: result.error, attemptsLeft: result.attemptsLeft },
        { status: result.exhausted ? 401 : 422 },
      );
    }

    await db.analytics
      .record('mfa_verified', { payload: { via: result.via, role: req.user.role }, sourcePath: '/login/mfa' })
      .catch(() => {});

    const next_ = auth.safeNextPath((req.body || {}).next);
    return sendJson(res, {
      ok: true,
      via: result.via,
      redirect: next_ || (roles.isStaff(req.user.role) ? '/admin' : '/account'),
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await auth.logout(req, res);
    await db.analytics
      .record('sign_out', { payload: { source: validate.text((req.body || {}).source, 40) || 'account' }, sourcePath: '/account' })
      .catch(() => {});
    return sendJson(res, { ok: true, redirect: '/' });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router };
