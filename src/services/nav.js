'use strict';

/**
 * Navigation model — §5.2 header, Appendix C footer map.
 * Kept in one place so the header, drawer, footer and bottom bar can never
 * drift apart.
 */

const config = require('../config');
const { icon } = require('./icons');

const HEADER_NAV = [
  { label: 'Buy Cars', href: '/cars' },
  { label: 'Services', href: '/services', mega: true },
  { label: 'Sell/Swap', href: '/sell-swap' },
  { label: 'Hire', href: '/hire' },
  { label: 'Blog', href: '/blog' },
];

/** Footer column ① Shop (§Appendix C). */
const FOOTER_SHOP = [
  { label: 'All Cars', href: '/cars' },
  { label: 'Certified Cars', href: '/cars/certified' },
  { label: 'Compare', href: '/cars/compare' },
  { label: 'Find My Car', href: '/find-my-car' },
  { label: 'Sell/Swap', href: '/sell-swap' },
  { label: 'Hire', href: '/hire' },
];

/** Footer column ② Services — all 8 + shop links. */
const FOOTER_SERVICES = [
  { label: 'Pre-Purchase Inspection', href: '/services/inspection' },
  { label: 'Find My Car Concierge', href: '/services/concierge' },
  { label: 'Customs & Documents', href: '/services/documents' },
  { label: 'Sell or Swap', href: '/services/sell-swap' },
  { label: 'Tracking & Security', href: '/services/tracking' },
  { label: 'Car Hire', href: '/hire' },
  { label: 'Research & Reports', href: '/services/research' },
  { label: 'Paid Consultation', href: '/services/consultation' },
  { label: 'Spare Parts', href: '/services/parts' },
  { label: 'Shop', href: '/shop' },
];

/** Footer column ③ Company. */
const FOOTER_COMPANY = [
  { label: 'About', href: '/about' },
  { label: 'Verification', href: '/verification' },
  { label: 'How It Works', href: '/how-it-works' },
  { label: 'Partner With Us', href: '/partner' },
  { label: 'Blog', href: '/blog' },
  { label: 'FAQ', href: '/faq' },
  { label: 'Contact', href: '/contact' },
];

/** Footer column ④ Legal. */
const FOOTER_LEGAL = [
  { label: 'Terms', href: '/terms' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Refunds', href: '/refunds' },
  { label: 'Disclaimer', href: '/disclaimer' },
];

/** Mobile bottom bar (§5.2): Home · Cars · Find My Car · Chat · Account. */
function bottomNav() {
  return [
    { label: 'Home', href: '/', icon: 'home' },
    { label: 'Cars', href: '/cars', icon: 'car' },
    { label: 'Find My Car', href: '/find-my-car', icon: 'compass' },
    {
      label: 'Chat',
      href: whatsappLink('Hi HonestCars, I need help choosing a car.'),
      icon: 'chat',
      external: true,
      event: 'whatsapp_click',
    },
    { label: 'Account', href: '/login', icon: 'account' }, // signed-in state swaps this to /account in the partial
  ];
}

/**
 * WhatsApp deep link with prefilled text (§11). Every entry carries its source
 * so attribution works: whatsapp_click fires with { source }.
 */
function whatsappLink(text, source) {
  const suffix = source ? `\n\n[ref: ${source}]` : '';
  return `https://wa.me/${config.business.whatsapp}?text=${encodeURIComponent(text + suffix)}`;
}

/**
 * Cross-context nav context. `path` drives aria-current and the drawer state.
 */
function buildNav(path = '/') {
  const current = (href) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  return {
    header: HEADER_NAV.map((item) => ({ ...item, current: current(item.href) })),
    footer: {
      shop: FOOTER_SHOP,
      services: FOOTER_SERVICES,
      company: FOOTER_COMPANY,
      legal: FOOTER_LEGAL,
    },
    bottom: bottomNav().map((item) => ({ ...item, current: !item.external && current(item.href) })),
    whatsapp: {
      general: whatsappLink('Hi HonestCars, I have a question about a car on your site.'),
    },
  };
}

/** Mega-menu items (icon + one-liner each) — §5.2. */
function megaMenuItems(services) {
  return services.map((service) => ({
    ...service,
    iconSvg: icon(service.icon || 'info', { size: 20 }),
  }));
}

module.exports = { buildNav, megaMenuItems, whatsappLink, HEADER_NAV, bottomNav };
