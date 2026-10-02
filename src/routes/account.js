'use strict';

/**
 * Customer account — §7.1.
 *
 *   GET  /login              phone + code entry (two steps, one page)
 *   GET  /account            dashboard: requests, hire, bookings, orders,
 *                            receipts, tracker subscriptions, saved cars,
 *                            saved searches, referrals
 *   GET  /account/export     NDPA right of access — one JSON file
 *   POST /api/account/saved-cars      save / unsave a car
 *   POST /api/account/saved-searches  save / delete a search, toggle alerts
 *   POST /api/account/profile         name, email, marketing opt-in
 *   POST /api/account/delete          NDPA right to erasure
 *
 * Every page here is noindex,nofollow and never publicly cacheable.
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../services/auth');
const roles = require('../services/roles');
const validate = require('../services/validate');
const listingQuery = require('../services/listing-query');
const { helpers } = require('../lib/locals');
const { sendPage, sendJson, CACHE } = require('../lib/respond');

const router = express.Router();

const DASHBOARD_PATH = '/account';

function loginLocals({ next, reason, ref: referralCode } = {}) {
  return {
    view: 'login',
    page: {
      title: 'Sign in',
      metaTitle: 'Sign in',
      titleSuffix: true,
      description: 'Sign in with your phone number — an OTP on WhatsApp, no password to remember. Requests, bookings, orders and saved cars in one place.',
      canonical: '/login',
      robots: 'noindex,nofollow',
      breadcrumbs: [{ label: 'Sign in' }],
      bodyClass: 'page-login',
      jsonLd: [],
    },
    data: {
      next: typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next.slice(0, 300) : '',
      reason: validate.text(reason, 80) || null,
      ref: validate.text(referralCode, 16).toUpperCase(),
      trail: [{ label: 'Sign in' }],
      otp: {
        length: config.auth.otpLength,
        ttlMinutes: config.auth.otpTtlMinutes,
        provider: config.auth.provider,
        whatsappLink: `https://wa.me/${config.business.whatsapp}?text=${encodeURIComponent('Hi HonestCars, I cannot receive the login code.')}`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// /login
// ---------------------------------------------------------------------------
router.get('/login', async (req, res, next) => {
  try {
    if (req.user) return res.redirect(302, auth.safeNextPath(req.query.next) || DASHBOARD_PATH);
    return await sendPage(req, res, {
      ...loginLocals({ next: req.query.next, reason: req.query.reason, ref: req.query.ref }),
      routePath: '/login',
      cache: CACHE.private,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /account — the dashboard
// ---------------------------------------------------------------------------
/**
 * Saved searches are stored as the raw querystring. Show them the way the
 * site shows filters everywhere else — as labelled chips — and keep the raw
 * string for the link target.
 */
function savedSearchChips(searches) {
  const withChips = searches.map((search) => {
    let chips = [];
    try {
      const parsed = new URLSearchParams(search.query.startsWith('?') ? search.query.slice(1) : search.query);
      const { view } = listingQuery.parseListingQuery(Object.fromEntries(parsed.entries()));
      chips = listingQuery.activeFilterPills(view, helpers()).map((pill) => `${pill.label}: ${pill.value}`);
    } catch {
      chips = [];
    }
    return { ...search, chips };
  });
  return withChips;
}

async function buildAccountLocals(user) {
  const dashboard = await db.users.dashboard(user);
  dashboard.savedSearches = savedSearchChips(dashboard.savedSearches);
  // §7.1 lists hire separately, so it does not also sit in the Requests card.
  dashboard.requests = dashboard.requests.filter((request) => request.type !== 'hire');
  const trail = [{ label: 'Account' }];

  // Staff land here too. Point them at the bit of the console their role
  // actually opens rather than at a module they will be refused (§7.4).
  const consoleHome = roles.can(user.role, 'reports.view')
    ? '/admin'
    : roles.can(user.role, 'bookings.own_jobs')
      ? '/admin/jobs'
      : null;

  return {
    view: 'account',
    page: {
      title: user.name ? `${user.shortName}'s account` : 'Your account',
      metaTitle: 'Your account',
      titleSuffix: true,
      description: 'Your requests, bookings, orders, saved cars and tracker subscriptions — keyed to your phone number.',
      canonical: DASHBOARD_PATH,
      robots: 'noindex,nofollow',
      breadcrumbs: trail,
      bodyClass: 'page-account',
      jsonLd: [],
    },
    data: { ...dashboard, trail, user, consoleHome },
  };
}

router.get('/account', async (req, res, next) => {
  try {
    if (!req.user) {
      const reason = req.sessionEnded ? '&reason=expired' : '';
      return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || DASHBOARD_PATH)}${reason}`);
    }
    const locals = await buildAccountLocals(req.user);
    return await sendPage(req, res, {
      ...locals,
      routePath: DASHBOARD_PATH,
      // Personalised: never cached, never served from the static bundle.
      cache: CACHE.private,
    });
  } catch (error) {
    return next(error);
  }
});

/** NDPA right of access (§12.2): everything keyed to this phone, as a download. */
router.get('/account/export', auth.requireUser, async (req, res, next) => {
  try {
    const payload = await db.users.exportData(req.user.id);
    res.status(200);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="honestcars-account-${req.user.id}.json"`);
    res.set('Cache-Control', CACHE.private);
    return res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    return next(error);
  }
});

/** NDPA right to erasure: anonymise the operational records, delete the account. */
router.post('/api/account/delete', auth.sameOriginOnly, auth.requireUser, async (req, res, next) => {
  try {
    const confirm = validate.text((req.body || {}).confirm, 20).toLowerCase();
    if (confirm !== 'delete') {
      return sendJson(res, { ok: false, error: 'Type “delete” to confirm you want the account closed.' }, { status: 422 });
    }
    await db.analytics.record('account_deleted', { payload: { source: 'account' }, sourcePath: '/account' }).catch(() => {});
    await db.users.deleteAccount(req.user.id);
    auth.clearSessionCookie(res);
    return sendJson(res, { ok: true, redirect: '/?account=deleted' });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Saved cars (§7.1) — also the target of the “save” button on cards and the VDP
// ---------------------------------------------------------------------------
router.post('/api/account/saved-cars', auth.sameOriginOnly, auth.requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const listingId = validate.integer(body.listingId, { min: 1, fallback: 0 });
    if (!listingId) return sendJson(res, { ok: false, error: 'That listing could not be found.' }, { status: 422 });

    const listing = await db.listings.findByIds([listingId]);
    if (!listing.length) return sendJson(res, { ok: false, error: 'That car is no longer listed.' }, { status: 404 });

    const action = body.action === 'remove' ? 'remove' : 'add';
    const ids = action === 'remove'
      ? await db.users.removeSavedCar(req.user.id, listingId)
      : await db.users.addSavedCar(req.user.id, listingId, validate.text(body.note, 200) || null);

    await db.analytics
      .record(action === 'remove' ? 'saved_car_removed' : 'saved_car_added', {
        payload: { listing_id: listingId, source: validate.text(body.source, 40) || 'card' },
        sourcePath: validate.text(body.sourcePath, 200) || '/cars',
      })
      .catch(() => {});

    return sendJson(res, { ok: true, saved: action === 'add', count: ids.length, savedIds: ids });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Saved searches (§7.1, event name saved_search_created per §15.1)
// ---------------------------------------------------------------------------
router.post('/api/account/saved-searches', auth.sameOriginOnly, auth.requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const action = validate.oneOf(body.action, ['add', 'delete', 'toggle'], 'add');

    if (action === 'delete') {
      const id = validate.integer(body.id, { min: 1, fallback: 0 });
      if (!id) return sendJson(res, { ok: false, error: 'That saved search no longer exists.' }, { status: 422 });
      await db.users.deleteSavedSearch(req.user.id, id);
      return sendJson(res, { ok: true, deleted: true });
    }

    if (action === 'toggle') {
      const id = validate.integer(body.id, { min: 1, fallback: 0 });
      if (!id) return sendJson(res, { ok: false, error: 'That saved search no longer exists.' }, { status: 422 });
      // §7.1: price-drop and new-match are separate switches. `alertsEnabled`
      // is still accepted so the master toggle keeps working.
      const priceDrop = body.priceDrop === undefined ? (body.alertsEnabled === undefined ? undefined : Boolean(body.alertsEnabled)) : Boolean(body.priceDrop);
      const newMatch = body.newMatch === undefined ? (body.alertsEnabled === undefined ? undefined : Boolean(body.alertsEnabled)) : Boolean(body.newMatch);
      await db.users.setSearchAlerts(req.user.id, id, { priceDrop, newMatch });
      const [saved] = (await db.users.savedSearches(req.user.id)).filter((row) => row.id === id);
      return sendJson(res, { ok: true, savedSearch: saved || null });
    }

    const queryString = validate.text(body.query, 300).replace(/^\?/, '');
    const label = validate.text(body.label, 120) || 'Saved search';
    if (!queryString) return sendJson(res, { ok: false, error: 'Apply a filter first, then save it.' }, { status: 422 });

    const saved = await db.users.addSavedSearch(req.user.id, {
      label,
      query: queryString,
      alertsEnabled: body.alertsEnabled !== false,
      priceDrop: body.priceDrop !== false,
      newMatch: body.newMatch !== false,
    });

    await db.analytics
      .record('saved_search_created', {
        payload: { source: 'account', query: queryString.slice(0, 120) },
        sourcePath: '/cars',
      })
      .catch(() => {});

    return sendJson(res, { ok: true, savedSearch: saved });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Profile — name, email, marketing opt-in (consent captured explicitly)
// ---------------------------------------------------------------------------
router.post('/api/account/profile', auth.sameOriginOnly, auth.requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = body.name === undefined ? undefined : validate.name(body.name);
    if (body.name !== undefined && !name) {
      return sendJson(res, { ok: false, error: 'Please use at least two characters for your name.' }, { status: 422 });
    }

    let email;
    if (body.email !== undefined) {
      email = validate.text(body.email, 160).toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return sendJson(res, { ok: false, error: 'That email address does not look right.' }, { status: 422 });
      }
    }

    const user = await db.users.updateProfile(req.user.id, {
      name,
      email,
      marketingOptIn: body.marketingOptIn === undefined ? undefined : Boolean(body.marketingOptIn),
    });

    return sendJson(res, { ok: true, user: { name: user.name, email: user.email, marketingOptIn: user.marketingOptIn } });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router, buildAccountLocals, loginLocals, DASHBOARD_PATH };
