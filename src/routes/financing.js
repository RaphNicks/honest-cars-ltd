'use strict';

/**
 * /financing — FR-34.
 *
 * FR-34 is a *module*, and §6.5 only ever gave a financing question one place to
 * live: a Y/N inside the concierge brief that "routes to a partner note". A
 * question worth asking is worth answering, so this page is where the answer
 * lives: what we do (put the requirement in front of a lender), what we do not
 * do (lend, price credit, promise an approval), the arithmetic the customer can
 * check themselves, and the enquiry form that starts it.
 *
 * The page is statically built like the rest of §6.10's trust set. The
 * calculator and the form are upgrades: with JavaScript off, the form still
 * posts and the server does the same arithmetic and says the same sentences —
 * the client only saves the round trip.
 */

const express = require('express');
const db = require('../db');
const seo = require('../services/seo');
const financing = require('../services/financing');
const { sendPrebuiltOrRender } = require('../lib/respond');

const router = express.Router();

/** The four questions people actually ask before they fill this in. */
const QUESTIONS = [
  {
    question: 'Do you lend the money yourselves?',
    answer:
      'No. We are not a lender and we do not sell loans. We take your requirement to a bank or microfinance lender we work with, and tell you exactly what we sent and when.',
  },
  {
    question: 'What will the interest be?',
    answer:
      'The lender’s rate, not ours — and it depends on their assessment of you. We do not quote a rate or a monthly repayment that includes interest, because a figure we cannot honour is worse than no figure at all.',
  },
  {
    question: 'What does this cost me?',
    answer:
      'Nothing to us. We do not charge you for the enquiry or for the introduction, and we add nothing to whatever the lender charges. If that ever changes, this page changes before anything is routed.',
  },
  {
    question: 'Do you decide whether I am approved?',
    answer:
      'No — the lender does, on their own criteria. We record the outcome on your enquiry so you can see where it got to, and if one lender says no we can try another.',
  },
];

const STEPS = [
  { title: 'You tell us what you are buying', copy: 'The car or your budget, what you can put down, and what you can pay monthly.' },
  { title: 'A human reads it the same day', copy: 'Not a scoring model. If the numbers do not add up, we say so before anyone else sees it.' },
  { title: 'We route it to a lender', copy: 'You get the reference, the partner it went to and the date. If we have no partner for your case, we tell you that instead.' },
  { title: 'The lender decides', copy: 'They contact you, and their written offer is the only thing that binds anyone. We record what came back.' },
];

async function buildFinancingLocals() {
  const [listings, partners, stats] = await Promise.all([
    // Real stock in a realistic band, so "finance this car" has somewhere to go.
    db.listings.browse({}, { perPage: 3, sort: 'recommended' }).catch(() => ({ listings: [] })),
    db.financing.partners({ activeOnly: true }).catch(() => []),
    db.listings.networkCounters().catch(() => ({ carsLive: 0 })),
  ]);

  const trail = [{ label: 'Financing' }];
  const car = null; // set per-request by `?car=<slug>`; the static build has none

  return {
    view: 'financing',
    page: {
      title: 'Car financing in Port Harcourt — how the handoff actually works',
      metaTitle: 'Car financing — HonestCars',
      titleSuffix: true,
      description:
        'HonestCars is not a lender. Tell us the car and what you can put down, see the arithmetic before interest, and we route the enquiry to a bank or MFB lender and record what came back.',
      canonical: '/financing',
      breadcrumbs: trail,
      bodyClass: 'page-financing',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Financing', href: '/financing' }]),
        seo.faqSchema(QUESTIONS),
      ],
    },
    data: {
      trail,
      questions: QUESTIONS,
      steps: STEPS,
      readiness: financing.READINESS,
      tenors: financing.TENORS,
      employments: db.financing.EMPLOYMENTS,
      timelines: db.financing.TIMELINES,
      partners,
      examples: listings.listings || [],
      carsLive: stats.carsLive || 0,
      car,
    },
  };
}

/** `?car=<slug>` — the VDP's "finance this car" arrives here. */
function wantedCar(req) {
  const slug = String(req.query.car || '').trim().slice(0, 200);
  return slug || null;
}

router.get('/financing', async (req, res, next) => {
  try {
    const locals = await buildFinancingLocals();
    const slug = wantedCar(req);

    // A car named in the query string is looked up server-side: the price we
    // show and pre-fill is the price in the database, never one from a link
    // (§11 — amounts are recomputed server-side).
    if (slug) {
      const listing = await db.listings.findBySlug(slug).catch(() => null);
      if (listing) {
        locals.data.car = {
          slug: listing.slug,
          title: listing.title,
          stockNo: listing.stockNo,
          priceKobo: listing.priceKobo,
          price: listing.price,
          url: listing.url,
          area: listing.area,
        };
        // A car-specific page must not be indexed as a duplicate of the hub.
        locals.page = {
          ...locals.page,
          canonical: '/financing',
          robots: 'noindex,follow',
          title: `Finance a ${listing.title} — the honest version`,
          metaTitle: `Finance a ${listing.title} — HonestCars`,
        };
      }
    }

    // A prebuilt /financing is the hub, without a car attached. When a car is
    // named, the manifest path is deliberately *not* the one in the manifest,
    // so the request renders instead of serving the hub's HTML with the wrong
    // price on it.
    const routePath = locals.data.car ? '/financing?car=' : '/financing';
    return await sendPrebuiltOrRender(req, res, { routePath, ...locals });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router, buildFinancingLocals, QUESTIONS };
