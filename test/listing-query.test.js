'use strict';

/**
 * Filter parsing and the safe WHERE builder. These are the two places where a
 * bad query string could otherwise reach SQL, so they are tested hard.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const lq = require('../src/services/listing-query');
const { buildWhere } = require('../src/db/listings');

test('naira query params become kobo for the database', () => {
  const parsed = lq.parseListingQuery({ min: '5000000', max: '15000000' });
  assert.equal(parsed.filters.price_min_kobo, 500_000_000);
  assert.equal(parsed.filters.price_max_kobo, 1_500_000_000);
  assert.equal(parsed.view.min, '5000000');
});

test('junk numeric input is ignored rather than passed through', () => {
  const parsed = lq.parseListingQuery({ min: 'abc', max: '-5', year_min: 'not-a-year' });
  assert.equal(parsed.filters.price_min_kobo, undefined);
  assert.equal(parsed.filters.price_max_kobo, undefined);
  assert.equal(parsed.filters.year_min, undefined);
});

test('sort tokens map to whitelisted keys and fall back safely', () => {
  assert.equal(lq.parseListingQuery({ sort: 'price-asc' }).sort, 'price_asc');
  assert.equal(lq.parseListingQuery({ sort: 'mileage-asc' }).sort, 'mileage_asc');
  assert.equal(lq.parseListingQuery({ sort: 'DROP TABLE' }).sort, 'recommended');
  assert.equal(lq.parseListingQuery({}).sort, 'recommended');
});

test('unknown params never reach the filter object', () => {
  const parsed = lq.parseListingQuery({ evil: '1', 'l.asking_price_kobo': '1', make: 'Toyota' });
  assert.deepEqual(Object.keys(parsed.filters), ['make']);
});

test('the WHERE builder only emits whitelisted enum values', () => {
  const { sql, params } = buildWhere({ body_type: 'suv', condition: 'not_an_enum', transmission: "' OR 1=1 --" });
  assert.match(sql, /l\.body_type = \?/);
  assert.ok(!sql.includes('not_an_enum'));
  assert.ok(!sql.includes('OR 1=1'));
  assert.deepEqual(params, ['suv']);
});

test('the certified toggle is a minimum grade, not an equality match', () => {
  const { sql, params } = buildWhere({ grade: 'certified' });
  assert.match(sql, /l\.verification_grade IN \(\?\)/);
  assert.deepEqual(params, ['certified']);

  const checked = buildWhere({ grade: 'field_checked' });
  assert.deepEqual(checked.params, ['field_checked', 'certified']);
});

test('the browsable scope always excludes archived and expired stock', () => {
  const { sql } = buildWhere({});
  assert.match(sql, /l\.status IN \('live','reserved'\)/);
  assert.match(sql, /l\.status = 'sold'/);
  assert.match(sql, /INTERVAL 7 DAY/);
});

test('raw filter combos are detected so they can be noindexed', () => {
  assert.equal(lq.isRawFilterCombo({}), false);
  assert.equal(lq.isRawFilterCombo({ make: 'Toyota' }), true);
  assert.equal(lq.isRawFilterCombo({ max: '15000000' }), true);
});

test('querystrings round-trip and drop defaults', () => {
  const qs = lq.buildQueryString({ make: 'Toyota', body: 'suv' }, { sort: 'price_asc', page: 2 });
  assert.equal(qs, '?make=Toyota&body=suv&sort=price_asc&page=2');
  assert.equal(lq.buildQueryString({}, {}), '');
});

test('filter pills link back to a URL without that filter', () => {
  const helpers = require('../src/lib/locals').helpers();
  const pills = lq.activeFilterPills({ make: 'Toyota', max: '15000000' }, helpers);
  const makePill = pills.find((pill) => pill.key === 'make');
  assert.ok(makePill);
  assert.equal(makePill.href, '/cars?max=15000000');
});
