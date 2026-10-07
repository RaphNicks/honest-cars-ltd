'use strict';

/**
 * SEO service — §14. All patterns live here so no route invents its own.
 *
 *   §14.1 URL architecture  · VDP slug contract, curated facets only indexable
 *   §14.2 meta templates    · VDP/service title + description patterns
 *   §12.4 JSON-LD           · Vehicle+Offer, LocalBusiness, FAQPage, Article,
 *                             BreadcrumbList
 *   §12.4 OG                · 1200×630 cards tuned for WhatsApp previews
 */

const config = require('../config');

const SITE_NAME = 'HonestCars';

/** Escape a string for a meta attribute value. */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function absolute(pathname = '/') {
  if (/^https?:\/\//.test(pathname)) return pathname;
  return `${config.siteUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

/**
 * VDP slug contract (§14.1): /cars/{year}-{make}-{model}-{trim}-{stock}
 * Canonical is always derived from the stored slug — never recomputed from
 * mutable fields, so URLs stay stable when ops edits a listing.
 */
function vdpPath(listing) {
  return `/cars/${listing.slug}`;
}

/** VDP meta template (§14.2). */
function vdpMeta(listing) {
  const price = formatNairaForTitle(listing.priceKobo);
  const title = `${listing.year} ${listing.make} ${listing.model}${listing.trim ? ` ${listing.trim}` : ''} for Sale in Port Harcourt — ${price} | HonestCars`;
  const condition = listing.conditionLabel.toLowerCase();
  const description =
    `${listing.year} ${listing.make} ${listing.model} ${listing.trim || ''} · ${price} · ${Math.round(listing.mileageKm / 1000)}k km · `.replace(/\s+/g, ' ') +
    `${condition} · ${listing.gradeLabel} · ${listing.area}, Port Harcourt. ${listing.documents.customs ? 'Customs verified. ' : ''}See the honest condition notes and photos before you travel.`;
  return {
    title: truncate(title, 62),
    fullTitle: title,
    description: truncate(description, 158),
    canonical: absolute(vdpPath(listing)),
  };
}

/** Service page meta template (§14.2). */
function serviceMeta(service) {
  const from = service.fromPriceKobo ? ` from ${formatNairaForTitle(service.fromPriceKobo)}` : '';
  const title = `${service.name} in Port Harcourt — ${service.promise}${from} | HonestCars`;
  return {
    title: truncate(`${service.name} in Port Harcourt${from} | HonestCars`, 62),
    fullTitle: title,
    description: truncate(`${service.promise} ${service.name} across Port Harcourt and Rivers State, run by people who buy cars here daily.`, 158),
    canonical: absolute(`/services/${service.slug}`),
  };
}

function formatNairaForTitle(kobo) {
  const naira = Number(kobo) / 100;
  if (naira >= 1_000_000) {
    const millions = naira / 1_000_000;
    return `₦${(Math.round(millions * 10) / 10).toString().replace(/\.0$/, '')}m`;
  }
  return `₦${Math.round(naira).toLocaleString('en-NG')}`;
}

function truncate(value, max) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/[\s,.;:—-]+$/, '')}…`;
}

/** OG/Twitter block. ogImage is an absolute URL to a 1200×630 card. */
function openGraph({ title, description, url, image, type = 'website', imageAlt }) {
  const imageUrl = absolute(image || '/og/default.png');
  return {
    title,
    description,
    url: absolute(url),
    type,
    image: imageUrl,
    imageAlt: imageAlt || title,
    siteName: SITE_NAME,
    locale: 'en_NG',
  };
}

// ---------------------------------------------------------------------------
// JSON-LD builders (§12.4)
// ---------------------------------------------------------------------------

function jsonLdScript(data) {
  // Escape the closing tag so listing text can never break out of the script.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** Site-wide LocalBusiness (LocalBusiness schema with PH geo — §14.3). */
function localBusinessSchema() {
  const b = config.business;
  return {
    '@context': 'https://schema.org',
    '@type': ['AutoDealer', 'LocalBusiness'],
    '@id': `${config.siteUrl}/#organization`,
    name: b.name,
    legalName: b.legalName,
    url: config.siteUrl,
    telephone: b.phone,
    email: b.email,
    image: absolute('/og/default.png'),
    // A real, generated, committed file. This used to point at
    // /img/logo.svg, which was never created — a 404 in the structured data
    // of every page, invisible because the visible logo is an inline icon.
    logo: absolute('/icons/icon-512.png'),
    priceRange: '₦₦',
    // FR-32: we run in four markets, and the markup says so. The address is
    // still Port Harcourt — that is where the business sits — while the service
    // area is the network the stock comes from.
    areaServed: [
      { '@type': 'City', name: 'Port Harcourt' },
      { '@type': 'City', name: 'Owerri' },
      { '@type': 'City', name: 'Aba' },
      { '@type': 'City', name: 'Benin City' },
      { '@type': 'State', name: 'Rivers State' },
      { '@type': 'State', name: 'Imo State' },
      { '@type': 'State', name: 'Abia State' },
      { '@type': 'State', name: 'Edo State' },
      { '@type': 'Country', name: 'Nigeria' },
    ],
    address: {
      '@type': 'PostalAddress',
      addressLocality: b.city,
      addressRegion: b.region,
      addressCountry: b.country,
    },
    geo: { '@type': 'GeoCoordinates', latitude: b.latitude, longitude: b.longitude },
    openingHoursSpecification: {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      opens: '08:00',
      closes: '18:00',
    },
    sameAs: [],
  };
}

const CONDITION_SCHEMA = {
  tokunbo: 'https://schema.org/UsedCondition',
  nigerian_used: 'https://schema.org/UsedCondition',
  new: 'https://schema.org/NewCondition',
};

/**
 * Vehicle + Offer for a VDP. VIN is deliberately omitted — ops-only (§10.2
 * "VIN visible to ops only") and it must never reach public markup.
 */
function vehicleSchema(listing) {
  const priceNaira = Number(listing.priceKobo) / 100;
  const sold = listing.status === 'sold';
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Vehicle',
    name: listing.title,
    url: absolute(vdpPath(listing)),
    sku: listing.stockNo,
    brand: { '@type': 'Brand', name: listing.make },
    model: listing.model,
    vehicleModelDate: String(listing.year),
    bodyType: listing.bodyTypeLabel,
    vehicleTransmission: listing.transmissionLabel,
    fuelType: listing.fuelTypeLabel,
    color: listing.extColour || undefined,
    mileageFromOdometer: {
      '@type': 'QuantitativeValue',
      value: listing.mileageKm,
      unitCode: 'KMT',
    },
    vehicleEngine: listing.engineSize
      ? { '@type': 'EngineSpecification', name: listing.engineSize }
      : undefined,
    numberOfDoors: undefined,
    image: (listing.media || []).slice(0, 6).map((m) => absolute(m.url)),
    description: listing.description || undefined,
    offers: {
      '@type': 'Offer',
      price: priceNaira,
      priceCurrency: 'NGN',
      availability: sold ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
      itemCondition: CONDITION_SCHEMA[listing.condition] || 'https://schema.org/UsedCondition',
      url: absolute(vdpPath(listing)),
      seller: { '@id': `${config.siteUrl}/#organization` },
      areaServed: { '@type': 'City', name: listing.city },
      priceValidUntil: listing.expiresAt ? new Date(listing.expiresAt).toISOString().slice(0, 10) : undefined,
    },
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Stock number', value: listing.stockNo },
      { '@type': 'PropertyValue', name: 'Verification grade', value: listing.gradeLabel },
      { '@type': 'PropertyValue', name: 'Price position', value: listing.pricePosition },
      { '@type': 'PropertyValue', name: 'Documents', value: documentsSummary(listing) },
    ],
  };
  if (listing.trim) schema.vehicleConfiguration = listing.trim;
  return pruneUndefined(schema);
}

function documentsSummary(listing) {
  const d = listing.documents || {};
  const parts = [];
  if (d.customs) parts.push('customs verified');
  if (d.registration) parts.push('registration');
  if (d.dutySighted) parts.push('duty papers sighted');
  return parts.length ? parts.join(', ') : 'pending';
}

/** FAQPage — only emit where FAQs actually render (§12.4). */
function faqSchema(faqs) {
  if (!faqs || !faqs.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

/** Article for blog posts (§6.9, §12.4). */
function articleSchema(post) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt,
    image: [absolute(post.heroImage)],
    datePublished: post.publishedAt ? new Date(post.publishedAt).toISOString() : undefined,
    dateModified: post.publishedAt ? new Date(post.publishedAt).toISOString() : undefined,
    author: { '@type': 'Person', name: post.author.name, jobTitle: post.author.role },
    publisher: { '@id': `${config.siteUrl}/#organization` },
    mainEntityOfPage: { '@type': 'WebPage', '@id': absolute(post.url) },
    articleSection: post.categoryLabel,
  };
}

/** BreadcrumbList from [{label, href}] — the last crumb may omit href. */
function breadcrumbSchema(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.label,
      ...(crumb.href ? { item: absolute(crumb.href) } : {}),
    })),
  };
}

/** ItemList for listing grids — helps facet and /cars pages (§12.4). */
function itemListSchema(listings, { name } = {}) {
  if (!listings || !listings.length) return null;
  return pruneUndefined({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: listings.length,
    itemListElement: listings.map((listing, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: absolute(vdpPath(listing)),
      name: `${listing.title} — ${formatNairaForTitle(listing.priceKobo)}`,
    })),
  });
}

/** WebSite + SearchAction so the hero search can appear in search results. */
function webSiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${config.siteUrl}/#website`,
    url: config.siteUrl,
    name: SITE_NAME,
    publisher: { '@id': `${config.siteUrl}/#organization` },
    inLanguage: 'en-NG',
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${config.siteUrl}/cars?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}


/**
 * Service page schema (§12.4 lists Vehicle/LocalBusiness/FAQPage/Article/
 * BreadcrumbList; Service + Offer is the natural extension for the service
 * suite and is what Google wants for priced services). Prices are kobo in the
 * DB, naira in markup.
 */
function serviceSchema(service, { areaServed = ['Port Harcourt', 'Owerri', 'Aba', 'Benin City', 'Rivers State', 'Imo State', 'Abia State', 'Edo State'] } = {}) {
  const offers = (service.pricing || [])
    .filter((tier) => tier.price_kobo)
    .map((tier) => ({
      '@type': 'Offer',
      name: tier.tier,
      price: Number(tier.price_kobo) / 100,
      priceCurrency: 'NGN',
      url: absolute(`/services/${service.slug}`),
      availability: 'https://schema.org/InStock',
      seller: { '@id': `${config.siteUrl}/#organization` },
    }));

  return pruneUndefined({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: service.name,
    serviceType: service.name,
    description: service.heroCopy || service.promise,
    url: absolute(`/services/${service.slug}`),
    provider: { '@id': `${config.siteUrl}/#organization` },
    areaServed: areaServed.map((name) => ({ '@type': 'City', name })),
    offers: offers.length ? (offers.length === 1 ? offers[0] : offers) : undefined,
    hasOfferCatalog: service.deliverables && service.deliverables.length
      ? {
          '@type': 'OfferCatalog',
          name: service.name,
          itemListElement: service.deliverables.map((item) => ({
            '@type': 'Offer',
            itemOffered: { '@type': 'Service', name: item.title },
            description: item.copy,
          })),
        }
      : undefined,
  });
}

/** Product + Offer for shop items (§6.8, §12.4 spirit). */
function productSchema(product) {
  return pruneUndefined({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.summary,
    sku: product.slug,
    image: product.image ? [absolute(product.image)] : undefined,
    brand: { '@type': 'Brand', name: SITE_NAME },
    category: product.categoryLabel,
    offers: {
      '@type': 'Offer',
      price: Number(product.priceKobo) / 100,
      priceCurrency: 'NGN',
      url: absolute(product.url),
      availability:
        product.stockStatus === 'out_of_stock'
          ? 'https://schema.org/OutOfStock'
          : 'https://schema.org/InStock',
      seller: { '@id': `${config.siteUrl}/#organization` },
    },
  });
}

/** HowTo for a service page’s numbered steps — only when steps carry copy. */
function howToSchema(service) {
  const steps = (service.steps || []).filter((step) => step && step.title);
  if (steps.length < 3) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: `How ${service.name} works at HonestCars`,
    description: service.promise,
    step: steps.map((step, index) => ({
      '@type': 'HowToStep',
      position: index + 1,
      name: step.title,
      text: step.copy || step.title,
    })),
  };
}

/** Meta template for blog posts (§14.2 spirit — title + description patterns). */
function postMeta(post) {
  const title = `${post.title} | HonestCars`;
  const suffix = post.excerpt && post.excerpt.includes(post.categoryLabel) ? '' : ` — ${post.categoryLabel}.`;
  return {
    title: truncate(title, 62),
    fullTitle: title,
    description: truncate(`${post.excerpt}${suffix}`, 158),
    canonical: absolute(post.url),
  };
}

/** Meta template for CMS pages: the CMS owns title/description verbatim. */
function pageMeta(page) {
  return {
    title: truncate(page.metaTitle || page.title, 62),
    fullTitle: page.metaTitle || page.title,
    description: truncate(page.metaDescription || page.title, 158),
    canonical: absolute(`/${page.slug}`),
  };
}

function pruneUndefined(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map(pruneUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;
      out[key] = pruneUndefined(val);
    }
    return out;
  }
  return value;
}

module.exports = {
  SITE_NAME,
  esc,
  absolute,
  truncate,
  vdpPath,
  vdpMeta,
  serviceMeta,
  postMeta,
  pageMeta,
  serviceSchema,
  productSchema,
  howToSchema,
  formatNairaForTitle,
  openGraph,
  jsonLdScript,
  localBusinessSchema,
  vehicleSchema,
  faqSchema,
  articleSchema,
  breadcrumbSchema,
  itemListSchema,
  webSiteSchema,
};
