'use strict';

/**
 * Public per-dealer storefront (§037) — one public mini-site per partner lot.
 *
 *   GET /dealers/:slug   the lot's page: its logo, tagline and live stock
 *
 * The whole module is gated by config.features.dealerStorefront, which defaults
 * to off: when off, every /dealers/:slug URL 404s and the sitemap omits them,
 * so the feature is built end to end but surfaces nothing until the owner
 * flips it on. Discovery is by link only — the dealer shares the URL from the
 * portal — so there are deliberately no in-site links or a directory page.
 *
 * The car grid reuses the standard browse machinery (db.listings.browse with a
 * dealer_id scope) so the lot's stock filters, sorts and paginates exactly like
 * /cars. Two compact strips frame it: the lot's live cars priced below the
 * market band ("Deals") and its recently sold cars (social proof).
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const seo = require('../services/seo');
const listingQuery = require('../services/listing-query');
const { sendPage, CACHE } = require('../lib/respond');
const { helpers } = require('../lib/locals');
const { sendNotFound } = require('./public');

const router = express.Router();

const PER_PAGE = listingQuery.PER_PAGE;

function dealerJsonLd(dealer, result) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': ['AutoDealer', 'LocalBusiness'],
    name: dealer.name,
    url: `${config.siteUrl}/dealers/${dealer.slug}`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: dealer.lotArea || null,
      addressLocality: dealer.city,
      addressCountry: 'NG',
    },
    areaServed: { '@type': 'City', name: dealer.city },
  };
  if (dealer.logo) ld.logo = dealer.logo;
  if (dealer.tagline) ld.description = dealer.tagline;
  if (result && result.total) ld.hasCatalog = { '@type': 'ItemList', numberOfItems: result.total };
  return ld;
}

// GET /dealers/:slug — one lot's public storefront.
router.get('/:slug', async (req, res, next) => {
  try {
    // Feature off → the URL does not exist (no partial storefront, no leak).
    if (!config.features.dealerStorefront) return sendNotFound(req, res);

    const dealer = await db.dealers.bySlug(req.params.slug);
    if (!dealer) return sendNotFound(req, res);

    const basePath = `/dealers/${dealer.slug}`;
    const parsed = listingQuery.parseListingQuery(req.query);

    // The grid is the lot's non-sold stock; sold cars live in their own strip.
    const [result, deals, sold, facets] = await Promise.all([
      db.listings.browse(
        { ...parsed.filters, dealer_id: dealer.id, exclude_sold: true },
        { page: parsed.page, perPage: PER_PAGE, sort: parsed.sort },
      ),
      db.dealers.storefrontDeals(dealer.id),
      db.dealers.storefrontRecentlySold(dealer.id, 6),
      // The filter rail is scoped to the lot's market so the makes/budget it
      // offers are the ones this page can actually show.
      db.listings.filterFacets({ city: dealer.city }),
    ]);

    const description = [
      `${dealer.name} — ${dealer.tagline || 'verified cars for sale'}.`,
      `See ${dealer.city} lot's live stock with mileage, documents and the market price band shown before you travel.`,
    ].join(' ');

    return await sendPage(req, res, {
      routePath: basePath,
      view: 'dealers/storefront',
      cache: CACHE.ssr,
      page: {
        title: `${dealer.name} · ${dealer.city}`,
        metaTitle: `${dealer.name} · ${dealer.city} | HonestCars`,
        titleSuffix: false,
        description,
        canonical: basePath,
        robots: 'index,follow',
        ogImage: dealer.logo || '/og/default.png',
        ogImageAlt: dealer.name,
        ogType: 'website',
        bodyClass: 'page-dealer-storefront',
        jsonLd: [
          dealerJsonLd(dealer, result),
          seo.breadcrumbSchema([
            { label: 'Home', href: '/' },
            { label: dealer.name },
          ]),
          seo.itemListSchema(result.listings, { name: dealer.name }),
        ],
      },
      data: {
        dealer,
        result,
        deals,
        sold,
        facets,
        models: [],
        filters: parsed.view,
        basePath,
        queryString: listingQuery.buildQueryString(parsed.view, { sort: parsed.sort }),
        activePills: listingQuery.activeFilterPills(parsed.view, helpers(), basePath),
        nearMatches: 0,
        hiddenQuery: {},
        locationLabel: dealer.city,
        help: helpers(),
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router };
