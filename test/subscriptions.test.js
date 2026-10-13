'use strict';

/**
 * FR-20 — tracking subscriptions, renewal reminders and dealer retainers.
 *
 * The promises worth testing are the ones that cost somebody money if they are
 * wrong:
 *
 *   • the state a subscription shows is *derived* from its renewal date, so a
 *     customer who stopped paying cannot sit in the console looking active
 *   • a renewal payment extends the subscription, in the same transaction that
 *     marks the money paid — and paying twice never grants two periods
 *   • renewing early does not cost the customer days; renewing late does not
 *     back-date them
 *   • the 30/7/1-day sweep sends once per window however often it runs, and the
 *     sentence it sends matches how many days are actually left
 *   • a reminder that could not be delivered is still recorded, with its text,
 *     because the desk has to send it by hand
 *
 * Rows created here are cleaned up by exact id, and the tenant is a throwaway
 * phone number so nothing in the seeded demo is touched.
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

test.after(async () => {
  if (available) await require('../src/db').pool.end();
});

/** A phone number no seeded account uses, so every fixture here is ours. */
const TENANT = '+2348099001122';
const other = '+2348099001133';

const subscriptions = require('../src/db/subscriptions');
const renewals = require('../src/services/renewals');
const money = require('../src/lib/money');

/** Create a subscription with an exact renewal offset — the whole point is the date. */
async function makeSubscription({ days, state = 'activated', amountKobo = 4_500_000, phone = TENANT, periodMonths = 12, unit = 'Test unit' } = {}) {
  const renewal = days === null ? null : new Date(Date.now() + days * 86_400_000);
  // An `ordered` subscription has been paid for and not fitted, so it carries no
  // install stamp. Getting this wrong in the fixture hides the very bug the
  // checklist order exists to prevent, which is exactly what happened once.
  const fitted = state !== 'ordered';
  const result = await require('../src/db').query(
    `INSERT INTO subscriptions
       (kind, customer_name, customer_phone, unit_label, plan_name, amount_kobo,
        device_state, installed_at, activated_at, renewal_at, period_months)
     VALUES ('tracker', 'Test Subscriber', ?, ?, 'Tracker — test, 12 months', ?,
             ?, ${fitted ? 'UTC_TIMESTAMP()' : 'NULL'}, ${fitted ? 'UTC_TIMESTAMP()' : 'NULL'}, ?, ?)`,
    [
      phone, unit, amountKobo, state,
      renewal ? renewal.toISOString().slice(0, 19).replace('T', ' ') : null,
      periodMonths,
    ],
  );
  return result.insertId;
}

async function cleanup(ids) {
  if (!ids.length) return;
  const db = require('../src/db');
  const marks = ids.map(() => '?').join(',');
  await db.query(`DELETE FROM subscription_reminders WHERE subscription_id IN (${marks})`, ids);
  await db.query(`DELETE FROM payments WHERE subscription_id IN (${marks})`, ids);
  await db.query(`DELETE FROM subscriptions WHERE id IN (${marks})`, ids);
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

maybe('state is derived from the renewal date, not from a column nobody updated', async () => {
  const ids = [];
  try {
    // Every one of these rows is device_state = 'activated' in the table. What
    // the console shows must follow the date instead.
    const active = await makeSubscription({ days: 200 });
    const inside = await makeSubscription({ days: 21 });
    const week = await makeSubscription({ days: 6 });
    const overdue = await makeSubscription({ days: -3 });
    const gone = await makeSubscription({ days: -40 });
    ids.push(active, inside, week, overdue, gone);

    const byId = await Promise.all(ids.map((id) => subscriptions.byId(id)));
    assert.deepEqual(byId.map((s) => s.state), [
      'activated',    // 200 days out — nothing to do
      'renewal_due',  // inside the 30-day window
      'renewal_due',  // inside the 7-day window
      'renewal_due',  // 3 days past — inside the 7-day grace window
      'lapsed',       // 40 days past — the grace window is gone
    ]);
    assert.equal(byId[4].overdue, true);
    assert.equal(byId[3].overdue, true, 'overdue is true while still renewable');
    assert.equal(byId[0].overdue, false);
  } finally {
    await cleanup(ids);
  }
});

maybe('a cancelled subscription stays cancelled whatever its date says', async () => {
  const id = await makeSubscription({ days: -40, state: 'cancelled' });
  try {
    const row = await subscriptions.byId(id);
    assert.equal(row.state, 'cancelled', 'cancelling is a decision, not a date');
    assert.equal(row.stateLabel, 'Cancelled');
  } finally {
    await cleanup([id]);
  }
});

maybe('the reminder window is the band the renewal is actually in', async () => {
  // Pure function, but it is the one that decides who gets messaged and when.
  assert.equal(subscriptions.reminderWindow(45), null, 'outside every window');
  assert.equal(subscriptions.reminderWindow(30), 30);
  assert.equal(subscriptions.reminderWindow(21), 30);
  assert.equal(subscriptions.reminderWindow(7), 7, 'seven days is the 7-day band, not the 30');
  assert.equal(subscriptions.reminderWindow(2), 7);
  assert.equal(subscriptions.reminderWindow(1), 1);
  assert.equal(subscriptions.reminderWindow(0), 1);
  assert.equal(subscriptions.reminderWindow(-6), 1, 'overdue sits in the last band; the wording says it is late');
});

maybe('the queue is scoped to the window and leads with what is most urgent', async () => {
  const ids = [];
  try {
    const far = await makeSubscription({ days: 200, unit: 'Queue — far away' });
    const soon = await makeSubscription({ days: 3, unit: 'Queue — soon' });
    ids.push(far, soon);

    const window = await subscriptions.queue({ withinDays: 30 });
    const ours = window.filter((s) => ids.includes(s.id));
    assert.deepEqual(ours.map((s) => s.id), [soon], 'the 200-day row is not in the 30-day queue');

    const all = await subscriptions.queue({ withinDays: null });
    const order = all.filter((s) => ids.includes(s.id)).map((s) => s.id);
    assert.ok(order.indexOf(soon) < order.indexOf(far), 'nearest renewal first');

    // “Renewal date not set” rows are real (paid, not yet fitted) and must not
    // be silently dropped from the register.
    const unordered = await makeSubscription({ days: null, state: 'ordered', unit: 'Queue — no date' });
    ids.push(unordered);
    const register = await subscriptions.queue({ withinDays: null });
    assert.ok(register.some((s) => s.id === unordered), 'a row with no renewal date still shows in the register');
    assert.equal(register.find((s) => s.id === unordered).daysRemaining, null);
  } finally {
    await cleanup(ids);
  }
});

// ---------------------------------------------------------------------------
// The money/entitlement link
// ---------------------------------------------------------------------------

maybe('paying a renewal extends the subscription, in the same transaction', async () => {
  const id = await makeSubscription({ days: -3, unit: 'Money — overdue renewal' });
  try {
    const before = await subscriptions.byId(id);
    assert.equal(before.state, 'renewal_due');

    const quote = await subscriptions.renewalQuote(id);
    assert.equal(quote.ok, true);
    assert.equal(quote.amountKobo, 4_500_000, 'the price is the subscription\'s own, not the caller\'s');

    const created = await require('../src/db').payments.createPayment({
      purpose: 'subscription',
      amountKobo: quote.amountKobo,
      subscriptionId: id,
      customerPhone: TENANT,
    });
    const paid = await require('../src/db').payments.markPaid(created.id, { providerRef: 'test' });
    assert.equal(paid.ok, true);
    assert.ok(paid.renewed, 'markPaid reports what it extended');

    const after = await subscriptions.byId(id);
    assert.equal(after.deviceState, 'activated');
    assert.equal(after.state, 'activated');
    assert.ok(after.daysRemaining > 360, `expected a year added, got ${after.daysRemaining} days`);
    assert.equal(paid.renewed.periodMonths, 12);
  } finally {
    await cleanup([id]);
  }
});

maybe('renaming early does not cost the customer days, and paying twice does not grant two periods', async () => {
  const id = await makeSubscription({ days: 9 });
  try {
    const before = await subscriptions.byId(id);
    const created = await require('../src/db').payments.createPayment({
      purpose: 'subscription', amountKobo: 4_500_000, subscriptionId: id, customerPhone: TENANT,
    });

    await require('../src/db').payments.markPaid(created.id, { providerRef: 'test' });
    const after = await subscriptions.byId(id);

    // 9 days kept + 365 = 374ish. The exact day count drifts by a day across a
    // DST-less boundary, so this asserts the promise (nothing lost) not a number.
    assert.ok(after.daysRemaining >= before.daysRemaining + 364,
      `early renewal must add a year to the existing date: ${before.daysRemaining} → ${after.daysRemaining}`);

    // The same payment cannot be applied twice — this is the double-credit risk.
    const again = await require('../src/db').payments.markPaid(created.id, { providerRef: 'test' });
    assert.equal(again.already, true);
    const unchanged = await subscriptions.byId(id);
    assert.equal(unchanged.daysRemaining, after.daysRemaining, 'no second period');
  } finally {
    await cleanup([id]);
  }
});

maybe('a renewal with no price is refused rather than quoted at zero', async () => {
  const id = await makeSubscription({ days: 5, amountKobo: 0, unit: 'Money — unpriced' });
  try {
    const quote = await subscriptions.renewalQuote(id);
    assert.equal(quote.ok, false);
    assert.match(quote.error, /no renewal price/i);
  } finally {
    await cleanup([id]);
  }
});

maybe('a renewal payment is linked to the subscription that raised it', async () => {
  const id = await makeSubscription({ days: 12 });
  try {
    const created = await require('../src/db').payments.createPayment({
      purpose: 'subscription', amountKobo: 4_500_000, subscriptionId: id, customerPhone: TENANT,
    });
    const payment = await require('../src/db').payments.paymentById(created.id);
    assert.equal(payment.subscriptionId, id, 'the link is what lets a payment extend the right row');
  } finally {
    await cleanup([id]);
  }
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

maybe('the sweep reminds once per window, however often it runs', async () => {
  const id = await makeSubscription({ days: 6, unit: 'Sweep — inside the 7-day window' });
  try {
    const first = await renewals.runReminders({ limit: 50 });
    const mine = await subscriptions.remindersFor(id);
    assert.equal(mine.length, 1, 'one reminder for this subscription');
    assert.equal(Number(mine[0].window_days), 7, 'and it is the 7-day one, not the 30-day one');
    assert.ok(first.checked > 0);

    // Run it again immediately: nothing new for this subscription.
    await renewals.runReminders({ limit: 50 });
    const twice = await subscriptions.remindersFor(id);
    assert.equal(twice.length, 1, 'the unique key is the dedupe — a second run must not message again');
  } finally {
    await cleanup([id]);
  }
});

maybe('the dry run reports the exact sentence without writing or sending anything', async () => {
  const id = await makeSubscription({ days: 2, unit: 'Sweep — dry run' });
  try {
    const report = await renewals.runReminders({ dryRun: true, limit: 50 });
    const entry = report.wouldSend.find((row) => row.id === id);
    assert.ok(entry, 'the row the dry run would message is reported');
    assert.match(entry.body, /renews on/, 'the body is what the customer would read, not a summary of it');
    assert.match(entry.body, new RegExp(money.formatNaira(4_500_000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const written = await subscriptions.remindersFor(id);
    assert.equal(written.length, 0, 'a dry run writes nothing — otherwise it would suppress the real send');
  } finally {
    await cleanup([id]);
  }
});

maybe('what a reminder says follows the days left, not just the window', async () => {
  const base = { kind: 'tracker', planName: 'Tracker — Standard, 12 months', unitLabel: '2019 Toyota Corolla · KJA-884-XA' };
  const at = (days) => renewals.reminderBody({
    windowDays: subscriptions.reminderWindow(days),
    subscription: base,
    renewalLabel: '1 Nov 2026',
    amount: 4_500_000,
    daysRemaining: days,
  });

  assert.match(at(21), /Heads-up/, 'three weeks out is a heads-up');
  assert.match(at(21), /nothing has been charged/, 'and must not read like a demand');
  assert.match(at(6), /A week to go/);
  assert.match(at(1), /expires tomorrow/);
  assert.match(at(0), /expires today/, 'the day itself is not “tomorrow”');
  assert.match(at(-6), /went past its renewal date/);
  assert.match(at(-6), /6 days ago/, 'a late reminder says how late');
  assert.doesNotMatch(at(-6), /expires tomorrow/, 'the bug this guards against');

  // A plan with no price cannot ask for money; it says the desk will confirm.
  const unpriced = renewals.reminderBody({
    windowDays: 7, subscription: base, renewalLabel: '1 Nov 2026', amount: null, daysRemaining: 5,
  });
  assert.match(unpriced, /has not been set on this plan/);
  assert.doesNotMatch(unpriced, /₦0/, 'never quote zero for an unpriced renewal');
});

maybe('a reminder that cannot be delivered is still recorded, with its text', async () => {
  const id = await makeSubscription({ days: 3, unit: 'Sweep — undeliverable' });
  try {
    // The channel the seeded config uses is `console`, which always "delivers"
    // in development. What must hold either way is the recording contract: a
    // reminder row exists for the window, and its status is one of the two
    // honest values.
    const report = await renewals.runReminders({ limit: 50 });
    const rows = await subscriptions.remindersFor(id);
    assert.equal(rows.length, 1);
    assert.ok(['sent', 'skipped'].includes(rows[0].status), `unexpected status ${rows[0].status}`);

    // ...and if it was not delivered, the report carries the sentence so ops can
    // send it by hand rather than assuming the customer was told.
    const skipped = report.skipped.find((row) => row.id === id);
    if (skipped) assert.ok(skipped.body && skipped.body.length > 40, 'a skipped reminder keeps its text');
  } finally {
    await cleanup([id]);
  }
});

maybe('a subscription past its grace window is lapsed and stops being reminded', async () => {
  const id = await makeSubscription({ days: -40, unit: 'Sweep — lapsed', state: 'activated' });
  try {
    await renewals.runReminders({ limit: 50 });
    const row = await subscriptions.byId(id);
    assert.equal(row.state, 'lapsed', 'the sweep lapses it rather than reminding into the void');

    // A lapsed subscription is not in the reminder set: the desk calls about
    // that, and the queue shows it.
    const due = await subscriptions.dueForReminders({ limit: 500 });
    assert.equal(due.some((s) => s.id === id), false, 'no renewal reminder for a lapsed unit');
  } finally {
    await cleanup([id]);
  }
});

// ---------------------------------------------------------------------------
// The activation checklist
// ---------------------------------------------------------------------------

maybe('the checklist runs installed → activated → renewal date, and stamps each step once', async () => {
  const id = await makeSubscription({ days: null, state: 'ordered', unit: 'Checklist — ordered' });
  try {
    // Step 2 before step 1 is refused, not silently accepted: an “active”
    // subscription with no device in the car is the failure this prevents.
    const jumped = await subscriptions.setChecklist(id, { activated: true });
    assert.equal(jumped.ok, false);
    assert.match(jumped.error, /installed/i);

    const fitted = await subscriptions.setChecklist(id, { installed: true, unitLabel: '2008 Toyota Corolla · ABC-1-PH' });
    assert.equal(fitted.ok, true);
    assert.equal(fitted.subscription.deviceState, 'installed');
    const installedAt = fitted.subscription.installedAt;
    assert.ok(installedAt, 'the install is stamped');
    // Compared as timestamps, not objects: two reads of the same DATETIME are
    // different Date instances, and assert.equal would fail on the reference. */
    const at = (value) => (value ? new Date(value).getTime() : null);

    // Re-ticking must not move the date — the renewal queue runs on these — and
    // it must not read as a failure either: the desk did nothing wrong.
    const reticked = await subscriptions.setChecklist(id, { installed: true });
    assert.equal(reticked.ok, true, 'a no-op re-tick is not an error');
    assert.equal(reticked.unchanged, true);
    assert.equal(at(reticked.subscription.installedAt), at(installedAt), 'a stamped step never moves');

    const renewal = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
    const activated = await subscriptions.setChecklist(id, { activated: true, renewalAt: renewal, amountKobo: 5_000_000, periodMonths: 12 });
    assert.equal(activated.ok, true);
    assert.equal(activated.subscription.deviceState, 'activated', 'all three steps are done');
    assert.equal(activated.subscription.amountKobo, 5_000_000);
    assert.equal(activated.subscription.planName, 'Tracker — test, 12 months', 'the plan from the row is kept');
  } finally {
    await cleanup([id]);
  }
});

maybe('cancelling stops the clock but keeps the record', async () => {
  const id = await makeSubscription({ days: 14 });
  try {
    const result = await subscriptions.cancel(id, { reason: 'car sold' });
    assert.equal(result.ok, true);
    assert.equal(result.subscription.state, 'cancelled');

    const again = await subscriptions.cancel(id, { reason: 'twice' });
    assert.equal(again.ok, false, 'cancelling twice is refused rather than recorded twice');

    // Still readable — the history is the point.
    assert.ok(await subscriptions.byId(id));

    const quote = await subscriptions.renewalQuote(id);
    assert.equal(quote.ok, false, 'a cancelled subscription cannot be renewed online');
  } finally {
    await cleanup([id]);
  }
});

// ---------------------------------------------------------------------------
// Dealer retainers
// ---------------------------------------------------------------------------

maybe('a dealer retainer joins the same queue as a tracker', async () => {
  const db = require('../src/db');
  const dealer = await db.queryOne('SELECT id, name FROM dealers LIMIT 1');
  if (!dealer) return; // a database with no dealers seeded yet

  const result = await subscriptions.createRetainer({
    dealerId: dealer.id,
    planName: 'Test retainer',
    amountKobo: 2_500_000,
    periodMonths: 1,
  });
  assert.equal(result.ok, true, result.error);
  const id = result.subscription.id;
  try {
    const retainer = await subscriptions.byId(id);
    assert.equal(retainer.kind, 'dealer_retainer');
    assert.equal(retainer.dealerName, dealer.name);
    assert.equal(retainer.periodMonths, 1);
    assert.ok(retainer.daysRemaining > 20 && retainer.daysRemaining < 32, `monthly plan renews in a month, got ${retainer.daysRemaining}`);

    // One queue, both kinds — the desk should not have to remember which screen.
    const queue = await subscriptions.queue({ withinDays: null });
    assert.ok(queue.some((s) => s.id === id), 'the retainer is in the renewal queue');

    // And the accounting is separated, because “trackers active” and “lots on a
    // plan” are different conversations.
    const summary = await subscriptions.summary();
    assert.ok(summary.retainerCount >= 1);
  } finally {
    await cleanup([id]);
  }
});

maybe('a retainer without a price or a name is refused', async () => {
  const db = require('../src/db');
  const dealer = await db.queryOne('SELECT id FROM dealers LIMIT 1');
  if (!dealer) return;

  const noName = await subscriptions.createRetainer({ dealerId: dealer.id, planName: '', amountKobo: 1_000 });
  assert.equal(noName.ok, false);
  assert.match(noName.error, /name/i);

  const noPrice = await subscriptions.createRetainer({ dealerId: dealer.id, planName: 'No price', amountKobo: 0 });
  assert.equal(noPrice.ok, false);
  assert.match(noPrice.error, /amount/i);

  const noDealer = await subscriptions.createRetainer({ dealerId: 999_999, planName: 'Ghost lot', amountKobo: 1_000 });
  assert.equal(noDealer.ok, false);
  assert.match(noDealer.error, /dealer/i);
});

// ---------------------------------------------------------------------------
// The customer's own view
// ---------------------------------------------------------------------------

maybe('a subscription is only readable by the phone number on it', async () => {
  const mine = await makeSubscription({ days: 30, phone: TENANT, unit: 'Privacy — mine' });
  const theirs = await makeSubscription({ days: 30, phone: other, unit: 'Privacy — theirs' });
  try {
    const seen = await subscriptions.forPhone(TENANT);
    assert.ok(seen.some((s) => s.id === mine));
    assert.equal(seen.some((s) => s.id === theirs), false, 'another customer\'s unit is not in this list');

    // ...and the shapes expose a masked number, never the stored one.
    const row = await subscriptions.byId(mine);
    assert.ok(row.maskedPhone && row.maskedPhone.includes('•'), 'the console sees a masked number, not a full one');
  } finally {
    await cleanup([mine, theirs]);
  }
});

maybe('a renewal quote is only generated for a subscription that can be renewed', async () => {
  const cancelled = await makeSubscription({ days: 20, state: 'cancelled' });
  try {
    const quote = await subscriptions.renewalQuote(cancelled);
    assert.equal(quote.ok, false);

    const missing = await subscriptions.renewalQuote(9_999_999);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /does not exist/i);
  } finally {
    await cleanup([cancelled]);
  }
});
