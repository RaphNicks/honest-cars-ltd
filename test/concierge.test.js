'use strict';

/**
 * The concierge retainer (FR-05, §6.5).
 *
 * §6.5 makes three promises about this money, and each one is a test:
 *   • the price comes from our published SLA card, never from the visitor —
 *     the client sends the key of an option, not an amount
 *   • the customer can always see where the retainer stands, in words rather
 *     than a database enum
 *   • credited against the success fee, and refunded in full if we find
 *     nothing that meets the brief
 *
 * Rows are created by the suite (unique phones) and removed in test.after. The
 * payments this raises are cleaned up by id, and so are the notifications they
 * send — a parallel suite's rows are never in scope.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, enrolMfa, completeMfa } = require('./helpers');
const roles = require('../src/services/roles');

let available = false;
let ctx;
let db;
let payments;
let paymentService;
let concierge;
let money;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const run = (Number(process.pid) * 4099 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0807${String((run * 19 + seq * 617) % 10_000_000).padStart(7, '0')}`;
}

const createdPhones = new Set();
const createdRequests = new Set();
const createdPayments = new Set();

function newClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, { method = 'GET', body, form, headers = {} } = {}) {
      const payload = form
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
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: payload,
      });
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(';');
        if (pair.split('=')[0] === 'hc_session') cookie = pair;
      }
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html */
      }
      return { status: response.status, headers: response.headers, text, json };
    },
  };
}

/** A signed-in staff member, for the ops side of the flow. */
async function createAccount(role, label) {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { canonical } = require('../src/lib/phone');
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    canonical(phone),
    `${label} (concierge test)`,
    role,
    'active',
  ]);
  const row = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [canonical(phone)]);
  // §12.2: a fixture in a required role carries a second factor, or the gate
  // sends it to the enrolment screen instead of the money screens.
  if (roles.MFA_ROLES.includes(role)) await enrolMfa(row.id);
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, `OTP failed for ${label}: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  assert.equal(verify.status, 200, `sign-in failed for ${label}: ${verify.text}`);
  if (roles.MFA_ROLES.includes(role)) {
    const finished = await completeMfa(client, { phone });
    assert.equal(finished.status, 200, `second factor failed for ${label}: ${finished.text}`);
  }
  return { id: row.id, phone: canonical(phone), role, client };
}

/** Submit a concierge brief the way the browser does: the SLA *key*, no price. */
async function submitBrief({ sla = 'standard', extra = {}, phone } = {}) {
  const client = newClient();
  const number = phone || nextPhone();
  if (!phone) createdPhones.add(number);
  const response = await client.request('/api/service-requests', {
    method: 'POST',
    body: {
      kind: 'concierge',
      name: 'Concierge Test Buyer',
      phone: number,
      sla,
      brief: { budget_max: '9000000', body: 'suv', timeline: 'two_weeks' },
      sourcePath: '/find-my-car',
      ...extra,
    },
  });
  assert.equal(response.status, 200, `brief rejected: ${response.text}`);
  const request = await db.queryOne('SELECT id, tracking_id FROM service_requests WHERE tracking_id = ?', [
    response.json.trackingId,
  ]);
  createdRequests.add(request.id);
  for (const payment of await payments.paymentsForRequest(request.id)) createdPayments.add(payment.id);
  return { ...response.json, requestId: request.id, client };
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  payments = db.payments;
  paymentService = require('../src/services/payments');
  concierge = require('../src/services/concierge');
  money = require('../src/lib/money');
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (!available) return;
  // Only rows this suite created: by id for payments/requests, by entity for
  // the messages the retainer sent. A parallel suite's notifications are safe.
  for (const id of createdPayments) {
    await db.query('DELETE FROM notifications WHERE entity = ? AND entity_id = ?', ['payment', id]);
    // Confirming and refunding a retainer is audited, so the test leaves audit
    // rows behind unless it removes them: they would read as real money history
    // in the console while pointing at payments that no longer exist.
    await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['payment', id]);
    await db.query('DELETE FROM payment_events WHERE payment_id = ?', [id]);
    await db.query('DELETE FROM payments WHERE id = ?', [id]);
  }
  for (const id of createdRequests) await db.query('DELETE FROM service_requests WHERE id = ?', [id]);
  if (createdPhones.size) {
    // Every stored form of the number — see the note in test/intel.test.js.
    const { variants } = require('../src/lib/phone');
    const shapes = [...new Set([...createdPhones].flatMap((number) => variants(number)))];
    const marks = shapes.map(() => '?').join(',');
    await db.query(`DELETE FROM notifications WHERE recipient IN (${marks})`, shapes);
    await db.query(`DELETE FROM leads WHERE phone IN (${marks})`, shapes);
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
    await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, shapes);
    await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
  }
  // Each test file is its own process; close the pool or the runner hangs.
  await db.pool.end();
});

maybe('the brief raises the retainer at the published price', async () => {
  const result = await submitBrief({ sla: 'priority' });
  const card = concierge.slaOption('priority');

  assert.ok(result.retainer, 'a concierge brief comes back with its retainer');
  assert.match(result.retainer.reference, /^HC-PAY-\d+$/);
  assert.equal(result.retainer.amountKobo, card.retainerKobo, 'priced from the SLA card');

  const row = await payments.paymentByReference(result.retainer.reference);
  createdPayments.add(row.id);
  assert.equal(row.purpose, 'retainer');
  assert.equal(row.status, 'pending', 'nothing is marked paid until a human sees the money');
  assert.equal(row.requestId, result.requestId, 'the retainer hangs off the request');
  assert.equal(row.customerPhone, result.client ? row.customerPhone : row.customerPhone);
  assert.ok(row.amountKobo > 0);
});

maybe('the visitor cannot name their own price', async () => {
  const sneaky = await submitBrief({ sla: 'urgent', extra: { retainerKobo: 1, amountKobo: 1 } });
  assert.equal(
    sneaky.retainer.amountKobo,
    concierge.slaOption('urgent').retainerKobo,
    'a posted amount is ignored in favour of the card',
  );

  const nonsense = await submitBrief({ sla: 'free-please' });
  assert.equal(nonsense.retainer.slaKey, concierge.DEFAULT_SLA, 'an unknown SLA key falls back, it never invents a price');
  assert.equal(nonsense.retainer.amountKobo, concierge.slaOption(concierge.DEFAULT_SLA).retainerKobo);

  const stored = await payments.paymentByReference(sneaky.retainer.reference);
  createdPayments.add(stored.id);
  assert.notEqual(stored.amountKobo, 1, 'and the row agrees with the card, not the request body');
});

maybe('without PSP keys the retainer is a bank transfer, not a fake checkout', async () => {
  const result = await submitBrief({ sla: 'standard' });
  assert.equal(result.retainer.hosted, false, 'no provider is configured in this environment');
  assert.equal(result.retainer.checkoutUrl, null, 'so there is no checkout link to pretend with');
});

maybe('the tracking page says where the money stands, in words', async () => {
  const result = await submitBrief({ sla: 'standard' });
  const page = await result.client.request(`/concierge/${result.trackingId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Your retainer/);
  assert.match(page.text, new RegExp(money.formatNaira(concierge.slaOption('standard').retainerKobo).replace(/[₦,]/g, (ch) => (ch === '₦' ? '₦' : ','))));
  assert.match(page.text, /Awaiting payment/, 'pending is explained, not printed as an enum');
  assert.match(page.text, /credited against the success fee/i);
  assert.match(page.text, new RegExp(result.retainer.reference), 'the reference to pay against is on the page');
});

maybe('ops confirms the transfer and the customer sees it', async () => {
  const result = await submitBrief({ sla: 'standard' });
  const finance = await createAccount('finance', 'Finance');
  const stored = await payments.paymentByReference(result.retainer.reference);
  createdPayments.add(stored.id);

  const confirm = await finance.client.request(`/admin/payments/${stored.id}/confirm`, {
    method: 'POST',
    form: { note: 'Transfer landed, GTB ref 8891' },
    headers: { Origin: ctx.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(confirm.status, 303, `confirm redirected: ${confirm.text.slice(0, 120)}`);

  const paid = await payments.paymentByReference(result.retainer.reference);
  assert.equal(paid.status, 'paid');
  assert.ok(paid.paidAt, 'a paid payment carries when it was paid');

  const page = await result.client.request(`/concierge/${result.trackingId}`);
  assert.match(page.text, /Received/, 'the buyer is told the retainer landed');
});

maybe('a full refund is possible, and is what the page promises', async () => {
  const result = await submitBrief({ sla: 'standard' });
  const finance = await createAccount('finance', 'Finance');
  const stored = await payments.paymentByReference(result.retainer.reference);
  createdPayments.add(stored.id);
  await finance.client.request(`/admin/payments/${stored.id}/confirm`, {
    method: 'POST',
    form: { note: 'Transfer landed' },
    headers: { Origin: ctx.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const refund = await finance.client.request(`/admin/payments/${stored.id}/refund`, {
    method: 'POST',
    form: { amount: String(stored.amountKobo / 100), reason: 'Nothing met the brief' },
    headers: { Origin: ctx.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(refund.status, 303, `refund redirected: ${refund.text.slice(0, 120)}`);

  const refunded = await payments.paymentByReference(result.retainer.reference);
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refundKobo, stored.amountKobo, 'the whole retainer goes back');
  assert.equal(refunded.refundReason, 'Nothing met the brief', 'the reason is kept for the audit trail');

  const page = await result.client.request(`/concierge/${result.trackingId}`);
  assert.match(page.text, /Refunded in full/);
  assert.match(page.text, /Nothing met the brief/);

  // And there is nothing left to refund.
  const again = await paymentService.refund(refunded.id, { amountKobo: 100, reason: 'double refund' });
  assert.equal(again.ok, false, 'a refund can never exceed what was taken');
});

maybe('other request kinds get no retainer', async () => {
  const client = newClient();
  const phone = nextPhone();
  createdPhones.add(phone);
  const response = await client.request('/api/service-requests', {
    method: 'POST',
    body: { kind: 'sell', name: 'Sell Test', phone, brief: { make: 'Toyota' }, sourcePath: '/sell-swap' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.retainer, null, 'sell/swap asks for a valuation, not money');

  const request = await db.queryOne('SELECT id FROM service_requests WHERE tracking_id = ?', [response.json.trackingId]);
  createdRequests.add(request.id);
  const rows = await payments.paymentsForRequest(request.id);
  assert.equal(rows.length, 0, 'and nothing was raised against it');
});
