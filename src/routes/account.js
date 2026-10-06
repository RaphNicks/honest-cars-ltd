'use strict';

/**
 * Customer account — §7.1.
 *
 *   GET  /login              phone + code entry (two steps, one page)
 *   GET  /account            dashboard: requests, hire, bookings, orders,
 *                            receipts, tracker subscriptions, saved cars,
 *                            saved searches, referrals
 *   GET  /account/export     NDPA right of access — one JSON file
 *   GET  /account/receipts/:reference      a receipt for money paid (§7.3)
 *   GET  /account/reports/:reference       the inspection report (FR-07)
 *   GET  /account/reports/:reference.pdf   the same report as a PDF
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
const reportService = require('../services/report');
const hireService = require('../services/hire');
const invoiceService = require('../services/invoice');
const paymentService = require('../services/payments');
const phone = require('../lib/phone');
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

/**
 * A receipt, owned by the phone number that paid. Anyone can type a reference
 * into the URL bar; only the phone it belongs to gets the page.
 */
router.get('/account/receipts/:reference', auth.requireUser, async (req, res, next) => {
  try {
    const reference = String(req.params.reference || '').toUpperCase().slice(0, 32);
    if (!/^HC-PAY-\d{6}$/.test(reference)) return next();
    const receipt = await db.payments.receiptForPhone(reference, req.user.phone);
    if (!receipt) {
      return await sendPage(req, res, {
        view: 'error',
        status: 404,
        cache: CACHE.private,
        page: {
          title: 'Receipt not found',
          metaTitle: 'Receipt not found',
          canonical: `/account/receipts/${reference}`,
          robots: 'noindex,nofollow',
          bodyClass: 'page-error',
          jsonLd: [],
        },
        data: { reason: 'not-found', detail: 'That reference is not on this account.' },
      });
    }
    return await sendPage(req, res, {
      routePath: `/account/receipts/${reference}`,
      view: 'receipt',
      cache: CACHE.private,
      page: {
        title: `Receipt ${reference}`,
        metaTitle: `Receipt ${reference}`,
        titleSuffix: false,
        description: 'A receipt for a payment made to Honest Cars Ltd.',
        canonical: `/account/receipts/${reference}`,
        robots: 'noindex,nofollow',
        breadcrumbs: [{ label: 'Account', href: '/account' }, { label: reference }],
        bodyClass: 'page-receipt',
        jsonLd: [],
      },
      data: { receipt, trail: [{ label: 'Account', href: '/account' }, { label: reference }] },
    });
  } catch (error) {
    return next(error);
  }
});

/** The bank account a renewal is paid into until a PSP is live (§11, §18). */
function bankDetails(reference) {
  return {
    name: config.business.bankAccountName,
    bank: config.business.bankName,
    account: config.business.bankAccount,
    note: reference
      ? `Use ${reference} as the transfer narration so we match it in seconds.`
      : 'Use the renewal reference as the transfer narration so we match it in seconds.',
  };
}

/**
 * Ownership check for anything keyed on a subscription id.
 *
 * A subscription is the customer's own record, so this is the whole
 * authorisation story: the id is in the URL, and the phone number on the row
 * has to be the signed-in account's. Anyone can type an id; only its owner gets
 * past here.
 */
async function ownedSubscription(user, id) {
  const subscription = await db.subscriptions.byId(id);
  if (!subscription || !subscription.phone) return null;
  const shapes = phone.variants(user.phone);
  const stored = phone.canonical(subscription.phone);
  return shapes.includes(stored) ? subscription : null;
}

/**
 * POST /account/subscriptions/:id/renew — §7.3 “online renewals”, FR-20.
 *
 * Raises the renewal payment and sends the customer to the page that says how
 * to pay it. Nothing is charged here and the renewal date does not move until
 * the money is confirmed: `db.payments.markPaid` extends the subscription
 * inside the same transaction that marks the payment paid, so there is no path
 * that grants the year without the payment (and none that takes the payment
 * without granting it).
 */
router.post('/account/subscriptions/:id/renew', auth.sameOriginOnly, auth.requireUser, async (req, res, next) => {
  try {
    const back = '/account#subscriptions';
    const subscription = await ownedSubscription(req.user, req.params.id);
    if (!subscription) return res.redirect(303, `${back}?err=${encodeURIComponent('That subscription is not on this account.')}`);
    if (subscription.deviceState === 'cancelled') {
      return res.redirect(303, `${back}?err=${encodeURIComponent('That subscription has been cancelled — message us and we will restart it.')}`);
    }

    const quote = await db.subscriptions.renewalQuote(subscription.id);
    if (!quote.ok) return res.redirect(303, `${back}?err=${encodeURIComponent(quote.error)}`);

    // A renewal already raised and still unpaid is reused rather than
    // duplicated: two pending references for one year is two chances to pay
    // twice, and the customer has only ever seen one.
    if (subscription.paymentId && subscription.paymentStatus === 'pending' && subscription.paymentReference) {
      return res.redirect(303, `/account/renewals/${subscription.paymentReference}`);
    }

    const raised = await paymentService.initiate({
      purpose: 'subscription',
      amountKobo: quote.amountKobo,
      subscriptionId: subscription.id,
      customerName: subscription.customerName,
      customerPhone: subscription.phone,
    });
    if (!raised.ok) return res.redirect(303, `${back}?err=${encodeURIComponent(raised.error || 'That renewal could not be raised.')}`);

    if (raised.hosted && raised.checkoutUrl) return res.redirect(303, raised.checkoutUrl);
    return res.redirect(303, `/account/renewals/${raised.reference}`);
  } catch (error) {
    return next(error);
  }
});

/**
 * GET /account/renewals/:reference — what the customer keeps while the transfer
 * is in flight. Private to the phone number that owns it, noindex, no-store.
 */
router.get('/account/renewals/:reference', auth.requireUser, async (req, res, next) => {
  try {
    const reference = String(req.params.reference || '').toUpperCase().slice(0, 32);
    if (!/^HC-PAY-\d{6}$/.test(reference)) return next();

    const receipt = await db.payments.receiptForPhone(reference, req.user.phone);
    if (!receipt) {
      return await sendPage(req, res, {
        view: 'error',
        status: 404,
        cache: CACHE.private,
        page: {
          title: 'Renewal not found',
          metaTitle: 'Renewal not found',
          canonical: `/account/renewals/${reference}`,
          robots: 'noindex,nofollow',
          bodyClass: 'page-error',
          jsonLd: [],
        },
        data: { reason: 'not-found', detail: 'That reference is not on this account.' },
      });
    }

    const payment = receipt.payment;
    const subscription = payment.subscriptionId ? await db.subscriptions.byId(payment.subscriptionId) : null;

    return await sendPage(req, res, {
      routePath: `/account/renewals/${reference}`,
      view: 'renewal',
      cache: CACHE.private,
      page: {
        title: `Renewal ${reference}`,
        metaTitle: `Renewal ${reference}`,
        titleSuffix: false,
        description: 'A subscription renewal and how to pay it.',
        canonical: `/account/renewals/${reference}`,
        robots: 'noindex,nofollow',
        breadcrumbs: [{ label: 'Account', href: '/account' }, { label: reference }],
        bodyClass: 'page-order',
        jsonLd: [],
      },
      data: {
        payment,
        subscription,
        bank: bankDetails(reference),
        trail: [{ label: 'Account', href: '/account' }, { label: reference }],
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * FR-22 — the customer's own hire, owned by the phone on the booking.
 *
 * Anyone can type HC-HIRE-0001 into the URL bar; only the number the hire was
 * quoted to gets the page, the same rule as receipts and renewals.
 */
async function ownedHire(user, reference) {
  const booking = await db.hire.bookingByReference(reference);
  if (!booking) return null;
  const shapes = require('../lib/phone').variants(user.phone);
  const stored = booking.phone ? require('../lib/phone').canonical(booking.phone) : null;
  if (!stored || !shapes.includes(stored)) return null;
  return booking;
}

router.get('/account/hire/:reference', auth.requireUser, async (req, res, next) => {
  try {
    const reference = String(req.params.reference || '').toUpperCase().slice(0, 24);
    if (!/^HC-HIRE-\d{4,}$/.test(reference)) return next();
    const booking = await ownedHire(req.user, reference);
    if (!booking) {
      return await sendPage(req, res, {
        view: 'error',
        status: 404,
        cache: CACHE.private,
        page: {
          title: 'Hire not found',
          metaTitle: 'Hire not found',
          canonical: `/account/hire/${reference}`,
          robots: 'noindex,nofollow',
          bodyClass: 'page-error',
          jsonLd: [],
        },
        data: { reason: 'not-found', detail: 'That hire is not on this account.' },
      });
    }

    const doc = await invoiceService.build(booking.id);
    const trail = [{ label: 'Account', href: '/account' }, { label: reference }];
    return await sendPage(req, res, {
      routePath: `/account/hire/${reference}`,
      view: 'hire-booking',
      cache: CACHE.private,
      page: {
        title: `Hire ${reference}`,
        metaTitle: `Hire ${reference}`,
        titleSuffix: false,
        description: 'Your car hire, what it costs and how to pay it.',
        canonical: `/account/hire/${reference}`,
        robots: 'noindex,nofollow',
        breadcrumbs: trail,
        bodyClass: 'page-order',
        jsonLd: [],
      },
      data: {
        booking,
        doc,
        bank: bankDetails(booking.paymentReference || reference),
        trail,
        // Accepting is only on offer while the hire is still a decision; once it
        // is paid or finished the page is a record, not a form.
        canAccept: ['requested', 'quoted', 'accepted'].includes(booking.status),
        invoiceUrl: doc && doc.ready ? `/account/hire/${reference}/invoice.pdf` : null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/** Accept the quote, and raise the payment for it in the same step. */
router.post('/account/hire/:reference/accept', auth.sameOriginOnly, auth.requireUser, async (req, res, next) => {
  try {
    const reference = String(req.params.reference || '').toUpperCase().slice(0, 24);
    const booking = await ownedHire(req.user, reference);
    if (!booking) return res.redirect(303, `/account?err=${encodeURIComponent('That hire is not on this account.')}`);
    if (['confirmed', 'on_hire', 'completed'].includes(booking.status)) {
      return res.redirect(303, `/account/hire/${reference}`);
    }
    if (booking.status === 'cancelled') {
      return res.redirect(303, `/account/hire/${reference}?err=${encodeURIComponent('That hire was cancelled — message us if you want it back.')}`);
    }

    const result = await hireService.accept(booking.id, { actorId: null });
    if (!result.ok) {
      return res.redirect(303, `/account/hire/${reference}?err=${encodeURIComponent(result.error || 'That quote could not be accepted.')}`);
    }
    if (result.hosted && result.checkoutUrl) return res.redirect(303, result.checkoutUrl);
    return res.redirect(303, `/account/hire/${reference}?ok=${encodeURIComponent('Accepted — pay with the reference below and the car is held the moment it lands.')}`);
  } catch (error) {
    return next(error);
  }
});

/** J6 “completion + invoice PDF”, from the customer's side of it. */
router.get('/account/hire/:reference/invoice.pdf', auth.requireUser, async (req, res, next) => {
  try {
    const booking = await ownedHire(req.user, req.params.reference);
    if (!booking) return res.status(404).json({ ok: false, error: 'Not found' });
    const doc = await invoiceService.build(booking.id);
    if (!doc || !doc.ready) {
      return res.status(409).json({ ok: false, error: 'Your invoice appears once the hire is confirmed.' });
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${invoiceService.fileName(doc)}"`,
      'Cache-Control': 'private, no-store',
    });
    return invoiceService.pdf(doc).pipe(res);
  } catch (error) {
    return next(error);
  }
});

/** The inspection report behind one of this customer's bookings (FR-07). */
async function ownedReport(user, reference) {
  const booking = await db.queryOne('SELECT id, reference, phone FROM bookings WHERE reference = ? LIMIT 1', [String(reference || '').toUpperCase().slice(0, 32)]);
  if (!booking) return null;
  const shapes = require('../lib/phone').variants(user.phone);
  const stored = booking.phone ? require('../lib/phone').canonical(booking.phone) : null;
  if (!stored || !shapes.includes(stored)) return null;
  return reportService.build(booking.id);
}

router.get('/account/reports/:reference', auth.requireUser, async (req, res, next) => {
  try {
    const built = await ownedReport(req.user, req.params.reference);
    if (!built) return next();
    return await sendPage(req, res, {
      routePath: `/account/reports/${built.reference}`,
      view: 'report-inspection',
      cache: CACHE.private,
      page: {
        title: `Inspection report ${built.reference}`,
        metaTitle: `Inspection report ${built.reference}`,
        titleSuffix: false,
        description: 'The pre-purchase inspection report for your booking.',
        canonical: `/account/reports/${built.reference}`,
        robots: 'noindex,nofollow',
        breadcrumbs: [{ label: 'Account', href: '/account' }, { label: built.reference }],
        bodyClass: 'page-report',
        jsonLd: [],
      },
      data: {
        report: built,
        pdfUrl: built.ready ? `/account/reports/${built.reference}.pdf` : null,
        backHref: '/account',
        backLabel: 'Back to your account',
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/account/reports/:reference.pdf', auth.requireUser, async (req, res, next) => {
  try {
    const built = await ownedReport(req.user, req.params.reference);
    if (!built) return res.status(404).json({ ok: false, error: 'Not found' });
    if (!built.ready) return res.status(409).json({ ok: false, error: 'The checklist has not been filed yet.' });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${reportService.fileName(built)}"`,
      'Cache-Control': 'private, no-store',
    });
    return reportService.pdf(built).pipe(res);
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
