'use strict';

/**
 * JSON endpoints.
 *
 *   POST /api/events        §15.1 client event batch → analytics_events
 *   POST /api/leads         every public form → leads (+ WhatsApp hand-off)
 *   GET  /api/listings      filtered results for the AJAX filter update (§6.2)
 *   GET  /api/og/listing/:slug.png   composited 1200×630 OG card (§12.4)
 *   GET  /api/health        liveness + database check
 */

const express = require('express');
const rateLimit = require('../lib/rate-limit');
const db = require('../db');
const config = require('../config');
const events = require('../services/events');
const og = require('../services/og');
const listingQuery = require('../services/listing-query');
const render = require('../lib/render');
const { sendJson, sendFragment } = require('../lib/respond');
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
// AJAX filter results (§6.2 “filters update via lightweight fetch”).
// Returns the same card markup the SSR page uses — one template, two callers.
// ---------------------------------------------------------------------------
router.get('/listings', rateLimit({ windowMs: 60_000, max: 90 }), async (req, res, next) => {
  try {
    const parsed = listingQuery.parseListingQuery(req.query);
    const [result, facets, models] = await Promise.all([
      db.listings.browse(parsed.filters, {
        page: parsed.page,
        perPage: listingQuery.PER_PAGE,
        sort: parsed.sort,
      }),
      db.listings.filterFacets(),
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

    const html = await render.renderFragment('fragment-listing-grid', {
      result,
      helpers: helpers(),
      facets,
    });
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
