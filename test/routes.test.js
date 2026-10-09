'use strict';

/**
 * End-to-end route tests against the real server and the real database.
 * Skipped automatically when MySQL is unreachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, getHtml } = require('./helpers');

/**
 * The number this suite posts its public-form enquiry with.
 *
 * Run-scoped, and deliberately *not* a seeded number: the demo database holds a
 * concierge enquiry from the seeded buyer's phone, so a fixed fixture number
 * would sweep that seeded lead away on the way out — a test deleting demo data
 * it never created. Run-scoped also means two copies of this file running at
 * once cannot sweep each other's fixtures.
 */
const FIXTURE_PHONE = `0803${String((Number(process.pid) * 7919 + (Date.now() % 100000)) % 10_000_000).padStart(7, '0')}`;

let available = false;
let ctx;
let slugs = {};

/** DB-backed tests skip (never fail) when MySQL is not reachable. */
const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  ctx = await startTestServer();
  const db = require('../src/db');
  const [live] = await db.query("SELECT seo_slug FROM vehicle_listings WHERE status='live' LIMIT 1");
  const [archived] = await db.query('SELECT seo_slug FROM v_archived_sold LIMIT 1');
  const [expired] = await db.query('SELECT seo_slug FROM v_expired_sold LIMIT 1');
  const [soldRecent] = await db.query(
    "SELECT seo_slug FROM vehicle_listings WHERE status='sold' AND sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) LIMIT 1",
  );
  slugs = {
    live: live?.seo_slug,
    archived: archived?.seo_slug,
    expired: expired?.seo_slug,
    soldRecent: soldRecent?.seo_slug,
  };
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (available) {
    const db = require('../src/db');
    // The suite posts one enquiry through the public form to prove it lands in
    // the CRM inbox. It is a fixture, not a customer, so it goes back out again
    // rather than sitting in the console for the next person who opens it.
    const { variants } = require('../src/lib/phone');
    const shapes = variants(FIXTURE_PHONE);
    const marks = shapes.map(() => '?').join(',');
    await db.query(`DELETE FROM leads WHERE phone IN (${marks})`, shapes);
    await db.query(`DELETE FROM notifications WHERE recipient IN (${marks})`, shapes);
    await db.pool.end();
  }
});

maybe('homepage renders the hero, the trust chips and the live feed', async () => {
  const { response, html } = await getHtml(ctx.baseUrl, '/');
  assert.equal(response.status, 200);
  // The hero now carries the reference's three-beat headline; the <br> and the
  // green <em> are presentation, so the assertion tolerates tags between beats.
  assert.match(html, /Quality Cars\.[\s\S]{0,12}Real People\.[\s\S]{0,40}Honest Deals\./);
  assert.match(html, /Hassle-Free/, 'the reference trust pill is in force');
  assert.match(html, /hero--cinematic/, 'the cinematic hero is in force');
  assert.match(html, /Find your perfect ride/, 'category cards render');
  assert.match(html, /cars live now/);
  assert.match(html, /Fresh on the market/);
  assert.match(html, /How it works/);
  assert.match(html, /Three grades\. No grey areas\./);
  assert.match(html, /Find My Car/);
});

maybe('homepage is server-rendered: the cards are in the HTML, not fetched later', async () => {
  const { html } = await getHtml(ctx.baseUrl, '/');
  const cards = (html.match(/car-card__title/g) || []).length;
  assert.ok(cards >= 8, `expected at least 8 server-rendered cards, got ${cards}`);
  assert.ok(!/client-render-placeholder/.test(html));
});

maybe('/cars lists live stock with the result header and filter rail', async () => {
  const { response, html } = await getHtml(ctx.baseUrl, '/cars');
  assert.equal(response.status, 200);
  assert.match(html, /cars in Port Harcourt/);
  assert.match(html, /name="make"/);
  assert.match(html, /data-filter-form/);
  assert.match(html, /Certified only/);
});

maybe('/cars with a raw filter combo is noindex and canonicalises to /cars (§14.1)', async () => {
  const { html } = await getHtml(ctx.baseUrl, '/cars?make=Toyota&body=suv&max=20000000');
  assert.match(html, /name="robots" content="noindex,follow"/);
  assert.match(html, /rel="canonical" href="[^"]*\/cars"/);
});

maybe('curated facet pages are indexable, self-canonical and carry their own H1', async () => {
  for (const [path, h1] of [
    ['/cars/toyota', 'Toyota cars for sale in Port Harcourt'],
    ['/cars/toyota/camry', 'Toyota Camry for sale in Port Harcourt'],
    ['/cars/suv-under-15m', 'SUVs under ₦15m in Port Harcourt'],
  ]) {
    const { response, html } = await getHtml(ctx.baseUrl, path);
    assert.equal(response.status, 200, `${path} should render`);
    assert.match(html, /name="robots" content="index,follow"/, `${path} should be indexable`);
    assert.match(html, new RegExp(`rel="canonical" href="[^"]*${path.replace(/[/]/g, '\\/')}"`));
    assert.ok(html.includes(h1), `${path} should use its curated H1`);
  }
});

maybe('the suv-under-15m facet really only shows SUVs under ₦15m', async () => {
  const { html } = await getHtml(ctx.baseUrl, '/cars/suv-under-15m');
  const prices = [...html.matchAll(/class="car-card__price mb-0">\s*₦([\d,]+)/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  assert.ok(prices.length > 0, 'facet should have results');
  for (const price of prices) {
    assert.ok(price <= 15_000_000, `found a car above ₦15m: ₦${price.toLocaleString('en-NG')}`);
  }
});

maybe('a market URL filters to that city, canonicalises onto its facet and is remembered (FR-32)', async () => {
  const { response, html } = await getHtml(ctx.baseUrl, '/cars?city=owerri');
  assert.equal(response.status, 200);
  assert.match(html, /cars in Owerri, Imo State/, 'the header says which market this is');
  assert.match(html, /rel="canonical" href="https?:\/\/[^"]*\/cars\/owerri"/, 'the query URL points at the curated page');
  assert.match(html, /name="robots" content="index,follow"/);
  assert.match(response.headers.get('set-cookie') || '', /hc_city=owerri/, 'picking a market remembers it');
  assert.match(html, /name="city" value="owerri" checked/, 'the rail shows the market that is applied');
  assert.doesNotMatch(html, /name="city" value="port-harcourt" checked/);

  // A city we do not serve is dropped: the grid is the whole network again.
  const bogus = await getHtml(ctx.baseUrl, '/cars?city=lagoos');
  assert.equal(bogus.response.status, 200);
  assert.match(bogus.html, /cars in All markets/);
  assert.doesNotMatch(bogus.html, /name="city" value="lagoos"/);
});

maybe('the remembered market applies without a URL token, privately and unindexed (FR-32)', async () => {
  const url = `${ctx.baseUrl}/cars`;
  const response = await fetch(url, { headers: { cookie: 'hc_city=aba' } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /cars in Aba, Abia State/);
  assert.match(html, /name="robots" content="noindex,follow"/, 'a variant of /cars is not the page we index');
  assert.match(response.headers.get('cache-control') || '', /no-store/, 'a preference-shaped page is not shared');
  assert.match(response.headers.get('vary') || '', /Cookie/i);
});

maybe('a curated city facet is scoped to its own market (FR-32)', async () => {
  const { response, html } = await getHtml(ctx.baseUrl, '/cars/aba');
  assert.equal(response.status, 200);
  assert.match(html, /cars in Aba, Abia State/);
  assert.match(html, /name="city" value="aba" checked/);
  // Every area offered is an Aba one — no Port Harcourt neighbourhoods in the rail.
  const areas = Array.from(html.matchAll(/name="area" value="([^"]+)"/g)).map((m) => m[1]);
  assert.ok(areas.length > 0, 'Aba stock carries areas');
  assert.ok(areas.every((area) => !/^(Woji|Rumuokoro|GRA Phase 2|Trans-Amadi)$/.test(area)), `Port Harcourt area in Aba rail: ${areas}`);
  assert.match(html, /Aba is .*Abia State/, 'the page copy names the market');
});

maybe('VDP emits Vehicle+Offer JSON-LD, the stock number and a WhatsApp CTA', async () => {
  const { response, html } = await getHtml(ctx.baseUrl, `/cars/${slugs.live}`);
  assert.equal(response.status, 200);
  assert.match(html, /"@type":"Vehicle"/);
  assert.match(html, /"priceCurrency":"NGN"/);
  assert.match(html, /Stock <span class="tabular">HC-PH-/);
  assert.match(html, /Request Viewing/);
  assert.match(html, /Never pay a seller or third party directly\./);
  assert.match(html, /data-gallery/);
});

maybe('the VDP never exposes dealer contact details publicly (§18.3)', async () => {
  const { html } = await getHtml(ctx.baseUrl, `/cars/${slugs.live}`);
  assert.match(html, /Partner dealer · .+ — verified by HonestCars/);
  assert.ok(!/dealer_name/.test(html), 'raw dealer identifiers must not leak into markup');
});

maybe('sold within 7 days stays visible and shows the social-proof badge', async () => {
  if (!slugs.soldRecent) return;
  const { response, html } = await getHtml(ctx.baseUrl, `/cars/${slugs.soldRecent}`);
  assert.equal(response.status, 200);
  assert.match(html, /badge--sold/);
  assert.match(html, /Sold in \d+ days?/);
  assert.match(html, /name="robots" content="noindex,follow"/);
});

maybe('sold 7–90 days 301s to its archive page, which is indexable', async () => {
  if (!slugs.archived) return;
  const vdp = await fetch(`${ctx.baseUrl}/cars/${slugs.archived}`, { redirect: 'manual' });
  assert.equal(vdp.status, 301);
  assert.equal(vdp.headers.get('location'), `/cars/sold/${slugs.archived}`);

  const { response, html } = await getHtml(ctx.baseUrl, `/cars/sold/${slugs.archived}`);
  assert.equal(response.status, 200);
  assert.match(html, /name="robots" content="index,follow"/);
  assert.match(html, /Similar cars you can buy today/);
});

maybe('sold beyond 90 days 301s to its facet (§14.1)', async () => {
  if (!slugs.expired) return;
  const response = await fetch(`${ctx.baseUrl}/cars/${slugs.expired}`, { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.match(response.headers.get('location'), /^\/cars\/[a-z-]+$/);
});

maybe('sitemap.xml contains listings, curated facets and no filter URLs', async () => {
  const response = await fetch(`${ctx.baseUrl}/sitemap.xml`);
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(xml, /<loc>[^<]*\/cars\/toyota<\/loc>/);
  assert.match(xml, /<loc>[^<]*\/cars\/suv-under-15m<\/loc>/);
  assert.ok(!xml.includes('?make='), 'filter combinations must never be in the sitemap');
  assert.ok((xml.match(/<url>/g) || []).length > 50);
});

maybe('POST /api/leads creates a lead and returns a WhatsApp hand-off', async () => {
  const response = await fetch(`${ctx.baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'concierge', name: 'Route Test', phone: FIXTURE_PHONE, sourcePath: '/find-my-car' }),
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.leadId > 0);
  assert.match(body.whatsappUrl, /^https:\/\/wa\.me\//);
});

maybe('POST /api/leads rejects a malformed phone number', async () => {
  const response = await fetch(`${ctx.baseUrl}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'viewing', name: 'Nobody', phone: 'abc' }),
  });
  assert.equal(response.status, 422);
});

maybe('POST /api/events stores known events and drops unknown ones (§15.1)', async () => {
  const response = await fetch(`${ctx.baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [
        { name: 'filter_applied', payload: { filters: { make: 'Toyota' } } },
        { name: 'made_up_event', payload: {} },
      ],
      path: '/cars',
      session: 'route-test',
    }),
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.stored, 1);
});

maybe('unknown URLs render the 404 page with a 404 status', async () => {
  const { response, html } = await getHtml(ctx.baseUrl, '/definitely-not-a-page');
  assert.equal(response.status, 404);
  assert.match(html, /We can’t find that page/);
});

maybe('response headers carry the security baseline (§12.2)', async () => {
  const response = await fetch(`${ctx.baseUrl}/`);
  assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control') || '', /max-age/);
});

maybe('the hybrid renderer serves from disk after a build, and renders per request without one', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { runScript, ROOT } = require('./helpers');

  // 1. No build on disk: the request-time renderer answers, and says so.
  const manifestPath = path.join(ROOT, '.test-static', '.static-manifest.json');
  assert.equal(fs.existsSync(manifestPath), false, 'test static dir should start empty');
  const before = await fetch(`${ctx.baseUrl}/cars/toyota`);
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('x-honestcars-render'), 'dynamic');

  // 2. Build (into the test static dir), boot again, and the same URL now comes
  //    from the file on disk — the §12.4 hybrid contract, end to end.
  try {
    runScript('scripts/build-static.js', ['--quiet']);
    const inner = await startTestServer();
    try {
      const response = await fetch(`${inner.baseUrl}/cars/toyota`);
      assert.equal(response.headers.get('x-honestcars-render'), 'static');
      assert.equal(response.status, 200);
    } finally {
      await inner.close();
    }
  } finally {
    fs.rmSync(path.join(ROOT, '.test-static'), { recursive: true, force: true });
  }
});
