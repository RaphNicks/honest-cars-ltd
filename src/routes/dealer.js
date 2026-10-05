'use strict';

/**
 * Dealer partner portal — §7.2 (“SHOULD, phase-2 hard requirement”).
 *
 *   GET  /dealer                     entry: signed out → the partner pitch,
 *                                    signed in as a dealer → the dashboard
 *   GET  /dealer/dashboard           live listings, leads, views, pending actions, commission
 *   GET  /dealer/listings            all of this lot's stock, with quick actions
 *   GET  /dealer/listings/new        the mobile-first add-a-car wizard
 *   POST /dealer/listings            create the draft (returns to the wizard step 2)
 *   GET  /dealer/listings/:id        one car: price, mileage, copy, photos, documents
 *   POST /dealer/listings/:id        save the edit
 *   POST /dealer/listings/:id/status submit for review / withdraw / reserved / sold
 *   POST /dealer/listings/:id/photos add or remove a photo
 *   POST /dealer/listings/:id/fresh  confirm the car is still current (freshness nudge)
 *   GET  /dealer/leads               enquiries on this lot's cars
 *   POST /dealer/leads/:id           move a lead through contacted/viewing/closed/lost
 *   GET  /dealer/performance         views, enquiries, response time, freshness scorecard
 *   GET  /dealer/billing             commission statements from the dealer ledger
 *   GET  /dealer/profile             lot details, tier and the signed agreement
 *
 * Authorisation is one idea: the lot comes from the signed-in account's own row
 * (`db.dealers.forUser`), and every query is scoped by that id. A dealer can
 * never reach another lot's stock or enquiries, and a listing only goes live
 * through the §7.3 moderation queue — the dealer submits, ops publishes.
 */

const express = require('express');
const db = require('../db');
const auth = require('../services/auth');
const roles = require('../services/roles');
const validate = require('../services/validate');
const { sendPrebuiltOrRender, sendPage, CACHE } = require('../lib/respond');
const { helpers } = require('../lib/locals');

const router = express.Router();
const dealers = db.dealers;

const HOME = '/dealer';
const PATHS = {
  home: HOME,
  dashboard: `${HOME}/dashboard`,
  listings: `${HOME}/listings`,
  newListing: `${HOME}/listings/new`,
  leads: `${HOME}/leads`,
  performance: `${HOME}/performance`,
  billing: `${HOME}/billing`,
  profile: `${HOME}/profile`,
};

const NAV = [
  { href: PATHS.dashboard, label: 'Dashboard', icon: 'chart' },
  { href: PATHS.listings, label: 'My listings', icon: 'car' },
  { href: PATHS.newListing, label: 'Add a car', icon: 'plus' },
  { href: PATHS.leads, label: 'Leads', icon: 'inbox' },
  { href: PATHS.performance, label: 'Performance', icon: 'gauge' },
  { href: PATHS.billing, label: 'Commission', icon: 'scale' },
  { href: PATHS.profile, label: 'Profile', icon: 'store' },
];

/** §7.2 guided shot list — the wizard asks for these in this order. */
const SHOT_LIST = [
  ['front', 'Front three-quarter', 'Stand at the front corner, car filling the frame'],
  ['rear', 'Rear three-quarter', 'The other rear corner — shows panel alignment'],
  ['interior', 'Interior', 'Driver’s door open, seats and dashboard visible'],
  ['dash', 'Dashboard', 'Ignition on, warning lights visible'],
  ['odometer', 'Odometer', 'Close enough to read the mileage'],
  ['engine', 'Engine bay', 'Bonnet open, from the front'],
];

const SHIFT = 6; // hours a photo-based beta can claim ops will look at a lead

function capability() {
  return 'dealer.portal';
}

/**
 * The gate. Resolves the lot once per request; a dealer account with no lot is
 * told so honestly rather than shown an empty console.
 */
function requireDealer(req, res, next) {
  if (!req.user) {
    return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || HOME)}`);
  }
  if (req.user.role !== 'dealer' && !roles.can(req.user.role, 'reports.view')) {
    return forbidden(req, res);
  }
  return dealers
    .forUser(req.user.id)
    .then((lot) => {
      if (!lot) {
        if (req.user.role === 'dealer') {
          return sendPage(req, res, {
            routePath: req.path,
            view: 'dealer/unlinked',
            status: 200,
            cache: CACHE.private,
            page: {
              title: 'Your lot is not linked yet',
              metaTitle: 'Dealer portal',
              titleSuffix: true,
              description: 'Your dealer account exists — ops has not linked a lot to it yet.',
              canonical: HOME,
              robots: 'noindex,nofollow',
            },
            data: { help: helpers() },
          });
        }
        // Staff may look, but there is no lot to show — send them to the console.
        return res.redirect(302, '/admin/leads');
      }
      req.lot = lot;
      return next();
    })
    .catch(next);
}

/**
 * 403 for a signed-in account that is not a partner lot. Rendered rather than a
 * bare status: a customer who guesses /dealer should be told which role they
 * hold, and where their own pages are.
 */
function forbidden(req, res) {
  return sendPage(req, res, {
    routePath: req.path,
    view: 'error',
    status: 403,
    cache: 'no-store',
    page: {
      title: 'Not a partner account',
      metaTitle: 'No access | HonestCars',
      canonical: HOME,
      robots: 'noindex,nofollow',
    },
    data: { reason: 'forbidden', role: req.user ? req.user.role : 'customer' },
  });
}

function feedback(req) {
  return {
    ok: validate.text(req.query.ok, 200) || null,
    error: validate.text(req.query.err, 300) || null,
  };
}

function done(res, path, message, { error = false } = {}) {
  const key = error ? 'err' : 'ok';
  const sep = path.includes('?') ? '&' : '?';
  return res.redirect(303, `${path}${sep}${key}=${encodeURIComponent(message)}`);
}

async function page(req, res, { view, active, title, description, data = {}, status = 200 }) {
  const { ok, error } = feedback(req);
  // The portal reuses the console chrome — same nav pattern, different module.
  return sendPage(req, res, {
    routePath: req.path,
    view,
    status,
    cache: CACHE.private,
    page: {
      title,
      metaTitle: `${title} · Dealer portal`,
      titleSuffix: false,
      description: description || 'Honest Cars dealer partner portal.',
      canonical: active,
      robots: 'noindex,nofollow',
      bodyClass: 'page-admin page-dealer',
      layout: 'admin',
      jsonLd: [],
    },
    data: {
      admin: {
        nav: NAV,
        active,
        user: req.user,
        dealer: true,
        roleLabel: `Dealer · ${req.lot.name}`,
        brandHref: PATHS.dashboard,
        brandName: 'Dealer portal',
      },
      lot: req.lot,
      ok,
      error,
      ...data,
    },
  });
}

// ---------------------------------------------------------------------------
// /dealer — the entry point (§7.2 stub becomes a real door)
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    if (req.user && (req.user.role === 'dealer' || roles.can(req.user.role, 'reports.view'))) {
      const lot = await dealers.forUser(req.user.id);
      if (lot) return res.redirect(302, PATHS.dashboard);
    }
    // Signed out (or signed in as a customer): the public partner pitch. A
    // customer account is told, plainly, that this door is not theirs.
    return await sendPrebuiltOrRender(req, res, {
      routePath: HOME,
      view: 'dealer/landing',
      page: {
        title: 'Dealer portal',
        metaTitle: 'Dealer partner portal',
        titleSuffix: true,
        description:
          'Run your lot on honestcarsltd.com: your stock, your enquiries and your statements — with the honesty layer that makes buyers trust the listing.',
        canonical: HOME,
        robots: 'noindex,nofollow',
      },
      data: {
        trail: [{ label: 'Dealer portal' }],
        accountRole: req.user ? req.user.role : null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Dashboard (§7.2 — one screen)
// ---------------------------------------------------------------------------
router.get('/dashboard', requireDealer, async (req, res, next) => {
  try {
    const [dashboard, statements] = await Promise.all([
      dealers.dashboard(req.lot.id),
      dealers.statements(req.lot.id, { limit: 5 }),
    ]);
    return await page(req, res, {
      view: 'dealer/dashboard',
      active: PATHS.dashboard,
      title: 'Dashboard',
      description: 'Stock, enquiries, views, pending actions and commission in one screen.',
      data: { dashboard, statements, shift: SHIFT },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------
router.get('/listings', requireDealer, async (req, res, next) => {
  try {
    const status = validate.oneOf(req.query.status, ['draft', 'in_review', 'live', 'reserved', 'sold', 'expired'], null);
    const [rows, all] = await Promise.all([
      dealers.listings(req.lot.id, { status }),
      dealers.listings(req.lot.id),
    ]);
    const counts = all.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});
    return await page(req, res, {
      view: 'dealer/listings',
      active: PATHS.listings,
      title: 'My listings',
      description: 'Every car this lot has on the network, with the actions you can take on it.',
      data: { rows, status, counts, total: all.length },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/listings/new', requireDealer, async (req, res, next) => {
  try {
    return await page(req, res, {
      view: 'dealer/listing-new',
      active: PATHS.newListing,
      title: 'Add a car',
      description: 'Photograph first, then the specification — a draft saves as you go.',
      data: {
        shots: SHOT_LIST,
        draft: null,
        form: {},
        step: validate.integer(req.query.step, { min: 1, max: 3, fallback: 1 }),
      },
    });
  } catch (error) {
    return next(error);
  }
});

function listingInput(body) {
  const year = validate.integer(body.year, { min: 1990, max: new Date().getFullYear() + 1 });
  return {
    year,
    make: validate.text(body.make, 60),
    model: validate.text(body.model, 80),
    trim: validate.text(body.trim, 80),
    bodyType: validate.oneOf(body.body_type, ['sedan', 'suv', 'hatchback', 'pickup', 'bus', 'coupe', 'wagon', 'van'], 'sedan'),
    transmission: validate.oneOf(body.transmission, ['automatic', 'manual'], 'automatic'),
    fuelType: validate.oneOf(body.fuel_type, ['petrol', 'diesel', 'hybrid', 'electric', 'cng'], 'petrol'),
    engineSize: validate.text(body.engine_size, 20),
    drivetrain: validate.oneOf(body.drivetrain, ['fwd', 'rwd', 'awd', '4wd'], 'fwd'),
    extColour: validate.text(body.ext_colour, 40),
    condition: validate.oneOf(body.condition, ['tokunbo', 'nigerian_used', 'new'], 'nigerian_used'),
    mileageKm: validate.integer(body.mileage_km, { min: 0, max: 900000, fallback: 0 }),
    features: validate.text(body.features, 400)
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean)
      .slice(0, 12),
    priceKobo: validate.kobo(body.asking_price),
    negotiable: String(body.negotiable || '') === '1',
    area: validate.text(body.area, 80) || 'Port Harcourt',
    documents: {
      customs_verified: Boolean(body.customs_verified),
      registration: Boolean(body.registration),
      duty_sighted: Boolean(body.duty_sighted),
      tinted_permit: Boolean(body.tinted_permit),
    },
    description: validate.text(body.description, 4000),
    honestNote: validate.text(body.honest_note, 1000),
  };
}

router.post('/listings', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const input = listingInput(req.body);
    if (!input.make || !input.model || !input.year) {
      return done(res, PATHS.newListing, 'A car needs a make, a model and a year.', { error: true });
    }
    if (!input.priceKobo) {
      return done(res, PATHS.newListing, 'A car needs an asking price — buyers filter on it.', { error: true });
    }
    const created = await dealers.createListing(req.lot.id, input);

    // Step 1 of the wizard: a link per guided shot. A car with fewer than
    // three photos cannot be submitted, and the wizard says so on its page.
    const links = SHOT_LIST
      .map((shot) => ({ shot, url: validate.text(req.body[`photo_${shot[0]}`], 400) }))
      .filter((row) => /^(https?:\/\/|\/img\/)/i.test(row.url));
    for (const row of links) {
      await dealers.addPhoto(req.lot.id, created.id, {
        url: row.url,
        alt: `${input.year} ${input.make} ${input.model} — ${row.shot[1]}`,
        shot: row.shot[1],
      });
    }

    const message = links.length
      ? `Draft saved as ${created.stockNo} with ${links.length} photograph${links.length === 1 ? '' : 's'}. Check the listing, then send it for review.`
      : `Draft saved as ${created.stockNo}. Add at least three photographs, then send it for review.`;
    return done(res, `${PATHS.listings}/${created.id}`, message);
  } catch (error) {
    return next(error);
  }
});

router.get('/listings/:id', requireDealer, async (req, res, next) => {
  try {
    const listing = await dealers.listingForDealer(req.lot.id, validate.integer(req.params.id, { min: 1, fallback: 0 }));
    if (!listing) return done(res, PATHS.listings, 'That listing is not one of yours.', { error: true });
    return await page(req, res, {
      view: 'dealer/listing',
      active: PATHS.listings,
      title: `${listing.stockNo} · ${listing.title}`,
      description: 'Price, mileage, copy, photos and the documents checklist.',
      data: { listing, shots: SHOT_LIST, rules: dealers.DEALER_STATUS_RULES },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const input = listingInput(req.body);
    const result = await dealers.updateListing(req.lot.id, validate.integer(req.params.id, { min: 1, fallback: 0 }), input);
    if (!result.ok) return done(res, `${PATHS.listings}/${req.params.id}`, result.error, { error: true });
    const message = result.priceChanged
      ? `Saved. The price moved from ${helpers().formatNaira(result.previousPriceKobo)} to ${helpers().formatNaira(input.priceKobo)} — everyone watching it will be told on the next alert run.`
      : 'Saved.';
    return done(res, `${PATHS.listings}/${req.params.id}`, message);
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/status', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const to = validate.oneOf(req.body.status, ['draft', 'in_review', 'live', 'reserved', 'sold', 'expired'], null);
    if (!to) return done(res, `${PATHS.listings}/${req.params.id}`, 'Unknown status.', { error: true });
    const result = await dealers.setListingStatus(req.lot.id, validate.integer(req.params.id, { min: 1, fallback: 0 }), to);
    if (!result.ok) return done(res, `${PATHS.listings}/${req.params.id}`, result.error, { error: true });

    await db.query(
      'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, `dealer.listing.${to}`, 'listing', req.params.id,
        JSON.stringify({ lot: req.lot.name, from: result.from, to })],
    ).catch(() => {});

    const message = to === 'in_review'
      ? `${result.stockNo} is with the HonestCars team for review — it goes live once it is checked.`
      : to === 'sold'
        ? `${result.stockNo} marked sold. The page stays up for a week as social proof, then becomes an archive link.`
        : `${result.stockNo} is now ${to.replace('_', ' ')}.`;
    return done(res, `${PATHS.listings}/${req.params.id}`, message);
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/photos', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const listingId = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const action = validate.oneOf(req.body.action, ['add', 'remove'], 'add');
    const result = action === 'remove'
      ? await dealers.removePhoto(req.lot.id, listingId, validate.integer(req.body.media_id, { min: 1, fallback: 0 }))
      : await dealers.addPhoto(req.lot.id, listingId, {
        url: validate.text(req.body.url, 400),
        alt: validate.text(req.body.alt, 200) || null,
        shot: validate.text(req.body.shot, 40) || null,
      });
    if (!result.ok) return done(res, `${PATHS.listings}/${listingId}`, result.error, { error: true });
    return done(res, `${PATHS.listings}/${listingId}`, action === 'remove' ? 'Photo removed.' : 'Photo added.');
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/fresh', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const result = await dealers.confirmFresh(req.lot.id, validate.integer(req.params.id, { min: 1, fallback: 0 }));
    if (!result.ok) return done(res, PATHS.listings, result.error, { error: true });
    return done(res, PATHS.listings, `${result.stockNo} confirmed as still available — the freshness clock restarts.`);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
router.get('/leads', requireDealer, async (req, res, next) => {
  try {
    const status = validate.oneOf(req.query.status, dealers.DEALER_LEAD_STATUSES, null);
    const [rows, all] = await Promise.all([
      dealers.leads(req.lot.id, { status }),
      dealers.leads(req.lot.id),
    ]);
    const counts = all.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});
    return await page(req, res, {
      view: 'dealer/leads',
      active: PATHS.leads,
      title: 'Leads',
      description: 'Every enquiry about this lot’s cars, with the status you keep up to date.',
      data: { rows, status, counts, statuses: dealers.DEALER_LEAD_STATUSES, total: all.length, shift: SHIFT },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/leads/:id', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const status = validate.oneOf(req.body.status, dealers.DEALER_LEAD_STATUSES, null);
    if (!status) return done(res, PATHS.leads, 'Unknown lead status.', { error: true });
    const result = await dealers.setLeadStatus(
      req.lot.id,
      validate.integer(req.params.id, { min: 1, fallback: 0 }),
      status,
      validate.text(req.body.lost_reason, 200) || null,
    );
    if (!result.ok) return done(res, PATHS.leads, result.error, { error: true });
    const messages = {
      contacted: 'Marked contacted — ops can see the buyer has been answered.',
      viewing: 'Viewing arranged. Keep it updated so dispatch knows the car is in play.',
      closed: 'Closed. Well done — this feeds the lot’s response score.',
      lost: 'Marked lost, with the reason. That is more useful than a silent no.',
      new: 'Back in the inbox.',
    };
    return done(res, PATHS.leads, messages[status] || 'Lead updated.');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Profile & agreement (§7.2)
// ---------------------------------------------------------------------------
router.get('/profile', requireDealer, async (req, res, next) => {
  try {
    return await page(req, res, {
      view: 'dealer/profile',
      active: PATHS.profile,
      title: 'Profile & agreement',
      description: 'Lot details, tier, and the agreement the two sides signed.',
      data: {
        agreement: {
          ref: req.lot.agreementRef,
          url: req.lot.agreementUrl,
          signed: req.lot.agreementSigned ? String(req.lot.agreementSigned).slice(0, 10) : null,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Performance & commission
// ---------------------------------------------------------------------------
router.get('/performance', requireDealer, async (req, res, next) => {
  try {
    const performance = await dealers.performance(req.lot.id);
    return await page(req, res, {
      view: 'dealer/performance',
      active: PATHS.performance,
      title: 'Performance',
      description: 'Views, enquiries, how fast you answer, and which cars need a refresh.',
      data: { performance },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/billing', requireDealer, async (req, res, next) => {
  try {
    const [statements, dashboard] = await Promise.all([
      dealers.statements(req.lot.id, { limit: 100 }),
      dealers.dashboard(req.lot.id),
    ]);
    return await page(req, res, {
      view: 'dealer/billing',
      active: PATHS.billing,
      title: 'Commission',
      description: 'Append-only statements from the dealer ledger — a balance is the sum of the rows.',
      data: { statements, commission: dashboard.commission },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router };
