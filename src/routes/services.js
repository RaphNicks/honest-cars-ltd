'use strict';

/**
 * Services hub + service pages — §6.7.
 *
 *   GET /services            hub: the whole suite on one grid (static-capable)
 *   GET /services/:slug      one of the nine §6.7 pages (static-capable)
 *   GET /services/hire       301 → /hire, where the hire page lives (§6.7 table)
 *
 * Every service page uses the same template: hero + from-price + CTA +
 * WhatsApp ghost CTA + trust line, what you get with included/excluded table,
 * how it works with timelines, pricing tiers, proof, FAQ accordion, and an
 * inline booking/request form followed by related services and listings.
 */

const express = require('express');
const db = require('../db');
const seo = require('../services/seo');
const { sendPrebuiltOrRender } = require('../lib/respond');

const router = express.Router();

/** Faq scope for a service page; /hire keeps its FAQs under page:hire. */
function faqScope(slug) {
  return slug === 'hire' ? 'page:hire' : `service:${slug}`;
}

/**
 * Which inventory to cross-sell under each service (§6.7 “related listings
 * (where sensible)”). Parts and B2B have no sensible listing match.
 */
const SERVICE_LISTING_RULES = {
  inspection: { filters: { grade: 'certified' }, sort: 'recommended', heading: 'Certified cars you can book an inspection on' },
  documents: { filters: { customs_verified: true }, sort: 'newest', heading: 'Cars with customs papers already sighted' },
  tracking: { filters: {}, sort: 'newest', heading: 'Recently listed cars worth protecting' },
  concierge: { filters: {}, sort: 'recommended', heading: 'Not sure this round is for you? Start here anyway' },
  research: { filters: {}, sort: 'price_desc', heading: 'Cars people are asking us to price-check right now' },
  consultation: { filters: {}, sort: 'recommended', heading: 'Shortlists we would happily talk through' },
  'sell-swap': { filters: {}, sort: 'newest', heading: 'What the network looks like before you swap' },
  'dealer-services': null,
  parts: null,
  hire: null,
};

async function relatedListingsFor(slug, limit = 3) {
  const rule = SERVICE_LISTING_RULES[slug];
  if (!rule) return null;
  try {
    const result = await db.listings.browse(rule.filters, { perPage: limit, sort: rule.sort });
    return { heading: rule.heading, listings: result.listings };
  } catch {
    return null;
  }
}

/** Locals shared by the hub and every service page. */
async function buildServiceLocals(slug) {
  const service = await db.content.serviceBySlug(slug);
  if (!service) return null;

  const [faqs, related, listingBlock, testimonials] = await Promise.all([
    db.content.faqsForScope(faqScope(slug)),
    db.content.relatedServices(slug, 3),
    relatedListingsFor(slug),
    service.proof && service.proof.length ? Promise.resolve([]) : db.content.publishedTestimonials(2),
  ]);

  const meta = seo.serviceMeta(service);
  const trail = [
    { label: 'Services', href: '/services' },
    { label: service.name },
  ];

  const jsonLd = [
    seo.breadcrumbSchema(trail.map((crumb) => ({ label: crumb.label, href: crumb.href }))),
    seo.serviceSchema(service),
    seo.howToSchema(service),
    seo.faqSchema(faqs),
  ].filter(Boolean);
  if (listingBlock && listingBlock.listings.length) {
    jsonLd.push(seo.itemListSchema(listingBlock.listings, { name: listingBlock.heading }));
  }

  return {
    view: 'service',
    page: {
      title: meta.title,
      metaTitle: meta.title,
      titleSuffix: false,
      description: meta.description,
      canonical: `/services/${service.slug}`,
      breadcrumbs: trail,
      bodyClass: `page-service page-service--${service.slug}`,
      jsonLd,
    },
    data: { service, faqs, related, listingBlock, testimonials, trail },
  };
}

// ---------------------------------------------------------------------------
// Services hub
// ---------------------------------------------------------------------------
async function buildServicesHubLocals() {
  const [services, testimonials, faqs, counters] = await Promise.all([
    db.content.serviceSuite(),
    db.content.publishedTestimonials(3),
    db.content.faqsForScope('page:services'),
    db.listings.networkCounters(),
  ]);

  const trail = [{ label: 'Services' }];

  return {
    view: 'services',
    page: {
      title: 'Car services in Port Harcourt — inspection and more',
      metaTitle: 'Car services in Port Harcourt',
      titleSuffix: true,
      description:
        'One coherent suite around the car: pre-purchase inspections, customs and documents, concierge search, tracking, hire, research, consultation and parts — all in Port Harcourt.',
      canonical: '/services',
      breadcrumbs: trail,
      bodyClass: 'page-services',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Services', href: '/services' }]),
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: 'HonestCars services',
          itemListElement: services.map((service, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: service.name,
            url: seo.absolute(service.url),
          })),
        },
        seo.faqSchema(faqs),
      ],
    },
    data: { services, testimonials, faqs, counters, trail },
  };
}

router.get('/', async (req, res, next) => {
  try {
    const locals = await buildServicesHubLocals();
    await sendPrebuiltOrRender(req, res, { routePath: '/services', ...locals });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// /services/hire → /hire (§6.7 table: car hire is the one service with its own
// top-level URL). 301 so the link equity lands on the real page.
// ---------------------------------------------------------------------------
router.get('/hire', (req, res) => res.redirect(301, '/hire'));

router.get('/:slug', async (req, res, next) => {
  try {
    const locals = await buildServiceLocals(req.params.slug);
    if (!locals) return next();
    await sendPrebuiltOrRender(req, res, { routePath: `/services/${req.params.slug}`, ...locals });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, buildServiceLocals, buildServicesHubLocals, faqScope, relatedListingsFor };
