'use strict';

/**
 * SEO contracts from §12.4 and §14: the VDP slug pattern, the meta templates,
 * and every JSON-LD shape the site must emit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const seo = require('../src/services/seo');
const sitemap = require('../src/services/sitemap');

const listing = {
  id: 1,
  slug: '2015-toyota-camry-le-hc-ph-0001',
  stockNo: 'HC-PH-0001',
  title: '2015 Toyota Camry LE',
  make: 'Toyota',
  model: 'Camry',
  year: 2015,
  trim: 'LE',
  bodyTypeLabel: 'Sedan',
  transmissionLabel: 'Automatic',
  fuelTypeLabel: 'Petrol',
  condition: 'tokunbo',
  conditionLabel: 'Tokunbo',
  mileageKm: 68_500,
  engineSize: '2.5L I4',
  extColour: 'Pearl White',
  priceKobo: 865_000_000,
  grade: 'certified',
  gradeLabel: 'HonestCars-Certified',
  pricePosition: 'within',
  city: 'Port Harcourt',
  area: 'GRA Phase 2',
  documents: { customs: true, registration: true, dutySighted: true, tintedPermit: false },
  status: 'live',
  media: [{ url: '/img/seed/sedan-front-3q.svg' }],
  expiresAt: new Date('2026-10-20'),
};

test('VDP slug follows the /cars/{year}-{make}-{model}-{trim}-{stock} contract', () => {
  assert.equal(seo.vdpPath(listing), '/cars/2015-toyota-camry-le-hc-ph-0001');
  assert.match(listing.slug, /^\d{4}-[a-z0-9-]+-hc-ph-\d{4}$/);
});

test('VDP title matches the §14.2 pattern and carries the price', () => {
  const meta = seo.vdpMeta(listing);
  assert.match(meta.fullTitle, /^2015 Toyota Camry LE for Sale in Port Harcourt — ₦[\d.,m]+ \| HonestCars$/);
  assert.ok(meta.title.length <= 62, `title too long: ${meta.title.length}`);
  assert.ok(meta.description.length <= 158);
});

test('Vehicle schema omits the VIN and includes an Offer in NGN', () => {
  const schema = seo.vehicleSchema({ ...listing, vin: 'JT1234567890' });
  const json = JSON.stringify(schema);
  assert.equal(schema['@type'], 'Vehicle');
  assert.equal(schema.offers.priceCurrency, 'NGN');
  assert.equal(schema.offers.price, 8_650_000);
  assert.equal(schema.offers.availability, 'https://schema.org/InStock');
  assert.ok(!json.includes('JT1234567890'), 'VIN must never reach public markup (§10.2)');
  assert.equal(schema.mileageFromOdometer.unitCode, 'KMT');
});

test('a sold vehicle reports SoldOut availability', () => {
  const schema = seo.vehicleSchema({ ...listing, status: 'sold' });
  assert.equal(schema.offers.availability, 'https://schema.org/SoldOut');
});

test('FAQPage schema is only emitted when FAQs exist', () => {
  assert.equal(seo.faqSchema([]), null);
  assert.equal(seo.faqSchema(null), null);

  const schema = seo.faqSchema([{ question: 'Do I pay the seller?', answer: 'No.' }]);
  assert.equal(schema['@type'], 'FAQPage');
  assert.equal(schema.mainEntity[0].acceptedAnswer.text, 'No.');
});

test('BreadcrumbList positions start at 1 and the last crumb may have no href', () => {
  const schema = seo.breadcrumbSchema([
    { label: 'Cars', href: '/cars' },
    { label: '2015 Toyota Camry LE' },
  ]);
  assert.equal(schema.itemListElement[0].position, 1);
  assert.equal(schema.itemListElement[1].position, 2);
  assert.equal(schema.itemListElement[1].item, undefined);
});

test('LocalBusiness carries Port Harcourt geo data for local search', () => {
  const schema = seo.localBusinessSchema();
  assert.ok(schema['@type'].includes('LocalBusiness'));
  assert.equal(schema.address.addressLocality, 'Port Harcourt');
  assert.equal(schema.address.addressRegion, 'Rivers State');
  assert.equal(schema.geo['@type'], 'GeoCoordinates');
});

test('Article schema names the author and publisher', () => {
  const schema = seo.articleSchema({
    title: 'The 2015 Camry: what ₦12m buys',
    excerpt: 'We put a Camry through the checklist.',
    heroImage: '/img/seed/og-default.svg',
    publishedAt: new Date('2026-09-28'),
    author: { name: 'Raph Nicks', role: 'Head of Inspections' },
    url: '/blog/2015-toyota-camry-honest-buyers-guide',
    categoryLabel: "Honest Buyer's Guide",
  });
  assert.equal(schema['@type'], 'Article');
  assert.equal(schema.author.name, 'Raph Nicks');
  assert.equal(schema.publisher['@id'].endsWith('/#organization'), true);
});

test('JSON-LD is escaped so listing text cannot break out of the script tag', () => {
  const script = seo.jsonLdScript({ note: '</script><script>alert(1)</script>' });
  assert.ok(!script.includes('</script>'));
});

test('robots.txt keeps crawlers out of filter combinations (§14.1)', () => {
  const robots = sitemap.buildRobots();
  assert.match(robots, /Disallow: \/cars\?\*/);
  assert.match(robots, /Sitemap: .*\/sitemap\.xml/);
});
