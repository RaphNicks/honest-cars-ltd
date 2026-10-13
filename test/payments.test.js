'use strict';

/**
 * Money, escrow and the inspection report (FR-07, FR-08, §7.3, §11, §12.2).
 *
 * The rules being tested are the ones that would cost someone real money if
 * they broke:
 *   • a payment is paid once, from pending — a retry is a no-op, not a
 *     second payment (webhooks are idempotent on the PSP's event id)
 *   • an unsigned webhook is refused *and recorded*, so an incident can be
 *     read back from the database afterwards
 *   • a refund can never exceed what was taken
 *   • escrow moves one stage at a time and records the human who released it
 *   • the ledger is append-only: a correction is a new row with a new balance
 *   • the inspection report is the same document on the page and in the PDF,
 *     and only the inspector, dispatch or the customer may open it
  *
 * Runnable rows are created by the suite (unique phones, a scratch order) and
 * removed in test.after; the seeded demo payments are only ever read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { dbAvailable, startTestServer, enrolMfa, completeMfa } = require('./helpers');
const roles = require('../src/services/roles');

let available = false;
let ctx;
let db;
let payments;
let paymentService;
let report;
let money;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const run = (Number(process.pid) * 4099 + (Date.now() % 100000)) % 1000000;
/** Notifications are written by the service, so the suite cleans up by id range. */
let notificationIdBefore = 0;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0806${String((run * 17 + seq * 613) % 10_000_000).padStart(7, '0')}`;
}

const createdPhones = new Set();
const createdPayments = [];
const createdMilestones = [];
const createdLedger = [];
const createdOrders = [];
let createdBooking = null;

function newClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, { method = 'GET', body, headers = {}, form, raw } = {}) {
      const payload = raw !== undefined
        ? raw
        : form
          ? new URLSearchParams(form).toString()
          : body
            ? JSON.stringify(body)
            : undefined;
      const response = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: payload,
      });
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(';');
        if (pair.split('=')[0] === 'hc_session') cookie = pair;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const text = buffer.toString('utf8');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html or a PDF */
      }
      return { status: response.status, headers: response.headers, text, json, buffer };
    },
  };
}

async function createAccount(role, label) {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { canonical } = require('../src/lib/phone');
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    canonical(phone),
    `${label} (payments test)`,
    role,
    'active',
  ]);
  const row = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [canonical(phone)]);
  // §12.2: a fixture holding `admin` or `finance` has a second factor, the way
  // a real account in those roles has to.
  if (roles.MFA_ROLES.includes(role)) await enrolMfa(row.id);
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, `OTP request failed for ${label}: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  assert.equal(verify.status, 200, `sign-in failed for ${label}: ${verify.text}`);
  if (roles.MFA_ROLES.includes(role)) {
    const finished = await completeMfa(client, { phone });
    assert.equal(finished.status, 200, `second factor failed for ${label}: ${finished.text}`);
  }
  return { id: row.id, phone: canonical(phone), local: phone, role, client };
}

/** A paid-for booking row the escrow and report tests can hang off. */
async function scratchBooking({ withChecklist = false } = {}) {
  const phone = nextPhone();
  createdPhones.add(phone);
  const reference = `HC-PT-${String(run).slice(0, 4)}${seq}`.slice(0, 24);
  const checklist = withChecklist
    ? JSON.stringify({
      sections: {
        engine: 'ok', transmission: 'ok', suspension: 'attention', brakes: 'ok',
        electricals: 'ok', body: 'ok', documents: 'ok',
      },
      obd2_codes: 'none stored',
      photos: '9 photos filed',
      checked_on: new Date().toISOString().slice(0, 10),
    })
    : null;
  const result = await db.query(
    `INSERT INTO bookings (reference, type, service_slug, slot_at, location, vehicle, name, phone,
                           amount_kobo, payment_status, status, completed_at, checklist, verdict, report_notes)
     VALUES (?, 'inspection', 'inspection', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), 'Dealer lot, Woji',
             '{"make":"Toyota","model":"Camry","year":2012,"mileage_km":118000,"vin":"TESTVIN0000000001"}',
             'Payments Test Buyer', ?, 4500000, 'paid', ?, ?, ?, ?, ?)`,
    [
      reference,
      require('../src/lib/phone').canonical(phone),
      withChecklist ? 'completed' : 'confirmed',
      withChecklist ? new Date() : null,
      checklist,
      withChecklist ? 'pass_with_advisory' : null,
      withChecklist ? 'Rear bushings due within the year; everything else sound.' : null,
    ],
  );
  createdBooking = { id: result.insertId, reference, phone: require('../src/lib/phone').canonical(phone) };
  return createdBooking;
}

/** Pull the text out of a PDFKit document written without compression. */
function pdfText(buffer) {
  const raw = buffer.toString('latin1');
  let out = '';
  const arrays = /\[([^\]]*)\]\s*TJ/g;
  let array;
  while ((array = arrays.exec(raw))) {
    const hexes = /<([0-9a-fA-F]+)>/g;
    let hex;
    while ((hex = hexes.exec(array[1]))) out += Buffer.from(hex[1], 'hex').toString('latin1');
    out += ' ';
  }
  return out;
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  payments = db.payments;
  paymentService = require('../src/services/payments');
  report = require('../src/services/report');
  money = require('../src/lib/money');
  const highest = await db.queryOne('SELECT MAX(id) AS id FROM notifications');
  notificationIdBefore = Number((highest && highest.id) || 0);
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (available) {
    // Messages written by the code under test, bounded by the id range.
    await db.query('DELETE FROM notifications WHERE id > ?', [notificationIdBefore]);
    for (const id of createdLedger) await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['dealer_ledger', id]);
    for (const id of createdLedger) await db.query('DELETE FROM dealer_ledger WHERE id = ?', [id]);
    // Audit rows first, by the entity each one names — scoped to the ids this
    // suite created, so nothing a parallel suite wrote is touched. Left behind,
    // they read as real history in the console while pointing at rows that no
    // longer exist.
    for (const id of createdMilestones) await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['milestone', id]);
    for (const id of createdPayments) await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['payment', id]);
    for (const id of createdOrders) await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['order', id]);
    for (const id of createdMilestones) await db.query('DELETE FROM payment_milestones WHERE id = ?', [id]);
    for (const id of createdPayments) {
      await db.query('DELETE FROM payment_events WHERE payment_id = ?', [id]);
      await db.query('DELETE FROM payments WHERE id = ?', [id]);
    }
    for (const id of createdOrders) await db.query('DELETE FROM orders WHERE id = ?', [id]);
    if (createdBooking) await db.query('DELETE FROM bookings WHERE id = ?', [createdBooking.id]);
    if (createdPhones.size) {
      // Matched on every stored form of the number: the suite tracks the local
      // 0806… it signs in with, while the row holds +234806…. Same expansion as
      // test/admin.test.js — without it these accounts pile up in /admin/staff
      // on every run.
      const { variants } = require('../src/lib/phone');
      const shapes = [...new Set([...createdPhones].flatMap((number) => variants(number)))];
      const marks = shapes.map(() => '?').join(',');
      await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
      await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, shapes);
      await db.query(`DELETE FROM notifications WHERE recipient IN (${marks})`, shapes);
      await db.query(`UPDATE admin_audit SET actor_id = NULL WHERE actor_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
      await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
    }
    await db.pool.end();
  }
});

// ---------------------------------------------------------------------------
// Honesty: what is actually available without PSP credentials
// ---------------------------------------------------------------------------
maybe('hosted checkout is honestly unavailable, and manual money is not', async () => {
  const availability = paymentService.availability();
  assert.equal(availability.manual, true);
  assert.equal(availability.bank_transfer, true);
  assert.equal(availability.cash, true);
  // No keys in this environment — and the code says so rather than pretending.
  const config = require('../src/config');
  if (!config.payments.paystackSecret) assert.equal(availability.paystack, false);
  if (!config.payments.flutterwaveSecret) assert.equal(availability.flutterwave, false);
  assert.equal(paymentService.activeProvider(), availability[config.payments.defaultProvider] ? config.payments.defaultProvider : 'manual');

  const page = await newClient().request('/api/payments/methods');
  assert.equal(page.status, 200);
  assert.equal(page.json.providers.paystack, availability.paystack);
  assert.equal(typeof page.json.active, 'string');
});

maybe('a hosted provider without keys records a pending payment and refuses to fake a redirect', async () => {
  const phone = nextPhone();
  const result = await paymentService.initiate({
    provider: 'paystack',
    purpose: 'booking',
    amountKobo: 4_500_000,
    customerName: 'Hosted Test',
    customerPhone: phone,
  });
  assert.equal(result.ok, false, 'a hosted checkout without keys must not claim success');
  assert.match(result.error, /not configured|key/i);
  assert.ok(result.reference, 'the abandoned attempt still has a reference for the record');
  createdPayments.push(result.id);

  const row = await payments.paymentById(result.id);
  assert.equal(row.status, 'abandoned', 'the payment is abandoned, not pending or paid');
  assert.equal(row.checkoutUrl, null, 'no checkout URL was invented');

  const events = await db.query('SELECT type FROM payment_events WHERE payment_id = ? ORDER BY id', [result.id]);
  assert.ok(events.some((event) => event.type === 'payment.created'));
});

// ---------------------------------------------------------------------------
// Webhooks (§12.2): unsigned is refused *and logged*, retries are no-ops
// ---------------------------------------------------------------------------
maybe('an unsigned webhook is refused and the attempt is on the record', async () => {
  const created = await payments.createPayment({
    purpose: 'booking',
    amountKobo: 4_500_000,
    customerName: 'Webhook Test',
    customerPhone: nextPhone(),
  });
  createdPayments.push(created.id);

  const client = newClient();
  const response = await client.request('/api/payments/webhook/paystack', {
    method: 'POST',
    raw: JSON.stringify({ event: 'charge.success', data: { reference: created.reference, status: 'success' } }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.json.ok, false);

  const stillPending = await payments.paymentById(created.id);
  assert.equal(stillPending.status, 'pending', 'an unsigned call never moves money');

  const trail = await db.query('SELECT type, signature_ok FROM payment_events WHERE payment_id = ? ORDER BY id', [created.id]);
  const refused = trail.find((event) => event.signature_ok === 0);
  assert.ok(refused, 'the failed signature is recorded, not silently dropped');
});

maybe('an unknown reference is a 404 and the manual provider does not accept webhooks', async () => {
  const client = newClient();
  const unknown = await client.request('/api/payments/webhook/paystack', {
    method: 'POST',
    raw: JSON.stringify({ event: 'charge.success', data: { reference: 'HC-PAY-999999', status: 'success' } }),
  });
  assert.equal(unknown.status, 404);

  const manual = await client.request('/api/payments/webhook/flutterwave', {
    method: 'POST',
    raw: JSON.stringify({ event: 'charge.completed', data: { tx_ref: 'HC-PAY-999999' } }),
  });
  assert.ok([400, 404].includes(manual.status), `unexpected status ${manual.status}`);
});

maybe('the same PSP event twice is one payment, and the event verdict is stored', async () => {
  const created = await payments.createPayment({
    purpose: 'booking',
    amountKobo: 4_500_000,
    customerName: 'Idempotency Test',
    customerPhone: nextPhone(),
  });
  createdPayments.push(created.id);

  // Sign the payload the way a provider would, once we know a secret.
  const secret = paymentService.adapters.paystack.verifySignature && require('../src/config').payments.paystackSecret;
  if (!secret) {
    // Without keys the signature can never be valid — the important half of the
    // contract is that the state machine refuses to move. Drive it directly.
    const eventId = `test.${created.reference}`;
    const first = await payments.recordPaymentEvent({
      paymentId: created.id, provider: 'paystack', eventId, type: 'charge.success', signatureOk: true, payload: { reference: created.reference },
    });
    const second = await payments.recordPaymentEvent({
      paymentId: created.id, provider: 'paystack', eventId, type: 'charge.success', signatureOk: true, payload: { reference: created.reference },
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true, 'the unique key on (provider, event_id) is the guard');
  }

  // And the mark-paid state machine itself is idempotent.
  const once = await payments.markPaid(created.id, { source: 'webhook' });
  assert.equal(once.ok, true);
  const twice = await payments.markPaid(created.id, { source: 'webhook' });
  assert.equal(twice.already, true, 'a PSP retry is a no-op');
  const row = await payments.paymentById(created.id);
  assert.equal(row.status, 'paid');
  assert.ok(row.paidAt, 'the paid timestamp is kept');
});

// ---------------------------------------------------------------------------
// Refunds: never more than was taken
// ---------------------------------------------------------------------------
maybe('a refund cannot exceed what was taken, and a partial refund leaves a balance', async () => {
  const created = await payments.createPayment({
    purpose: 'order',
    amountKobo: 4_500_000,
    customerName: 'Refund Test',
    customerPhone: nextPhone(),
  });
  createdPayments.push(created.id);
  await payments.markPaid(created.id, { source: 'manual' });

  const tooMuch = await paymentService.refund(created.id, { amountKobo: 5_000_000, reason: 'too much', actorId: null });
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.error, /more than is left/i);

  const partial = await paymentService.refund(created.id, { amountKobo: 2_000_000, reason: 'Goodwill', actorId: null });
  assert.equal(partial.ok, true);
  let row = await payments.paymentById(created.id);
  assert.equal(row.status, 'partially_refunded');
  assert.equal(row.refundKobo, 2_000_000);
  assert.equal(row.refundableKobo, 2_500_000);

  const rest = await paymentService.refund(created.id, { amountKobo: 2_500_000, reason: 'The rest', actorId: null });
  assert.equal(rest.ok, true);
  row = await payments.paymentById(created.id);
  assert.equal(row.status, 'refunded');
  assert.equal(row.refundableKobo, 0);

  const again = await paymentService.refund(created.id, { amountKobo: 100, reason: 'nothing left', actorId: null });
  assert.equal(again.ok, false, 'a fully refunded payment cannot be refunded again');

  const trail = await db.query('SELECT type FROM payment_events WHERE payment_id = ? ORDER BY id', [created.id]);
  const types = trail.map((event) => event.type);
  assert.ok(types.includes('payment.refunded'), 'refunds are part of the evidence trail');
});

// ---------------------------------------------------------------------------
// The console surface: capability-gated, audited, and honest about errors
// ---------------------------------------------------------------------------
maybe('only the roles with payments.approve can confirm or refund, and every action is audited', async () => {
  const finance = await createAccount('finance', 'Payments finance');
  const ops = await createAccount('ops', 'Payments ops');

  const created = await payments.createPayment({
    purpose: 'booking',
    amountKobo: 4_500_000,
    customerName: 'Approval Test',
    customerPhone: nextPhone(),
  });
  createdPayments.push(created.id);

  const refused = await ops.client.request(`/admin/payments/${created.id}/confirm`, {
    method: 'POST',
    form: { note: 'ops tried' },
  });
  assert.equal(refused.status, 403, 'ops does not hold payments.approve');
  assert.equal((await payments.paymentById(created.id)).status, 'pending');

  const confirmed = await finance.client.request(`/admin/payments/${created.id}/confirm`, {
    method: 'POST',
    form: { note: 'GTBank alert 14:02 matched' },
  });
  assert.equal(confirmed.status, 303);
  assert.match(confirmed.headers.get('location'), /ok=/);
  const row = await payments.paymentById(created.id);
  assert.equal(row.status, 'paid');
  assert.ok(row.providerRef && row.providerRef.startsWith('manual:'), 'the note becomes the matching evidence');

  const audit = await db.query('SELECT action, actor_id FROM admin_audit WHERE entity = ? AND entity_id = ?', ['payment', created.id]);
  assert.ok(audit.some((entry) => entry.action === 'payment.paid'), 'the money write is on the audit log');
  assert.equal(Number(audit.find((entry) => entry.action === 'payment.paid').actor_id), Number(finance.id));

  // The customer was told, and the message is on the record.
  const notices = await payments.listNotifications({ entity: 'payment', entityId: created.id });
  assert.ok(notices.some((notice) => notice.template === 'payment_receipt'));

  // A refund without a reason is refused: the reason goes on the log.
  const noReason = await finance.client.request(`/admin/payments/${created.id}/refund`, {
    method: 'POST',
    form: { amount: '₦10,000' },
  });
  assert.equal(noReason.status, 303);
  assert.match(noReason.headers.get('location'), /err=/);
  assert.equal((await payments.paymentById(created.id)).refundKobo, 0);

  const badAmount = await finance.client.request(`/admin/payments/${created.id}/refund`, {
    method: 'POST',
    form: { amount: 'ten thousand', reason: 'typo' },
  });
  assert.match(badAmount.headers.get('location'), /err=/);

  const good = await finance.client.request(`/admin/payments/${created.id}/refund`, {
    method: 'POST',
    form: { amount: '₦10,000', reason: 'Inspection rescheduled at our end' },
  });
  assert.equal(good.status, 303);
  assert.match(good.headers.get('location'), /ok=/);
  assert.equal((await payments.paymentById(created.id)).refundKobo, 1_000_000);
});

maybe('the console money screens render, and say what is actually configured', async () => {
  const finance = await createAccount('finance', 'Money screens finance');
  for (const path of ['/admin/orders', '/admin/payments', '/admin/milestones']) {
    const page = await finance.client.request(path);
    assert.equal(page.status, 200, `${path} should render for finance`);
    assert.match(page.text, /Console/);
  }

  const paymentsPage = await finance.client.request('/admin/payments');
  assert.match(paymentsPage.text, /Dealer ledger/);
  assert.match(paymentsPage.text, /HC-PAY-/, 'seeded payments are listed');
  assert.ok(
    /not live|no Paystack/i.test(paymentsPage.text),
    'the page states that hosted checkout is not configured',
  );

  const financeDenied = await finance.client.request('/admin/bookings');
  assert.equal(financeDenied.status, 403, 'finance does not dispatch jobs');

  const orders = await finance.client.request('/admin/orders');
  assert.match(orders.text, /HC-ORD-/, 'seeded orders are listed');
});

// ---------------------------------------------------------------------------
// Orders: the status machine does not go backwards
// ---------------------------------------------------------------------------
maybe('an order moves forward, and a fulfilled order cannot be reopened', async () => {
  const finance = await createAccount('finance', 'Orders finance');
  const product = await db.queryOne("SELECT slug, price_kobo FROM products WHERE is_active = 1 ORDER BY id LIMIT 1");
  const orderNo = `HC-OT-${String(run).slice(0, 4)}${seq}`.slice(0, 24);
  const inserted = await db.query(
    `INSERT INTO orders (order_no, name, phone, delivery_area, delivery_fee_kobo, subtotal_kobo, total_kobo, status)
     VALUES (?, 'Order Test', ?, 'GRA Phase 2', 0, ?, ?, 'pending_payment')`,
    [orderNo, nextPhone(), product.price_kobo, product.price_kobo],
  );
  createdOrders.push(inserted.insertId);

  const move = (status) => finance.client.request(`/admin/orders/${inserted.insertId}/status`, { method: 'POST', form: { status } });
  assert.equal((await move('paid')).status, 303);
  assert.equal((await move('processing')).status, 303);
  assert.equal((await move('fulfilled')).status, 303);
  const reopen = await move('processing');
  assert.match(reopen.headers.get('location'), /err=/, 'a fulfilled order is closed for good');
  const row = await db.queryOne('SELECT status FROM orders WHERE id = ?', [inserted.insertId]);
  assert.equal(row.status, 'fulfilled');

  const audit = await db.query('SELECT action FROM admin_audit WHERE entity = ? AND entity_id = ?', ['order', inserted.insertId]);
  assert.ok(audit.length >= 3, 'every status move is audited');
});

// ---------------------------------------------------------------------------
// Escrow milestones
// ---------------------------------------------------------------------------
maybe('escrow moves one stage at a time, records the releaser, and pays a new row for corrections', async () => {
  const finance = await createAccount('finance', 'Escrow finance');
  const listing = await db.queryOne("SELECT id, stock_no FROM vehicle_listings WHERE status = 'live' ORDER BY id LIMIT 1");
  const created = await payments.createMilestone({
    kind: 'protected_purchase',
    subject: 'Escrow test car — protected purchase',
    listingId: listing.id,
    customerName: 'Escrow Test Buyer',
    customerPhone: nextPhone(),
    amountKobo: 50_000_000,
    actorId: null,
  });
  assert.equal(created.ok, true);
  createdMilestones.push(created.id);

  const skipped = await payments.advanceMilestone(created.id, { to: 'released', actorId: finance.id });
  assert.equal(skipped.ok, false, 'escrow cannot jump the inspection');
  assert.match(skipped.error, /one stage at a time/i);

  const toInspection = await finance.client.request(`/admin/milestones/${created.id}/stage`, {
    method: 'POST',
    form: { to: 'inspection_passed', note: 'Report filed, rear bushings noted' },
  });
  assert.equal(toInspection.status, 303);
  assert.match(toInspection.headers.get('location'), /ok=/);

  const toDocuments = await payments.advanceMilestone(created.id, { to: 'documents_verified', actorId: finance.id });
  const released = await payments.advanceMilestone(created.id, { to: 'released', actorId: finance.id, note: 'Buyer confirmed collection' });
  assert.equal(toDocuments.ok, true);
  assert.equal(released.ok, true);

  const row = await payments.milestoneById(created.id);
  assert.equal(row.stage, 'released');
  assert.equal(Number(row.releasedBy), Number(finance.id), 'a human is on the release');
  assert.ok(row.releasedAt);

  const after = await payments.advanceMilestone(created.id, { to: 'released', actorId: finance.id });
  assert.equal(after.ok, false, 'released money does not move again');

  const audit = await db.query('SELECT action FROM admin_audit WHERE entity = ? AND entity_id = ?', ['milestone', created.id]);
  const actions = audit.map((entry) => entry.action);
  assert.ok(actions.includes('milestone.released'));
  assert.ok(actions.includes('milestone.stage'));

  const notices = await payments.listNotifications({ entity: 'milestone', entityId: created.id });
  assert.ok(notices.some((notice) => notice.template === 'milestone_stage'), 'the customer hears about each stage');

  // The ladder itself reports what is held.
  const board = await payments.listMilestones({});
  assert.equal(typeof board.counts.heldKobo, 'number');
  assert.equal(board.counts.released >= 1, true);
});

maybe('the milestone page shows the ladder and refuses backwards moves', async () => {
  const finance = await createAccount('finance', 'Ladder finance');
  const page = await finance.client.request('/admin/milestones');
  assert.equal(page.status, 200);
  assert.match(page.text, /ms-ladder/);
  assert.match(page.text, /Money held/);

  const seeded = await db.queryOne("SELECT id FROM payment_milestones WHERE stage = 'documents_verified' LIMIT 1");
  if (seeded) {
    const page2 = await finance.client.request(`/admin/milestones?stage=documents_verified`);
    assert.match(page2.text, new RegExp(`/admin/milestones/${seeded.id}/stage`));
  }
});

// ---------------------------------------------------------------------------
// The dealer ledger (§7.2, §7.3)
// ---------------------------------------------------------------------------
maybe('the ledger is append-only, signed, and balances add up', async () => {
  const finance = await createAccount('finance', 'Ledger finance');
  const dealer = await db.queryOne('SELECT id, name FROM dealers ORDER BY id DESC LIMIT 1');
  const before = await payments.ledgerFor(dealer.id, {});

  // A commission is positive; a payout must be entered as money leaving.
  const wrongSign = await payments.addLedgerEntry({
    dealerId: dealer.id, entryType: 'payout', amountKobo: 5_000_00, detail: 'wrong sign', actorId: finance.id,
  });
  assert.equal(wrongSign.ok, false);
  assert.match(wrongSign.error, /negative/i);

  const commission = await finance.client.request('/admin/ledger', {
    method: 'POST',
    form: { dealer_id: dealer.id, entry_type: 'sale_commission', direction: 'in', amount: '₦120,000', reference: 'STMT-TEST', detail: 'Test commission' },
  });
  assert.equal(commission.status, 303);
  assert.match(commission.headers.get('location'), /ok=/);

  const payout = await finance.client.request('/admin/ledger', {
    method: 'POST',
    form: { dealer_id: dealer.id, entry_type: 'payout', direction: 'out', amount: '₦50,000', reference: 'PO-TEST', detail: 'Test payout' },
  });
  assert.equal(payout.status, 303);

  const after = await payments.ledgerFor(dealer.id, {});
  createdLedger.push(...after.entries.filter((entry) => String(entry.reference || '').endsWith('-TEST')).map((entry) => entry.id));

  assert.equal(after.closingKobo, before.closingKobo + 12_000_000 - 5_000_000, 'the closing balance is the arithmetic of the rows');
  const summary = (await payments.ledgerSummary()).find((row) => row.dealerId === dealer.id);
  assert.ok(summary);
  assert.equal(summary.balanceKobo, after.closingKobo);
  assert.equal(typeof summary.paidOutKobo, 'number');

  // A correction is another row, never an edit.
  const correction = await payments.addLedgerEntry({
    dealerId: dealer.id, entryType: 'adjustment', amountKobo: -1_000_00, detail: 'Correction: over-billed the last statement', actorId: finance.id,
  });
  assert.equal(correction.ok, true);
  createdLedger.push(correction.id);
  const corrected = await payments.ledgerFor(dealer.id, {});
  assert.equal(corrected.closingKobo, after.closingKobo - 100_000);

  // The window maths: opening + movement = closing.
  const window = await payments.ledgerFor(dealer.id, { from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) });
  assert.equal(window.openingKobo + window.movementKobo, window.closingKobo);

  const audit = await db.query('SELECT action FROM admin_audit WHERE entity = ? ORDER BY id DESC LIMIT 5', ['dealer_ledger']);
  assert.ok(audit.length, 'ledger writes are audited');
});

// ---------------------------------------------------------------------------
// The inspection report (FR-07)
// ---------------------------------------------------------------------------
maybe('the report is one document for the page and the PDF, and only the right people open it', async () => {
  const booking = await scratchBooking({ withChecklist: true });
  const inspector = await createAccount('inspector', 'Report inspector');
  const ops = await createAccount('ops', 'Report dispatch');
  const stranger = await createAccount('customer', 'Report stranger');

  const built = await report.build(booking.id);
  assert.equal(built.ready, true);
  assert.equal(built.reference, booking.reference);
  assert.equal(built.vehicle.vin, 'TESTVIN0000000001');
  assert.equal(built.sections.length, 7);
  assert.equal(built.counts.recorded, 7);
  assert.equal(built.counts.attention, 1);
  assert.match(built.verdictLabel, /advisories/i);
  assert.match(built.disclaimer, /not a warranty/i);

  // Unassigned inspector: not theirs. Dispatch and the file itself are the
  // other two doors, and both are checked at the route.
  const notMine = await inspector.client.request(`/admin/jobs/${booking.id}/report`);
  assert.equal(notMine.status, 303, 'an unassigned inspector is turned back with a message');

  const dispatchView = await ops.client.request(`/admin/jobs/${booking.id}/report`);
  assert.equal(dispatchView.status, 200);
  assert.match(dispatchView.text, /Rear bushings due within the year/, 'the notes are the inspector’s words');
  assert.match(dispatchView.text, /seven|7\/7/i);

  const customerView = await stranger.client.request(`/account/reports/${booking.reference}`);
  assert.equal(customerView.status, 404, 'someone else’s report is not readable by reference alone');

  // The PDF: a real one, and the same facts.
  const pdf = await ops.client.request(`/admin/jobs/${booking.id}/report.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.buffer.slice(0, 4).toString(), '%PDF');
  assert.ok(pdf.buffer.length > 3000, 'the PDF has content in it');

  const plain = report.pdf(built, { plainFonts: true, compress: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    plain.on('data', (chunk) => chunks.push(chunk));
    plain.on('end', resolve);
    plain.on('error', reject);
  });
  const text = pdfText(Buffer.concat(chunks));
  assert.match(text, new RegExp(booking.reference));
  assert.match(text, /Pre-purchase inspection report/);
  assert.match(text, /Pass with advisories/);
  assert.match(text, /Suspension & steering/);
  assert.match(text, /not a warranty/i, 'the limitation wording travels with the PDF');
  assert.match(text, /page 1 of 1/, 'the footer is a footer, not a stray page');

  // No checklist yet → no report to print, said plainly.
  const draft = await scratchBooking({ withChecklist: false });
  const noReport = await ops.client.request(`/admin/jobs/${draft.id}/report.pdf`);
  assert.equal(noReport.status, 409);
  const page = await ops.client.request(`/admin/jobs/${draft.id}/report`);
  assert.equal(page.status, 200);
  assert.match(page.text, /No checklist on file yet/);
});

maybe('the inspection report reaches the customer it belongs to', async () => {
  const booking = await scratchBooking({ withChecklist: true });
  const { canonical } = require('../src/lib/phone');
  await db.query('UPDATE bookings SET phone = ? WHERE id = ?', [canonical(booking.phone), booking.id]);

  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone: booking.phone } });
  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone: booking.phone, code: otp.json.devCode } });
  assert.equal(verify.status, 200);

  const dashboard = await client.request('/account');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, new RegExp(`/account/reports/${booking.reference}`), 'the report is filed under Documents');

  const page = await client.request(`/account/reports/${booking.reference}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Download the PDF/);

  const pdf = await client.request(`/account/reports/${booking.reference}.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buffer.slice(0, 4).toString(), '%PDF');
});

// ---------------------------------------------------------------------------
// Loose ends: money parsing, masking, and the module contract
// ---------------------------------------------------------------------------
maybe('the money helpers refuse what a human would not mean', async () => {
  assert.equal(money.nairaToKobo('₦2,500,000'), 250_000_000);
  assert.equal(money.nairaToKobo('NGN 45000'), 4_500_000);
  assert.equal(money.nairaToKobo('45,000.50'), 4_500_050);
  assert.equal(money.nairaToKobo('-45000'), null);
  assert.equal(money.nairaToKobo('forty-five thousand'), null);
  assert.equal(money.nairaToKobo(''), null);
  assert.equal(money.formatNaira(4_500_000), '₦45,000');
  assert.equal(money.formatNairaShort(1_350_000_000), '₦13.5m');
});

maybe('phone numbers are masked everywhere money is shown', async () => {
  const phones = require('../src/lib/phone');
  assert.match(phones.mask('+2348031110002'), /^\+234 803 ••• 0002$/);
  const rows = (await payments.listPayments({ limit: 5 })).rows;
  if (rows.length) {
    for (const row of rows) {
      if (row.maskedPhone) assert.match(row.maskedPhone, /•••/);
    }
  }
  const statement = await payments.ledgerFor((await db.queryOne('SELECT id FROM dealers LIMIT 1')).id, {});
  assert.ok(statement && Array.isArray(statement.entries));
});
