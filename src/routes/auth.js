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
      redirect: auth.safeNextPath(body.next) || '/account',
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
