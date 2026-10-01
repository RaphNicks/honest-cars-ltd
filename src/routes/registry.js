'use strict';

/**
 * Static build registry — the "statically generated public pages" half of §12.4.
 *
 * Every entry below is rendered once by `npm run build:static`, written to
 * STATIC_DIR as a real HTML file and then served from disk. Anything not listed
 * here — /cars and the VDP in particular — is rendered per request instead.
 *
 * The remaining ~27 PRD routes (/services/*, /blog, /legal, /how-it-works,
 * /faq, /about, /contact, /partner, /hire, /shop…) get added as they are
 * ported. Each one only needs a path, a view and a build() function; the
 * builder, manifest, sitemap and cache headers come for free.
 */

const seo = require('../services/seo');
const { buildHomeLocals, buildFacetLocals } = require('./public');

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
  const facets = await facetRoutes(ctx);
  return [home, ...facets];
}

module.exports = { staticRoutes, facetRoutes };
