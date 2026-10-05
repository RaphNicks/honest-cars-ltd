'use strict';

/**
 * Slice map.
 *
 * This build ships the whole public storefront (design system, homepage,
 * /cars, the VDP, the service suite, both funnels, hire, the blog, the shop,
 * every trust/company/legal page), the customer account interior (§7.1), the
 * operations console (§7.3/§7.4), the dealer partner portal (§7.2) and the
 * money seam — orders, payments, receipts, refunds, the dealer ledger, escrow
 * milestones and the inspection report PDF. What remains is the market-intel
 * screens (§7.3).
 *
 * The console paths listed here are protected: an anonymous request to them
 * redirects to /login, so check-links only follows the ones it can reach
 * signed out. When a route is ported, remove it from PENDING and check-links
 * starts requiring a 200 for it.
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
  { path: '/account', label: 'Account dashboard + login (§7.1)' },
  { path: '/account/receipts/{reference}', label: 'Payment receipt (§7.3)' },
  { path: '/account/reports/{reference}', label: 'Inspection report (FR-07)' },
  { path: '/dealer', label: 'Dealer portal entry (§7.2)' },
  { path: '/dealer/dashboard', label: 'Dealer: dashboard (§7.2)' },
  { path: '/dealer/listings', label: 'Dealer: my listings (§7.2)' },
  { path: '/dealer/listings/new', label: 'Dealer: add a car wizard (§7.2)' },
  { path: '/dealer/leads', label: 'Dealer: leads inbox (§7.2)' },
  { path: '/dealer/performance', label: 'Dealer: performance (§7.2)' },
  { path: '/dealer/billing', label: 'Dealer: commission & billing (§7.2)' },
  { path: '/dealer/profile', label: 'Dealer: profile & agreement (§7.2)' },
  { path: '/admin/cms', label: 'Admin: content workflow + revisions (§7.3/§7.4)' },
  { path: '/admin/cms/posts/{id}', label: 'Admin: post editor + workflow' },
  { path: '/admin/cms/pages', label: 'Admin: CMS pages (§6.10)' },
  { path: '/admin/cms/faqs', label: 'Admin: FAQs' },
  { path: '/admin/cms/testimonials', label: 'Admin: testimonials' },
  { path: '/admin/cms/modules', label: 'Admin: homepage modules' },
  { path: '/sitemap.xml', label: 'Sitemap' },
  { path: '/robots.txt', label: 'robots.txt' },
];

/**
 * PRD §7 routes still to port. The back office is complete: §7.1 accounts,
 * §7.2 dealer portal, §7.3 console (including the price-intel table) and §7.4
 * roles are all live. What is left is not a screen but an integration — live
 * PSP keys, an OTP/SMS provider, email and telematics — so nothing is listed
 * here until that work is scoped.
 */
const PENDING = [];

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

  // Every /admin and /dealer screen is built and capability-gated, so an
  // unknown path under either is now a genuine 404 rather than a promised-but-
  // missing screen.

  return null;
}

module.exports = { BUILT, PENDING, pendingRouteFor };
