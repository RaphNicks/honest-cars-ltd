'use strict';

/**
 * Auth endpoints — §7.1, mounted at /api/auth.
 *
 *   POST /api/auth/otp      request a login code (WhatsApp → SMS → console)
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
const db = require('../db');
const validate = require('../services/validate');
const roles = require('../services/roles');
const mfa = require('../services/mfa');
const { sendJson } = require('../lib/respond');

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

router.post('/otp', otpLimiter, async (req, res, next) => {
  try {
    const result = await auth.requestCode({
      rawPhone: (req.body || {}).phone,
      ip: req.ip,
      userAgent: req.get('user-agent'),
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

router.post('/verify', verifyLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await auth.verifyCode({
      rawPhone: body.phone,
      code: validate.text(body.code, 12),
      // §7.1 referrals: the invitation code rides along from /login?ref=…
      referralCode: validate.text(body.ref, 16),
      // §18.3: the sign-in box is consent to be contacted about this person's
      // own requests and orders — service contact, never marketing — recorded
      // only when it really came through, which is what the login page posts.
      consent: body.consent === '1' || body.consent === 'on' || body.consent === true,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (!result.ok) return sendJson(res, { ok: false, error: result.error }, { status: result.status });

    auth.setSessionCookie(res, result.token, { expiresAt: result.expiresAt });

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
        ? { required: true, next: `/login/mfa?next=${encodeURIComponent(auth.safeNextPath(body.next) || (roles.isStaff(result.user.role) ? '/admin' : '/account'))}` }
        : null,
      redirect: auth.safeNextPath(body.next) || '/account',
    });
  } catch (error) {
    return next(error);
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
