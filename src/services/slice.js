'use strict';

/**
 * Slice map.
 *
 * This build ships the whole public storefront: design system, homepage,
 * /cars, the VDP, the service suite, both funnels (concierge + sell/swap),
 * hire, the blog, the shop and every trust/company/legal page. What remains is
 * the authenticated back office — the customer account interior, the dealer
 * portal and the admin console (§7.1–§7.4), which the PRD itself marks as
 * later-phase work.
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
  { path: '/cars/compare', label: 'Compare tool (≤3 cars)' },
  { path: '/services', label: 'Services hub' },
  { path: '/services/inspection', label: 'Pre-purchase inspection' },
  { path: '/services/concierge', label: 'Find-my-car concierge' },
  { path: '/services/documents', label: 'Customs & document services' },
  { path: '/services/tracking', label: 'Car tracking & security' },
  { path: '/services/research', label: 'Research & reports' },
  { path: '/services/consultation', label: 'Paid consultation' },
  { path: '/services/parts', label: 'Spare-parts sourcing' },
  { path: '/services/sell-swap', label: 'Sell or swap (service page)' },
  { path: '/services/dealer-services', label: 'B2B dealer services' },
  { path: '/find-my-car', label: 'Find My Car concierge flow' },
  { path: '/concierge/{id}', label: 'Concierge status page' },
  { path: '/sell-swap', label: 'Sell / swap flow' },
  { path: '/hire', label: 'Car hire' },
  { path: '/partner', label: 'Dealer recruitment' },
  { path: '/blog', label: 'Blog home' },
  { path: '/blog/{slug}', label: 'Blog post + Article schema' },
  { path: '/blog/rss.xml', label: 'Blog RSS feed' },
  { path: '/guide', label: 'Honest Buyer’s Guide shelf' },
  { path: '/shop', label: 'Products shop' },
  { path: '/shop/{slug}', label: 'Product page' },
  { path: '/cart', label: 'Cart' },
  { path: '/checkout', label: 'Guest checkout' },
  { path: '/order/{no}', label: 'Order confirmation' },
  { path: '/how-it-works', label: 'How it works' },
  { path: '/about', label: 'About' },
  { path: '/verification', label: 'Verification (trust page)' },
  { path: '/faq', label: 'FAQ' },
  { path: '/contact', label: 'Contact' },
  { path: '/terms', label: 'Terms (placeholder wording)' },
  { path: '/privacy', label: 'Privacy (NDPA-aligned, placeholder wording)' },
  { path: '/refunds', label: 'Refunds (placeholder wording)' },
  { path: '/disclaimer', label: 'Disclaimer (placeholder wording)' },
  { path: '/account', label: 'Account entry page (interior is phase 2)' },
  { path: '/dealer', label: 'Dealer portal entry page (interior is phase 2)' },
  { path: '/admin', label: 'Admin entry page (interior is phase 2)' },
  { path: '/sitemap.xml', label: 'Sitemap' },
  { path: '/robots.txt', label: 'robots.txt' },
];

/**
 * PRD §7 routes still to port — the authenticated back office. The public site
 * writes the records these screens will read (service_requests, bookings,
 * orders, subscriptions, leads, analytics_events).
 */
const PENDING = [
  { path: '/account/dashboard', label: 'Customer account dashboard (§7.1)', phase: 'phase-2' },
  { path: '/dealer/dashboard', label: 'Dealer portal: dashboard (§7.2)', phase: 'phase-2' },
  { path: '/dealer/listings', label: 'Dealer portal: my listings (§7.2)', phase: 'phase-2' },
  { path: '/dealer/listings/new', label: 'Dealer portal: add listing wizard (§7.2)', phase: 'phase-2' },
  { path: '/dealer/leads', label: 'Dealer portal: leads & viewings (§7.2)', phase: 'phase-2' },
  { path: '/admin/requests', label: 'Admin: concierge pipeline (§7.3)', phase: 'phase-2' },
  { path: '/admin/bookings', label: 'Admin: inspection dispatch (§7.3)', phase: 'phase-2' },
  { path: '/admin/orders', label: 'Admin: order manager (§7.3)', phase: 'phase-2' },
  { path: '/admin/cms', label: 'Admin: content workflow (§7.4)', phase: 'phase-2' },
];

/** Does this request path correspond to a route we have promised but not built? */
function pendingRouteFor(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';

  for (const route of PENDING) {
    if (route.path.includes('{')) {
      const prefix = route.path.split('{')[0];
      if (clean.startsWith(prefix.replace(/\/$/, '')) && clean !== prefix.replace(/\/$/, '')) return route;
      continue;
    }
    if (clean === route.path) return route;
  }

  // Dynamic prefixes the public site owns get their own routers; anything else
  // under them is a phase-2 screen.
  for (const prefix of ['/account/', '/dealer/', '/admin/']) {
    if (clean.startsWith(prefix) && clean.length > prefix.length) {
      const match = PENDING.find((r) => r.path.startsWith(prefix));
      if (match) return match;
    }
  }

  return null;
}

module.exports = { BUILT, PENDING, pendingRouteFor };
