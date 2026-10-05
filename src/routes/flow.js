'use strict';

/**
 * Conversion flows:
 *
 *   GET /find-my-car      §6.5 concierge intake — 4 steps, progress, auto-saved
 *   GET /concierge/:id    §6.5 status page — Searching → Options ready → Viewings → Closed
 *   GET /sell-swap        §6.6 sell / swap intake, free valuation inside 24h
 *   GET /hire             §6.7 car hire, daily/weekly/corporate + airport pickup
 *
 * All three intakes post to /api/service-requests, which writes the operational
 * record and returns the tracking id shown on the success screen.
 */

const express = require('express');
const db = require('../db');
const seo = require('../services/seo');
const concierge = require('../services/concierge');
const { sendPrebuiltOrRender, sendPage, CACHE } = require('../lib/respond');

const router = express.Router();

// ---------------------------------------------------------------------------
// /find-my-car — §6.5
// ---------------------------------------------------------------------------
async function buildFindMyCarLocals() {
  const [facets, faqs, counters, service] = await Promise.all([
    db.listings.filterFacets(),
    db.content.faqsForScope('service:concierge'),
    db.listings.networkCounters(),
    db.content.serviceBySlug('concierge'),
  ]);

  const trail = [{ label: 'Find My Car' }];

  return {
    view: 'find-my-car',
    page: {
      title: 'Find my car — 3 verified options in 48–72 hours',
      metaTitle: 'Find my car in Port Harcourt',
      titleSuffix: true,
      description:
        'Tell us the brief once. HonestCars brings up to three verified, inspected options in Port Harcourt inside 48–72 hours — retainer credited against the success fee.',
      canonical: '/find-my-car',
      breadcrumbs: trail,
      bodyClass: 'page-find-my-car',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Find My Car', href: '/find-my-car' }]),
        seo.faqSchema(faqs),
      ],
    },
    data: { facets, faqs, counters, service, trail, slaOptions: concierge.SLA_OPTIONS, spec: concierge },
  };
}

router.get('/find-my-car', async (req, res, next) => {
  try {
    const locals = await buildFindMyCarLocals();
    await sendPrebuiltOrRender(req, res, { routePath: '/find-my-car', ...locals });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// /concierge/lookup — the tracking-ID form on /find-my-car. Registered before
// /concierge/:trackingId so “lookup” is never treated as an id.
// ---------------------------------------------------------------------------
router.get('/concierge/lookup', (req, res) => {
  const id = String(req.query.id || '').trim().toUpperCase();
  if (!/^HC-\d{3,6}$/.test(id)) return res.redirect(302, '/find-my-car');
  return res.redirect(301, `/concierge/${id}`);
});

// ---------------------------------------------------------------------------
// /concierge/{trackingId} — §6.5 status page. Private: noindex, no caching.
// ---------------------------------------------------------------------------
router.get('/concierge/:trackingId', async (req, res, next) => {
  try {
    const request = await db.requests.findByTracking(req.params.trackingId);
    if (!request) return next();

    const stages = db.requests.STATUS_STAGES.filter((stage) => stage.key !== 'lost');
    const trail = [{ label: 'Find My Car', href: '/find-my-car' }, { label: request.trackingId }];

    // §6.5 promises what happens to the retainer, so the page states where it
    // actually stands rather than assuming it was paid.
    const payments = await db.payments.paymentsForRequest(request.id);
    const retainer = payments.find((payment) => payment.purpose === 'retainer') || null;
    const retainerState = retainer ? db.payments.RETAINER_STATES[retainer.status] || null : null;

    return await sendPage(req, res, {
      routePath: `/concierge/${request.trackingId}`,
      view: 'concierge-status',
      cache: CACHE.private,
      page: {
        title: `Concierge ${request.trackingId} — ${request.statusLabel}`,
        metaTitle: `Concierge ${request.trackingId}`,
        titleSuffix: false,
        description: 'Track a HonestCars find-my-car request: brief, stage and next update.',
        canonical: `/concierge/${request.trackingId}`,
        robots: 'noindex,nofollow',
        breadcrumbs: trail,
        bodyClass: 'page-concierge-status',
        jsonLd: [],
      },
      data: { request, stages, trail, retainer, retainerState },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// /sell-swap — §6.6, three-step intake on two tabs.
// ---------------------------------------------------------------------------
async function buildSellSwapLocals() {
  const [service, faqs, testimonials, counters] = await Promise.all([
    db.content.serviceBySlug('sell-swap'),
    db.content.faqsForScope('service:sell-swap'),
    db.content.publishedTestimonials(2),
    db.listings.networkCounters(),
  ]);

  const trail = [{ label: 'Sell / Swap' }];

  return {
    view: 'sell-swap',
    page: {
      title: 'Sell or swap your car in Port Harcourt',
      metaTitle: 'Sell or swap your car in Port Harcourt',
      titleSuffix: true,
      description:
        'Free valuation within 24 hours from live Port Harcourt network data. Sell it, or swap it for a verified car through the concierge — no listing fee up front.',
      canonical: '/sell-swap',
      breadcrumbs: trail,
      bodyClass: 'page-sell-swap',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Sell / Swap', href: '/sell-swap' }]),
        seo.serviceSchema({ ...service, slug: 'sell-swap' }),
        seo.faqSchema(faqs),
      ],
    },
    data: { service, faqs, testimonials, counters, trail, spec: concierge },
  };
}

router.get('/sell-swap', async (req, res, next) => {
  try {
    const locals = await buildSellSwapLocals();
    await sendPrebuiltOrRender(req, res, { routePath: '/sell-swap', ...locals });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// /hire — §6.7. Class list comes from hire_classes; the quote form posts a
// service request (type hire) with the dates, driver and airport toggles.
// ---------------------------------------------------------------------------
async function buildHireLocals() {
  const [classes, service, faqs, counters] = await Promise.all([
    db.content.hireClasses(),
    db.content.serviceBySlug('hire'),
    db.content.faqsForScope('page:hire'),
    db.listings.networkCounters(),
  ]);

  const trail = [{ label: 'Car Hire' }];

  return {
    view: 'hire',
    page: {
      title: 'Car hire in Port Harcourt — daily and weekly',
      metaTitle: 'Car hire in Port Harcourt',
      titleSuffix: true,
      description:
        'Sedans, SUVs, buses and chauffeur-driven executive cars by the day, week or month — with airport pickup at Omagwa and corporate accounts.',
      canonical: '/hire',
      breadcrumbs: trail,
      bodyClass: 'page-hire',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Car Hire', href: '/hire' }]),
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: 'Car hire classes',
          itemListElement: classes.map((entry, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: entry.name,
            url: seo.absolute('/hire'),
          })),
        },
        seo.faqSchema(faqs),
      ],
    },
    data: { classes, service, faqs, counters, trail },
  };
}

router.get('/hire', async (req, res, next) => {
  try {
    const locals = await buildHireLocals();
    await sendPrebuiltOrRender(req, res, { routePath: '/hire', ...locals });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, buildFindMyCarLocals, buildSellSwapLocals, buildHireLocals };
