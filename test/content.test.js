'use strict';

/**
 * Content + service-suite integrity.
 *
 * These tests guard the things that are easy to get wrong when copy is data-
 * driven: every service page having the §6.7 template blocks, every seeded body
 * block being one the renderer understands, every service having an FAQ scope,
 * and meta descriptions that fit the §14.2 templates.
 *
 * The database-backed ones skip themselves when MySQL is not reachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable } = require('./helpers');

const validate = require('../src/services/validate');
const concierge = require('../src/services/concierge');
const seo = require('../src/services/seo');
const slice = require('../src/services/slice');
const content = require('../scripts/seed-content');

let available = false;
const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
});

test.after(async () => {
  // Close the pool or the mysql2 sockets keep the test runner alive.
  if (available) await require('../src/db').pool.end();
});

// ---------------------------------------------------------------------------
// Validation helpers (no DB needed)
// ---------------------------------------------------------------------------
test('phone validation accepts Nigerian shapes and rejects junk', () => {
  for (const good of ['08031234567', '+234 803 123 4567', '0803-123-4567', '(0803) 1234567']) {
    assert.ok(validate.phone(good), `${good} should be accepted`);
  }
  for (const bad of ['', 'abc', '12345', '<script>', '0803'.repeat(20), 'call me maybe']) {
    assert.equal(validate.phone(bad), null, `${bad} should be rejected`);
  }
});

test('kobo parsing never accepts a negative or a exponent', () => {
  assert.equal(validate.kobo('12500'), 1_250_000);
  assert.equal(validate.kobo('₦12,500.50'), 1_250_050);
  assert.equal(validate.kobo('-5'), null);
  assert.equal(validate.kobo('1e9'), null);
  assert.equal(validate.kobo('abc'), null);
});

test('briefs are sanitised down to strings, numbers and short arrays', () => {
  const cleaned = validate.brief({
    budget_min: 8_000_000,
    must_haves: ['AC must chill', 'low mileage', 'x'.repeat(600)],
    nested: { evil: true },
    'bad key!': 'dropped or key-sanitised',
  });
  assert.equal(cleaned.budget_min, 8_000_000);
  assert.equal(cleaned.must_haves.length, 3);
  assert.ok(cleaned.must_haves[2].length <= 400);
  assert.equal(typeof cleaned.nested, 'string');
  assert.ok(!('bad key!' in cleaned), 'the raw key never survives');
  assert.ok('badkey' in cleaned || Object.keys(cleaned).length === 3);
});

test('futureDateTime refuses the past and the far future', () => {
  assert.equal(validate.futureDateTime('2020-01-01T09:00:00Z'), null);
  assert.equal(validate.futureDateTime('2999-01-01T09:00:00Z'), null);
  assert.ok(validate.futureDateTime(new Date(Date.now() + 86_400_000).toISOString()));
});

test('SLA hours are limited to the 48–72 hour window the PRD promises', () => {
  assert.equal(validate.slaHours('48'), 48);
  assert.equal(validate.slaHours('72'), 72);
  assert.equal(validate.slaHours('12'), 72); // falls back, never promises 12h
  assert.equal(validate.slaHours('168'), 72);
});

// ---------------------------------------------------------------------------
// Concierge flow spec (§6.5)
// ---------------------------------------------------------------------------
test('the concierge flow offers three SLA options, all inside 48–72 hours', () => {
  assert.equal(concierge.SLA_OPTIONS.length, 3);
  for (const option of concierge.SLA_OPTIONS) {
    assert.ok(option.hours >= 48 && option.hours <= 72, `${option.key} promises ${option.hours}h`);
    assert.ok(option.retainerKobo > 0);
    assert.ok(option.note.length > 10);
  }
  assert.equal(concierge.slaOption('nonsense').key, concierge.DEFAULT_SLA);
});

test('every concierge add-on is either included or priced', () => {
  for (const addon of concierge.ADDONS) {
    assert.ok(addon.label && addon.copy);
    assert.ok(addon.included || Number.isFinite(addon.priceKobo), `${addon.key} has neither a price nor “included”`);
  }
  // Physical inspection is the one thing that must never be an extra (§6.5).
  const inspection = concierge.ADDONS.find((addon) => addon.key === 'inspection_included');
  assert.equal(inspection.included, true);
});

// ---------------------------------------------------------------------------
// SEO helpers
// ---------------------------------------------------------------------------
test('title and description truncation respect the §14.2 length contracts', () => {
  const long = 'A'.repeat(300);
  assert.ok(seo.truncate(long, 62).length <= 62);
  assert.ok(seo.truncate(long, 158).length <= 158);
  assert.equal(seo.truncate('short', 62), 'short');
});

test('serviceSchema omits offers entirely when no tier is priced', () => {
  const schema = seo.serviceSchema({ slug: 'x', name: 'X', promise: 'p', pricing: [], deliverables: [] });
  assert.equal(schema.offers, undefined);
  assert.equal(schema.hasOfferCatalog, undefined);
});

// ---------------------------------------------------------------------------
// Seeded content (module only — no DB)
// ---------------------------------------------------------------------------
test('every seeded service has the full §6.7 template and a numeric tier price', () => {
  for (const [slug, service] of Object.entries(content.SERVICES)) {
    assert.ok(service.hero_copy && service.hero_copy.length > 40, `${slug}: hero copy`);
    assert.ok(service.deliverables.length >= 4, `${slug}: 4–6 deliverables`);
    assert.ok(service.deliverables.length <= 6, `${slug}: not more than 6 deliverables`);
    assert.ok(service.steps.length >= 3 && service.steps.length <= 5, `${slug}: 3–5 steps`);
    for (const step of service.steps) assert.ok(step.timeline, `${slug}: step “${step.title}” has no timeline`);
    assert.ok(service.included.length && service.excluded.length, `${slug}: included/excluded table`);
    assert.ok(service.proof.length >= 1, `${slug}: proof`);
    for (const tier of service.pricing || []) {
      assert.ok(tier.tier && tier.price, `${slug}: a pricing tier is missing its label`);
      // Commission-based work (sell/swap, B2B) is priced as a percentage, so a
      // ₦ figure is optional — but a quoted tier must never carry a number.
      if (/₦/.test(tier.price)) assert.match(tier.price, /₦[\d,]+/, `${slug}: tier “${tier.tier}”`);
    }
  }
});

test('every service page has 4+ FAQs and every Shop/trust page has FAQs too', () => {
  for (const slug of Object.keys(content.SERVICES)) {
    if (slug === 'hire') continue; // hire keeps its FAQs under page:hire
    const faqs = content.FAQS[`service:${slug}`];
    assert.ok(faqs && faqs.length >= 4, `service:${slug} needs at least 4 FAQs`);
  }
  for (const scope of ['page:verification', 'page:about', 'page:contact', 'page:partner', 'page:how-it-works', 'page:shop', 'page:hire']) {
    assert.ok((content.FAQS[scope] || []).length >= 3, `${scope} needs at least 3 FAQs`);
  }
  for (const category of ['trackers', 'diagnostics', 'care_kits']) {
    assert.ok((content.FAQS[`shop:${category}`] || []).length >= 2, `shop:${category} needs FAQs`);
  }
});

test('seeded post bodies only use block types the renderer implements', () => {
  const RENDERED = new Set(['paragraph', 'heading', 'callout', 'checklist', 'table', 'quote', 'youtube', 'listings', 'stats']);
  for (const [slug, post] of Object.entries(content.POST_BODIES)) {
    for (const block of post.body) {
      assert.ok(RENDERED.has(block.type), `${slug}: unknown block type “${block.type}” would render as nothing`);
      if (block.type === 'table') {
        assert.ok(block.head.length && block.rows.length, `${slug}: table without content`);
        for (const row of block.rows) assert.equal(row.length, block.head.length, `${slug}: ragged table`);
      }
    }
    assert.ok(post.serviceCta, `${slug}: posts must carry a contextual service CTA (§6.9)`);
    assert.ok(post.authorBio && post.authorBio.length > 40, `${slug}: author bio (E-E-A-T)`);
  }
});

test('delivery areas are priced in kobo and cover the checkout areas', () => {
  assert.ok(content.DELIVERY_AREAS.length >= 5);
  for (const area of content.DELIVERY_AREAS) {
    assert.ok(Number.isFinite(area.fee) && area.fee >= 0);
    assert.ok(area.note);
  }
});

test('the demo concierge record exists so the status page can be reviewed', () => {
  assert.match(content.DEMO_REQUEST.trackingId, /^HC-\d{4}$/);
  assert.ok(content.DEMO_REQUEST.slaHours <= 72);
});

// ---------------------------------------------------------------------------
// Slice bookkeeping
// ---------------------------------------------------------------------------
test('the slice map has no route listed as both built and pending', () => {
  const built = new Set(slice.BUILT.map((route) => route.path));
  for (const route of slice.PENDING) {
    assert.ok(!built.has(route.path), `${route.path} is listed twice`);
  }
});

test('every phase-2 route is a console route, not a public page', () => {
  for (const route of slice.PENDING) {
    assert.match(route.path, /^\/(account|dealer|admin)\//, `${route.path} should be behind auth`);
  }
});

// ---------------------------------------------------------------------------
// Database-backed content checks
// ---------------------------------------------------------------------------
maybe('every active service in the database carries the whole template', async () => {
  const db = require('../src/db');
  const services = await db.content.serviceSuite();
  assert.ok(services.length >= 10, 'the whole suite is seeded');
  for (const service of services) {
    const full = await db.content.serviceBySlug(service.slug);
    assert.ok(full.deliverables.length >= 4, `${service.slug}: deliverables`);
    assert.ok(full.steps.length >= 3, `${service.slug}: steps`);
    assert.ok(full.pricing.length >= 2, `${service.slug}: pricing tiers`);
    for (const tier of full.pricing) {
      if (/₦[\d,]+/.test(tier.price)) {
        assert.ok(tier.price_kobo > 0, `${service.slug}: “${tier.tier}” prints a ₦ figure but has no numeric price`);
      } else {
        assert.equal(tier.price_kobo, null, `${service.slug}: “${tier.tier}” is quoted, so price_kobo must stay null`);
      }
    }
    assert.ok(full.included.length && full.excluded.length, `${service.slug}: included/excluded`);
  }
});

maybe('each service page has a FAQ scope with answers, and hire uses page:hire', async () => {
  const db = require('../src/db');
  const services = await db.content.serviceSuite();
  for (const service of services) {
    const scope = service.slug === 'hire' ? 'page:hire' : `service:${service.slug}`;
    const faqs = await db.content.faqsForScope(scope);
    assert.ok(faqs.length >= 4, `${scope} returned ${faqs.length} FAQs`);
    for (const faq of faqs) assert.ok(faq.answer.length > 40, `${scope}: thin answer for “${faq.question}”`);
  }
});

maybe('the blog feed serves 9 per page with working pagination and category filters', async () => {
  const db = require('../src/db');
  const first = await db.content.blogIndex({ page: 1 });
  assert.ok(first.posts.length <= 9);
  assert.equal(first.page, 1);
  assert.ok(first.categories.some((category) => category.count > 0), 'at least one category has posts');

  const category = first.categories.find((entry) => entry.count > 0);
  const filtered = await db.content.blogIndex({ page: 1, category: category.key });
  assert.ok(filtered.posts.every((post) => post.category === category.key));

  const search = await db.content.blogIndex({ page: 1, q: 'Camry' });
  assert.ok(search.total >= 1, 'searching for a known model finds posts');
});

maybe('the RSS feed is well-formed and links absolute URLs', async () => {
  const db = require('../src/db');
  const xml = await db.content.rssFeed(5, 'https://honestcarsltd.com');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<rss version="2\.0"/);
  assert.match(xml, /<link>https:\/\/honestcarsltd\.com\/blog<\/link>/);
  assert.equal((xml.match(/<item>/g) || []).length, 5);
});

maybe('shop products are priced, categorised, and parts never enter the cart', async () => {
  const db = require('../src/db');
  const products = await db.content.products();
  assert.ok(products.length >= 6);
  for (const product of products) {
    assert.ok(product.priceKobo > 0, `${product.slug}: price`);
    assert.ok(['trackers', 'diagnostics', 'care_kits'].includes(product.category), `${product.slug}: category`);
    const full = await db.content.productBySlug(product.slug);
    assert.ok(full.specs.length >= 2, `${product.slug}: key specs`);
    assert.ok(full.deliveryOptions.length >= 1, `${product.slug}: delivery options`);
  }
  assert.ok(!products.some((product) => product.category === 'parts'), 'parts are service-led (§6.8)');
});

maybe('guest checkout recomputes totals and opens a subscription for tracker SKUs', async () => {
  const db = require('../src/db');
  const order = await db.commerce.createOrder({
    name: 'Test Buyer',
    phone: '08030000009',
    deliveryArea: 'GRA / Old GRA',
    items: [
      { slug: 'tracker-standard', qty: 1, installRequested: true },
      { slug: 'care-kit-essentials', qty: 2 },
    ],
  });

  const expectedSubtotal = order.items.reduce((sum, item) => sum + item.lineTotalKobo, 0);
  assert.equal(order.subtotalKobo, expectedSubtotal, 'subtotal is the sum of line totals');
  assert.equal(order.totalKobo, order.subtotalKobo + order.deliveryFeeKobo);
  assert.ok(order.deliveryFeeKobo > 0, 'a priced area applies a delivery fee');

  const subscriptions = await db.commerce.subscriptionsForOrder(order.orderNo);
  assert.equal(subscriptions.length, 1, 'exactly one subscription for one tracker');
  assert.equal(subscriptions[0].deviceState, 'ordered');

  const fetched = await db.commerce.findByOrderNo(order.orderNo);
  assert.equal(fetched.items.length, 2);
});

maybe('an unknown cart item is refused instead of silently dropped', async () => {
  const db = require('../src/db');
  await assert.rejects(
    () => db.commerce.createOrder({ name: 'Test', phone: '08030000009', items: [{ slug: 'not-a-real-sku', qty: 1 }] }),
    /None of those products/,
  );
});

maybe('service requests get human tracking ids and an SLA due date', async () => {
  const db = require('../src/db');
  const request = await db.requests.createRequest({
    type: 'concierge',
    name: 'Test Buyer',
    phone: '08030000009',
    brief: { budget_min: 8_000_000, must_haves: ['AC must chill'] },
    slaHours: 48,
  });
  assert.match(request.trackingId, /^HC-\d{4}$/);
  const delta = new Date(request.slaDueAt).getTime() - Date.now();
  assert.ok(delta > 47 * 3_600_000 && delta < 49 * 3_600_000, 'SLA lands 48 hours out');

  const found = await db.requests.findByTracking(request.trackingId);
  assert.equal(found.trackingId, request.trackingId);
  assert.deepEqual(found.brief.must_haves, ['AC must chill']);

  const updated = await db.requests.updateStatus(request.trackingId, 'options_ready', 'Three options sent');
  assert.equal(updated.statusLabel, 'Options ready');
  assert.equal(updated.stageIndex, 2);
  await assert.rejects(() => db.requests.updateStatus(request.trackingId, 'not_a_status'), /Unknown request status/);
});

maybe('bookings carry a reference and land in the dispatch queue', async () => {
  const db = require('../src/db');
  const booking = await db.requests.createBooking({
    type: 'inspection',
    serviceSlug: 'inspection',
    slotAt: new Date(Date.now() + 2 * 86_400_000),
    location: 'GRA Phase 2',
    vehicle: { make: 'Toyota', model: 'Camry', year: 2015 },
    name: 'Test Buyer',
    phone: '08030000009',
  });
  assert.match(booking.reference, /^HC-BK-\d{4}$/);
  const found = await db.requests.findByReference(booking.reference);
  assert.equal(found.vehicle.make, 'Toyota');
});

maybe('CMS pages exist for the legal set and each carries meta', async () => {
  const db = require('../src/db');
  for (const slug of ['terms', 'privacy', 'refunds', 'disclaimer', 'about', 'contact', 'how-it-works']) {
    const page = await db.content.pageBySlug(slug);
    assert.ok(page, `${slug} missing`);
    assert.ok(page.metaTitle && page.metaDescription, `${slug}: meta`);
    assert.ok(page.body.length >= 3, `${slug}: body blocks`);
  }
  const legal = await db.content.pageBySlug('privacy');
  assert.equal(legal.legalReview, true, 'legal copy is flagged as awaiting counsel');
});

maybe('the compare tool never returns more than 3 cars and estimates running costs', async () => {
  const db = require('../src/db');
  const listings = await db.listings.findByIds([1, 2, 3, 4, 5]);
  assert.ok(listings.length <= 3);
  for (const listing of listings) assert.ok(listing.runningCostKobo > 0);
  assert.ok(listings.every((listing) => listing.documentsSummary && listing.pricePositionLabel));
});
