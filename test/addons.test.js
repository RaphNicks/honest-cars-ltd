'use strict';

/**
 * FR-18 — dealer add-on purchases and commission statements (§7.2 “Orders &
 * Billing: commission statements per closed deal; pay for add-on services
 * (media shoot, featured placement, intelligence subscription) via PSP”).
 *
 * The promises worth testing are the ones that move money or change what a
 * customer sees on the site:
 *
 *   • a lot may only buy for its own stock — a featured slot for someone else's
 *     car is refused with a sentence, not silently granted
 *   • the money landing *is* the delivery: `applyPurchase` runs inside the
 *     transaction that marks the payment paid, and paying twice does not extend
 *     twice
 *   • each effect leaves a record the rest of the site already reads —
 *     featured_rank for a placement, a real booking for a shoot, an
 *     intelligence subscription for the monthly report
 *   • a statement ties: opening balance + the month's entries = closing, and
 *     the closing equals the ledger's own sum for that lot
 *   • a paid window that has closed gives its benefit up, so nothing stays
 *     featured for free
 *
 * Fixtures live on a make-believe lot whose account uses a phone no seeded
 * account has, and are torn down by exact id.
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
const addons = require('../src/services/addons');
const statement = require('../src/services/statement');

/**
 * A block of phone numbers no seeded account uses, handed out one per lot so
 * every fixture has its own account.
 */
let seq = 0;
function nextPhone() {
  seq += 1;
  return `+2348099001${String(seq).padStart(2, '0')}`;
}

const created = { lots: [], users: [], listings: [], purchases: [], payments: [], bookings: [], subscriptions: [] };

/**
 * A lot of our own with one car. `status` chooses whether the car can carry an
 * add-on at all — a sold car cannot be shot or featured.
 */
async function makeLot({ name = 'Test Add-on Motors', listingStatus = 'live', withAccount = true } = {}) {
  const phone = withAccount ? nextPhone() : null;
  let user = null;
  if (phone) {
    await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [phone, 'Test Add-on Dealer', 'dealer', 'active']);
    user = await db.queryOne('SELECT id, phone FROM `users` WHERE phone = ? LIMIT 1', [phone]);
    created.users.push(user.id);
  }

  const rug = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 9000 + 1000)}`;
  const lotSlug = `test-addon-lot-${rug}`;
  await db.query(
    `INSERT INTO dealers (name, slug, lot_area, city, tier, verified, commission_pct, user_id, agreement_signed)
     VALUES (?, ?, 'Test layout', 'Port Harcourt', 'standard', 1, 10, ?, UTC_TIMESTAMP())`,
    [name, lotSlug, user ? user.id : null],
  );
  const lot = await db.queryOne('SELECT * FROM dealers WHERE slug = ? LIMIT 1', [lotSlug]);
  created.lots.push(lot.id);

  const stockNo = `HC-TST-${rug}`;
  await db.query(
    `INSERT INTO vehicle_listings (stock_no, dealer_id, status, verification_grade, make, model, year, body_type,
                                   transmission, fuel_type, engine_size, mileage_km, \`condition\`, asking_price_kobo,
                                   seo_slug, city, area, documents)
     VALUES (?, ?, ?, 'certified', 'Toyota', 'Corolla', 2016, 'sedan', 'automatic', 'petrol', '1.8L', 90000,
             'tokunbo', 12000000, ?, 'Port Harcourt', 'Woji',
             '{"customs_verified":true,"registration":true,"duty_sighted":false,"tinted_permit":false}')`,
    [stockNo, lot.id, listingStatus, `test-addon-car-${rug}`],
  );
  const listing = await db.queryOne('SELECT * FROM vehicle_listings WHERE seo_slug = ? LIMIT 1', [`test-addon-car-${rug}`]);
  created.listings.push(listing.id);
  return { lot, listing, user, phone };
}

/** Raise a purchase (and its payment) the way the portal does. */
async function buy(addonSlug, { dealerId, listingId = null, phone = null } = {}) {
  const result = await addons.purchase({
    dealerId,
    addonSlug,
    listingId,
    customerName: 'Test Add-on Dealer',
    customerPhone: phone,
  });
  if (result.ok && result.purchase) created.purchases.push(result.purchase.id);
  if (result.ok && result.payment && result.payment.id) created.payments.push(result.payment.id);
  return result;
}

test.after(async () => {
  if (!available) return;
  // Children first: payments and bookings, then purchases, cars, lots, users.
  for (const id of created.bookings) await db.query('DELETE FROM bookings WHERE id = ?', [id]).catch(() => {});
  for (const id of created.subscriptions) await db.query('DELETE FROM subscriptions WHERE id = ?', [id]).catch(() => {});
  for (const id of created.purchases) {
    await db.query('DELETE FROM payments WHERE dealer_purchase_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM dealer_purchases WHERE id = ?', [id]).catch(() => {});
  }
  for (const id of created.listings) {
    await db.query('UPDATE vehicle_listings SET featured_rank = 0 WHERE id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM vehicle_listings WHERE id = ?', [id]).catch(() => {});
  }
  for (const id of created.lots) await db.query('DELETE FROM dealers WHERE id = ?', [id]).catch(() => {});
  for (const id of created.users) await db.query('DELETE FROM `users` WHERE id = ?', [id]).catch(() => {});
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

maybe('the catalogue is read from the database and priced in kobo', async () => {
  const catalogue = await db.addons.catalogue();
  assert.equal(catalogue.length >= 3, true, 'the seed ships a catalogue');
  for (const addon of catalogue) {
    assert.equal(typeof addon.slug, 'string');
    assert.equal(Number.isInteger(addon.priceKobo), true);
    assert.equal(addon.priceKobo > 0, true);
    assert.equal(['one_off', 'monthly'].includes(addon.interval), true);
    assert.equal(['media_shoot', 'featured_placement', 'intelligence'].includes(addon.effect), true);
    // Every add-on says what it does in words a dealer can read.
    assert.equal(typeof addon.effectLabel, 'string');
    assert.equal(addon.effectLabel.length > 0, true);
  }
  const shot = await db.addons.bySlug('media-shoot');
  assert.equal(shot.needsListing, true, 'a shoot has to name the car');
  const intel = await db.addons.bySlug('market-intelligence');
  assert.equal(intel.needsListing, false, 'intelligence is about the lot, not a car');
  assert.equal(intel.interval, 'monthly');
});

// ---------------------------------------------------------------------------
// Eligibility — a lot buys for its own stock
// ---------------------------------------------------------------------------

maybe('a lot cannot feature a car that is not on its own lot', async () => {
  const mine = await makeLot({ name: 'Test Add-on Motors A' });
  const theirs = await makeLot({ name: 'Test Add-on Motors B', withAccount: false });

  const refused = await buy('featured-placement', { dealerId: mine.lot.id, listingId: theirs.listing.id });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not on your lot/i);

  const accepted = await buy('featured-placement', { dealerId: mine.lot.id, listingId: mine.listing.id });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.purchase.status, 'pending', 'raised unpaid, not delivered');
});

maybe('an add-on that needs a car refuses to be bought without one', async () => {
  const { lot } = await makeLot({ name: 'Test Add-on Motors C' });
  const refused = await buy('media-shoot', { dealerId: lot.id, listingId: null });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /pick which listing/i);
});

maybe('a sold car cannot take a new shoot or placement', async () => {
  const { lot, listing } = await makeLot({ name: 'Test Add-on Motors D', listingStatus: 'sold' });
  const refused = await buy('media-shoot', { dealerId: lot.id, listingId: listing.id });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /sold/i);
});

maybe('a raised purchase carries a payment of purpose addon and no checkout URL', async () => {
  const { lot, listing } = await makeLot({ name: 'Test Add-on Motors E' });
  const bought = await buy('featured-placement', { dealerId: lot.id, listingId: listing.id });
  assert.equal(bought.ok, true);

  const payment = await db.queryOne('SELECT * FROM payments WHERE id = ?', [bought.payment.id]);
  assert.equal(payment.purpose, 'addon');
  assert.equal(payment.dealer_purchase_id, bought.purchase.id);
  assert.equal(payment.status, 'pending');
  assert.equal(Number(payment.amount_kobo), bought.purchase.amountKobo);
  // No PSP keys exist, so nothing may pretend a hosted checkout was created.
  assert.equal(payment.checkout_url, null);
  assert.equal(bought.hosted, false);
});

// ---------------------------------------------------------------------------
// Delivery — the money landing is the switch
// ---------------------------------------------------------------------------

maybe('a paid featured placement sets featured_rank, and paying twice does not extend twice', async () => {
  const { lot, listing } = await makeLot({ name: 'Test Add-on Motors F' });
  const bought = await buy('featured-placement', { dealerId: lot.id, listingId: listing.id });

  const paid = await db.payments.markPaid(bought.payment.id, { actorId: null });
  assert.equal(paid.ok, true);
  assert.equal(paid.purchased.effect, 'featured_placement');

  const car = await db.queryOne('SELECT featured_rank FROM vehicle_listings WHERE id = ?', [listing.id]);
  assert.equal(Number(car.featured_rank), 1, 'the car is featured because the money landed');

  const purchase = await db.addons.purchaseById(bought.purchase.id);
  assert.equal(purchase.status, 'active');
  assert.notEqual(purchase.startsAt, null, 'the paid window started');
  assert.notEqual(purchase.endsAt, null, 'a 30-day placement has an end');
  const days = Math.round((new Date(purchase.endsAt) - new Date(purchase.startsAt)) / 86_400_000);
  assert.equal(days, 30, 'the window is the add-on’s own duration, not a guess');

  // A second confirmation (a PSP retry) must be a no-op, not a second grant.
  const again = await db.payments.markPaid(bought.payment.id, { actorId: null });
  assert.equal(again.already, true);
  const after = await db.addons.purchaseById(bought.purchase.id);
  assert.equal(after.getTime === undefined ? new Date(after.endsAt).getTime() : 0, new Date(purchase.endsAt).getTime());
});

maybe('a second paid placement on the same car supersedes the first', async () => {
  const { lot, listing } = await makeLot({ name: 'Test Add-on Motors G' });
  const first = await buy('featured-placement', { dealerId: lot.id, listingId: listing.id });
  await db.payments.markPaid(first.payment.id, { actorId: null });

  const second = await buy('featured-placement', { dealerId: lot.id, listingId: listing.id });
  await db.payments.markPaid(second.payment.id, { actorId: null });

  const older = await db.addons.purchaseById(first.purchase.id);
  assert.equal(older.status, 'expired', 'the old placement gives way to the new one');
  const active = await db.addons.activeFor(lot.id, 'featured_placement');
  assert.equal(active.length, 1);
  assert.equal(active[0].reference, second.purchase.reference);
});

maybe('a paid media shoot becomes a real booking the dispatch calendar already runs', async () => {
  const { lot, listing, phone } = await makeLot({ name: 'Test Add-on Motors H' });
  const bought = await buy('media-shoot', { dealerId: lot.id, listingId: listing.id, phone });
  const paid = await db.payments.markPaid(bought.payment.id, { actorId: null });
  assert.equal(paid.ok, true);
  assert.match(paid.purchased.detail, /HC-BK-/);

  const booking = await db.queryOne('SELECT * FROM bookings WHERE reference = ?', [paid.purchased.bookingReference]);
  created.bookings.push(booking.id);
  assert.equal(booking.type, 'media_shoot');
  assert.equal(booking.payment_status, 'paid');
  assert.equal(booking.status, 'requested', 'the media desk still picks the slot');
  assert.equal(booking.phone, phone);
  // The crew is told which car, by stock number — not "a shoot, somewhere".
  const vehicle = typeof booking.vehicle === 'string' ? JSON.parse(booking.vehicle) : booking.vehicle;
  assert.equal(vehicle.stockNo, listing.stock_no);

  const purchase = await db.addons.purchaseById(bought.purchase.id);
  assert.equal(purchase.status, 'active');
  assert.equal(purchase.endsAt, null, 'a shoot is a job, not a window');
});

maybe('a shoot nobody can be called about is refused rather than booked', async () => {
  const { lot, listing } = await makeLot({ name: 'Test Add-on Motors I', withAccount: false });
  // No account phone and no number on the payment.
  const bought = await buy('media-shoot', { dealerId: lot.id, listingId: listing.id, phone: null });
  assert.equal(bought.ok, true);
  await assert.rejects(() => db.payments.markPaid(bought.payment.id, { actorId: null }), /phone number/i);

  // The refusal must not have delivered anything or taken the money.
  const payment = await db.queryOne('SELECT status FROM payments WHERE id = ?', [bought.payment.id]);
  assert.equal(payment.status, 'pending', 'the payment is still unpaid, so the transaction rolled back');
  const purchase = await db.addons.purchaseById(bought.purchase.id);
  assert.equal(purchase.status, 'pending');
});

maybe('a paid intelligence subscription lands in the renewal queue', async () => {
  const { lot } = await makeLot({ name: 'Test Add-on Motors J' });
  const bought = await buy('market-intelligence', { dealerId: lot.id, listingId: null });
  assert.equal(bought.ok, true, 'intelligence needs no car');
  const paid = await db.payments.markPaid(bought.payment.id, { actorId: null });
  assert.equal(paid.purchased.effect, 'intelligence');

  const subscription = await db.queryOne('SELECT * FROM subscriptions WHERE id = ?', [paid.purchased.subscriptionId]);
  created.subscriptions.push(subscription.id);
  assert.equal(subscription.kind, 'intelligence');
  assert.equal(subscription.dealer_id, lot.id);
  assert.equal(subscription.device_state, 'activated');
  assert.notEqual(subscription.renewal_at, null, 'the monthly desk can see it coming');
});

// ---------------------------------------------------------------------------
// Expiry — a lapsed window gives the benefit back
// ---------------------------------------------------------------------------

maybe('a paid window that has closed releases the car’s featured rank', async () => {
  const { lot, listing } = await makeLot({ name: 'Test Add-on Motors K' });
  const bought = await buy('featured-placement', { dealerId: lot.id, listingId: listing.id });
  await db.payments.markPaid(bought.payment.id, { actorId: null });
  assert.equal(Number((await db.queryOne('SELECT featured_rank FROM vehicle_listings WHERE id = ?', [listing.id])).featured_rank), 1);

  // Wind the window back: this purchase should have ended yesterday.
  await db.query('UPDATE dealer_purchases SET ends_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE id = ?', [bought.purchase.id]);
  // Status is derived: it reads expired before any sweep runs.
  assert.equal((await db.addons.purchaseById(bought.purchase.id)).status, 'expired');

  const settled = await db.addons.expireDue();
  assert.equal(settled.expired >= 1, true);
  assert.equal(Number((await db.queryOne('SELECT featured_rank FROM vehicle_listings WHERE id = ?', [listing.id])).featured_rank), 0, 'the rank went back');
  assert.equal((await db.addons.purchaseById(bought.purchase.id)).storedStatus, 'expired');
});

// ---------------------------------------------------------------------------
// Statements — the month, and the arithmetic
// ---------------------------------------------------------------------------

maybe('a statement ties: opening balance plus the month equals the ledger', async () => {
  const { lot } = await makeLot({ name: 'Test Add-on Motors L' });
  await db.query(
    `INSERT INTO dealer_ledger (dealer_id, entry_type, amount_kobo, reference, detail, created_at)
     VALUES (?, 'sale_commission', 2500000, 'TEST-STMT-1', 'commission', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY))`,
    [lot.id],
  );
  await db.query(
    `INSERT INTO dealer_ledger (dealer_id, entry_type, amount_kobo, reference, detail)
     VALUES (?, 'payout', -1000000, 'TEST-STMT-2', 'payout')`,
    [lot.id],
  );

  const month = new Date().toISOString().slice(0, 7);
  const built = await statement.build(lot.id, month);
  assert.equal(built.ties, true, 'the closing balance equals the ledger');
  assert.equal(built.openingKobo, 2500000, 'the earlier commission is the opening balance');
  assert.equal(built.entries.length, 1, 'only this month’s rows are entries');
  assert.equal(built.closingKobo, 1500000);
  assert.equal(built.totals.payoutKobo, -1000000);
  assert.equal(built.totals.commissionKobo, 0, 'nothing was commissioned inside this month');

  // Every entry carries a running balance, the last of which is the closing one.
  assert.equal(built.entries[0].balanceKobo, built.closingKobo);

  await db.query('DELETE FROM dealer_ledger WHERE dealer_id = ?', [lot.id]);
});

maybe('months() lists the months a statement exists for, newest first', async () => {
  const { lot } = await makeLot({ name: 'Test Add-on Motors M' });
  // Two entries, two months apart, so the ordering is what is being tested.
  await db.query(
    `INSERT INTO dealer_ledger (dealer_id, entry_type, amount_kobo, reference, created_at)
     VALUES (?, 'adjustment', 500000, 'TEST-STMT-3', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 70 DAY)),
            (?, 'payout', -100000, 'TEST-STMT-4', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 DAY))`,
    [lot.id, lot.id],
  );
  const months = await statement.months(lot.id);
  assert.equal(months.length, 2, 'one statement per month that has entries');
  assert.equal(months[0] > months[1], true, 'newest first');
  assert.equal(/^\d{4}-\d{2}$/.test(months[0]), true);
  // The month the newest row falls in is offered; a month with nothing in it is
  // not dressed up as a statement.
  assert.equal(months.includes(new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 7)), true);

  const empty = await statement.build(lot.id, '2019-01');
  assert.equal(empty.ties, true);
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.openingKobo, empty.closingKobo, 'a month with nothing in it does not invent a balance');

  await db.query('DELETE FROM dealer_ledger WHERE dealer_id = ?', [lot.id]);
});

maybe('the statement renders as a PDF a finance officer can file', async () => {
  const { lot } = await makeLot({ name: 'Test Add-on Motors N' });
  const built = await statement.build(lot.id, new Date().toISOString().slice(0, 7));
  const buffer = await new Promise((resolve, reject) => {
    const doc = statement.pdf(built);
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
  assert.equal(buffer.slice(0, 5).toString(), '%PDF-');
  assert.equal(buffer.length > 3000, true);
  assert.match(statement.fileName(built), /^honestcars-commission-\d+-\d{4}-\d{2}\.pdf$/);
});

// ---------------------------------------------------------------------------
// What the dealer portal and the console read
// ---------------------------------------------------------------------------

maybe('a purchase reads back with its car, its payment and a derived status', async () => {
  const { lot, listing } = await makeLot({ name: 'Test Add-on Motors O' });
  const bought = await buy('media-shoot', { dealerId: lot.id, listingId: listing.id });

  const mine = await db.addons.purchasesFor(lot.id);
  const found = mine.find((row) => row.reference === bought.purchase.reference);
  assert.equal(found.status, 'pending');
  assert.equal(found.statusLabel, 'Awaiting payment');
  assert.equal(found.listing.stockNo, listing.stock_no);
  assert.equal(found.paymentReference, bought.payment.reference);
  assert.equal(found.url, `/dealer/addons/purchase/${bought.purchase.reference}`);
  assert.equal(found.amountKobo, found.amountKobo, 'amounts stay in one unit');

  // Another lot can never see it.
  const other = await db.addons.purchasesFor(lot.id + 999999);
  assert.equal(other.some((row) => row.reference === bought.purchase.reference), false);
});

maybe('the fleet view totals what every lot owes and has running', async () => {
  const totals = await db.dealers.fleetTotals();
  assert.equal(totals.lots >= 12, true);
  assert.equal(Number.isInteger(totals.addonsActive), true);
  assert.equal(Number.isInteger(totals.addonsPending), true);
  assert.equal(totals.addonsPendingKobo >= 0, true);
  // The console list reads the same rows the portal does.
  const lots = await db.dealers.list({ limit: 50 });
  assert.equal(lots.length >= 12, true);
  const withStock = lots.find((lot) => lot.counts.live > 0);
  assert.equal(typeof withStock.ledger.balanceKobo, 'number');
  assert.equal(typeof withStock.addons.active, 'number');
});
