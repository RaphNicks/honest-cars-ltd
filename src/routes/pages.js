'use strict';

/**
 * Trust, company and legal pages — §6.10 — plus /guide (§6.9) and the
 * account / portal entry points (§7.1, §7.2 — interiors are phase 2).
 *
 *   GET /verification   the trust page: three grades, the checklist, real
 *                       catches, integrity rules (built to get design love)
 *   GET /how-it-works   the checklist journey, step by step
 *   GET /about          story, mission, team, CAC details
 *   GET /faq            searchable, grouped
 *   GET /contact        form + WhatsApp + the “we operate virtually” note
 *   GET /guide          evergreen shelf — start-here reading path
 *   GET /partner        B2B dealer recruitment + packages
 *   GET /terms /privacy /refunds /disclaimer   CMS-driven legal pages
 *   GET /dealer                               phase-2 entry stub, noindex
 *   GET /admin                                §7.3 console — routes/admin.js
 *   GET /account /login                       §7.1 — served by routes/account.js
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const seo = require('../services/seo');
const { sendPrebuiltOrRender, sendPage, CACHE } = require('../lib/respond');

const router = express.Router();

const LEGAL_SLUGS = ['terms', 'privacy', 'refunds', 'disclaimer'];

// ---------------------------------------------------------------------------
// /verification — §6.10 “Most underrated page on the site”
// ---------------------------------------------------------------------------
const CHECKLIST = [
  'OBD2 scan — stored codes, pending codes, readiness monitors',
  'Documents sighted at source — customs, registration, duty papers',
  'Body and paint — panel gaps, overspray, filler, accident repair signs',
  'Flood and water ingress — smell, silt, corroded connectors, seat rails',
  'Odometer sanity — wear vs reading, service book, tyre ages',
  'Engine and drivetrain — cold start, smoke, leaks, gear changes under load',
  'Suspension and steering — bushings, shocks, alignment symptoms',
  'Electrical — every window, light, AC vent, camera, sensor and switch',
  'Tyres and brakes — tread depth measured, disc lips, pad life',
  'Road test — a real drive on the roads you will actually use',
];

const CATCHES = [
  {
    tag: 'Flood',
    title: 'Clean outside, silt inside',
    copy: 'A 2018 SUV with gleaming paint. Seat rails and the spare-wheel well told the real story: water line marks and fine silt. Recorded, photographed and priced out of the deal.',
    image: '/img/seed/suv-interior.svg',
  },
  {
    tag: 'Odometer',
    title: '62,000 km on a ten-year-old car',
    copy: 'The service book stopped in 2019 at 96,000 km. Pedal rubbers, driver’s seat bolster and tyre dates all agreed with the book, not the dashboard.',
    image: '/img/seed/sedan-dash.svg',
  },
  {
    tag: 'Documents',
    title: 'Duty paper that did not match the VIN',
    copy: 'Customs paperwork looked official. One character in the VIN did not match the chassis plate. The registration would have failed months later — with the buyer holding the loss.',
    image: '/img/seed/van-dash.svg',
  },
];

async function buildVerificationLocals() {
  const [faqs, counters, examples, testimonials] = await Promise.all([
    db.content.faqsForScope('page:verification'),
    db.listings.networkCounters(),
    db.listings.browse({ grade: 'certified' }, { perPage: 3, sort: 'recommended' }),
    db.content.publishedTestimonials(2),
  ]);

  const trail = [{ label: 'Verification' }];

  return {
    view: 'verification',
    page: {
      title: 'Verification — how we check a car before you pay',
      metaTitle: 'Verification — how HonestCars checks a car',
      titleSuffix: true,
      description:
        'Three grades explained, the ten-point HonestCars Checklist, real catches (flood, odometer, documents) and the integrity rules our inspectors work under.',
      canonical: '/verification',
      breadcrumbs: trail,
      bodyClass: 'page-verification',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Verification', href: '/verification' }]),
        seo.faqSchema(faqs),
      ],
    },
    data: { faqs, counters, checklist: CHECKLIST, catches: CATCHES, examples: examples.listings, testimonials, trail },
  };
}

router.get('/verification', async (req, res, next) => {
  try {
    const locals = await buildVerificationLocals();
    return await sendPrebuiltOrRender(req, res, { routePath: '/verification', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /how-it-works
// ---------------------------------------------------------------------------
const JOURNEY = [
  { title: 'Pick a car or hand us the brief', copy: 'Browse verified stock, or use the concierge and let us search for 48–72 hours.', timeline: 'Minutes' },
  { title: 'We check the car, not the advert', copy: 'An inspector visits, scans, drives and reads the body. Documents are sighted at source.', timeline: '2–24 hours' },
  { title: 'You get the honest report', copy: 'Read the faults, the photos and the price position — below, within or above market, with reasons.', timeline: 'Within 4 hours of the check' },
  { title: 'Buy protected', copy: 'Payment moves through HonestCars-protected channels. Never to a seller directly.', timeline: 'Same day' },
  { title: 'Documents and handover', copy: 'Registration, change of ownership or a tracker — handled before you drive away.', timeline: '3–7 working days' },
];

async function buildHowItWorksLocals() {
  const [page, faqs, counters] = await Promise.all([
    db.content.pageBySlug('how-it-works'),
    db.content.faqsForScope('page:how-it-works'),
    db.listings.networkCounters(),
  ]);
  const trail = [{ label: 'How It Works' }];
  const meta = page ? seo.pageMeta(page) : { title: 'How it works', description: '', canonical: '/how-it-works' };

  return {
    view: 'how-it-works',
    page: {
      title: meta.title,
      metaTitle: meta.title,
      titleSuffix: false,
      description: meta.description,
      canonical: '/how-it-works',
      breadcrumbs: trail,
      bodyClass: 'page-how-it-works',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'How It Works', href: '/how-it-works' }]),
        seo.faqSchema(faqs),
        {
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: 'How buying a car through HonestCars works',
          step: JOURNEY.map((step, index) => ({
            '@type': 'HowToStep',
            position: index + 1,
            name: step.title,
            text: step.copy,
          })),
        },
      ],
    },
    data: { cmsPage: page, faqs, journey: JOURNEY, counters, trail },
  };
}

router.get('/how-it-works', async (req, res, next) => {
  try {
    const locals = await buildHowItWorksLocals();
    return await sendPrebuiltOrRender(req, res, { routePath: '/how-it-works', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /guide — §6.9 evergreen shelf
// ---------------------------------------------------------------------------
async function buildGuideLocals() {
  const [shelf, latest, services] = await Promise.all([
    db.content.guideShelf(12),
    db.content.latestPosts(6),
    db.content.serviceSuite(),
  ]);
  const trail = [{ label: 'Start here' }];
  const steps = ['pick-a-sane-budget', 'inspect-before-you-pay', 'documents-and-transfer'];

  return {
    view: 'guide',
    page: {
      title: 'Start here — the Honest Buyer’s Guide',
      metaTitle: 'Start here — the Honest Buyer’s Guide',
      titleSuffix: true,
      description:
        'A short reading path through the Honest Buyer’s Guide: budget, inspection, documents and handover — what decides whether a used car in Port Harcourt is a good buy.',
      canonical: '/guide',
      breadcrumbs: trail,
      bodyClass: 'page-guide',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Start here', href: '/guide' }]),
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: 'The Honest Buyer’s Guide reading path',
          itemListElement: shelf.slice(0, 6).map((post, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: post.title,
            url: seo.absolute(post.url),
          })),
        },
      ],
    },
    data: { shelf, latest, services, trail, steps },
  };
}

router.get('/guide', async (req, res, next) => {
  try {
    const locals = await buildGuideLocals();
    return await sendPrebuiltOrRender(req, res, { routePath: '/guide', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /faq — searchable, grouped (§6.10)
// ---------------------------------------------------------------------------
const FAQ_GROUPS = [
  { scope: 'global', label: 'Buying with HonestCars', description: 'The rules of the road: grades, payments, inspectors and viewings.' },
  { scope: 'page:verification', label: 'Verification and inspections', description: 'What we check, what we cannot check, and what the grades mean.' },
  { scope: 'service:concierge', label: 'The concierge search', description: 'Retainer, SLA, refunds and what “options ready” actually delivers.' },
  { scope: 'service:documents', label: 'Documents and customs', description: 'Registration, licences, tinted permits and insurance.' },
  { scope: 'service:tracking', label: 'Tracking and security', description: 'Bundles, installation, subscriptions and renewals.' },
  { scope: 'service:sell-swap', label: 'Selling and swapping', description: 'Valuations, commissions, listings and swaps.' },
  { scope: 'page:shop', label: 'Shop, cart and delivery', description: 'Checkout, delivery areas, warranties and returns.' },
];

async function buildFaqLocals(term = null) {
  const groups = term
    ? null
    : await Promise.all(
        FAQ_GROUPS.map(async (group) => ({
          ...group,
          faqs: await db.content.faqsForScope(group.scope),
        })),
      );
  const results = term ? await db.content.searchFaqs(term) : null;
  const [counters, faqs] = await Promise.all([db.listings.networkCounters(), db.content.allFaqs()]);
  const trail = [{ label: 'FAQ' }];

  return {
    view: 'faq',
    page: {
      title: 'Car-buying questions, answered',
      metaTitle: 'HonestCars FAQ',
      titleSuffix: true,
      description:
        'Searchable answers about buying a used car in Port Harcourt: verification grades, inspection reports, protected payments, documents, tracking, delivery and refunds.',
      canonical: '/faq',
      robots: term ? 'noindex,follow' : 'index,follow',
      breadcrumbs: trail,
      bodyClass: 'page-faq',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'FAQ', href: '/faq' }]),
        seo.faqSchema(faqs.slice(0, 12)),
      ],
    },
    data: { term, groups: groups || [], results: results || [], counters, trail, totalFaqs: faqs.length },
  };
}

router.get('/faq', async (req, res, next) => {
  try {
    const term = req.query.q ? String(req.query.q).slice(0, 60) : null;
    const locals = await buildFaqLocals(term);
    return await sendPrebuiltOrRender(req, res, { routePath: '/faq', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /contact
// ---------------------------------------------------------------------------
async function buildContactLocals() {
  const [faqs, counters, services] = await Promise.all([
    db.content.faqsForScope('page:contact'),
    db.listings.networkCounters(),
    db.content.serviceSuite(),
  ]);
  const trail = [{ label: 'Contact' }];

  return {
    view: 'contact',
    page: {
      title: 'Contact HonestCars in Port Harcourt',
      metaTitle: 'Contact HonestCars in Port Harcourt',
      titleSuffix: true,
      description:
        'Reach the HonestCars team in Port Harcourt: WhatsApp (fastest), phone and email. We operate virtually — inspections come to you.',
      canonical: '/contact',
      breadcrumbs: trail,
      bodyClass: 'page-contact',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Contact', href: '/contact' }]),
        seo.localBusinessSchema(),
        seo.faqSchema(faqs),
      ],
    },
    data: { faqs, counters, services, trail },
  };
}

router.get('/contact', async (req, res, next) => {
  try {
    const locals = await buildContactLocals();
    return await sendPrebuiltOrRender(req, res, { routePath: '/contact', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /about — CMS page body + team + CAC details
// ---------------------------------------------------------------------------
const TEAM = [
  { name: 'Raph Nicks', role: 'Founder · inspections', bio: 'Leads the inspection bench. More than 600 cars checked across Port Harcourt and Rivers State.' },
  { name: 'Ops desk', role: 'Concierge · documents · dispatch', bio: 'Reads every brief that arrives, runs the document errands and keeps the dispatch queue moving.' },
  { name: 'Partner network', role: '11 verified lots', bio: 'Port Harcourt dealers who signed the honesty rules: real mileage, documents sighted, no buyer-side games.' },
];

async function buildAboutLocals() {
  const [page, faqs, counters, testimonials] = await Promise.all([
    db.content.pageBySlug('about'),
    db.content.faqsForScope('page:about'),
    db.listings.networkCounters(),
    db.content.publishedTestimonials(3),
  ]);
  const trail = [{ label: 'About' }];
  const meta = page ? seo.pageMeta(page) : { title: 'About', description: '', canonical: '/about' };

  return {
    view: 'about',
    page: {
      title: meta.title,
      metaTitle: meta.title,
      titleSuffix: false,
      description: meta.description,
      canonical: '/about',
      breadcrumbs: trail,
      bodyClass: 'page-about',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'About', href: '/about' }]),
        seo.localBusinessSchema(),
        seo.faqSchema(faqs),
      ],
    },
    data: { cmsPage: page, faqs, counters, team: TEAM, testimonials, trail },
  };
}

router.get('/about', async (req, res, next) => {
  try {
    const locals = await buildAboutLocals();
    return await sendPrebuiltOrRender(req, res, { routePath: '/about', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /partner — B2B dealer services (§6.7 dealer-services + §7.2 portal link)
// ---------------------------------------------------------------------------
const PACKAGES = [
  {
    name: 'Media & listing',
    price: 'Per car',
    copy: 'A professional shot list per car, honest descriptions written for buyers, and moderation before it goes live.',
    includes: ['8-shot media pack', 'Buyer-facing description', 'Listing moderation', 'Re-shoots if the car changes'],
  },
  {
    name: 'Featured placement',
    price: 'Per car / month',
    lead: true,
    copy: 'Front of the network: homepage feed, facet pages and the WhatsApp deal list — with views and leads reported back.',
    includes: ['Homepage slot rotation', 'Facet priority', 'Deal-list inclusion', 'Weekly view/lead report'],
  },
  {
    name: 'Market intelligence',
    price: 'Monthly',
    copy: 'What PH buyers are asking for, what your cars are compared against, and where your pricing sits against live stock.',
    includes: ['Demand report', 'Price-position audit', 'Lead-quality review', 'Quarterly strategy call'],
  },
];

async function buildPartnerLocals() {
  const [service, faqs, counters, feed] = await Promise.all([
    db.content.serviceBySlug('dealer-services'),
    db.content.faqsForScope('page:partner'),
    db.listings.networkCounters(),
    db.listings.homeFeed(3),
  ]);
  const trail = [{ label: 'Partner with us' }];

  return {
    view: 'partner',
    page: {
      title: 'Partner with HonestCars in Port Harcourt',
      metaTitle: 'Partner with HonestCars',
      titleSuffix: true,
      description:
        'Dealer recruitment for Port Harcourt lots: media and listing, featured placement and market intelligence — plus the dealer portal for live stock and leads.',
      canonical: '/partner',
      breadcrumbs: trail,
      bodyClass: 'page-partner',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Partner with us', href: '/partner' }]),
        service ? seo.serviceSchema(service) : null,
        seo.faqSchema(faqs),
      ].filter(Boolean),
    },
    data: { service, faqs, counters, packages: PACKAGES, feed: feed.tabs.all.listings.slice(0, 3), trail },
  };
}

router.get('/partner', async (req, res, next) => {
  try {
    const locals = await buildPartnerLocals();
    return await sendPrebuiltOrRender(req, res, { routePath: '/partner', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Legal pages — CMS-editable envelope around counsel's wording (§6.10)
// ---------------------------------------------------------------------------
async function buildLegalLocals(slug) {
  const page = await db.content.pageBySlug(slug);
  if (!page) return null;

  const trail = [{ label: page.title }];
  const meta = seo.pageMeta(page);

  return {
    view: 'page',
    page: {
      title: meta.title,
      metaTitle: meta.title,
      titleSuffix: false,
      description: meta.description,
      canonical: `/${slug}`,
      robots: page.indexable ? 'index,follow' : 'noindex,follow',
      breadcrumbs: trail,
      bodyClass: `page-legal page-legal--${slug}`,
      jsonLd: [seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: page.title, href: `/${slug}` }])],
      layout: 'base',
    },
    data: { cmsPage: page, trail, isLegal: true },
  };
}

router.get('/legal', (req, res) => res.redirect(301, '/terms'));

for (const slug of LEGAL_SLUGS) {
  router.get(`/${slug}`, async (req, res, next) => {
    try {
      const locals = await buildLegalLocals(slug);
      if (!locals) return next();
      return await sendPrebuiltOrRender(req, res, { routePath: `/${slug}`, ...locals });
    } catch (error) {
      return next(error);
    }
  });
}

// ---------------------------------------------------------------------------
// Account / portal entry points — §7.1 and §7.2 interiors are phase 2.
// ---------------------------------------------------------------------------
const PORTALS = {
  '/dealer': {
    view: 'portal-stub',
    title: 'Dealer portal',
    heading: 'The dealer portal is the phase-2 build',
    copy:
      'Live listings, lead routing, expiring-stock alerts and commission summaries are specified in §7.2 and land in phase 2. Until then, stock and leads are managed by the ops desk — message us and a human answers.',
    metaDescription:
      'The dealer portal — live listings, lead routing and commission summaries — is the phase-2 build. Until then the ops desk manages stock and leads by hand.',
    icon: 'store',
    ctaLabel: 'Talk to the ops desk',
    secondLabel: 'See dealer packages',
    secondHref: '/partner',
  },
};

for (const [path, portal] of Object.entries(PORTALS)) {
  router.get(path, async (req, res, next) => {
    try {
      return await sendPage(req, res, {
        routePath: path,
        view: portal.view,
        cache: CACHE.private,
        page: {
          title: portal.title,
          metaTitle: portal.title,
          titleSuffix: true,
          description: portal.metaDescription || portal.copy,
          canonical: path,
          robots: 'noindex,nofollow',
          breadcrumbs: [{ label: portal.title }],
          bodyClass: 'page-portal',
          jsonLd: [],
        },
        data: { portal, trail: [{ label: portal.title }] },
      });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = {
  router,
  buildVerificationLocals,
  buildHowItWorksLocals,
  buildGuideLocals,
  buildFaqLocals,
  buildContactLocals,
  buildAboutLocals,
  buildPartnerLocals,
  buildLegalLocals,
  LEGAL_SLUGS,
  FAQ_GROUPS,
};
