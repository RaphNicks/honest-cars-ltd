'use strict';

/**
 * Slice map.
 *
 * This build is the agreed vertical slice: design system + homepage + /cars +
 * the VDP, on the real stack, with the database wired. The rest of the PRD §5.1
 * sitemap is ported next — until then those URLs return a 404 that says so
 * plainly, rather than a bare "page not found" that looks like a bug.
 *
 * When a route is ported, remove it from PENDING; check-links.js will start
 * requiring a 200 for it.
 */

const BUILT = [
  { path: '/', label: 'Homepage' },
  { path: '/cars', label: 'Car listings' },
  { path: '/cars/{slug}', label: 'Vehicle detail page' },
  { path: '/cars/toyota', label: 'Curated facet (make)' },
  { path: '/cars/toyota/camry', label: 'Curated facet (model)' },
  { path: '/cars/suv-under-15m', label: 'Curated facet (body + budget)' },
  { path: '/cars/sold/{slug}', label: 'Sold archive (day 7 → 90)' },
  { path: '/sitemap.xml', label: 'Sitemap' },
  { path: '/robots.txt', label: 'robots.txt' },
];

/** PRD §5.1 routes still to port, in the order they will be built. */
const PENDING = [
  { path: '/services', label: 'Services hub', phase: 'next' },
  { path: '/services/inspection', label: 'Pre-purchase inspection', phase: 'next' },
  { path: '/services/concierge', label: 'Find-my-car concierge', phase: 'next' },
  { path: '/services/documents', label: 'Customs & document services', phase: 'next' },
  { path: '/services/tracking', label: 'Car tracking & security', phase: 'next' },
  { path: '/services/research', label: 'Research & reports', phase: 'next' },
  { path: '/services/consultation', label: 'Paid consultation', phase: 'next' },
  { path: '/services/parts', label: 'Spare-parts sourcing', phase: 'next' },
  { path: '/find-my-car', label: 'Find My Car concierge flow', phase: 'next' },
  { path: '/sell-swap', label: 'Sell / swap flow', phase: 'next' },
  { path: '/hire', label: 'Car hire', phase: 'next' },
  { path: '/partner', label: 'Dealer recruitment', phase: 'next' },
  { path: '/blog', label: 'Blog home', phase: 'next' },
  { path: '/blog/{slug}', label: 'Blog post + Article schema', phase: 'next' },
  { path: '/guide', label: 'Honest Buyer’s Guide shelf', phase: 'next' },
  { path: '/how-it-works', label: 'How it works', phase: 'next' },
  { path: '/about', label: 'About', phase: 'next' },
  { path: '/verification', label: 'Verification (trust page)', phase: 'next' },
  { path: '/faq', label: 'FAQ', phase: 'next' },
  { path: '/contact', label: 'Contact', phase: 'next' },
  { path: '/shop', label: 'Products shop', phase: 'next' },
  { path: '/cars/compare', label: 'Compare tool', phase: 'next' },
  { path: '/terms', label: 'Terms', phase: 'legal' },
  { path: '/privacy', label: 'Privacy (NDPA-aligned)', phase: 'legal' },
  { path: '/refunds', label: 'Refunds', phase: 'legal' },
  { path: '/disclaimer', label: 'Disclaimer', phase: 'legal' },
  { path: '/account', label: 'Customer account', phase: 'phase-2' },
  { path: '/dealer', label: 'Dealer portal', phase: 'phase-2' },
  { path: '/admin', label: 'Admin console', phase: 'phase-2' },
];

/** Does this request path correspond to a route we have promised but not built? */
function pendingRouteFor(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';

  for (const route of PENDING) {
    if (route.path.includes('{')) {
      const prefix = route.path.split('{')[0];
      if (clean.startsWith(prefix.replace(/\/$/, '')) && clean !== prefix.replace(/\/$/, '')) return route;
      // /blog/anything and /cars/... handled by their own routers already.
      continue;
    }
    if (clean === route.path) return route;
  }

  // Dynamic prefixes: /blog/<slug>, /services/<slug>, /hire/<x>
  for (const prefix of ['/blog/', '/services/']) {
    if (clean.startsWith(prefix) && clean.length > prefix.length) {
      const match = PENDING.find((r) => r.path.startsWith(prefix));
      if (match) return match;
    }
  }

  return null;
}

module.exports = { BUILT, PENDING, pendingRouteFor };
