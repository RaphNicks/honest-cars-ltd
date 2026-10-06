'use strict';

/**
 * FR-32 — multi-city inventory (Port Harcourt · Owerri · Aba · Benin City) with
 * an area switcher, and the admin-managed area list the PRD's data model asks
 * for ("city / area enum/str ✓ Default Port Harcourt; area list admin-managed").
 *
 * The promises worth testing are the ones a buyer or an ops person would notice
 * if they broke:
 *
 *   • a market is a *governed* thing — a hand-typed `?city=` is dropped, never
 *     filtered on, and a city facet's rule narrows stock to that city
 *   • the filter rail is scoped to the market in view: makes, areas and budget
 *     all come from the same set of cars the grid is showing
 *   • a listing inherits its lot's market and that market's stock-number series
 *     (HC-OW-, HC-AB-, HC-BN-) — a car cannot be filed in a city its lot is not
 *     in, and an area-less car is not silently filed in Port Harcourt
 *   • ops can add, rename, retire, restore and reorder areas; a rename leaves
 *     existing listings where they are and says how many it left behind
 *
 * Fixtures are one make-believe lot in Owerri (a phone no seeded account uses)
 * and are torn down by exact id.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable } = require('./helpers');

let available = false;
const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
});

const db = require('../src/db');
const listingQuery = require('../src/services/listing-query');

let seq = 0;
function nextPhone() {
  seq += 1;
  return `+2348099111${String(seq).padStart(2, '0')}`;
}

const created = { lots: [], users: [], listings: [], areas: [] };

/** A lot of our own, in a market of our choosing (Owerri by default). */
async function makeLot({ name = 'Test Owerri Motors', city = 'Owerri' } = {}) {
  const phone = nextPhone();
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [phone, 'Test Owerri Dealer', 'dealer', 'active']);
  const user = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  created.users.push(user.id);

  const rug = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 9000 + 1000)}`;
  const slug = `test-area-lot-${rug}`;
  await db.query(
    `INSERT INTO dealers (name, slug, lot_area, city, tier, verified, commission_pct, user_id, agreement_signed)
     VALUES (?, ?, 'Test layout', ?, 'standard', 1, 10, ?, UTC_TIMESTAMP())`,
    [name, slug, city, user.id],
  );
  const lot = await db.queryOne('SELECT * FROM dealers WHERE slug = ? LIMIT 1', [slug]);
  created.lots.push(lot.id);
  return { lot, user, rug };
}

test.after(async () => {
  if (!available) return;
  for (const id of created.listings) await db.query('DELETE FROM vehicle_listings WHERE id = ?', [id]).catch(() => {});
  for (const id of created.areas) await db.query('DELETE FROM service_areas WHERE id = ?', [id]).catch(() => {});
  for (const id of created.lots) await db.query('DELETE FROM dealers WHERE id = ?', [id]).catch(() => {});
  for (const id of created.users) await db.query('DELETE FROM `users` WHERE id = ?', [id]).catch(() => {});
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The markets we cover
// ---------------------------------------------------------------------------

maybe('the four markets exist, in ops order, each with its own stock series', async () => {
  const cities = await db.areas.cities();
  const names = cities.map((city) => city.name);

  assert.deepEqual(names, ['Port Harcourt', 'Owerri', 'Aba', 'Benin City'], 'switcher order is the storefront order');
  assert.deepEqual(cities.map((city) => city.slug), ['port-harcourt', 'owerri', 'aba', 'benin-city']);
  assert.deepEqual(cities.map((city) => city.stockPrefix), ['HC-PH', 'HC-OW', 'HC-AB', 'HC-BN']);
  assert.equal(cities[1].state, 'Imo');

  const total = cities.reduce((sum, city) => sum + city.cars, 0);
  assert.equal(total > 0, true, 'some stock is in the window');
  for (const city of cities) {
    assert.equal(city.areas >= 10, true, `${city.name} has a real area list`);
  }
  assert.equal(cities.every((city) => city.live <= city.cars), true, 'live cannot exceed the window');
});

maybe('every market has partner lots and real stock, not a token listing', async () => {
  const [cities, lots] = await Promise.all([
    db.areas.cities(),
    db.query('SELECT city, COUNT(*) AS lots FROM dealers GROUP BY city'),
  ]);
  const lotsByCity = Object.fromEntries(lots.map((row) => [row.city, Number(row.lots)]));

  for (const city of cities) {
    assert.equal(lotsByCity[city.name] >= 2, true, `${city.name} has at least two lots`);
    assert.equal(city.live > 0, true, `${city.name} has live stock a buyer can browse`);
  }
});

maybe('a city token resolves by slug or by name, and anything else resolves to nothing', async () => {
  assert.equal((await db.areas.cityByToken('owerri')).name, 'Owerri');
  assert.equal((await db.areas.cityByToken('Benin City')).name, 'Benin City');
  assert.equal((await db.areas.cityByToken('OWERRI')).name, 'Owerri', 'case is not a reason to fail');
  assert.equal(await db.areas.cityByToken('Lagos'), null, 'a city we do not serve is not a filter');
  assert.equal(await db.areas.cityByToken('<script>alert(1)</script>'), null);
  assert.equal(await db.areas.cityByToken(''), null);
  assert.equal(await db.areas.cityByToken('x'.repeat(200)), null);
});

maybe('areas belong to exactly one market, and carry that market\'s stock counts', async () => {
  const owerri = await db.areas.areas({ cityName: 'Owerri' });
  assert.equal(owerri.length, 10);
  assert.equal(owerri.every((area) => area.cityName === 'Owerri' && area.citySlug === 'owerri'), true);
  assert.equal(owerri.some((area) => Number.isInteger(area.cars)), true, 'live counts are on every row');

  const ph = await db.areas.areas({ cityName: 'Port Harcourt' });
  assert.equal(ph.some((area) => area.name === 'Woji'), true);
  assert.equal(owerri.some((area) => area.name === 'Woji'), false, 'an area belongs to one market only');
});

maybe('every seeded listing is filed under an area its own market actually lists', async () => {
  const [rows, pairs] = await Promise.all([
    db.query("SELECT city, area FROM vehicle_listings WHERE city <> 'Port Harcourt' GROUP BY city, area"),
    db.areas.pairs(),
  ]);
  const known = new Set(pairs.map((pair) => `${pair.city}|${pair.area}`));
  assert.equal(rows.length > 0, true, 'the expansion markets carry stock');
  for (const row of rows) {
    assert.equal(known.has(`${row.city}|${row.area}`), true, `${row.city} / ${row.area} is on the governed list`);
  }
});

// ---------------------------------------------------------------------------
// The URL contract
// ---------------------------------------------------------------------------

test('a city in the querystring survives parsing, and a bogus one is dropped', () => {
  const parsed = listingQuery.parseListingQuery({ city: 'owerri', make: 'Toyota' });
  assert.equal(parsed.view.city, 'owerri');
  assert.equal(parsed.filters.city, 'owerri');
  assert.equal(listingQuery.buildQueryString(parsed.view), '?city=owerri&make=Toyota');
  assert.equal(listingQuery.isRawFilterCombo(parsed.view), true, 'a filtered URL is not a facet page');

  assert.deepEqual(listingQuery.parseListingQuery({ city: '<script>' }).view, {});
  assert.deepEqual(listingQuery.parseListingQuery({ city: '' }).view, {});
  assert.deepEqual(listingQuery.parseListingQuery({ city: 'x'.repeat(120) }).view, {});
});

test('the city pill says which market the URL means', () => {
  const pills = listingQuery.activeFilterPills({ city: 'owerri' }, {
    BODY_TYPE_LABELS: {}, CONDITION_LABELS: {}, TRANSMISSION_LABELS: {}, FUEL_LABELS: {},
    formatNaira: (value) => String(value), formatMileage: (value) => String(value),
  });
  const city = pills.find((pill) => pill.key === 'city');
  assert.equal(city.value, 'owerri');
  assert.equal(city.href, '/cars', 'removing the pill is the whole network');
});

maybe('browsing is scoped to the market, and a raw URL token cannot reach SQL', async () => {
  const [aba, everything] = await Promise.all([
    db.listings.browse({ city: 'Aba' }, { perPage: 50 }),
    db.listings.browse({}, { perPage: 50 }),
  ]);
  assert.equal(aba.total > 0, true);
  assert.equal(aba.total < everything.total, true, 'a market is a subset of the network');
  assert.equal(aba.listings.every((listing) => listing.city === 'Aba'), true);

  const hostile = await db.listings.browse({ city: "; DROP TABLE vehicle_listings" }, { perPage: 5 });
  assert.equal(hostile.total, everything.total, 'a value that is not a place name is ignored, not queried');
});

maybe('the filter rail is scoped to the market in view', async () => {
  const network = await db.listings.filterFacets();
  const owerri = await db.listings.filterFacets({ city: 'Owerri' });

  assert.equal(network.cities.length, 4);
  assert.deepEqual(network.cities.map((city) => city.name), ['Port Harcourt', 'Owerri', 'Aba', 'Benin City']);
  assert.equal(owerri.cities.length, 4, 'the switcher still offers every market');

  assert.equal(owerri.areaGroups.length, 1, 'one market in view, one block of areas');
  assert.equal(owerri.areaGroups[0].city, 'Owerri');
  assert.equal(owerri.makes.length < network.makes.length, true, 'the makes on offer are the ones in stock there');
  assert.equal(owerri.range.maxPrice <= network.range.maxPrice, true, 'the budget range follows the market');
  assert.equal(
    owerri.areas.every((area) => area.city === 'Owerri'),
    true,
    'no Port Harcourt neighbourhood sneaks into an Owerri rail',
  );
});

maybe('a curated city facet is a real page with the market its rule names', async () => {
  const facet = await db.facets.findBySlug('owerri');
  assert.equal(facet.pageType, 'city');
  assert.equal(facet.indexable, true);
  assert.equal(facet.canonicalPath, '/cars/owerri');

  const filters = db.listings.filtersFromFacet(facet);
  assert.equal(filters.city, 'Owerri');

  const result = await db.listings.browse(filters, { perPage: 50 });
  assert.equal(result.total > 0, true);
  assert.equal(result.listings.every((listing) => listing.city === 'Owerri'), true);

  const sitemapFacets = await db.facets.allIndexable();
  assert.equal(sitemapFacets.some((row) => row.canonicalPath === '/cars/aba'), true, 'city pages are crawlable');
});

// ---------------------------------------------------------------------------
// The lot side
// ---------------------------------------------------------------------------

maybe('a listing inherits its lot\'s market, its area list and its stock series', async () => {
  const { lot } = await makeLot({ city: 'Owerri' });
  const market = await db.dealers.marketFor(lot.id);
  assert.deepEqual(market, { city: 'Owerri', prefix: 'HC-OW' });

  const made = await db.dealers.createListing(lot.id, {
    make: 'Kia', model: 'Rio', year: 2017, bodyType: 'hatchback', transmission: 'automatic',
    fuelType: 'petrol', condition: 'tokunbo', mileageKm: 74000, priceKobo: 850000000,
    negotiable: true, area: 'New Owerri', documents: {}, features: [],
  });
  created.listings.push(made.id);
  assert.match(made.stockNo, /^HC-OW-\d+$/, 'the number comes from the market\'s own series');

  const row = await db.queryOne('SELECT stock_no, city, area, status FROM vehicle_listings WHERE id = ? LIMIT 1', [made.id]);
  assert.equal(row.city, 'Owerri');
  assert.equal(row.area, 'New Owerri');
  assert.equal(row.status, 'draft', 'a lot\'s own import still waits for ops');

  // No area given: the car is filed under the market, not under Port Harcourt.
  const bare = await db.dealers.createListing(lot.id, {
    make: 'Kia', model: 'Sportage', year: 2018, bodyType: 'suv', transmission: 'automatic',
    fuelType: 'petrol', condition: 'tokunbo', mileageKm: 60000, priceKobo: 1500000000,
    negotiable: false, area: null, documents: {}, features: [],
  });
  created.listings.push(bare.id);
  const bareRow = await db.queryOne('SELECT city, area FROM vehicle_listings WHERE id = ? LIMIT 1', [bare.id]);
  assert.equal(bareRow.city, 'Owerri');
  assert.notEqual(bareRow.area, 'Port Harcourt');
});

// ---------------------------------------------------------------------------
// Ops owns the list (§5.1 settings)
// ---------------------------------------------------------------------------

maybe('ops can add an area, retire it, and restore it by adding it again', async () => {
  const abas = await db.areas.areas({ cityName: 'Aba' });
  const cityId = abas[0].cityId;
  const name = `Test Yard ${Date.now().toString().slice(-5)}`;

  const added = await db.areas.addArea(cityId, name);
  assert.equal(added.ok, true);
  created.areas.push(added.area.id);
  assert.equal(added.area.cityName, 'Aba');
  assert.equal(added.area.active, true);

  const duplicate = await db.areas.addArea(cityId, name);
  assert.equal(duplicate.ok, false, 'a live duplicate is refused with a sentence');
  assert.match(duplicate.error, /already listed/);

  const retired = await db.areas.updateArea(added.area.id, { active: false });
  assert.equal(retired.ok, true);
  assert.equal(retired.area.active, false);

  const offered = await db.areas.areas({ cityName: 'Aba' });
  assert.equal(offered.some((area) => area.name === name), false, 'a retired area leaves the storefront list');
  const everything = await db.areas.areas({ cityName: 'Aba', includeInactive: true });
  assert.equal(everything.some((area) => area.name === name), true, 'the console still sees it');

  const restored = await db.areas.addArea(cityId, name);
  assert.equal(restored.restored, true, 're-adding a retired area is a correction, not a duplicate');
  assert.equal(restored.area.active, true);
});

maybe('renaming an area is not retroactive — and the desk is told what it left behind', async () => {
  const { lot } = await makeLot();
  const made = await db.dealers.createListing(lot.id, {
    make: 'Toyota', model: 'Avensis', year: 2015, bodyType: 'sedan', transmission: 'automatic',
    fuelType: 'petrol', condition: 'nigerian_used', mileageKm: 150000, priceKobo: 700000000,
    negotiable: false, area: 'MCC Road', documents: {}, features: [],
  });
  created.listings.push(made.id);

  const owerri = await db.areas.areas({ cityName: 'Owerri' });
  const mcc = owerri.find((area) => area.name === 'MCC Road');
  const renamed = `MCC Road ${Date.now().toString().slice(-4)}`;

  const result = await db.areas.updateArea(mcc.id, { name: renamed });
  assert.equal(result.ok, true);
  assert.equal(result.previousName, 'MCC Road');
  assert.equal(result.staleListings >= 1, true, 'the car still carries the old spelling');

  const stillOld = await db.queryOne('SELECT area FROM vehicle_listings WHERE id = ? LIMIT 1', [made.id]);
  assert.equal(stillOld.area, 'MCC Road', 'a rename never moves a car behind the desk\'s back');

  const undone = await db.areas.updateArea(mcc.id, { name: 'MCC Road' });
  assert.equal(undone.ok, true);
});

maybe('reordering moves an area one place and keeps the list numbered', async () => {
  const owerri = await db.areas.areas({ cityName: 'Owerri' });
  const second = owerri[1];
  const first = owerri[0];

  const up = await db.areas.moveArea(second.id, 'up');
  assert.equal(up.moved, true);

  const after = await db.areas.areas({ cityName: 'Owerri' });
  assert.equal(after[0].id, second.id, 'it is now first');
  assert.equal(after[1].id, first.id, 'and the one it passed is second');
  assert.equal(after.every((area) => area.position % 10 === 0), true, 'positions stay readable');

  const top = await db.areas.moveArea(after[0].id, 'up');
  assert.equal(top.moved, false, 'the top of the list cannot move up');

  const back = await db.areas.moveArea(second.id, 'down');
  assert.equal(back.moved, true);
  const restored = await db.areas.areas({ cityName: 'Owerri' });
  assert.deepEqual(restored.map((area) => area.id), owerri.map((area) => area.id), 'the list is back as ops had it');
});

maybe('an area cars are filed under but the list does not know is surfaced, not hidden', async () => {
  const { lot } = await makeLot();
  const area = `Unlisted Yard ${Date.now().toString().slice(-5)}`;
  const made = await db.dealers.createListing(lot.id, {
    make: 'Honda', model: 'Civic', year: 2016, bodyType: 'sedan', transmission: 'automatic',
    fuelType: 'petrol', condition: 'tokunbo', mileageKm: 88000, priceKobo: 900000000,
    negotiable: false, area, documents: {}, features: [],
  });
  created.listings.push(made.id);

  const unmanaged = await db.areas.unmanagedAreas();
  const row = unmanaged.find((entry) => entry.area === area);
  assert.equal(Boolean(row), true, 'the console can see the drift');
  assert.equal(row.city, 'Owerri');
  assert.equal(row.cars >= 1, true);
});
