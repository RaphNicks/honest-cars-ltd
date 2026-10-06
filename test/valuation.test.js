'use strict';

/**
 * FR-29 — the instant valuation widget (§6.6 "rough band from pricing DB with
 * 'confirm with free human valuation' CTA").
 *
 * The widget is easy to fake and hard to make honest, so what is tested here is
 * the honesty rather than the arithmetic:
 *
 *   • the band comes from `price_bands` by the same matching rule the VDP price
 *     badge uses (exact condition beats `any`, most evidence wins a tie);
 *   • the age of the data is part of the answer — a band past §7.3's weekly
 *     refresh says so, and no band at all is a real answer, not a guess;
 *   • mileage is *described*, never applied: the widget prints the median of the
 *     live comparables and refuses to move the number it does not own;
 *   • a make or model that is not name-shaped is refused rather than echoed.
 *
 * Fixtures are one invented model ("Keystone Testcase") with its own bands and
 * live stock, so the numbers in the assertions are ours and not the seed's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, getHtml } = require('./helpers');

let available = false;
let ctx;
let db;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

let seq = 0;
function nextPhone() {
  seq += 1;
  return `+2348099444${String(seq).padStart(2, '0')}`;
}

/**
 * Every test invents its own model name. Bands live in a shared table and the
 * lookup is make + model + year, so a fixture from an earlier test would answer
 * a later test's question — the classic way a "no band" assertion passes for the
 * wrong reason until the day it fails for the wrong reason.
 */
let modelSeq = 0;
const nextModel = () => `Testcase ${String.fromCharCode(65 + (modelSeq % 26))}${Math.floor(modelSeq++ / 26)}`;
const MAKE = 'Keystone';

const created = { users: [], lots: [], listings: [], bands: [] };

async function makeLot() {
  const phone = nextPhone();
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [phone, 'Valuation Test Lot', 'dealer', 'active']);
  const user = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  created.users.push(Number(user.id));
  const slug = `valuation-test-lot-${Date.now().toString().slice(-6)}`;
  await db.query(
    `INSERT INTO dealers (name, slug, lot_area, city, tier, verified, commission_pct, user_id, agreement_signed)
     VALUES ('Valuation Test Motors', ?, 'Test layout', 'Port Harcourt', 'standard', 1, 10, ?, UTC_TIMESTAMP())`,
    [slug, user.id],
  );
  const lot = await db.queryOne('SELECT * FROM dealers WHERE slug = ? LIMIT 1', [slug]);
  created.lots.push(Number(lot.id));
  return lot;
}

/** A live listing that the widget will count as a comparable. */
async function makeListing(lot, model, { year, mileageKm, priceKobo, status = 'live' }) {
  const stockNo = `HC-VT-${String(created.listings.length + 1).padStart(4, '0')}-${Date.now().toString().slice(-5)}`;
  const slug = `${year}-keystone-${model.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stockNo.toLowerCase()}`;
  const result = await db.query(
    `INSERT INTO vehicle_listings
       (stock_no, dealer_id, status, make, model, year, body_type, transmission, fuel_type, \`condition\`,
        mileage_km, asking_price_kobo, area, documents, seo_slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'suv', 'automatic', 'petrol', 'nigerian_used',
             ?, ?, 'Woji', '{"customs":true}', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [stockNo, lot.id, status, MAKE, model, year, mileageKm, priceKobo, slug],
  );
  created.listings.push(Number(result.insertId));
  return Number(result.insertId);
}

async function makeBand({ model, yearFrom, yearTo, condition = 'any', minKobo, maxKobo, sampleSize, ageDays = 0 }) {
  const result = await db.pricing.upsertBand({
    make: MAKE,
    model,
    yearFrom,
    yearTo,
    condition,
    minKobo,
    maxKobo,
    sampleSize,
  });
  assert.equal(result.ok, true, result.error);
  created.bands.push(result.band.id);
  if (ageDays) {
    await db.query('UPDATE price_bands SET refreshed_at = DATE_SUB(CURDATE(), INTERVAL ? DAY) WHERE id = ?', [ageDays, result.band.id]);
  }
  return result.band;
}

const valuation = require('../src/services/valuation');

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  ctx = await startTestServer();
});

test.after(async () => {
  if (!available) return;
  await ctx.close();
  for (const id of created.listings) await db.query('DELETE FROM vehicle_listings WHERE id = ?', [id]).catch(() => {});
  for (const id of created.bands) await db.query('DELETE FROM price_bands WHERE id = ?', [id]).catch(() => {});
  for (const id of created.lots) await db.query('DELETE FROM dealers WHERE id = ?', [id]).catch(() => {});
  for (const id of created.users) await db.query('DELETE FROM `users` WHERE id = ?', [id]).catch(() => {});
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

maybe('a covered car gets a band, with its evidence and its age attached', async () => {
  const model = nextModel();
  await makeBand({ model, yearFrom: 2012, yearTo: 2016, minKobo: 8_000_000_00, maxKobo: 10_000_000_00, sampleSize: 18 });
  const result = await valuation.estimate({ make: 'keystone', model: model.toLowerCase(), year: 2014, condition: 'nigerian_used' });

  assert.equal(result.ok, true);
  assert.equal(result.found, true);
  assert.equal(result.band.minKobo, 800_000_000);
  assert.equal(result.band.maxKobo, 1_000_000_000);
  assert.equal(result.band.sampleSize, 18);
  assert.match(result.verdict.headline, /₦8,000,000/);
  assert.match(result.verdict.detail, /18 comparable sale/);
  assert.match(result.verdict.detail, /2012–2016/);
  assert.equal(result.verdict.staleNote, null, 'a fresh band carries no warning');
  assert.equal(result.band.stale, false);
  assert.equal(Boolean(result.humanCta && result.humanCta.label), true, 'the CTA is always there');
});

maybe('a band past the weekly refresh says so rather than reading as current', async () => {
  const model = nextModel();
  await makeBand({ model, yearFrom: 2018, yearTo: 2020, minKobo: 12_000_000_00, maxKobo: 14_000_000_00, sampleSize: 9, ageDays: 40 });
  const result = await valuation.estimate({ make: MAKE, model, year: 2019 });

  assert.equal(result.band.stale, true);
  assert.equal(result.band.ageDays >= 40, true);
  assert.match(result.verdict.staleNote, /weekly refresh/);
  assert.equal(result.verdict.tone, 'amber', 'the card changes colour with the caveat');
});

maybe('the year has to be inside the band — and the answer then shows what we do cover', async () => {
  const model = nextModel();
  await makeBand({ model, yearFrom: 2005, yearTo: 2009, minKobo: 4_000_000_00, maxKobo: 5_000_000_00, sampleSize: 6 });
  const result = await valuation.estimate({ make: MAKE, model, year: 2014 });

  assert.equal(result.ok, true);
  assert.equal(result.found, false);
  assert.equal(result.band, null, 'no number is invented for an uncovered year');
  assert.match(result.verdict.detail, /2005–2009/, 'the range we do hold is named');
  assert.equal(result.verdict.headline, 'No band for that car yet');
});

maybe('an unknown model is offered the models we do hold, not a dead end', async () => {
  const held = nextModel();
  await makeBand({ model: held, yearFrom: 2010, yearTo: 2014, minKobo: 6_000_000_00, maxKobo: 7_000_000_00, sampleSize: 5 });
  const result = await valuation.estimate({ make: MAKE, model: `Unknown ${nextModel()}`, year: 2012 });

  assert.equal(result.found, false);
  assert.equal(result.alternatives.some((alt) => alt.model === held), true, 'suggests a model we do hold');
  assert.match(result.verdict.detail, /bands for other Keystone models/);
});

maybe('exact condition beats a general band, and the tie-break prefers evidence', async () => {
  const model = nextModel();
  await makeBand({ model, yearFrom: 2021, yearTo: 2022, condition: 'any', minKobo: 20_000_000_00, maxKobo: 24_000_000_00, sampleSize: 4 });
  await makeBand({ model, yearFrom: 2021, yearTo: 2022, condition: 'tokunbo', minKobo: 26_000_000_00, maxKobo: 30_000_000_00, sampleSize: 2 });

  const tokunbo = await valuation.estimate({ make: MAKE, model, year: 2021, condition: 'tokunbo' });
  assert.equal(tokunbo.band.minKobo, 2_600_000_000, 'the exact-condition band wins');
  assert.equal(tokunbo.band.condition, 'tokunbo');

  const unspecified = await valuation.estimate({ make: MAKE, model, year: 2021, condition: 'any' });
  assert.equal(unspecified.band.minKobo, 2_000_000_000, 'and “assume” gets the general band');
});

// ---------------------------------------------------------------------------
// Mileage and comparables
// ---------------------------------------------------------------------------

maybe('mileage is described from live comparables, never applied', async () => {
  const lot = await makeLot();
  const model = nextModel();
  await makeBand({ model, yearFrom: 2011, yearTo: 2013, minKobo: 7_000_000_00, maxKobo: 9_000_000_00, sampleSize: 11 });
  await makeListing(lot, model, { year: 2012, mileageKm: 200_000, priceKobo: 7_500_000_00 });
  await makeListing(lot, model, { year: 2012, mileageKm: 150_000, priceKobo: 8_200_000_00 });
  await makeListing(lot, model, { year: 2013, mileageKm: 100_000, priceKobo: 8_900_000_00 });
  await makeListing(lot, model, { year: 2012, mileageKm: 90_000, priceKobo: 9_500_000_00, status: 'sold' });

  const low = await valuation.estimate({ make: MAKE, model, year: 2012, mileageKm: 60_000 });
  assert.equal(low.comparables.count, 3, 'a sold car is not live comparable stock');
  assert.equal(low.comparables.medianMileageKm, 150_000);
  assert.equal(low.comparables.medianPriceLabel, '₦8,200,000');
  assert.match(low.verdict.mileageNote, /median of 150,000 km/);
  assert.match(low.verdict.mileageNote, /90,000 km below/);
  assert.match(low.verdict.mileageNote, /top of the band/);
  assert.match(low.verdict.mileageNote, /do not adjust the number/, 'the band is not silently moved');

  const high = await valuation.estimate({ make: MAKE, model, year: 2012, mileageKm: 320_000 });
  assert.match(high.verdict.mileageNote, /170,000 km above/);
  assert.match(high.verdict.mileageNote, /bottom of the band/);

  const noMileage = await valuation.estimate({ make: MAKE, model, year: 2012 });
  assert.equal(noMileage.verdict.mileageNote, null, 'no mileage given, no mileage claim made');
  assert.equal(noMileage.band.minKobo, low.band.minKobo, 'and the band is the same either way');
});

maybe('the widget links to the facet the band is drawn from', async () => {
  // Deliberately the seeded stock: the point is the *facet* link, which only
  // exists for a curated make/model.
  const toyota = await valuation.estimate({ make: 'Toyota', model: 'Camry', year: 2015 });
  assert.equal(toyota.found, true);
  assert.equal(toyota.comparables.browsePath, '/cars/toyota/camry', 'a curated facet is the link, not a raw query');
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

maybe('bad input is refused with a sentence a person could act on', async () => {
  const missingMake = await valuation.estimate({ make: '', model: 'Camry', year: 2015 });
  assert.equal(missingMake.ok, false);
  assert.match(missingMake.error, /Which make/);

  const missingModel = await valuation.estimate({ make: 'Toyota', year: 2015 });
  assert.equal(missingModel.ok, false);

  const oldYear = await valuation.estimate({ make: 'Toyota', model: 'Camry', year: 1900 });
  assert.equal(oldYear.ok, false);
  assert.match(oldYear.error, /1980/);

  const badMileage = await valuation.estimate({ make: 'Toyota', model: 'Camry', year: 2015, mileageKm: 'twelve thousand' });
  assert.equal(badMileage.ok, false);
  assert.match(badMileage.error, /Mileage/);

  const absurd = await valuation.estimate({ make: 'Toyota', model: 'Camry', year: 2015, mileageKm: '9000000' });
  assert.equal(absurd.ok, false, 'a two-million-kilometre typo does not become a valuation');

  const hostile = await valuation.estimate({ make: '<script>alert(1)</script>', model: 'Camry', year: 2015 });
  assert.equal(hostile.ok, false, 'not name-shaped → refused, never echoed into a lookup');
  assert.match(hostile.error, /Toyota Camry/);
});

maybe('the endpoint answers JSON, and only a malformed request is a 400', async () => {
  const model = nextModel();
  await makeBand({ model, yearFrom: 2017, yearTo: 2019, minKobo: 11_000_000_00, maxKobo: 13_000_000_00, sampleSize: 8 });
  const ok = await fetch(`${ctx.baseUrl}/api/valuation?make=Keystone&model=${encodeURIComponent(model)}&year=2018`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.found, true);
  assert.equal(body.band.minKobo, 1_100_000_000);

  // No band is a 200 with an honest answer — the question was answered.
  const noBand = await fetch(`${ctx.baseUrl}/api/valuation?make=Keystone&model=${encodeURIComponent(model)}&year=1999`);
  assert.equal(noBand.status, 200);
  assert.equal((await noBand.json()).found, false);

  const bad = await fetch(`${ctx.baseUrl}/api/valuation?model=${encodeURIComponent(model)}&year=2018`);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).ok, false);

  const hostile = await fetch(`${ctx.baseUrl}/api/valuation?make=%3Cscript%3E&model=${encodeURIComponent(model)}&year=2018`);
  assert.equal(hostile.status, 400);
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

maybe('/sell-swap carries the widget, and it works without JavaScript', async () => {
  const { response, html } = await getHtml(ctx.baseUrl, '/sell-swap');
  assert.equal(response.status, 200);

  assert.match(html, /data-valuation(?![a-z-])/, 'the widget is on the page');
  assert.match(html, /data-valuation-form/);
  assert.match(html, /data-valuation-result/);
  assert.match(html, /What is it likely worth\?/);
  assert.match(html, /not an offer and not a promise/i, 'the copy says what it is not');

  // Without JavaScript the page still makes the §6.6 promise and still has the
  // three-step intake — the widget is an upgrade, not the mechanism.
  assert.match(html, /Free valuation within 24 hours/);
  assert.match(html, /data-flow="sell"/);
  assert.match(html, /id="sell-intake"/);
  const script = await getHtml(ctx.baseUrl, '/js/valuation.js');
  assert.equal(script.response.status, 200, 'the module ships');
  assert.match(script.html, /initValuation/);
});
