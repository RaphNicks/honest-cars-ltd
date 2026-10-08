'use strict';

/**
 * Public storefront routes for the vertical slice.
 *
 *   GET /                       static-capable  (§6.1)
 *   GET /cars                   server-rendered (§6.2)
 *   GET /cars/{facet}           curated, static-capable (§14.1)
 *   GET /cars/{slug}            VDP, server-rendered (§6.3)
 *   GET /cars/sold/{slug}       sold archive 7→90 days, else 301 (§6.2/§14.1)
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const seo = require('../services/seo');
const compare = require('../services/compare');
const listingQuery = require('../services/listing-query');
const areaPref = require('../services/area-pref');
const cityDirectory = require('../services/city-directory');
const sitemap = require('../services/sitemap');
const slice = require('../services/slice');
const { sendPage, sendPrebuiltOrRender, CACHE } = require('../lib/respond');
const { helpers } = require('../lib/locals');

const router = express.Router();

// ---------------------------------------------------------------------------
// Homepage — §6.1 (static-capable: it renders identically for everyone)
// ---------------------------------------------------------------------------
async function buildHomeLocals() {
  const [feed, testimonials, posts, services, facets, counters] = await Promise.all([
    db.listings.homeFeed(config.listings.homeFeedLimit),
    db.content.publishedTestimonials(4),
    db.content.latestPosts(3),
    db.content.serviceSuite(),
    db.listings.filterFacets(),
    db.listings.networkCounters(),
  ]);

  const faqs = await db.content.faqsForScope('global');

  // §7.3 — the CMS owns the homepage modules. Counters contribute labels only;
  // the figures stay live so a published number can never be stale.
  const modules = await db.cms.homepageModules();
  const counterLabels = (modules.counters && modules.counters.labels) || {};
  const picked = ((modules.featured && modules.featured.listing_slugs) || []).filter(Boolean).slice(0, 6);
  const featured = picked.length ? await db.listings.bySlugs(picked) : [];

  return {
    view: 'home',
    page: {
      title: 'Verified cars for sale in Port Harcourt',
      metaTitle: 'Verified cars in Port Harcourt — every price compared',
      description:
        'Browse verified cars from trusted Port Harcourt lots. Honest inspection grades, real mileage, documents checked, and negotiation handled for you.',
      canonical: '/',
      ogImage: '/og/default.png',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }]),
        seo.itemListSchema(feed.tabs.all.listings, { name: 'Fresh on the market' }),
        seo.faqSchema(faqs),
      ],
      breadcrumbs: null,
      bodyClass: 'page-home',
    },
    data: {
      feed,
      testimonials,
      posts,
      services,
      facets,
      counters,
      faqs,
      modules,
      counterLabels,
      featured: featured.filter(Boolean),
      featuredModule: modules.featured || null,
    },
  };
}

router.get('/', async (req, res, next) => {
  try {
    const built = await buildHomeLocals();
    await sendPrebuiltOrRender(req, res, { routePath: '/', ...built });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// /cars — server-rendered: filters, sort and pagination are per request (§12.4)
// ---------------------------------------------------------------------------
async function buildBrowseLocals({ routePath, filters, view, sort, page, city = null }) {
  const [result, facets, models] = await Promise.all([
    db.listings.browse(filters, { page, perPage: listingQuery.PER_PAGE, sort }),
    // FR-32: the rail is scoped to the market being viewed, so its makes,
    // areas and budget range are the ones this page can actually show.
    db.listings.filterFacets({ city: city ? city.name : null }),
    view.make ? db.listings.modelCounts(view.make) : Promise.resolve([]),
  ]);

  const nearMatches = result.total === 0 ? await db.listings.countNearMatches(filters) : 0;

  return { result, facets, models, nearMatches, view, sort };
}

router.get('/cars', async (req, res, next) => {
  try {
    const parsed = listingQuery.parseListingQuery(req.query);
    // FR-32 — which market is this visitor looking at? An explicit ?city= wins,
    // otherwise the remembered preference, otherwise the whole network. The
    // token is resolved against service_cities first (the markets we operate),
    // then the national catalogue: a city we list but have no lots in is a real
    // filter that honestly returns nothing, while a token we do not recognise
    // at all is still dropped rather than applied.
    const requested = parsed.view.city || null;
    const remembered = requested ? null : areaPref.readCityPreference(req);
    const city = await cityDirectory.resolve(requested || remembered);

    if (city) {
      parsed.filters.city = city.name;
      parsed.view.city = city.slug;
    } else {
      delete parsed.filters.city;
      delete parsed.view.city;
    }
    // An explicit choice becomes the preference — but only for a city we
    // operate in. Remembering "Lagos" for a visitor who would land on an empty
    // grid on every future visit is not the memory they asked for. A city we
    // list but have no lots in is a one-visit look; anything unrecognised
    // clears a stale preference instead of leaving it to mislead.
    if (requested && city && city.served) areaPref.setCityPreference(res, city.slug);
    if (requested && !city) areaPref.clearCityPreference(res);

    // The preference case has no URL token for it, so the page is a variant of
    // /cars: never cached publicly, never indexed as if it were the whole market.
    const fromPreference = !requested && Boolean(city);

    const built = await buildBrowseLocals({
      routePath: '/cars',
      filters: parsed.filters,
      view: parsed.view,
      sort: parsed.sort,
      page: parsed.page,
      city,
    });

    // §14.1: raw filter combinations stay noindex — they canonicalise back to a
    // crawlable page. A URL that carries nothing but the market is the one
    // exception: it canonicalises onto that market's curated facet page, which
    // is the page we actually want in the index.
    const cityFacet = city ? await db.facets.findBySlug(city.slug) : null;
    const otherFilters = Object.keys(parsed.view).filter((key) => key !== 'city');
    const onlyCity = Boolean(city) && !fromPreference && otherFilters.length === 0;
    const raw = listingQuery.isRawFilterCombo(parsed.view) && !onlyCity;
    const queryString = listingQuery.buildQueryString(parsed.view, { sort: parsed.sort });
    const activePills = listingQuery.activeFilterPills(parsed.view, helpers()).map((pill) => (
      // The URL carries `owerri`; a person reads “Owerri, Imo State”.
      pill.key === 'city' && city ? { ...pill, value: `${city.name}, ${city.stateLabel}` } : pill
    ));

    const locationLabel = city ? `${city.name}, ${city.stateLabel}` : 'All markets';
    // §6.2's hero copy follows the market: a buyer who filtered to Owerri should
    // not read a Port Harcourt introduction.
    const heading = city ? `Cars for sale in ${city.name}` : 'Cars for sale in Port Harcourt, Owerri, Aba & Benin City';
    // A market with stock gets the market intro. A city we list but have no lots
    // in says so, and offers the thing that can actually help; the network view
    // keeps the four-market line.
    const intro = city && city.live > 0
      ? `Live stock from partner lots in ${city.name}, ${city.stateLabel} — with the mileage, documents status and verification grade shown before you travel. Prices are what the dealer is asking; we tell you where each one sits against the current market band.`
      : city
        ? `We do not have partner lots in ${city.name} yet. Tell us what you are looking for and a human will find it, verify it and bring you the paperwork — usually inside 72 hours. Every car we do have is one click away.`
        : 'Live stock from partner lots across four markets — Port Harcourt, Owerri, Aba and Benin City — with the mileage, documents status and verification grade shown before you travel. Prices are what the dealer is asking; we tell you where each one sits against the current market band.';

    const data = {
      ...built,
      heading,
      intro,
      filters: parsed.view,
      activePills,
      basePath: '/cars',
      queryString,
      hiddenQuery: parsed.view,
      locationLabel,
      serviceCity: city,
      // A city we list but have no stock in: the empty state says so in words
      // instead of showing the generic "no exact matches", which would read as
      // a filter problem rather than an honest "we are not there yet".
      marketEmpty: Boolean(city) && city.live === 0,
    };

    await sendPage(req, res, {
      routePath: '/cars',
      view: 'cars',
      cache: fromPreference ? CACHE.private : CACHE.ssr,
      headers: fromPreference ? { Vary: 'Cookie' } : {},
      page: {
        // A market with stock is the page a buyer searched for. A city we list
        // but have no lots in must not promise "verified stock" in a title or a
        // meta description — it says what is true and points at the concierge.
        title: !city
          ? 'Cars for sale in Port Harcourt & South-East Nigeria'
          : city.live > 0
            ? `Cars for sale in ${city.name} — verified stock`
            : `Cars for sale in ${city.name} — we are not there yet`,
        metaTitle: !city
          ? 'Cars for sale in Port Harcourt & South-East Nigeria'
          : city.live > 0
            ? `Cars for sale in ${city.name}, ${city.stateLabel} — verified stock`
            : `Cars for sale in ${city.name}, ${city.stateLabel} — find one for me`,
        description: !city
          ? 'Filter live verified stock across Port Harcourt, Owerri, Aba and Benin City by budget, make, body type, mileage and verification grade. Prices shown against the current market band.'
          : city.live > 0
            ? `Filter live verified stock in ${city.name}, ${city.stateLabel} by budget, make, body type, mileage and verification grade. Prices shown against the current market band.`
            : `No partner lots in ${city.name} yet. Send us the car you want and a human will find it, verify it and bring you the paperwork — usually inside 72 hours.`,
        canonical: onlyCity && cityFacet ? cityFacet.canonicalPath : raw || fromPreference ? '/cars' : `/cars${queryString}`,
        // Only a city with a curated facet is a page we want indexed. Every
        // other city view is a filter of /cars — including a city we list but
        // have no stock in, which would otherwise publish an empty page as
        // "Cars for sale in Lagos" and mean it.
        robots: onlyCity && cityFacet ? 'index,follow' : raw || fromPreference || (city && !cityFacet) ? 'noindex,follow' : 'index,follow',
        jsonLd: [seo.itemListSchema(built.result.listings, {
          name: city ? `Cars for sale in ${city.name}` : 'Cars for sale in Port Harcourt, Owerri, Aba and Benin City',
        })],
        bodyClass: 'page-cars',
      },
      data: {
        ...data,
        crumbs: city
          ? [{ label: 'Cars for sale', href: '/cars' }, { label: `${city.name} cars` }]
          : [{ label: 'Cars for sale' }],
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Curated facets — /cars/toyota · /cars/toyota/camry · /cars/suv-under-15m
// ---------------------------------------------------------------------------
async function buildFacetLocals(facet) {
  const facetFilters = db.listings.filtersFromFacet(facet);
  const parsed = listingQuery.parseListingQuery({});
  // A city facet (§14.1) carries its market as a rule, not as a query string,
  // so the rail and the chrome follow it the same way /cars does.
  const city = facetFilters.city ? await db.areas.cityByName(facetFilters.city) : null;
  const [result, facets, models] = await Promise.all([
    db.listings.browse(facetFilters, { page: 1, perPage: listingQuery.PER_PAGE, sort: 'recommended' }),
    db.listings.filterFacets({ city: city ? city.name : null }),
    Promise.resolve([]),
  ]);
  const certified = result.listings.filter((l) => l.grade === 'certified').length;
  const trail = (await db.facets.breadcrumbTrail(facet.slug)).map((node, index, all) => ({
    label: node.title,
    href: index < all.length - 1 ? node.canonicalPath : null,
  }));
  const siblings = (await db.facets.childrenOf(facet.slug)).concat(
    (facet.parentSlug ? [] : await db.facets.topLevel(8)).filter((s) => s.slug !== facet.slug),
  );
  const facetFaqs = await db.content.faqsForScope(`facet:${facet.slug}`);
  void parsed;
  return {
    facet, result, facets, models, serviceCity: city, certifiedCount: certified, trail, siblings: siblings.slice(0, 8), facetFaqs,
  };
}

/**
 * Resolve /cars/<anything>. Order matters and follows §14.1:
 *   1. a curated facet (indexable, own canonical)
 *   2. a live/reserved VDP
 *   3. a sold listing inside the 7-day soft window (its VDP carries the badge)
 *   4. a sold listing in the 7→90 day archive
 *   5. a sold listing past 90 days → 301 to the facet
 *   6. otherwise 404
 */
// ---------------------------------------------------------------------------
// Compare tool — §6.4. Up to 3 cars side-by-side with best values highlighted.
// Rendered server-side from ?ids= so a shared link shows the same table, and
// hydrated by compare.js from the device’s comparison list.
// ---------------------------------------------------------------------------
router.get('/cars/compare', async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3);
    const listings = await db.listings.findByIds(ids);

    // One definition of the comparison, shared with the concierge shortlist
    // (§7.3): the buyer's shortlist and the visitor's compare tool must never
    // disagree about what a row means.
    const rows = compare.rowsFor(listings, {
      formatNaira: db.shape.formatNaira,
      formatMileage: db.shape.formatMileage,
    });

    const trail = [{ label: 'Cars', href: '/cars' }, { label: 'Compare' }];
    const canonical = ids.length ? `/cars/compare?ids=${listings.map((l) => l.id).join(',')}` : '/cars/compare';

    return await sendPage(req, res, {
      routePath: '/cars/compare',
      view: 'compare',
      cache: CACHE.ssr,
      page: {
        title: 'Compare cars side by side',
        metaTitle: 'Compare cars — price, mileage, grade, documents',
        titleSuffix: true,
        description:
          'Up to three verified cars side-by-side: price position, mileage, condition, documents, known faults and a transparent five-year running-cost estimate.',
        canonical,
        // A comparison is a personal view of listings — useful, not indexable.
        robots: 'noindex,follow',
        breadcrumbs: trail,
        bodyClass: 'page-compare',
        jsonLd: [seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Cars', href: '/cars' }, { label: 'Compare' }])],
      },
      data: {
        listings,
        rows,
        requestedIds: ids,
        comparedCount: listings.length,
        trail,
        compareIds: listings.map((listing) => listing.id).join(','),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/cars/*', async (req, res, next) => {
  const rest = String(req.params[0] || '').replace(/\/+$/, '');
  if (!rest) return res.redirect(301, '/cars');

  try {
    // The sold archive lives under its own prefix so its canonical is stable.
    if (rest === 'sold') return res.redirect(301, '/cars');
    if (rest.startsWith('sold/')) {
      const slug = rest.slice('sold/'.length);
      return await sendSoldArchiveOrRedirect(req, res, slug, true);
    }

    // 1 — curated facet (indexable subset only, §14.1)
    const facet = await db.facets.findBySlug(rest);
    if (facet && facet.indexable) {
      const built = await buildFacetLocals(facet);
      return await sendPrebuiltOrRender(req, res, {
        routePath: facet.canonicalPath,
        view: 'facet',
        page: {
          title: facet.metaTitle,
          titleSuffix: false,
          metaTitle: facet.metaTitle,
          description: facet.metaDescription,
          canonical: facet.canonicalPath,
          robots: 'index,follow',
          jsonLd: [
            seo.breadcrumbSchema(built.trail.map((c) => ({ label: c.label, href: c.href }))),
            seo.itemListSchema(built.result.listings, { name: facet.title }),
            seo.faqSchema(built.facetFaqs),
          ],
          bodyClass: 'page-facet',
        },
        data: {
          ...built,
          // The rail still reads the selected market off `filters`, so a city
          // facet's rail does not claim "All cities" while showing one.
          filters: built.serviceCity ? { city: built.serviceCity.slug } : {},
          basePath: facet.canonicalPath,
          queryString: '',
          activePills: [],
          nearMatches: 0,
          hiddenQuery: {},
          locationLabel: built.serviceCity
            ? `${built.serviceCity.name}, ${built.serviceCity.stateLabel || built.serviceCity.state} State`
            : 'All markets',
        },
      });
    }

    // 2 & 3 — live, reserved, or sold within the 7-day visible window: the VDP.
    const listing = await db.listings.findBySlug(rest);
    if (listing) return await renderVdp(req, res, listing);

    // 3b — a make or make+model that has no curated facet: browse, not 404.
    const [makeSlug, modelSlug, ...extra] = rest.split('/');
    if (!extra.length) {
      const makePage = await buildMakeBrowseLocals(makeSlug, modelSlug || null);
      if (makePage) {
        const filters = makePage.filters;
        const view = { ...filters };
        const built = await buildBrowseLocals({
          routePath: `/cars/${rest}`,
          filters,
          view,
          sort: 'recommended',
          page: 1,
        });
        const label = makePage.model ? `${makePage.make} ${makePage.model}` : makePage.make;
        return await sendPage(req, res, {
          routePath: `/cars/${rest}`,
          view: 'cars',
          cache: CACHE.ssr,
          page: {
            title: `${label} cars for sale — verified stock`,
            metaTitle: `${label} cars for sale — verified stock`,
            description: `Every verified ${label} in stock with its price position, documents and known faults checked. Browse live stock and compare before you buy.`,
            canonical: '/cars',
            robots: 'noindex,follow',
            jsonLd: [
              seo.breadcrumbSchema([
                { label: 'Cars', href: '/cars' },
                { label },
              ]),
            ],
            bodyClass: 'page-cars',
          },
          data: {
            ...built,
            filters: view,
            activePills: listingQuery.activeFilterPills(view, helpers()),
            basePath: `/cars/${rest}`,
            queryString: '',
            hiddenQuery: view,
            nearMatches: built.nearMatches,
            locationLabel: 'All markets',
            makeBrowse: { label, count: built.result.total },
            heading: `${label} cars for sale`,
            intro: `${built.result.total} verified ${label} cars in stock right now, each with its mileage, documents status and verification grade checked before it was listed. Prices are what the dealer is asking — we show where each sits against the market band.`,
            crumbs: [{ label: 'Cars for sale', href: '/cars' }, { label }],
          },
        });
      }
    }

    // 4 — 7→90 days: hand the old VDP URL to its canonical archive page.
    const archived = await db.listings.findArchivedSoldBySlug(rest);
    if (archived) return res.redirect(301, `/cars/sold/${rest}`);

    // 5 — beyond 90 days: 301 to the listing's facet (§14.1).
    const redirect = await db.listings.findRedirectTarget(rest);
    if (redirect) {
      await db.redirects.upsert(`/cars/${rest}`, redirect.to, redirect.reason).catch(() => {});
      return res.redirect(301, redirect.to);
    }

    // 6 — nothing here
    return await sendNotFound(req, res);
  } catch (error) {
    return next(error);
  }
});

/**
 * /cars/{make} and /cars/{make}/{model} — the fallback for a make that has no
 * curated facet page. Curated facets are the indexable subset (§14.1); a bare
 * make+model combination is a raw filter, so it renders a real, working browse
 * page with `noindex,follow` and canonical /cars rather than a 404 — which is
 * what a dealer's brand link or a VDP breadcrumb deserves.
 */
async function buildMakeBrowseLocals(makeSlug, modelSlug) {
  const facets = await db.listings.filterFacets();
  const makeEntry = (facets.makes || []).find((entry) => slugify(entry.value) === makeSlug);
  if (!makeEntry) return null;

  const filters = { make: makeEntry.value };
  let modelLabel = null;

  if (modelSlug) {
    const models = await db.listings.modelCounts(makeEntry.value);
    const modelEntry = (models || []).find((entry) => slugify(entry.value) === modelSlug);
    if (!modelEntry) return null;
    filters.model = modelEntry.value;
    modelLabel = modelEntry.value;
  }

  return { make: makeEntry.value, model: modelLabel, filters };
}

/**
 * Sold archive page (§6.2 + §14.1).
 *   0–7 days    handled by the VDP itself, with the "Sold in N days" badge
 *   7–90 days   this page: indexable, similar cars, routes to live stock
 *   >90 days    301 to the listing's curated facet
 */
async function sendSoldArchiveOrRedirect(req, res, slug, canonicalPrefix) {
  const archived = await db.listings.findArchivedSoldBySlug(slug);
  if (archived) {
    const similar = await db.listings.findSimilar(archived, config.listings.similarLimit);
    const canonical = canonicalPrefix ? `/cars/sold/${slug}` : `/cars/${slug}`;
    return await sendPage(req, res, {
      routePath: canonical,
      view: 'sold-archive',
      cache: CACHE.static,
      page: {
        title: `${archived.title} — sold`,
        metaTitle: `${archived.title} — sold in Port Harcourt | HonestCars`,
        description: `${archived.title} sold through HonestCars. See what it was listed at and browse similar verified cars available now in Port Harcourt.`,
        canonical,
        robots: 'index,follow',
        jsonLd: [
          seo.breadcrumbSchema([
            { label: 'Cars', href: '/cars' },
            { label: 'Sold archive', href: '/cars/sold' },
            { label: archived.title },
          ]),
        ],
        bodyClass: 'page-archive',
      },
      data: {
        listing: archived,
        similar,
        trail: [{ label: 'Cars for sale', href: '/cars' }, { label: 'Sold archive' }],
      },
    });
  }

  const redirect = await db.listings.findRedirectTarget(slug);
  if (redirect) {
    await db.redirects.upsert(`/cars/sold/${slug}`, redirect.to, redirect.reason).catch(() => {});
    return res.redirect(301, redirect.to);
  }

  return sendNotFound(req, res);
}

// ---------------------------------------------------------------------------
// VDP renderer (shared by the soft-window sold state)
// ---------------------------------------------------------------------------
async function renderVdp(req, res, listing) {
  const [similar, priceBand] = await Promise.all([
    db.listings.findSimilar(listing, config.listings.similarLimit),
    db.listings.findPriceBand(listing),
  ]);

  if (priceBand && priceBand.position !== listing.pricePosition) {
    // The live band is authoritative for the price-position indicator (§3.5).
    listing.pricePosition = priceBand.position;
  }

  const meta = seo.vdpMeta(listing);
  const ogImage = listing.primaryImage ? ogImagePath(listing) : '/og/default.png';

  return await sendPage(req, res, {
    routePath: `/cars/${listing.slug}`,
    view: 'vdp',
    cache: CACHE.ssr,
    page: {
      title: meta.fullTitle,
      titleSuffix: false,        // vdpMeta already ends with “| HonestCars”
      metaTitle: meta.fullTitle,
      description: meta.description,
      canonical: `/cars/${listing.slug}`,
      robots: listing.status === 'sold' ? 'noindex,follow' : 'index,follow',
      ogImage,
      ogImageAlt: `${listing.title} · ${listing.area}, Port Harcourt`,
      ogType: 'product',
      jsonLd: [
        seo.vehicleSchema(listing),
        seo.breadcrumbSchema([
          { label: 'Cars', href: '/cars' },
          { label: listing.make, href: `/cars/${seo.esc(listing.make.toLowerCase().replace(/\s+/g, '-'))}` },
          { label: listing.title },
        ]),
      ],
      bodyClass: 'page-vdp',
    },
    data: {
      listing,
      similar,
      priceBand,
      trail: [
        { label: 'Cars for sale', href: '/cars' },
        { label: `${listing.make} ${listing.model}`, href: `/cars/${slugify(listing.make)}` },
        { label: listing.title },
      ],
    },
  });
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** OG cards are generated on demand and cached by content hash (§12.4). */
function ogImagePath(listing) {
  return `/api/og/listing/${listing.slug}.png`;
}

// ---------------------------------------------------------------------------
// Sitemap + robots — regenerated from live data on every request, cached briefly
// (§12.4). The static build also writes these files for static deployments.
// ---------------------------------------------------------------------------
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const xml = await sitemap.buildSitemap(db, { siteUrl: config.siteUrl });
    res.type('application/xml');
    res.set('Cache-Control', 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=86400');
    res.send(xml);
  } catch (error) {
    next(error);
  }
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(sitemap.buildRobots({ siteUrl: config.siteUrl }));
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------
/**
 * 404 — with a difference. If the path is one of the PRD routes that this
 * vertical slice has not ported yet, say so plainly and show the slice map, so
 * a reviewer can tell "not built yet" apart from "broken link".
 * Status stays 404 so search engines never index a half-built page.
 */
async function sendNotFound(req, res) {
  const pending = slice.pendingRouteFor(req.path);
  return await sendPage(req, res, {
    routePath: req.path,
    view: 'not-found',
    status: 404,
    cache: CACHE.private,
    page: {
      title: pending ? 'Not in this slice yet' : 'Page not found',
      metaTitle: pending ? 'Not ported yet | HonestCars' : 'Page not found | HonestCars',
      description: pending
        ? `${pending.label} is on the port backlog. This build covers the design system, the homepage, /cars and the vehicle pages.`
        : 'That page is not here. Browse live verified cars in Port Harcourt instead.',
      canonical: '/',
      robots: 'noindex,follow',
      bodyClass: 'page-404',
    },
    data: { pending, built: slice.BUILT, backlog: slice.PENDING },
  });
}

module.exports = { router, buildHomeLocals, buildFacetLocals, sendNotFound, slugify };
