'use strict';

/**
 * JSON endpoints.
 *
 *   POST /api/events             §15.1 client event batch → analytics_events
 *   POST /api/leads              every public form → leads (+ WhatsApp hand-off)
 *   POST /api/service-requests   §6.5/§6.6/§6.7 intake → service_requests + tracking id
 *   POST /api/bookings           §6.7 scheduled work → bookings + reference
 *   POST /api/orders             §6.8 guest checkout → orders + items (+ tracker subscriptions)
 *   POST /api/contact            §6.10 contact form → leads
 *   GET  /api/listings           filtered results for the AJAX filter update (§6.2)
 *   GET  /api/listings/compare   the ≤3 cars on /cars/compare (§6.4)
 *   GET  /api/posts              next 9 blog cards for “load more” (§6.9)
 *   POST /api/dealer/listings    bulk listing import for a lot, by API key (FR-33)
 *   GET  /api/og/listing/:slug.png   composited 1200×630 OG card (§12.4)
 *   GET  /api/health             liveness + database check
 */

const express = require('express');
const rateLimit = require('../lib/rate-limit');
const db = require('../db');
const config = require('../config');
const paymentService = require('../services/payments');
const concierge = require('../services/concierge');
const events = require('../services/events');
const validate = require('../services/validate');
const seo = require('../services/seo');
const og = require('../services/og');
const listingQuery = require('../services/listing-query');
const imports = require('../services/imports');
const dealerApi = require('../services/dealer-api');
const render = require('../lib/render');
const { sendJson, sendFragment, personalise, wantsLessData } = require('../lib/respond');
const { helpers } = require('../lib/locals');

const router = express.Router();

// ---------------------------------------------------------------------------
// §15.1 analytics — the browser posts batches, we validate against the same
// event list the templates use and drop anything unknown.
// ---------------------------------------------------------------------------
router.post('/events', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const incoming = Array.isArray(body.events) ? body.events.slice(0, 25) : [];
    let stored = 0;

    if (config.analytics.serverSide) {
      for (const event of incoming) {
        const name = String(event && event.name ? event.name : '');
        if (!events.EVENT_NAMES.includes(name)) continue;
        // Money-adjacent events are server-authoritative — never trust a client.
        if (events.SERVER_ONLY.has(name)) continue;
        await db.analytics.record(name, {
          payload: events.sanitizePayload(event.payload),
          sourcePath: body.path || req.get('referer') || null,
          sessionId: body.session || null,
        });
        stored += 1;
      }
    }

    return sendJson(res, { ok: true, stored });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Lead capture. Guest-first: no account, three fields, instant WhatsApp hand-off.
// ---------------------------------------------------------------------------
router.post('/leads', rateLimit({ windowMs: 60_000, max: 12 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const type = String(body.type || 'viewing');

    if (!name && type !== 'deal_alert') {
      return sendJson(res, { ok: false, error: 'Please tell us your name.' }, { status: 422 });
    }
    if (!/^[+()\d\s-]{7,20}$/.test(phone)) {
      return sendJson(res, { ok: false, error: 'That phone number does not look right — please check it.' }, { status: 422 });
    }

    const listingId = Number(body.listingId) || null;
    const created = await db.leads.createLead({
      type,
      listingId,
      name: name || 'Deal-alert subscriber',
      phone,
      message: body.message || null,
      preferredDay: body.preferredDay || null,
      sourcePath: String(body.sourcePath || req.get('referer') || '/').slice(0, 200),
      utm: body.utm || null,
    });

    // Mirror the funnel event server-side (§15.1: viewing_requested, deal_alert_signup…)
    const eventName = type === 'deal_alert' ? 'deal_alert_signup' : type === 'viewing' ? 'viewing_requested' : null;
    if (eventName) {
      await db.analytics
        .record(eventName, { payload: { listing_id: listingId, type }, sourcePath: body.sourcePath || '/' })
        .catch(() => {});
    }

    // Ops hand-off: prefilled WhatsApp so the lead lands in the queue immediately.
    const opsText = encodeURIComponent(
      `New ${type} lead #${created.id}\nName: ${name || '—'}\nPhone: ${phone}` +
        (listingId ? `\nListing id: ${listingId}` : '') +
        (body.preferredDay ? `\nPreferred day: ${body.preferredDay}` : ''),
    );

    return sendJson(res, {
      ok: true,
      leadId: created.id,
      whatsappUrl: `https://wa.me/${config.business.whatsapp}?text=${opsText}`,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Service requests (§6.5 concierge, §6.6 sell/swap, §6.7 service pages).
// Creates the operational record the admin pipeline reads (§7.3) and returns
// the human tracking id the customer keeps.
// ---------------------------------------------------------------------------
const REQUEST_KINDS = {
  concierge: { type: 'concierge', slaHours: 72, leadType: 'concierge', event: 'concierge_started' },
  documents: { type: 'documents', slaHours: 48, leadType: 'service', event: 'services_enquiry_submitted' },
  tracking: { type: 'tracking', slaHours: 48, leadType: 'service', event: 'services_enquiry_submitted' },
  research: { type: 'research', slaHours: 72, leadType: 'service', event: 'services_enquiry_submitted' },
  parts: { type: 'parts', slaHours: 48, leadType: 'parts', event: 'services_enquiry_submitted' },
  sell: { type: 'sell', slaHours: 24, leadType: 'sell_swap', event: 'sell_swap_submitted' },
  swap: { type: 'swap', slaHours: 24, leadType: 'sell_swap', event: 'sell_swap_submitted' },
  hire: { type: 'hire', slaHours: 24, leadType: 'hire', event: 'hire_requested' },
  dealer: { type: 'consultation', slaHours: 48, leadType: 'b2b', event: 'dealer_application_submitted' },
  b2b: { type: 'consultation', slaHours: 48, leadType: 'b2b', event: 'dealer_application_submitted' },
};

router.post('/service-requests', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const rule = REQUEST_KINDS[String(body.kind || 'concierge')] || REQUEST_KINDS.concierge;

    const name = validate.name(body.name);
    const phone = validate.phone(body.phone);
    if (!name) return sendJson(res, { ok: false, error: 'Please tell us your name.' }, { status: 422 });
    if (!phone) return sendJson(res, { ok: false, error: 'That phone number does not look right — please check it.' }, { status: 422 });

    const brief = validate.brief(body.brief);
    if (body.serviceSlug) brief.service = validate.text(body.serviceSlug, 80);
    if (body.notes) brief.notes = validate.text(body.notes, 400);

    // §6.5: the concierge retainer comes from the published SLA card, never
    // from the request body — a client cannot name its own price.
    const sla = rule.type === 'concierge' ? concierge.slaOption(body.sla) : null;
    if (sla) brief.sla = sla.key;

    const request = await db.requests.createRequest({
      type: rule.type,
      name,
      phone,
      brief,
      sourcePath: validate.text(body.sourcePath || req.get('referer') || '/', 200),
      slaHours: sla ? sla.hours : validate.slaHours(body.slaHours, rule.slaHours),
    });

    // The retainer is raised with the brief, not after it: the customer leaves
    // with a reference to pay against. Without PSP keys `initiate` returns
    // hosted:false and the honest bank-transfer instructions instead of a
    // checkout link — the same rule the rest of the money code follows.
    let retainer = null;
    if (sla) {
      const raised = await paymentService.initiate({
        purpose: 'retainer',
        amountKobo: sla.retainerKobo,
        requestId: request.id,
        customerName: name,
        customerPhone: phone,
      });
      if (raised.ok) {
        retainer = {
          reference: raised.reference,
          amountKobo: sla.retainerKobo,
          slaKey: sla.key,
          hosted: Boolean(raised.hosted),
          checkoutUrl: raised.checkoutUrl || null,
        };
      }
    }

    await db.leads.createLead({
      type: rule.leadType,
      name,
      phone,
      message: `Service request ${request.trackingId} (${rule.type})`,
      sourcePath: body.sourcePath || req.get('referer') || '/',
      // The brief carries the campaign too — a concierge request from an
      // Instagram link is an Instagram lead, not an unattributed one.
      utm: body.utm || null,
    }).catch(() => {});

    await db.analytics
      .record(rule.event, {
        payload: { type: rule.type, source: validate.text(body.sourcePath || '/', 200) },
        sourcePath: body.sourcePath || '/',
      })
      .catch(() => {});

    const opsText = encodeURIComponent(
      `New ${rule.type} request ${request.trackingId}\nName: ${name}\nPhone: ${phone}\nBrief: ${JSON.stringify(brief).slice(0, 400)}`,
    );

    return sendJson(res, {
      ok: true,
      trackingId: request.trackingId,
      status: request.status,
      url: request.url,
      slaDueAt: request.slaDueAt,
      retainer,
      whatsappUrl: `https://wa.me/${config.business.whatsapp}?text=${opsText}`,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Bookings (§6.7 inline booking forms; §7.3 dispatch queue).
// ---------------------------------------------------------------------------
router.post('/bookings', rateLimit({ windowMs: 60_000, max: 12 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const type = validate.oneOf(body.type, ['inspection', 'install', 'consultation'], 'inspection');
    const name = validate.name(body.name);
    const phone = validate.phone(body.phone);
    if (!name) return sendJson(res, { ok: false, error: 'Please tell us your name.' }, { status: 422 });
    if (!phone) return sendJson(res, { ok: false, error: 'That phone number does not look right — please check it.' }, { status: 422 });

    const slotAt = validate.futureDateTime(body.slotAt, { maxDays: 120 });
    if (!slotAt) return sendJson(res, { ok: false, error: 'Pick a day for this — it must be within the next few months.' }, { status: 422 });

    const booking = await db.requests.createBooking({
      type,
      serviceSlug: validate.text(body.serviceSlug, 80) || null,
      slotAt,
      location: validate.text(body.location, 200) || null,
      vehicle: body.vehicle ? validate.brief(body.vehicle) : null,
      addons: Array.isArray(body.addons) ? validate.brief({ list: body.addons }).list : null,
      name,
      phone,
      amountKobo: null, // priced by ops once the slot is confirmed
      status: 'requested',
    });

    await db.leads.createLead({
      type: 'service',
      name,
      phone,
      message: `Booking ${booking.reference} (${type})${body.location ? ` at ${body.location}` : ''}`,
      preferredDay: String(body.slotAt || '').slice(0, 20),
      sourcePath: validate.text(body.sourcePath || req.get('referer') || '/', 200),
    }).catch(() => {});

    // booking_completed is server-only (§15.1 + §11): the server created it.
    await db.analytics
      .record('booking_completed', { payload: { type }, sourcePath: body.sourcePath || '/' })
      .catch(() => {});

    const opsText = encodeURIComponent(
      `New ${type} booking ${booking.reference}\nName: ${name}\nPhone: ${phone}\nSlot: ${slotAt.toISOString()}`,
    );

    return sendJson(res, {
      ok: true,
      reference: booking.reference,
      type: booking.type,
      slotAt: booking.slotAt,
      whatsappUrl: `https://wa.me/${config.business.whatsapp}?text=${opsText}`,
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Guest checkout (§6.8). Totals are recomputed from the products table — the
// browser's prices are ignored on purpose (§11).
// ---------------------------------------------------------------------------
router.post('/orders', rateLimit({ windowMs: 60_000, max: 8 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = validate.name(body.name);
    const phone = validate.phone(body.phone);
    if (!name) return sendJson(res, { ok: false, error: 'Please tell us your name.' }, { status: 422 });
    if (!phone) return sendJson(res, { ok: false, error: 'That phone number does not look right — please check it.' }, { status: 422 });

    const items = Array.isArray(body.items)
      ? body.items.slice(0, 20).map((item) => ({
          slug: validate.text(item && item.slug, 120),
          qty: validate.integer(item && item.qty, { min: 1, max: 10, fallback: 1 }),
          installRequested: Boolean(item && item.installRequested),
        }))
      : [];
    if (!items.length) return sendJson(res, { ok: false, error: 'Your cart is empty.' }, { status: 422 });

    const order = await db.commerce.createOrder({
      name,
      phone,
      items,
      deliveryArea: validate.text(body.deliveryArea, 80) || 'Pickup at a PH meet-point',
      notes: validate.text(body.notes, 400) || null,
    });

    await db.leads.createLead({
      type: 'service',
      name,
      phone,
      message: `Shop order ${order.orderNo} — ${order.items.map((item) => `${item.qty}× ${item.name}`).join(', ')}`,
      sourcePath: validate.text(body.sourcePath || '/shop', 200),
    }).catch(() => {});

    await db.analytics
      .record('begin_checkout', {
        payload: { value: order.totalKobo / 100, currency: 'NGN', items: order.items.map((i) => i.name).slice(0, 10) },
        sourcePath: body.sourcePath || '/checkout',
      })
      .catch(() => {});

    // The money seam: every order opens a payment row, so the confirmation page
    // can show real instructions and finance has something to match. With no PSP
    // keys the payment stays pending with bank-transfer wording — we never
    // pretend a card page exists.
    const payment = await paymentService
      .initiate({
        purpose: 'order',
        amountKobo: order.totalKobo,
        orderId: order.id,
        customerName: name,
        customerPhone: phone,
      })
      .catch(() => null);

    const opsText = encodeURIComponent(
      `New shop order ${order.orderNo}\nName: ${name}\nPhone: ${phone}\nTotal: ₦${(order.totalKobo / 100).toLocaleString('en-NG')}` +
        (payment && payment.reference ? `\nPayment ref: ${payment.reference}` : ''),
    );

    return sendJson(res, {
      ok: true,
      orderNo: order.orderNo,
      totalKobo: order.totalKobo,
      url: order.url,
      payment: payment && payment.ok
        ? { reference: payment.reference, hosted: Boolean(payment.hosted), checkoutUrl: payment.checkoutUrl || null }
        : null,
      whatsappUrl: `https://wa.me/${config.business.whatsapp}?text=${opsText}`,
    });
  } catch (error) {
    if (error.statusCode === 422) return sendJson(res, { ok: false, error: error.message }, { status: 422 });
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Contact form (§6.10 /contact).
// ---------------------------------------------------------------------------
router.post('/contact', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = validate.name(body.name);
    const phone = validate.phone(body.phone);
    if (!name) return sendJson(res, { ok: false, error: 'Please tell us your name.' }, { status: 422 });
    if (!phone) return sendJson(res, { ok: false, error: 'That phone number does not look right — please check it.' }, { status: 422 });

    const lead = await db.leads.createLead({
      type: 'service',
      name,
      phone,
      message: validate.text(body.message, 2000) || 'Contact form',
      sourcePath: validate.text(body.sourcePath || '/contact', 200),
    });

    await db.analytics
      .record('services_enquiry_submitted', { payload: { source: 'contact' }, sourcePath: '/contact' })
      .catch(() => {});

    const opsText = encodeURIComponent(`Contact form #${lead.id}\nName: ${name}\nPhone: ${phone}\n${validate.text(body.message, 300)}`);
    return sendJson(res, { ok: true, leadId: lead.id, whatsappUrl: `https://wa.me/${config.business.whatsapp}?text=${opsText}` });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Compare (§6.4) — up to 3 cars, returned shaped for the compare table.
// ---------------------------------------------------------------------------
router.get('/listings/compare', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value))
      .slice(0, 3);

    const listings = await db.listings.findByIds(ids);
    return sendJson(res, {
      ok: true,
      count: listings.length,
      listings: listings.map((listing) => ({
        id: listing.id,
        url: listing.url,
        title: listing.title,
        priceKobo: listing.priceKobo,
        priceFormatted: db.shape.formatNaira(listing.priceKobo),
        pricePosition: listing.pricePosition,
        year: listing.year,
        mileageKm: listing.mileageKm,
        mileageFormatted: db.shape.formatMileage(listing.mileageKm),
        transmissionLabel: listing.transmissionLabel,
        fuelTypeLabel: listing.fuelTypeLabel,
        bodyTypeLabel: listing.bodyTypeLabel,
        conditionLabel: listing.conditionLabel,
        grade: listing.grade,
        gradeLabel: listing.gradeLabel,
        documents: listing.documents,
        area: listing.area,
        image: listing.primaryImage ? listing.primaryImage.url : null,
        runningCostKobo: listing.runningCostKobo || null,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Blog “load more” (§6.9: latest-posts grid, 9 per load more).
// ---------------------------------------------------------------------------
router.get('/posts', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res, next) => {
  try {
    const page = validate.integer(req.query.page, { min: 1, max: 40, fallback: 1 });
    const category = validate.text(req.query.category, 40) || null;
    const q = validate.text(req.query.q, 60) || null;
    const feed = await db.content.blogIndex({ page, category, q });

    const html = await render.renderFragment('fragment-post-grid', {
      posts: feed.posts,
      // §13.2: the fragment is fetched with the same headers as the page, so a
      // Save-Data visitor gets small photos here too — otherwise "load more"
      // would quietly undo what the page just did.
      helpers: helpers({ saveData: wantsLessData(req) }),
      feed,
    });
    return sendFragment(res, html);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// AJAX filter results (§6.2 “filters update via lightweight fetch”).
// Returns the same card markup the SSR page uses — one template, two callers.
// ---------------------------------------------------------------------------
router.get('/listings', rateLimit({ windowMs: 60_000, max: 90 }), async (req, res, next) => {
  try {
    const parsed = listingQuery.parseListingQuery(req.query);
    // FR-32: the filter rail posts the market as a slug (`city=owerri`), and the
    // grid refresh has to resolve it against service_cities exactly as /cars
    // does — otherwise the AJAX update would quietly show an empty grid.
    const city = await db.areas.cityByToken(parsed.view.city);
    if (city) {
      parsed.filters.city = city.name;
      parsed.view.city = city.slug;
    } else {
      delete parsed.filters.city;
      delete parsed.view.city;
    }

    const [result, facets, models] = await Promise.all([
      db.listings.browse(parsed.filters, {
        page: parsed.page,
        perPage: listingQuery.PER_PAGE,
        sort: parsed.sort,
      }),
      db.listings.filterFacets({ city: city ? city.name : null }),
      parsed.view.make ? db.listings.modelCounts(parsed.view.make) : Promise.resolve([]),
    ]);

    if (req.query.format === 'json' || req.get('accept') === 'application/json') {
      return sendJson(res, {
        total: result.total,
        page: result.page,
        pages: result.pages,
        sort: result.sort,
        listings: result.listings.map((listing) => ({
          id: listing.id,
          title: listing.title,
          url: listing.url,
          price: listing.priceKobo,
          priceFormatted: db.shape.formatNaira(listing.priceKobo),
          mileageKm: listing.mileageKm,
          grade: listing.grade,
          pricePosition: listing.pricePosition,
          status: listing.status,
          image: listing.primaryImage ? listing.primaryImage.url : null,
        })),
        models,
      });
    }

    const html = await render.renderFragment('fragment-listing-grid', personalise(req, {
      result,
      helpers: helpers({ saveData: wantsLessData(req) }),
      facets,
    }));
    return sendFragment(res, html);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// OG card (§12.4). Rendered on demand, cached by content hash, immutable.
// ---------------------------------------------------------------------------
router.get('/og/listing/:slug.png', async (req, res, next) => {
  try {
    const listing = await db.listings.findBySlug(req.params.slug);
    if (!listing) return res.status(404).end();

    const path = await og.listingOgCard(listing);
    if (!path) return res.redirect(302, '/og/default.png');

    res.set('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
    return res.sendFile(require('node:path').join(render.ROOT, 'public', path.replace(/^\//, '')));
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// PSP webhooks (§12.2). These two routes are the only places a payment can be
// marked paid without a human, so they are deliberately paranoid:
//   • the raw body is what the signature is computed over — express.json would
//     have consumed it, so app.js gives these paths express.raw first
//   • an unsigned or mis-signed call is logged with signature_ok = 0 and
//     answered 401: never applied, never trusted
//   • a repeated event_id is a no-op, because PSPs retry
// ---------------------------------------------------------------------------
function webhookHandler(provider) {
  return async (req, res, next) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      let body = null;
      try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = null; }

      const result = await paymentService.handleWebhook({
        provider,
        headers: req.headers,
        rawBody,
        body,
      });

      if (!result.ok) {
        return sendJson(res, { ok: false, error: result.error, verdict: result.verdict || null }, { status: result.status || 400 });
      }
      return sendJson(res, {
        ok: true,
        duplicate: Boolean(result.duplicate),
        reference: result.payment ? result.payment.reference : null,
        status: result.payment ? result.payment.status : null,
      });
    } catch (error) {
      return next(error);
    }
  };
}

router.post('/payments/webhook/paystack', webhookHandler('paystack'));
router.post('/payments/webhook/flutterwave', webhookHandler('flutterwave'));

/** What the site can honestly say about payment methods right now (§18). */
router.get('/payments/methods', async (req, res) => {
  return sendJson(res, {
    ok: true,
    providers: paymentService.availability(),
    active: paymentService.activeProvider(),
  });
});

// ---------------------------------------------------------------------------
// FR-33 — bulk listing import over the API, one key per lot.
//
//   POST /api/dealer/listings                     dry run (default)
//   POST /api/dealer/listings?dry_run=false       write the rows that pass
//   POST /api/dealer/listings?dry_run=false&status=draft
//
// Body: CSV (text/csv) or JSON — either { "csv": "..." } or
// { "listings": [ { make, model, year, price, ... } ] }.
//
// The default is a dry run on purpose: a script that gets the URL wrong writes
// nothing, and the response says exactly what a real run would do. Nothing can
// go live from here — imports create drafts, and ops publishes them.
// ---------------------------------------------------------------------------
const IMPORT_BODY = [
  express.text({ type: ['text/csv', 'text/plain'], limit: '512kb' }),
  express.json({ limit: '512kb' }),
];

/** A JSON array of objects becomes the same CSV the file form takes. */
function csvFromJson(listings) {
  if (!Array.isArray(listings) || !listings.length) return null;
  const columns = imports.COLUMNS.map((column) => column.name).filter((name) => name !== 'photos');
  const rows = listings.slice(0, imports.MAX_ROWS).map((row) => columns.map((column) => {
    const value = row[column];
    if (Array.isArray(value)) return value.join(' | ');
    return value == null ? '' : String(value);
  }).concat([Array.isArray(row.photos) ? row.photos.join(' | ') : String(row.photos || '')]));
  return require('../lib/csv').stringify(rows, [...columns, 'photos']);
}

router.post('/dealer/listings', rateLimit({ windowMs: 60_000, max: 20 }), IMPORT_BODY, async (req, res, next) => {
  try {
    const auth = await dealerApi.fromRequest(req);
    if (!auth.ok) return sendJson(res, { ok: false, error: auth.error }, { status: auth.status, cache: 'no-store' });

    let text = typeof req.body === 'string' ? req.body : '';
    if (!text && req.body && typeof req.body === 'object') {
      if (typeof req.body.csv === 'string') text = req.body.csv;
      else if (Array.isArray(req.body.listings)) text = csvFromJson(req.body.listings) || '';
    }
    if (!text.trim()) {
      return sendJson(res, {
        ok: false,
        error: 'Send CSV as the body (content-type text/csv), or JSON like { "listings": [ … ] }.',
        template: '/dealer/imports/template.csv',
      }, { status: 400, cache: 'no-store' });
    }

    const dryRun = String(req.query.dry_run || 'true') !== 'false';
    const report = await imports.run(text, { dealerId: auth.lot.id, actorId: null, dryRun });

    return sendJson(res, {
      ok: report.ok,
      lot: { id: auth.lot.id, name: auth.lot.name },
      dryRun: report.dryRun,
      counts: report.counts,
      fileErrors: report.fileErrors,
      rows: report.rows.map((row) => ({
        line: row.line,
        action: row.errors.length ? 'refuse' : 'create',
        errors: row.errors,
        warnings: row.warnings,
        preview: row.errors.length ? undefined : {
          title: [row.input.year, row.input.make, row.input.model].filter(Boolean).join(' '),
          priceKobo: row.input.priceKobo,
          condition: row.input.condition,
          photos: row.photos.length,
        },
      })),
      created: report.created,
    }, { cache: 'no-store' });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Health (§12.3)
// ---------------------------------------------------------------------------
router.get('/health', async (req, res) => {
  try {
    const health = await db.healthcheck();
    return sendJson(res, { ok: true, ...health, env: config.env }, { cache: 'no-store' });
  } catch (error) {
    return sendJson(res, { ok: false, error: error.code || error.message }, { status: 503, cache: 'no-store' });
  }
});

module.exports = { router };
