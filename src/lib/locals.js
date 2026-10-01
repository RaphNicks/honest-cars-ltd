'use strict';

/**
 * The locals contract every view receives.
 *
 *   site     — config, navigation, footer data, trust counters
 *   page     — title / description / canonical / robots / OG / JSON-LD
 *   helpers  — icon(), money and date formatting, WhatsApp links
 *
 * Routes never pass raw DB rows straight to a template: repository shapers own
 * that (§10). This file owns everything else.
 */

const config = require('../config');
const db = require('../db');
const { SORT_LABELS } = require('../db/listings');
const shape = require('../db/shape');
const { icon, SERVICE_ICONS } = require('../services/icons');
const { buildNav, megaMenuItems, whatsappLink } = require('../services/nav');
const seo = require('../services/seo');
const events = require('../services/events');

/** Cache of site-wide chrome data (services list, counters). */
let chromeCache = { at: 0, data: null };
const CHROME_TTL_MS = 60_000;

async function siteChrome() {
  if (chromeCache.data && Date.now() - chromeCache.at < CHROME_TTL_MS) return chromeCache.data;
  const [services, counters] = await Promise.all([
    db.content.serviceSuite(),
    db.listings.networkCounters(),
  ]);
  const data = { services, counters };
  chromeCache = { at: Date.now(), data };
  return data;
}

/** Exposed for tests and after a rebuild. */
function invalidateChrome() {
  chromeCache = { at: 0, data: null };
}

function helpers() {
  return {
    icon,
    SERVICE_ICONS,
    whatsappLink,
    formatNaira: shape.formatNaira,
    formatNairaCompact: shape.formatNairaCompact,
    formatMileage: shape.formatMileage,
    relativeDays: shape.relativeDays,
    koboToNaira: shape.koboToNaira,
    GRADE_LABELS: shape.GRADE_LABELS,
    GRADE_TOOLTIPS: shape.GRADE_TOOLTIPS,
    CONDITION_LABELS: shape.CONDITION_LABELS,
    BODY_TYPE_LABELS: shape.BODY_TYPE_LABELS,
    TRANSMISSION_LABELS: shape.TRANSMISSION_LABELS,
    FUEL_LABELS: shape.FUEL_LABELS,
    PRICE_POSITION: shape.PRICE_POSITION,
    absolute: seo.absolute,
    esc: seo.esc,
    jsonLdScript: seo.jsonLdScript,
    eventNames: events.EVENT_NAMES,
    localBusinessSchema: seo.localBusinessSchema,
    webSiteSchema: seo.webSiteSchema,
    faqSchema: seo.faqSchema,
    breadcrumbSchema: seo.breadcrumbSchema,
    itemListSchema: seo.itemListSchema,
    SORT_LABELS: SORT_LABELS,
    vdpPath: seo.vdpPath,
    vdpMeta: seo.vdpMeta,
    serviceMeta: seo.serviceMeta,
  };
}

/**
 * Build the locals object for a page render.
 *
 * @param {string} routePath  current request path — drives aria-current and nav
 * @param {object} page       page meta (see defaultPage)
 * @param {object} extra      view-specific data
 */
async function buildLocals(routePath, page = {}, extra = {}) {
  const chrome = await siteChrome();
  const nav = buildNav(routePath);
  return {
    site: {
      config,
      url: config.siteUrl,
      business: config.business,
      soldArchive: config.soldArchive,
      nav,
      services: chrome.services,
      megaMenu: megaMenuItems(chrome.services),
      counters: chrome.counters,
      analytics: config.analytics,
      currentPath: routePath,
    },
    page: defaultPage(page),
    helpers: helpers(),
    ...extra,
  };
}

const BASE_DESCRIPTION =
  'Verified cars from trusted Port Harcourt lots — inspections, documents and negotiation handled for you. Every vehicle verified. Every price compared. Every deal honest.';

function defaultPage(page = {}) {
  const title = page.title || 'Cars for sale in Port Harcourt';
  return {
    title: page.titleSuffix === false ? title : `${title} | HonestCars`,
    metaTitle: title,
    description: page.description || BASE_DESCRIPTION,
    canonical: seo.absolute(page.canonical || '/'),
    robots: page.robots || 'index,follow',
    og: {
      type: page.ogType || 'website',
      image: seo.absolute(page.ogImage || '/og/default.png'),
      imageAlt: page.ogImageAlt || title,
      imageWidth: 1200,
      imageHeight: 630,
    },
    jsonLd: page.jsonLd || [],
    bodyClass: page.bodyClass || '',
    layout: page.layout || 'base',
    breadcrumbs: page.breadcrumbs || null,
    activeNav: page.activeNav || null,
  };
}

module.exports = { buildLocals, siteChrome, invalidateChrome, helpers, defaultPage, BASE_DESCRIPTION };
