'use strict';

/**
 * FR-33 — bulk listing import: the CSV, the validator, the dry run and the key.
 *
 * The promises worth testing are the ones that decide whether a dealer can trust
 * an import:
 *
 *   • the parser survives what a spreadsheet actually produces — quoted commas,
 *     quotes inside quotes, newlines inside a cell, CRLF and a BOM
 *   • the template is generated from the same column table that validates, so a
 *     downloaded template always imports
 *   • money in the shapes people write it (₦12,500,000, 12.5m, 850k), and a
 *     refusal for the shape that is almost certainly a mistake
 *   • a row that fails is refused alone — the rest of the file still imports
 *   • a dry run writes nothing, and an apply creates drafts, never live stock
 *   • a refusals message names the line and the column, in a sentence
 *   • a key is a credential: hashed at rest, revoked for good, and scoped to one
 *     lot — it can never see or write another lot's stock
 *
 * Fixtures live on a made-up lot whose account uses a phone no seeded account
 * has, and are torn down by exact id.
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
const csv = require('../src/lib/csv');
const imports = require('../src/services/imports');
const dealerApi = require('../src/services/dealer-api');

let seq = 0;
function nextPhone() {
  seq += 1;
  return `+2348099002${String(seq).padStart(2, '0')}`;
}

const created = { lots: [], users: [], listings: [], keys: [] };

async function makeLot({ name = 'Test Import Motors' } = {}) {
  const phone = nextPhone();
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [phone, 'Test Import Dealer', 'dealer', 'active']);
  const user = await db.queryOne('SELECT id, phone FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  created.users.push(user.id);

  const slug = `test-import-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 9000 + 1000)}`;
  await db.query(
    `INSERT INTO dealers (name, slug, lot_area, city, tier, verified, commission_pct, user_id, agreement_signed)
     VALUES (?, ?, 'Test layout', 'Port Harcourt', 'standard', 1, 10, ?, UTC_TIMESTAMP())`,
    [name, slug, user.id],
  );
  const lot = await db.queryOne('SELECT * FROM dealers WHERE slug = ? LIMIT 1', [slug]);
  created.lots.push(lot.id);
  return lot;
}

/**
 * The file the page's own example is modelled on: the template's header, and a
 * full row for every column in it.
 */
const HEADER = imports.COLUMNS.map((column) => column.name).join(',');
const GOOD_ROW = [
  'Kia', 'Sportage', '2018', '14.5m', 'EX', 'suv', 'automatic', 'petrol', 'tokunbo', '88000',
  '2.0L', 'fwd', 'Blue', 'Woji', 'yes', '"Air conditioning, Reverse camera"',
  'yes', 'yes', 'no', 'no', 'Clean car.', '', '',
].join(',');
/** One row that breaks every rule in the book, and one that is only human. */
const BAD_ROW = ['Toyota', 'Corolla', '1898', '5m', '', 'sedan', '', 'nigerian_used', 'abc', 'Toyota', '', '', '', '', 'maybe', '', 'perhaps', 'no', 'no', 'no', '', '', ''].join(',');

function file(rows) {
  return `${HEADER}\n${rows.join('\n')}\n`;
}

test.after(async () => {
  if (!available) return;
  for (const id of created.listings) {
    await db.query('DELETE FROM listing_media WHERE listing_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM listings_fts WHERE listing_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM vehicle_listings WHERE id = ?', [id]).catch(() => {});
  }
  for (const id of created.keys) await db.query('DELETE FROM dealer_api_keys WHERE id = ?', [id]).catch(() => {});
  for (const id of created.lots) await db.query('DELETE FROM dealers WHERE id = ?', [id]).catch(() => {});
  for (const id of created.users) await db.query('DELETE FROM `users` WHERE id = ?', [id]).catch(() => {});
  await db.pool.end();
});

async function listingCount(dealerId) {
  const row = await db.queryOne('SELECT COUNT(*) AS n FROM vehicle_listings WHERE dealer_id = ?', [dealerId]);
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// The CSV itself
// ---------------------------------------------------------------------------

maybe('the parser handles quotes, embedded commas, newlines, CRLF and a BOM', () => {
  const text = '\uFEFFa,b,c\r\n"x,1","he said ""hi""","line\nbreak"\r\nplain,,z\r\n';
  const parsed = csv.parse(text);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], ['a', 'b', 'c']);
  assert.deepEqual(parsed[1], ['x,1', 'he said "hi"', 'line\nbreak']);
  assert.deepEqual(parsed[2], ['plain', '', 'z']);

  const { columns, rows } = csv.table(text);
  assert.deepEqual(columns, ['a', 'b', 'c']);
  assert.equal(rows[0].line, 2, 'line numbers are what a spreadsheet shows');
  assert.equal(rows[0].values.b, 'he said "hi"');
  assert.equal(rows[1].line, 3);

  // Round-trip: what we write is what we read.
  const written = csv.stringify([{ a: 'x,1', b: 'he said "hi"', c: 'line\nbreak' }], ['a', 'b', 'c']);
  assert.deepEqual(csv.parse(written)[1], ['x,1', 'he said "hi"', 'line\nbreak']);
});

maybe('the parser marks trailing junk rather than silently dropping it', () => {
  const { rows } = csv.table('a,b\n1,2,3,4\n');
  assert.deepEqual(rows[0].extra, ['3', '4']);
});

maybe('the template is generated from the columns that validate it', () => {
  const text = imports.template();
  const { columns, rows } = csv.table(text);
  assert.deepEqual(columns, imports.COLUMNS.map((column) => column.name));
  assert.equal(rows.length, 1, 'one example row, and the page says to delete it');
  // Every required column has an example in the template, so it can be run as-is.
  for (const column of imports.COLUMNS.filter((c) => c.required)) {
    assert.notEqual(rows[0].values[column.name], '', `${column.name} needs an example`);
  }
  // …and the example is a real row for the validator.
  return imports.validateText(text, {}).then((report) => {
    assert.equal(report.fatal, false);
    assert.equal(report.counts.ready, 1);
    assert.equal(report.rows[0].warnings.length > 0, true, 'the example row is flagged as the example');
  });
});

// ---------------------------------------------------------------------------
// Money and booleans, as people write them
// ---------------------------------------------------------------------------

maybe('money is read as people write it, and the ambiguous shape is refused', () => {
  assert.equal(imports.moneyFromText('12500000'), 1_250_000_000);
  assert.equal(imports.moneyFromText('₦12,500,000'), 1_250_000_000);
  assert.equal(imports.moneyFromText('12.5m'), 1_250_000_000);
  assert.equal(imports.moneyFromText('12.5 million'), 1_250_000_000);
  assert.equal(imports.moneyFromText('850k'), 85_000_000);
  assert.equal(imports.moneyFromText('abc'), null);

  // ₦12.50 is ₦12.50 — but as an asking price it is a mistake, so the validator
  // refuses it and says what to write instead.
  const report = imports.normalise({ make: 'Kia', model: 'Rio', year: '2019', price: '12.5' }, { line: 2 });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0].message, /under ₦100,000/);
  assert.match(report.errors[0].message, /12\.5m/);
});

maybe('yes/no columns take what a spreadsheet produces, and nothing else', () => {
  for (const yes of ['yes', 'YES', 'y', '1', 'true']) assert.equal(imports.boolFromText(yes), true);
  for (const no of ['no', 'NO', 'n', '0', 'false', '']) assert.equal(imports.boolFromText(no), false);
  assert.equal(imports.boolFromText('maybe'), null);
});

// ---------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------

maybe('a dry run reports and writes nothing', async () => {
  const lot = await makeLot();
  const before = await listingCount(lot.id);

  const text = file([
    GOOD_ROW,
    BAD_ROW,
    ['Honda', 'Civic', '2015', '8m', 'EX', 'sedan', 'automatic', 'petrol', 'tokunbo', '120000', '1.8L', 'fwd', 'Black', 'Woji', 'no', '"Air conditioning"', 'yes', 'yes', 'no', 'no', '', '', ''].join(','),
  ]);
  const report = await imports.run(text, { dealerId: lot.id, dryRun: true });

  assert.equal(report.dryRun, true);
  assert.equal(report.counts.total, 3);
  assert.equal(report.counts.ready, 2);
  assert.equal(report.counts.refused, 1);
  assert.equal(report.created.length, 0);
  assert.equal(await listingCount(lot.id), before, 'the dry run wrote nothing');

  const refused = report.rows.find((row) => row.errors.length);
  assert.equal(refused.line, 3);
  // Every refusal names its column, and the year one says what is wrong with it.
  assert.equal(refused.errors.some((error) => error.column === 'year'), true);
  assert.match(refused.errors.find((error) => error.column === 'year').message, /1990 or newer/);
  assert.equal(refused.errors.some((error) => error.column === 'mileage_km'), true);
  // A missing photo list is a warning, not a refusal — the car is still a draft
  // that can be photographed later.
  assert.equal(report.rows.find((row) => row.line === 2).warnings.some((w) => /draft until it has at least three/.test(w.message)), true);
});

maybe('a file that is not about listings is refused as a whole, with a reason', async () => {
  const lot = await makeLot();
  const report = await imports.validateText('colour,size\nred,large\n', { dealerId: lot.id });
  assert.equal(report.ok, false);
  assert.equal(report.fatal, true);
  assert.match(report.fileErrors.join(' '), /missing make, model, year, price/);

  const empty = await imports.validateText('   ', { dealerId: lot.id });
  assert.equal(empty.fatal, true);
  assert.match(empty.fileErrors.join(' '), /empty/);

  const headerOnly = await imports.validateText(`${HEADER}\n`, { dealerId: lot.id });
  assert.match(headerOnly.fileErrors.join(' '), /no rows/);

  const tooMany = await imports.validateText(file(Array.from({ length: imports.MAX_ROWS + 1 }, () => GOOD_ROW)), { dealerId: lot.id });
  assert.equal(tooMany.fatal, true);
  assert.match(tooMany.fileErrors.join(' '), /limit is 200/);
});

maybe('an unknown column is flagged but the rest of the file still imports', async () => {
  const lot = await makeLot();
  const text = `make,model,year,price,colour_of_the_moon\nKia,Rio,2019,9m,green\n`;
  const report = await imports.validateText(text, { dealerId: lot.id });
  assert.equal(report.fatal, false);
  assert.equal(report.counts.ready, 1);
  assert.match(report.fileErrors.join(' '), /do not know: colour_of_the_moon/);
});

maybe('a car the lot already has is a warning, and two identical rows warn too', async () => {
  const lot = await makeLot();
  const first = await imports.run(file([GOOD_ROW]), { dealerId: lot.id, dryRun: false });
  created.listings.push(first.created[0].id);

  const again = await imports.validateText(file([GOOD_ROW]), { dealerId: lot.id });
  assert.equal(again.counts.ready, 1, 'a duplicate is not refused — the lot may mean it');
  assert.match(again.rows[0].warnings.map((w) => w.message).join(' '), /You already have HC-/);

  const twice = await imports.validateText(file([GOOD_ROW, GOOD_ROW]), { dealerId: lot.id });
  assert.match(twice.rows[1].warnings.map((w) => w.message).join(' '), /Same car as line 2/);
});

// ---------------------------------------------------------------------------
// The apply
// ---------------------------------------------------------------------------

maybe('applying creates drafts, with the price, the features and the photos on them', async () => {
  const lot = await makeLot();
  const photos = '/img/seed/car-11.jpg | /img/seed/car-12.jpg | /img/seed/car-13.jpg';
  const row = `Kia,Sportage,2018,14.5m,EX,suv,automatic,petrol,tokunbo,88000,2.0L,fwd,Blue,Woji,yes,"Air conditioning, Reverse camera",yes,yes,no,no,Clean car.,,"${photos}"`;
  const report = await imports.run(file([row]), { dealerId: lot.id, dryRun: false });

  assert.equal(report.created.length, 1);
  const createdRow = report.created[0];
  created.listings.push(createdRow.id);
  assert.match(createdRow.stockNo, /^HC-PH-\d+$/);

  const listing = await db.queryOne('SELECT * FROM vehicle_listings WHERE id = ?', [createdRow.id]);
  assert.equal(listing.status, 'draft', 'imports are drafts — ops publishes');
  assert.equal(listing.dealer_id, lot.id, 'and they belong to the lot that imported them');
  assert.equal(Number(listing.asking_price_kobo), 1_450_000_000);
  assert.equal(Number(listing.mileage_km), 88_000);
  assert.equal(listing.condition, 'tokunbo');
  const features = typeof listing.features === 'string' ? JSON.parse(listing.features) : listing.features;
  assert.deepEqual(features, ['Air conditioning', 'Reverse camera']);

  const media = await db.query('SELECT url, position FROM listing_media WHERE listing_id = ? ORDER BY position', [createdRow.id]);
  assert.equal(media.length, 3);
  assert.equal(createdRow.photos, 3);
});

maybe('a partly-good file imports the good rows and names the bad ones', async () => {
  const lot = await makeLot();
  const before = await listingCount(lot.id);
  const report = await imports.run(file([GOOD_ROW, BAD_ROW]), { dealerId: lot.id, dryRun: false });
  assert.equal(report.created.length, 1);
  assert.equal(report.counts.refused, 1);
  created.listings.push(report.created[0].id);
  assert.equal(await listingCount(lot.id), before + 1);
});

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

maybe('a key is stored as a hash and can never be read back', async () => {
  const lot = await makeLot();
  const issued = await dealerApi.issue(lot.id, { label: 'Stock tool' });
  created.keys.push(issued.keyInfo.id);

  assert.match(issued.key, /^hc_live_[0-9a-f]{32}$/);
  assert.equal(issued.keyInfo.prefix, issued.key.slice(0, 12));

  const row = await db.queryOne('SELECT * FROM dealer_api_keys WHERE id = ?', [issued.keyInfo.id]);
  assert.equal(row.hash, dealerApi.hashKey(issued.key));
  assert.notEqual(row.hash, issued.key);
  assert.equal(JSON.stringify(row).includes(issued.key.slice(12)), false, 'the secret is not stored anywhere');
});

maybe('a key authenticates its own lot, and only its own lot', async () => {
  const mine = await makeLot({ name: 'Test Import Motors A' });
  const theirs = await makeLot({ name: 'Test Import Motors B' });
  const issued = await dealerApi.issue(mine.id, { label: 'Mine' });
  created.keys.push(issued.keyInfo.id);

  const auth = await dealerApi.fromRequest({ get: (name) => (name === 'x-api-key' ? issued.key : '') });
  assert.equal(auth.ok, true);
  assert.equal(auth.lot.id, mine.id);

  // A request with my key is scoped to my lot: their stock is untouched.
  const before = await listingCount(theirs.id);
  const report = await imports.run(file([GOOD_ROW]), { dealerId: auth.lot.id, dryRun: false });
  created.listings.push(report.created[0].id);
  assert.equal(await listingCount(theirs.id), before);
  const listing = await db.queryOne('SELECT dealer_id FROM vehicle_listings WHERE id = ?', [report.created[0].id]);
  assert.equal(listing.dealer_id, mine.id);
});

maybe('a key is checked before anything else happens, and revocation is final', async () => {
  const lot = await makeLot();
  const issued = await dealerApi.issue(lot.id, { label: 'Short lived' });

  const missing = await dealerApi.fromRequest({ get: () => '' });
  assert.equal(missing.status, 401);
  assert.match(missing.error, /x-api-key header/);

  const wrongShape = await dealerApi.fromRequest({ get: () => 'hello' });
  assert.equal(wrongShape.status, 401);
  assert.match(wrongShape.error, /begin hc_live_/);

  const unknown = await dealerApi.fromRequest({ get: () => `hc_live_${'0'.repeat(32)}` });
  assert.equal(unknown.status, 401);

  const revoked = await dealerApi.revoke(lot.id, issued.keyInfo.id, { actorId: null });
  assert.equal(revoked.key.active, false);
  const after = await dealerApi.fromRequest({ get: () => issued.key });
  assert.equal(after.ok, false);
  assert.equal(after.status, 401);
});

maybe('revoking is recorded, and another lot cannot revoke my key', async () => {
  const mine = await makeLot({ name: 'Test Import Motors C' });
  const theirs = await makeLot({ name: 'Test Import Motors D' });
  const issued = await dealerApi.issue(mine.id, { label: 'Audited' });

  const stolen = await dealerApi.revoke(theirs.id, issued.keyInfo.id, { actorId: null });
  assert.equal(stolen.ok, false, 'a lot may only revoke its own key');
  assert.match(stolen.error, /not on your lot/);

  const revoked = await dealerApi.revoke(mine.id, issued.keyInfo.id, { actorId: created.users[0] });
  assert.equal(revoked.ok, true);
  const audit = await db.query(
    "SELECT * FROM admin_audit WHERE action = 'dealer.api_key.revoked' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [issued.keyInfo.id],
  );
  assert.equal(audit.length, 1, 'a revocation is auditable');
  assert.equal(Number(audit[0].actor_id), created.users[0]);
});

maybe('a key tracks when it was last used, so a stale integration is visible', async () => {
  const lot = await makeLot();
  const issued = await dealerApi.issue(lot.id, { label: 'In use' });
  created.keys.push(issued.keyInfo.id);
  assert.equal(issued.keyInfo.lastUsedAt, null);

  await dealerApi.fromRequest({ get: () => issued.key });
  const [again] = await dealerApi.keysFor(lot.id);
  assert.equal(again.requestCount >= 1, true);
  assert.notEqual(again.lastUsedAt, null);
});
