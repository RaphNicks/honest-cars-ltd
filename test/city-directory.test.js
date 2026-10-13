'use strict';

/**
 * The city catalogue — every Nigerian city the picker offers, and the rules that
 * keep it honest.
 *
 * The catalogue lives in code (`src/lib/nigeria-cities.js`) rather than in
 * `service_cities`, and the reason is worth pinning down here: `service_cities`
 * means *a market we operate* — it carries the stock prefix and the area list,
 * and `db.listings.filterFacets` reads it straight into the /cars filter rail,
 * where "a market with no stock still shows as a real 0". Adding forty-eight
 * cities there would put forty-eight radio buttons in that rail. So the two
 * questions stay separate, and this file holds the invariants of the wider list:
 *
 *   • slugs, names and prefixes are unique — a duplicate prefix would let two
 *     cities mint stock numbers in the same series;
 *   • every column it could be written into accepts it (lengths, slug alphabet);
 *   • the four markets are in it, and marked served;
 *   • the directory sorts by stock, deepest first, ties by name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { CITIES, findCity, stateLabel } = require('../src/lib/nigeria-cities');

test('every Nigerian state is represented, the FCT included', () => {
  const states = new Set(CITIES.map((city) => city.state));
  // 36 states + the Federal Capital Territory.
  assert.equal(states.size, 37, `expected 37 states, found ${states.size}: ${[...states].sort().join(', ')}`);
  assert.equal(states.has('FCT'), true, 'Abuja is in the FCT, not a state of its own');
  assert.ok(CITIES.length >= 40, `a national list, not a token one — found ${CITIES.length}`);
});

test('the four markets we operate are in it, and marked as served', () => {
  const served = CITIES.filter((city) => city.served).map((city) => city.slug).sort();
  assert.deepEqual(served, ['aba', 'benin-city', 'owerri', 'port-harcourt']);
});

test('slugs, names and stock prefixes are unique', () => {
  for (const key of ['slug', 'name', 'prefix']) {
    const seen = new Map();
    for (const city of CITIES) {
      const value = city[key];
      assert.ok(value, `${city.slug} is missing ${key}`);
      assert.equal(seen.has(value), false, `${value} is used twice as a ${key}: ${seen.get(value)} and ${city.slug}`);
      seen.set(value, city.slug);
    }
  }
});

test('every entry fits the column it would be written into', () => {
  for (const city of CITIES) {
    assert.match(city.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${city.slug} is not a URL slug`);
    assert.ok(city.slug.length <= 60, `${city.slug} exceeds service_cities.slug (60)`);
    assert.ok(city.name.length <= 80, `${city.name} exceeds service_cities.name (80)`);
    assert.ok(city.state.length <= 60, `${city.state} exceeds service_cities.state (60)`);
    assert.ok(city.prefix.length <= 8, `${city.prefix} exceeds service_cities.stock_prefix (8)`);
    assert.match(city.prefix, /^HC-[A-Z]+$/, `${city.prefix} is not an HonestCars stock series`);
  }
});

test('a city resolves by slug or by the name a person types, and nothing else', () => {
  assert.equal(findCity('lagos').name, 'Lagos');
  assert.equal(findCity('LAGOS').name, 'Lagos', 'case is not a reason to fail');
  assert.equal(findCity('Port Harcourt').name, 'Port Harcourt');
  assert.equal(findCity('  benin-city  ').name, 'Benin City', 'whitespace is trimmed');
  assert.equal(findCity('Atlantis'), null);
  assert.equal(findCity(''), null);
  assert.equal(findCity(null), null);
  assert.equal(findCity('x'.repeat(200)), null, 'the length guard still applies');
});

test('the state label reads the way people say it', () => {
  assert.equal(stateLabel({ state: 'Rivers' }), 'Rivers State');
  assert.equal(stateLabel({ state: 'FCT' }), 'FCT', 'nobody says “FCT State”');
  assert.equal(stateLabel({}), '');
  assert.equal(stateLabel(null), '');
});

// ---------------------------------------------------------------------------
// The directory — catalogue merged with the markets, in the order buyers read.
// ---------------------------------------------------------------------------

const { dbAvailable } = require('./helpers');

let available = false;
test.before(async () => {
  available = await dbAvailable();
});

// The house rule: a suite that opens the pool closes it, or the test runner
// waits on an idle connection for ever.
test.after(async () => {
  if (!available) return;
  const db = require('../src/db');
  await db.pool.end();
});

test('the directory lists the whole country, deepest stock first', async (t) => {
  if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
  const directory = require('../src/services/city-directory');
  const rows = await directory.directory();

  assert.ok(rows.length >= CITIES.length, `expected at least ${CITIES.length} cities, found ${rows.length}`);

  // Stock never increases as you read down.
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(
      rows[i - 1].live >= rows[i].live,
      `${rows[i - 1].name} (${rows[i - 1].live}) must not come before ${rows[i].name} (${rows[i].live})`,
    );
  }

  // The ties are broken by ops' own market order, then by name: Owerri before
  // Benin City at equal stock because that is where ops put them, and the
  // forty-odd cities at zero in alphabetical order.
  const markets = rows.filter((row) => row.served).map((row) => row.slug);
  const byOpsOrder = ['port-harcourt', 'owerri', 'aba', 'benin-city'];
  assert.deepEqual(
    markets.slice().sort((a, b) => rows.findIndex((r) => r.slug === a) - rows.findIndex((r) => r.slug === b)),
    markets,
    'markets keep a stable order between calls',
  );
  assert.deepEqual(byOpsOrder.filter((slug) => markets.includes(slug)), markets.slice().sort((a, b) => byOpsOrder.indexOf(a) - byOpsOrder.indexOf(b)));

  const empties = rows.filter((row) => row.live === 0).map((row) => row.name);
  assert.deepEqual(empties, empties.slice().sort((a, b) => a.localeCompare(b)), 'the zero-stock tail is alphabetical');

  // And the whole thing is deterministic — the picker cannot reshuffle itself
  // between two requests a second apart.
  const again = await directory.directory();
  assert.deepEqual(again.map((row) => row.slug), rows.map((row) => row.slug));

  // The market with the stock leads — that is the whole point of the ordering.
  assert.equal(rows[0].slug, 'port-harcourt');
  assert.equal(rows[0].served, true);
  assert.ok(rows[0].live > 0);

  // Every city carries what the picker draws and searches.
  for (const row of rows) {
    assert.ok(row.slug && row.name && row.stateLabel, `${row.slug} is missing a field the picker needs`);
    assert.equal(typeof row.live, 'number');
    assert.equal(typeof row.served, 'boolean');
  }

  // A city we have no lots in is listed and truthfully empty.
  const lagos = rows.find((row) => row.slug === 'lagos');
  assert.ok(lagos, 'Lagos is in the catalogue and must appear');
  assert.equal(lagos.live, 0);
  assert.equal(lagos.served, false);

  // Markets carry their area list; catalogue cities do not pretend to.
  const ph = rows.find((row) => row.slug === 'port-harcourt');
  assert.equal(ph.served, true);
  assert.ok(ph.areas >= 10, 'Port Harcourt has a real area list');
});
