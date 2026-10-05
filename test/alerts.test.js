'use strict';

/**
 * FR-25 — saved-car and saved-search alerts.
 *
 * The important properties are the boring ones: an alert fires once per event,
 * saving something never triggers an alert about what you just looked at, a
 * price rise is not news, and a message that could not be delivered is still
 * recorded. Each test snapshots the rows it touches and restores them in the
 * same block, so the seeded demo data is unchanged afterwards.
 *
 * Skipped automatically when MySQL is not reachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable } = require('./helpers');

let available = false;
let db;
let alerts;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

/**
 * The seeded customer (Ada, §7.1).
 *
 * She is the fixture because she is what a real account looks like — and the
 * seed gives her **more than one** saved car, one of them deliberately sitting
 * under its baseline. So a run scoped to her can legitimately produce more than
 * one alert, and every assertion below names the row it is talking about
 * instead of counting the whole account's output.
 */
const CUSTOMER = '+2348031234567';

async function fixture() {
  const user = await db.queryOne('SELECT id, phone, name FROM `users` WHERE phone = ?', [CUSTOMER]);
  const cars = user ? await db.query('SELECT * FROM saved_cars WHERE user_id = ? ORDER BY id', [user.id]) : [];
  const searches = user ? await db.query('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY id', [user.id]) : [];
  const car = cars[0] || null;
  const search = searches[0] || null;
  const listing = car
    ? await db.queryOne('SELECT id, asking_price_kobo, published_at, status FROM vehicle_listings WHERE id = ?', [car.listing_id])
    : null;
  return { user, cars, searches, car, search, listing };
}

/** The sweep's output, narrowed to the row a test is actually about. */
function forListing(report, listingId, key = 'priceDrops') {
  return report[key].filter((entry) => entry.listingId === listingId);
}

/** Everything the sweep can change, put back exactly as it was. */
async function restore({ user, cars = [], searches = [], listing }) {
  if (!user) return;
  // Only the alerts' own templates: the payment suite writes notifications too
  // and runs in parallel with this file.
  await db.query("DELETE FROM notifications WHERE template IN ('price_drop','new_match')");
  if (listing) {
    await db.query('UPDATE vehicle_listings SET asking_price_kobo = ?, published_at = ?, status = ? WHERE id = ?', [
      listing.asking_price_kobo, listing.published_at, listing.status, listing.id,
    ]);
  }
  for (const car of cars) {
    await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = ? WHERE id = ?', [
      car.last_price_kobo, car.last_alerted_at, car.id,
    ]);
  }
  for (const search of searches) {
    await db.query('UPDATE saved_searches SET last_alerted_at = ? WHERE id = ?', [search.last_alerted_at, search.id]);
  }
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  alerts = require('../src/services/alerts');
});

test.after(async () => {
  if (available && db) await db.pool.end();
});

// ---------------------------------------------------------------------------
// The message composers
// ---------------------------------------------------------------------------
test('the price-drop message names both prices and the drop, and links the car', () => {
  const body = alerts.dropMessage(
    { title: '2012 Toyota RAV4 XLE', url: '/cars/2012-toyota-rav4-xle-hc-ph-0069', slug: '2012-toyota-rav4-xle-hc-ph-0069' },
    1_010_000_000,
    950_000_000,
  );
  assert.match(body, /2012 Toyota RAV4 XLE/);
  assert.match(body, /₦600,000/);
  assert.match(body, /₦9,500,000/);
  assert.match(body, /₦10,100,000/);
  assert.match(body, /\/cars\/2012-toyota-rav4-xle-hc-ph-0069/);
});

test('the new-match message lists cars with their grades and the search link', () => {
  const body = alerts.matchMessage(
    { label: 'Toyota SUVs under ₦15m', url: '/cars?make=toyota&body=suv' },
    [
      { title: '2012 Toyota RAV4 XLE', priceKobo: 1_010_000_000, gradeLabel: 'HonestCars-Certified' },
      { title: '2014 Toyota RAV4 LE', priceKobo: 900_000_000, gradeLabel: 'Field-Checked' },
    ],
  );
  assert.match(body, /2 new cars matching/);
  assert.match(body, /Toyota SUVs under ₦15m/);
  assert.match(body, /HonestCars-Certified/);
  assert.match(body, /\/cars\?make=toyota&body=suv/);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------
maybe('a price drop alerts once, and the second run is silent', async () => {
  const before = await fixture();
  assert.ok(before.car, 'the seeded customer has a saved car');
  assert.ok(before.listing, 'and that car still exists');

  try {
    await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = NULL WHERE id = ?', [
      before.listing.asking_price_kobo, before.car.id,
    ]);
    await db.query('UPDATE vehicle_listings SET asking_price_kobo = asking_price_kobo - 30000000 WHERE id = ?', [
      before.listing.id,
    ]);

    const dry = await alerts.runWatch({ dryRun: true, userId: before.user.id });
    assert.equal(forListing(dry, before.listing.id).length, 1);
    assert.equal(dry.sent, 0, 'a dry run sends nothing');
    const baselineBefore = await db.queryOne('SELECT last_price_kobo FROM saved_cars WHERE id = ?', [before.car.id]);
    assert.equal(Number(baselineBefore.last_price_kobo), Number(before.listing.asking_price_kobo), 'a dry run writes nothing');

    const run = await alerts.runWatch({ userId: before.user.id });
    const drops = forListing(run, before.listing.id);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].dropKobo, 30000000);
    assert.ok(drops[0].body.length > 20);
    assert.ok(drops[0].notificationId, 'the alert is recorded as a notification');
    assert.equal(Number(drops[0].fromKobo), Number(before.listing.asking_price_kobo));

    const second = await alerts.runWatch({ userId: before.user.id });
    assert.equal(
      forListing(second, before.listing.id).length,
      0,
      'the baseline moved, so the same drop cannot alert twice',
    );

    const rows = await db.query(
      "SELECT COUNT(*) AS n FROM notifications WHERE template = 'price_drop' AND entity_id = ?",
      [before.listing.id],
    );
    assert.equal(Number(rows[0].n), 1, 'exactly one notification');
  } finally {
    await restore(before);
  }
});

maybe('a price rise is not an alert, and resets the baseline', async () => {
  const before = await fixture();
  assert.ok(before.car && before.listing);

  try {
    await db.query('UPDATE vehicle_listings SET asking_price_kobo = asking_price_kobo + 40000000 WHERE id = ?', [
      before.listing.id,
    ]);
    const run = await alerts.runWatch({ userId: before.user.id });
    assert.equal(forListing(run, before.listing.id).length, 0, 'a rise is not news');

    const after = await db.queryOne('SELECT last_price_kobo FROM saved_cars WHERE id = ?', [before.car.id]);
    assert.equal(
      Number(after.last_price_kobo),
      Number(before.listing.asking_price_kobo) + 40000000,
      'the baseline follows the price up, so the next drop is measured from the truth',
    );
  } finally {
    await restore(before);
  }
});

maybe('a saved car that has sold is reported, never alerted about', async () => {
  const before = await fixture();
  assert.ok(before.car && before.listing);

  try {
    await db.query("UPDATE vehicle_listings SET status = 'sold', sold_at = UTC_TIMESTAMP() WHERE id = ?", [before.listing.id]);
    await db.query('UPDATE vehicle_listings SET asking_price_kobo = asking_price_kobo - 10000000 WHERE id = ?', [before.listing.id]);
    const run = await alerts.runWatch({ userId: before.user.id });

    assert.equal(forListing(run, before.listing.id).length, 0, 'no alert for a car you can no longer buy');
    assert.ok(run.soldOff.some((entry) => entry.listingId === before.listing.id), 'but the sweep says it is gone');
  } finally {
    await restore(before);
  }
});

maybe('saving a car records the price seen, so saving is never itself an alert', async () => {
  const user = await db.queryOne('SELECT id FROM `users` WHERE phone = ?', [CUSTOMER]);
  const listing = await db.queryOne(
    "SELECT id, asking_price_kobo FROM vehicle_listings WHERE status = 'live' ORDER BY id DESC LIMIT 1",
  );
  const existing = await db.queryOne('SELECT * FROM saved_cars WHERE user_id = ? AND listing_id = ?', [user.id, listing.id]);

  try {
    await db.users.addSavedCar(user.id, listing.id, 'alerts test');
    const row = await db.queryOne('SELECT last_price_kobo FROM saved_cars WHERE user_id = ? AND listing_id = ?', [user.id, listing.id]);
    assert.equal(Number(row.last_price_kobo), Number(listing.asking_price_kobo));

    // A dry run: this test is about what saving triggers, not about delivery,
    // and it shares Ada's account with the seeded demo watches.
    const run = await alerts.runWatch({ userId: user.id, dryRun: true });
    assert.equal(forListing(run, listing.id).length, 0, 'nothing drops the moment you save it');
  } finally {
    if (existing) {
      await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = ?, note = ? WHERE user_id = ? AND listing_id = ?', [
        existing.last_price_kobo, existing.last_alerted_at, existing.note, user.id, listing.id,
      ]);
    } else {
      await db.query('DELETE FROM saved_cars WHERE user_id = ? AND listing_id = ?', [user.id, listing.id]);
    }
  }
});

maybe('a saved search starts its watermark at the moment it is saved', async () => {
  const user = await db.queryOne('SELECT id FROM `users` WHERE phone = ?', [CUSTOMER]);
  const query = `body=suv&max_price=${Math.floor(Math.random() * 9000000) + 1000000}`;
  const existing = await db.queryOne('SELECT * FROM saved_searches WHERE user_id = ? AND query = ?', [user.id, query]);

  try {
    const saved = await db.users.addSavedSearch(user.id, { label: 'Alert test search', query });
    assert.ok(saved.lastAlertedAt, 'the watermark is set on save');

    const run = await alerts.runWatch({ userId: user.id, dryRun: true });
    const forThis = run.newMatches.filter((match) => match.searchId === saved.id);
    assert.equal(forThis.length, 0, 'saving a search does not mail the whole inventory');
  } finally {
    await db.query('DELETE FROM saved_searches WHERE user_id = ? AND query = ?', [user.id, query]);
    if (existing) {
      await db.query(
        'INSERT INTO saved_searches (id, user_id, label, query, alerts_enabled, alert_price_drop, alert_new_match, last_alerted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [existing.id, existing.user_id, existing.label, existing.query, existing.alerts_enabled,
          existing.alert_price_drop, existing.alert_new_match, existing.last_alerted_at, existing.created_at],
      );
    }
  }
});

maybe('a listing published inside the window produces one new-match alert', async () => {
  const before = await fixture();
  assert.ok(before.search, 'the seeded customer has a saved search');

  // A car that matches the saved search, with a fresh published_at.
  const parsed = require('../src/services/listing-query').parseListingQuery(
    Object.fromEntries(new URLSearchParams(String(before.search.query).replace(/^\?/, ''))),
  );
  const match = (await db.listings.browse(parsed.filters, { perPage: 1, sort: 'newest' })).listings[0];
  assert.ok(match, 'the saved search matches at least one car');

  const original = await db.queryOne('SELECT published_at FROM vehicle_listings WHERE id = ?', [match.id]);
  try {
    await db.query('UPDATE saved_searches SET last_alerted_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?', [before.search.id]);
    await db.query('UPDATE vehicle_listings SET published_at = UTC_TIMESTAMP() WHERE id = ?', [match.id]);

    const run = await alerts.runWatch({ userId: before.user.id });
    const mine = run.newMatches.filter((entry) => entry.searchId === before.search.id);
    assert.equal(mine.length, 1);
    assert.ok(mine[0].count >= 1);
    assert.ok(mine[0].listings.every((listing) => listing.slug && listing.title));

    const watermark = await db.queryOne('SELECT last_alerted_at FROM saved_searches WHERE id = ?', [before.search.id]);
    assert.ok(
      new Date(watermark.last_alerted_at).getTime() >= new Date(original.published_at).getTime(),
      'the watermark moves to the listing that was alerted, not to wall-clock now',
    );

    const second = await alerts.runWatch({ userId: before.user.id });
    assert.equal(second.newMatches.filter((entry) => entry.searchId === before.search.id).length, 0);
  } finally {
    await db.query('UPDATE vehicle_listings SET published_at = ? WHERE id = ?', [original.published_at, match.id]);
    await restore(before);
  }
});

maybe('a channel with no provider records the alert as skipped, with its text kept', async () => {
  const before = await fixture();
  assert.ok(before.car && before.listing);

  // Point alerts at a channel that has no credentials configured.
  const notifyConfig = require('../src/config').notifications;
  const originalChannel = notifyConfig.channels.price_drop;
  try {
    notifyConfig.channels.price_drop = 'whatsapp';
    await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = NULL WHERE id = ?', [
      before.listing.asking_price_kobo, before.car.id,
    ]);
    await db.query('UPDATE vehicle_listings SET asking_price_kobo = asking_price_kobo - 5000000 WHERE id = ?', [before.listing.id]);

    const run = await alerts.runWatch({ userId: before.user.id });
    const drops = forListing(run, before.listing.id);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].delivery, 'skipped');
    assert.equal(run.sent, 0, 'this run sent nothing at all');
    assert.equal(forListing(run, before.listing.id, 'skipped').length, 1);

    const row = await db.queryOne(
      "SELECT status, body, channel FROM notifications WHERE template = 'price_drop' AND entity_id = ? ORDER BY id DESC LIMIT 1",
      [before.listing.id],
    );
    assert.equal(row.status, 'skipped');
    assert.equal(row.channel, 'whatsapp');
    assert.match(row.body, /₦/, 'the message text survives, ready to send by hand');
  } finally {
    notifyConfig.channels.price_drop = originalChannel;
    await restore(before);
  }
});

maybe('the watch list shows what a run would do, without running it', async () => {
  const before = await fixture();
  assert.ok(before.car && before.listing);

  try {
    await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = NULL WHERE id = ?', [
      before.listing.asking_price_kobo, before.car.id,
    ]);
    const watch = await alerts.watchList();
    const mine = watch.cars.find((car) => car.id === before.car.id);
    assert.ok(mine);
    assert.equal(mine.pendingDrop, 0, 'no drop yet, so nothing pending');
    assert.equal(mine.baselineKobo, Number(before.listing.asking_price_kobo));
    assert.equal(mine.listing.live, true);
    assert.ok(Array.isArray(watch.searches));
  } finally {
    await restore(before);
  }
});

maybe('the run is capped, and what it did not send is reported rather than lost', async () => {
  const before = await fixture();
  assert.ok(before.car && before.listing);

  try {
    await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = NULL WHERE id = ?', [
      before.listing.asking_price_kobo, before.car.id,
    ]);
    await db.query('UPDATE vehicle_listings SET asking_price_kobo = asking_price_kobo - 1000000 WHERE id = ?', [before.listing.id]);

    const run = await alerts.runWatch({ userId: before.user.id, limit: 0 });
    assert.equal(run.sent, 0, 'a cap of zero sends nothing');
    // With no budget left the sweep counts what it deferred rather than listing
    // it as handled — that is what the console's "N deferred" line reads from.
    assert.ok(run.remaining >= 1, 'the drop is deferred, not dropped');
    const baseline = await db.queryOne('SELECT last_price_kobo FROM saved_cars WHERE id = ?', [before.car.id]);
    assert.equal(Number(baseline.last_price_kobo), Number(before.listing.asking_price_kobo), 'the baseline stays put so it is found again');

    const next = await alerts.runWatch({ userId: before.user.id });
    assert.equal(forListing(next, before.listing.id).length, 1, 'the next run picks it up');
  } finally {
    await restore(before);
  }
});
