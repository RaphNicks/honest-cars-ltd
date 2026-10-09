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
 *   GET  /dealer/billing             commission summary, statements and add-ons
 *   GET  /dealer/billing/statements/:month      one month, stated (§7.2 FR-18)
 *   GET  /dealer/billing/statements/:month.pdf  the same statement as a PDF
 *   POST /dealer/addons/:slug        buy an add-on — raises the purchase + payment
 *   GET  /dealer/addons/purchase/:reference     where to pay it, and what it does
 *   GET  /dealer/profile             lot details, tier and the signed agreement
 *   GET  /dealer/imports             bulk CSV import: template, dry run, keys (FR-33)
 *   POST /dealer/imports             check a pasted/uploaded file — apply only if asked
 *   GET  /dealer/imports/template.csv the header, and one row showing every column
 *   POST /dealer/imports/keys        issue an API key for this lot (shown once)
 *   POST /dealer/imports/keys/:id/revoke   cut a key off
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
const addonService = require('../services/addons');
const statementService = require('../services/statement');
const imports = require('../services/imports');
const dealerApi = require('../services/dealer-api');

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
  statements: `${HOME}/billing/statements`,
  addons: `${HOME}/addons`,
  profile: `${HOME}/profile`,
  imports: `${HOME}/imports`,
};

const NAV = [
  { href: PATHS.dashboard, label: 'Dashboard', icon: 'chart' },
  { href: PATHS.listings, label: 'My listings', icon: 'car' },
  { href: PATHS.newListing, label: 'Add a car', icon: 'plus' },
  { href: PATHS.leads, label: 'Leads', icon: 'inbox' },
  { href: PATHS.performance, label: 'Performance', icon: 'gauge' },
  { href: PATHS.billing, label: 'Commission', icon: 'scale' },
  { href: PATHS.addons, label: 'Add-ons', icon: 'plus' },
  { href: PATHS.imports, label: 'Import', icon: 'package' },
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

/**
 * FR-32 — the lot's own market and the areas inside it, for the area field.
 * A dealer in Aba is offered Aba's neighbourhoods, spelled the way the filter
 * rail spells them, so a car is filed where buyers will actually look for it.
 */
async function lotAreaOptions(lotId) {
  const market = await dealers.marketFor(lotId);
  const areas = await db.areas.areas({ cityName: market.city });
  return { market, areaNames: areas.map((area) => area.name) };
}

router.get('/listings/new', requireDealer, async (req, res, next) => {
  try {
    const { market, areaNames } = await lotAreaOptions(req.lot.id);
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
        market,
        areaOptions: areaNames,
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
    area: validate.text(body.area, 80) || null,
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
    const { market, areaNames } = await lotAreaOptions(req.lot.id);
    return await page(req, res, {
      view: 'dealer/listing',
      active: PATHS.listings,
      title: `${listing.stockNo} · ${listing.title}`,
      description: 'Price, mileage, copy, photos and the documents checklist.',
      data: { listing, shots: SHOT_LIST, rules: dealers.DEALER_STATUS_RULES, market, areaOptions: areaNames },
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
    const [statements, dashboard, months, purchases] = await Promise.all([
      dealers.statements(req.lot.id, { limit: 100 }),
      dealers.dashboard(req.lot.id),
      statementService.months(req.lot.id),
      db.addons.purchasesFor(req.lot.id, { limit: 50 }),
    ]);
    return await page(req, res, {
      view: 'dealer/billing',
      active: PATHS.billing,
      title: 'Commission',
      description: 'Append-only statements from the dealer ledger — a balance is the sum of the rows.',
      data: { statements, commission: dashboard.commission, months, purchases },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Commission statements — FR-18, §7.2 “statements per closed deal”
// ---------------------------------------------------------------------------
router.get('/billing/statements/:month', requireDealer, async (req, res, next) => {
  try {
    const month = String(req.params.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return next();
    const statement = await statementService.build(req.lot.id, month);
    if (!statement) return next();
    return await page(req, res, {
      view: 'dealer/statement',
      active: PATHS.billing,
      title: `Statement — ${statement.label}`,
      description: `Commission statement for ${statement.label}: opening balance, every entry, closing balance.`,
      data: { statement },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/billing/statements/:month.pdf', requireDealer, async (req, res, next) => {
  try {
    const month = String(req.params.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return next();
    const statement = await statementService.build(req.lot.id, month);
    if (!statement) return next();
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${statementService.fileName(statement)}"`);
    res.set('Cache-Control', CACHE.private);
    const doc = statementService.pdf(statement);
    doc.pipe(res);
    doc.end();
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Add-ons — FR-18, §7.2 “pay for add-on services … via PSP”
// ---------------------------------------------------------------------------
router.get('/addons', requireDealer, async (req, res, next) => {
  try {
    const [catalogue, purchases, listings] = await Promise.all([
      db.addons.catalogue(),
      db.addons.purchasesFor(req.lot.id, { limit: 50 }),
      dealers.listings(req.lot.id, { limit: 60 }).catch(() => []),
    ]);
    return await page(req, res, {
      view: 'dealer/addons',
      active: PATHS.addons,
      title: 'Add-ons',
      description: 'Media shoots, featured placement and market intelligence — paid by transfer until a card processor is live.',
      data: {
        catalogue,
        purchases,
        // Only cars an add-on may be bought for: a sold car cannot be shot.
        listings: (Array.isArray(listings) ? listings : []).filter((car) => ['draft', 'in_review', 'live', 'reserved'].includes(car.status)),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/addons/:slug', requireDealer, async (req, res, next) => {
  try {
    const listingId = Number.parseInt(req.body.listing_id, 10);
    const result = await addonService.purchase({
      dealerId: req.lot.id,
      addonSlug: String(req.params.slug || '').toLowerCase().slice(0, 60),
      listingId: Number.isFinite(listingId) ? listingId : null,
      actorId: req.user.id,
      customerName: req.user.name || req.lot.name,
      customerPhone: req.lot.phone || req.user.phone || null,
    });
    if (!result.ok) return done(res, PATHS.addons, result.error, { error: true });
    return done(res, result.purchase.url, `${result.purchase.addonName} reserved — pay against ${result.payment.reference} and it goes live the moment the money lands.`);
  } catch (error) {
    return next(error);
  }
});

router.get('/addons/purchase/:reference', requireDealer, async (req, res, next) => {
  try {
    const reference = String(req.params.reference || '').toUpperCase().slice(0, 24);
    if (!/^HC-ADD-\d{4,}$/.test(reference)) return next();
    const purchase = await db.addons.purchaseByReference(reference);
    if (!purchase || Number(purchase.dealerId) !== Number(req.lot.id)) return next();

    // The payment the purchase was raised with — the page has to show what to
    // pay, not just what was bought.
    const payment = purchase.paymentId ? await db.payments.paymentById(purchase.paymentId) : null;
    return await page(req, res, {
      view: 'dealer/addon-purchase',
      active: PATHS.addons,
      title: `${purchase.addonName} — ${purchase.reference}`,
      description: 'What this add-on does, what it costs, and how to pay it.',
      data: { purchase, payment, bank: addonService.bank(purchase.paymentReference || reference) },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Bulk import — FR-33. The whole point is the dry run: nothing is written until
// the dealer has seen what would be written, row by row.
// ---------------------------------------------------------------------------
const IMPORT_BODY = express.urlencoded({ extended: false, limit: '512kb' });

router.get('/imports', requireDealer, async (req, res, next) => {
  try {
    const keys = await dealerApi.keysFor(req.lot.id);
    return await page(req, res, {
      view: 'dealer/imports',
      active: PATHS.imports,
      title: 'Bulk import',
      description: 'Import a spreadsheet of cars as drafts, with a dry run first, or wire your own tooling up with an API key.',
      data: {
        fields: imports.fieldGuide(),
        maxRows: imports.MAX_ROWS,
        maxPhotos: imports.MAX_PHOTOS,
        keys,
        keyPrefix: dealerApi.KEY_PREFIX,
        csv: '',
        report: null,
        newKey: null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/imports/template.csv', requireDealer, (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="honestcars-listing-import-template.csv"');
  res.set('Cache-Control', CACHE.private);
  return res.send(imports.template());
});

router.post('/imports', requireDealer, auth.sameOriginOnly, IMPORT_BODY, async (req, res, next) => {
  try {
    const text = typeof req.body.csv === 'string' ? req.body.csv : '';
    const apply = String(req.body.mode || 'dry') === 'apply';
    const keys = await dealerApi.keysFor(req.lot.id);

    const report = await imports.run(text, { dealerId: req.lot.id, actorId: req.user.id, dryRun: !apply });
    return await page(req, res, {
      view: 'dealer/imports',
      active: PATHS.imports,
      title: 'Bulk import',
      description: 'The dry run’s findings, line by line.',
      data: {
        fields: imports.fieldGuide(),
        maxRows: imports.MAX_ROWS,
        maxPhotos: imports.MAX_PHOTOS,
        keys,
        keyPrefix: dealerApi.KEY_PREFIX,
        csv: text.slice(0, 200_000),
        report,
        newKey: null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/imports/keys', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const issued = await dealerApi.issue(req.lot.id, { label: validate.text(req.body.label, 80), actorId: req.user.id });
    const keys = await dealerApi.keysFor(req.lot.id);
    return await page(req, res, {
      view: 'dealer/imports',
      active: PATHS.imports,
      title: 'Bulk import',
      description: 'Your new API key — it is shown once.',
      data: {
        fields: imports.fieldGuide(),
        maxRows: imports.MAX_ROWS,
        maxPhotos: imports.MAX_PHOTOS,
        keys,
        keyPrefix: dealerApi.KEY_PREFIX,
        csv: '',
        report: null,
        newKey: issued.key,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/imports/keys/:id/revoke', requireDealer, auth.sameOriginOnly, async (req, res, next) => {
  try {
    const result = await dealerApi.revoke(req.lot.id, validate.integer(req.params.id, { min: 1, fallback: 0 }), { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.imports, result.error, { error: true });
    return done(res, PATHS.imports, result.already ? 'That key was already revoked.' : `“${result.key.label}” is revoked. Anything still using it stops working now.`);
  } catch (error) {
    return next(error);
  }
});

module.exports = { router };
