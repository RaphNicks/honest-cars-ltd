'use strict';

/**
 * Static build registry — the "statically generated public pages" half of §12.4.
 *
 * Every entry below is rendered once by `npm run build:static`, written to
 * STATIC_DIR as a real HTML file and then served from disk. Anything not listed
 * here — /cars, the VDP, the sold archive, /concierge/{id}, /order/{no} — is
 * rendered per request instead.
 *
 * Each entry only needs a path, a view and a build() function; the builder,
 * manifest, sitemap and cache headers come for free.
 */

const seo = require('../services/seo');
const { buildHomeLocals, buildFacetLocals } = require('./public');
const { buildServicesHubLocals, buildServiceLocals } = require('./services');
const { buildFindMyCarLocals, buildSellSwapLocals, buildHireLocals } = require('./flow');
const { buildBlogLocals, buildPostLocals } = require('./blog');
const { buildShopLocals, buildProductLocals } = require('./shop');
const {
  buildVerificationLocals,
  buildHowItWorksLocals,
  buildGuideLocals,
  buildFaqLocals,
  buildContactLocals,
  buildAboutLocals,
  buildPartnerLocals,
  buildLegalLocals,
  LEGAL_SLUGS,
} = require('./pages');

/** Curated facet pages (§14.1) — the indexable subset only. */
async function facetRoutes({ db }) {
  const facets = await db.facets.allIndexable();
  return facets.map((facet) => ({
    path: facet.canonicalPath,
    view: 'facet',
    async build() {
      const built = await buildFacetLocals(facet);
      return {
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
          filters: {},
          basePath: facet.canonicalPath,
          queryString: '',
          activePills: [],
          nearMatches: 0,
          hiddenQuery: {},
          locationLabel: 'Port Harcourt',
        },
      };
    },
  }));
}

/** §6.7 — the hub plus one page per service (hire lives at /hire). */
async function serviceRoutes({ db }) {
  const services = await db.content.serviceSuite();
  const routes = [
    {
      path: '/services',
      view: 'services',
      build: () => buildServicesHubLocals(),
    },
  ];

  for (const service of services) {
    if (service.slug === 'hire') continue; // /hire is the canonical URL
    routes.push({
      path: `/services/${service.slug}`,
      view: 'service',
      build: () => buildServiceLocals(service.slug),
    });
  }
  return routes;
}

/** §6.9 — blog home, the evergreen shelf and every published post. */
async function blogRoutes({ db }) {
  const routes = [
    { path: '/blog', view: 'blog', build: () => buildBlogLocals({ page: 1 }) },
    { path: '/guide', view: 'guide', build: () => buildGuideLocals() },
  ];

  const feed = await db.content.blogIndex({ page: 1, perPage: 48 });
  for (const post of feed.posts) {
    routes.push({
      path: post.url,
      view: 'post',
      build: () => buildPostLocals(post.slug),
    });
  }
  return routes;
}

/** §6.8 — shop home and every active product page. */
async function shopRoutes({ db }) {
  const products = await db.content.products();
  const routes = [{ path: '/shop', view: 'shop', build: () => buildShopLocals(null) }];
  for (const product of products) {
    routes.push({
      path: product.url,
      view: 'product',
      build: () => buildProductLocals(product.slug),
    });
  }
  return routes;
}

/** §6.10 — trust, company, funnel entry pages and the legal set. */
function trustRoutes() {
  return [
    { path: '/verification', view: 'verification', build: () => buildVerificationLocals() },
    { path: '/how-it-works', view: 'how-it-works', build: () => buildHowItWorksLocals() },
    { path: '/about', view: 'about', build: () => buildAboutLocals() },
    { path: '/faq', view: 'faq', build: () => buildFaqLocals() },
    { path: '/contact', view: 'contact', build: () => buildContactLocals() },
    { path: '/partner', view: 'partner', build: () => buildPartnerLocals() },
    { path: '/find-my-car', view: 'find-my-car', build: () => buildFindMyCarLocals() },
    { path: '/sell-swap', view: 'sell-swap', build: () => buildSellSwapLocals() },
    { path: '/hire', view: 'hire', build: () => buildHireLocals() },
    ...LEGAL_SLUGS.map((slug) => ({
      path: `/${slug}`,
      view: 'page',
      build: () => buildLegalLocals(slug),
    })),
  ];
}

/**
 * @param {object} ctx
 * @param {object} ctx.db
 * @returns {Promise<Array<{path: string, view: string, build: Function}>>}
 */
async function staticRoutes(ctx) {
  const home = {
    path: '/',
    view: 'home',
    build() {
      return buildHomeLocals();
    },
  };

  const [facets, services, blog, shop] = await Promise.all([
    facetRoutes(ctx),
    serviceRoutes(ctx),
    blogRoutes(ctx),
    shopRoutes(ctx),
  ]);

  return [home, ...facets, ...services, ...blog, ...shop, ...trustRoutes()];
}

module.exports = { staticRoutes, facetRoutes, serviceRoutes, blogRoutes, shopRoutes, trustRoutes };
