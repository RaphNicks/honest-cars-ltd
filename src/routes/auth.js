'use strict';

/**
 * Auth endpoints — §7.1, §7.2, §7.4, mounted at /api/auth.
 *
 *   POST /api/auth/email/otp     request an email code (audience: customer | staff | dealer)
 *   POST /api/auth/email/verify  exchange the code for a session cookie
 *   GET  /api/auth/google        start Google sign-in (audience in the signed state)
 *   GET  /api/auth/google/callback  the one registered Google callback
 *   POST /api/auth/mfa           the §12.2 second factor
 *   POST /api/auth/logout        revoke the session and clear the cookie
 *
 * Sign-in is email OTP or Google for every account — there is no phone
 * sign-in and no passwords anywhere. The audience is the surface the form
 * sits on: customer (open registration), staff (provisioned, admin host) or
 * dealer (provisioned, dealer portal). Codes never travel in a URL, a log
 * line or an event payload.
 */

const express = require('express');
const rateLimit = require('../lib/rate-limit');
const auth = require('../services/auth');
const signin = require('../services/signin');
const emailService = require('../services/email');
const config = require('../config');
const db = require('../db');
const validate = require('../services/validate');
const roles = require('../services/roles');
const mfa = require('../services/mfa');
const { sendJson } = require('../lib/respond');

const router = express.Router();

/**
 * §12.2 “rate-limited auth/OTP”. Two layers:
 *   · per IP   — a blunt ceiling so one host cannot enumerate addresses
 *   · per email — configurable (auth.emailMaxRequestsPerHour), the control that
 *     actually matters, enforced in services/signin.js against the
 *     email_auth_codes table rather than in memory.
 * The IP ceiling is deliberately generous: Nigerian mobile traffic shares
 * carrier NATs, and a legitimate household must not lock itself out.
 */
const mfaLimiter = rateLimit({ windowMs: 5 * 60_000, max: 30 });
const emailOtpLimiter = rateLimit({ windowMs: 15 * 60_000, max: config.auth.emailOtpIpMax });
const emailVerifyLimiter = rateLimit({ windowMs: 15 * 60_000, max: config.auth.emailVerifyIpMax });
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
  return { httpOnly: true, sameSite: 'lax', secure: config.isProduction, path: '/api/auth/google', maxAge: signin.GOOGLE_STATE_TTL_MS };
}

/** Where sign-in errors land: back on the surface the form came from. */
function loginPathFor(audience) {
  const scope = signin.normaliseAudience(audience);
  if (scope === 'staff') return '/admin/login';
  if (scope === 'dealer') return '/dealer/login';
  return '/login';
}

function audienceFromRequest(req) {
  return signin.normaliseAudience((req.body || {}).audience ?? req.query.audience);
}

// Customer email OTP — also the staff and dealer first factor, scoped by the
// surface the form sits on (`audience`).
router.post('/email/otp', auth.sameOriginOnly, emailOtpLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const audience = audienceFromRequest(req);
    const result = await signin.requestEmailCode({ rawEmail: body.email, ip: req.ip, audience });
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
    const audience = audienceFromRequest(req);
    const result = await signin.verifyEmailCode({
      rawEmail: body.email,
      code: validate.text(body.code, 12),
      name: validate.name(body.name),
      referralCode: validate.text(body.ref, 16),
      ip: req.ip,
      userAgent: req.get('user-agent'),
      audience,
    });
    if (!result.ok) return sendJson(res, { ok: false, error: result.error, code: result.code }, { status: result.status });

    auth.setSessionCookie(res, result.token, { expiresAt: result.expiresAt });
    const defaultRedirect = signin.defaultRedirect(audience);
    return sendJson(res, {
      ok: true,
      // The greeting half of the contract: who the browser is now signed in
      // as. `firstName` is the short display name the pages use.
      user: {
        name: result.user.name,
        firstName: result.user.shortName,
        email: result.user.email,
        emailVerified: Boolean(result.emailVerified || result.user.emailVerified),
        hasName: Boolean(result.user.name),
      },
      newAccount: Boolean(result.newAccount),
      // §12.2: an enrolled account gets a session that has passed the first
      // factor and nothing else, and is told where to finish.
      mfa: result.mfaPending
        ? { required: true, next: `/login/mfa?next=${encodeURIComponent(auth.safeNextPath(body.next) || defaultRedirect)}` }
        : null,
      redirect: auth.safeNextPath(body.next) || defaultRedirect,
    });
  } catch (error) {
    return next(error);
  }
});

// Google OpenID Connect. The state cookie is signed, short-lived, SameSite=Lax,
// and includes PKCE + nonce material plus the audience; every verified
// identity is checked against that audience before a session exists.
router.get('/google', googleLimiter, (req, res) => {
  const intent = String(req.query.intent || '') === 'link' ? 'link' : 'sign_in';
  const audience = intent === 'link' ? 'customer' : audienceFromRequest(req);
  const loginPath = loginPathFor(audience);
  if (req.user && !signin.audienceMatches(req.user, audience)) {
    return res.redirect(302, `${loginPath}?auth_error=customer_only`);
  }
  if (intent === 'link' && (!req.user || req.user.role !== 'customer')) {
    return res.redirect(302, '/login?auth_error=google_link_session');
  }
  if (intent !== 'link' && req.user && signin.audienceMatches(req.user, audience)) {
    return res.redirect(302, auth.safeNextPath(req.query.next) || signin.defaultRedirect(audience));
  }

  const result = signin.beginGoogleAuth({
    audience,
    next: auth.safeNextPath(req.query.next) || (intent === 'link' ? '/account#profile' : signin.defaultRedirect(audience)),
    linkUserId: intent === 'link' ? req.user.id : null,
    saveListingId: intent === 'link' ? null : validate.integer(req.query.save, { min: 1, fallback: 0 }),
  });
  if (!result.ok) {
    const path = intent === 'link' ? '/account' : loginPath;
    return res.redirect(302, `${path}?auth_error=${encodeURIComponent(result.code.toLowerCase())}${intent === 'link' ? '#profile' : ''}`);
  }
  res.cookie(signin.GOOGLE_STATE_COOKIE, result.cookie, googleCookieOptions());
  return res.redirect(302, result.url);
});

router.get('/google/callback', googleLimiter, async (req, res, next) => {
  const stateCookie = readCookie(req, signin.GOOGLE_STATE_COOKIE);
  res.clearCookie(signin.GOOGLE_STATE_COOKIE, { ...googleCookieOptions(), maxAge: undefined });
  const loginPath = '/login';
  if (req.query.error) {
    return res.redirect(302, req.user && req.user.role === 'customer'
      ? '/account?auth_error=google_cancelled#profile'
      : `${loginPath}?auth_error=google_cancelled`);
  }

  let audience = 'customer';
  try {
    const { context, profile } = await signin.verifyGoogleCallback({
      cookie: stateCookie,
      state: req.query.state,
      code: req.query.code,
    });
    audience = context.audience;
    const errorPath = loginPathFor(audience);

    if (context.linkUserId) {
      if (!req.user || req.user.role !== 'customer' || Number(req.user.id) !== Number(context.linkUserId)) {
        return res.redirect(302, '/account?auth_error=google_link_session#profile');
      }
      const linked = await signin.linkGoogleIdentity(context.linkUserId, profile);
      if (!linked.ok) return res.redirect(302, `/account?auth_error=${encodeURIComponent(linked.code.toLowerCase())}#profile`);
      return res.redirect(302, auth.safeNextPath(context.next) || '/account#profile');
    }

    const result = await signin.signInWithGoogle(profile, {
      audience,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    if (!result.ok) {
      return res.redirect(302, `${context.linkUserId ? '/account' : errorPath}?auth_error=${encodeURIComponent(result.code.toLowerCase())}`);
    }
    auth.setSessionCookie(res, result.token, { expiresAt: result.expiresAt });
    if (result.mfaPending) {
      return res.redirect(302, `/login/mfa?next=${encodeURIComponent(auth.safeNextPath(context.next) || signin.defaultRedirect(audience))}`);
    }
    if (context.saveListingId) {
      await db.users.addSavedCar(result.user.id, context.saveListingId, null).catch(() => {});
    }
    return res.redirect(302, auth.safeNextPath(context.next) || signin.defaultRedirect(audience));
  } catch (error) {
    const code = String(error.code || 'google_sign_in_failed').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60);
    const safeCode = encodeURIComponent(code || 'google_sign_in_failed');
    return res.redirect(302, req.user && req.user.role === 'customer'
      ? `/account?auth_error=${safeCode}#profile`
      : `${loginPathFor(audience)}?auth_error=${safeCode}`);
  }
});

/**
 * §12.2 — the second factor at sign-in.
 *
 * Only a half-signed-in session can call this: the gate lets such a session
 * reach this one endpoint and nothing else. A wrong code is counted against
 * the session, and running out of tries kills the session outright rather
 * than leaving a first-factor foothold open to keep guessing on.
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
        redirect: auth.safeNextPath((req.body || {}).next) || signin.defaultRedirect(req.user.role),
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
      redirect: next_ || signin.defaultRedirect(req.user.role),
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
