'use strict';

/**
 * Partner onboarding — §7.2, self-serve "become a partner".
 *
 *   GET  /become-a-partner   the application a signed-in account files to open
 *                            a brand-new partner lot.
 *   POST /become-a-partner   files the application; a human reviews it in the
 *                            console's Applications queue and approves or
 *                            declines (which opens the lot and makes them a
 *                            dealer, or tells them plainly why not).
 *
 * This screen is only for opening a NEW partnership. A partner who already runs
 * a lot edits their own lot from the portal (/dealer/lot) instead, and staff go
 * to the console. The two flows deliberately land on separate screens.
 */

const express = require('express');
const db = require('../db');
const auth = require('../services/auth');
const { sendPage, CACHE } = require('../lib/respond');

const router = express.Router();
const dealers = db.dealers;

const PATH = '/become-a-partner';

const TIER_OPTIONS = [
  { value: 'pilot', label: 'Pilot', hint: 'A small, curated lot. Start here if you have a handful of cars to offer.' },
  { value: 'standard', label: 'Standard', hint: 'A regular dealer lot with ongoing stock.' },
  { value: 'premium', label: 'Premium', hint: 'High volume and premium inventory.' },
];

// Signed-in, and (if they already run a lot or hold a staff/dealer role) pointed
// at the right place instead of filing a second "become a partner" application.
function divert(req) {
  if (!req.user || req.user.role === 'customer') return null;
  return req.user.role === 'dealer' ? '/dealer' : '/admin';
}

router.get(PATH, auth.requireUser, async (req, res, next) => {
  try {
    const home = divert(req);
    if (home) return res.redirect(303, home);
    const existingLot = await dealers.forUser(req.user.id);
    if (existingLot) return res.redirect(303, '/dealer/lot');
    return await sendPage(req, res, {
      routePath: PATH,
      view: 'become-a-partner',
      status: 200,
      cache: CACHE.private,
      page: {
        title: 'Become a partner',
        metaTitle: 'Become a partner | Honest Cars',
        titleSuffix: false,
        description:
          'List your cars on Honest Cars. Tell us about your lot — a person, not a bot, reviews it and sets you up.',
        canonical: PATH,
        breadcrumbs: [{ label: 'Home', href: '/' }, { label: 'Become a partner', href: PATH }],
        bodyClass: 'page-become-a-partner',
        jsonLd: [],
      },
      data: {
        account: { name: req.user.name || '', phone: req.user.phone || '', email: req.user.email || '' },
        tierOptions: TIER_OPTIONS,
        ok: req.query.ok || null,
        err: req.query.err || null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post(PATH, auth.requireUser, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const home = divert(req);
    if (home) return res.redirect(303, home);
    const existingLot = await dealers.forUser(req.user.id);
    if (existingLot) return res.redirect(303, '/dealer/lot');

    const b = req.body;
    const result = await dealers.createApplication(
      {
        userId: req.user.id,
        type: 'new',
        lotName: b.lotName,
        city: b.city,
        lotArea: b.lotArea,
        tier: b.tier,
        contactName: b.contactName,
        phone: b.phone,
        email: b.email,
        website: b.website,
        notes: b.notes,
      },
      { actorId: req.user.id },
    );
    if (!result.ok) {
      return res.redirect(303, `${PATH}?err=${encodeURIComponent(result.error)}`);
    }
    const email = String(b.email || req.user.email || '').trim();
    const message = `Sent. A person will review it and reply ${email ? `to ${email}` : ''} with the outcome.`;
    return res.redirect(303, `${PATH}?ok=${encodeURIComponent(message)}`);
  } catch (error) {
    return next(error);
  }
});

module.exports = { router };
