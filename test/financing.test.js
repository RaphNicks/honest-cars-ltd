'use strict';

/**
 * FR-34 — financing enquiries and the partner handoff.
 *
 * Two things this module must never do, and both are tested here rather than
 * trusted:
 *
 *   1. **Quote credit.** `plan()` is arithmetic on the customer's own figures.
 *      The tests assert that no rate, APR or "approved" language can come out of
 *      it, that a shortfall says the plan does not add up instead of inventing a
 *      monthly payment, and that a customer who does not need financing is told
 *      so.
 *   2. **Claim a handoff that did not happen.** An enquiry is `new` with no
 *      partner until a human routes it; routing to a switched-off partner is
 *      refused; and with no email/WhatsApp provider configured the message is
 *      recorded `failed`/`skipped` with its text intact rather than reported as
 *      delivered.
 *
 * The DB half skips itself when MySQL is unreachable (see test/helpers.js). Every
 * row these tests create is deleted again: the seed owns the demo desk, and a
 * suite that leaves rows behind makes the next `db:seed` look like a diff.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer } = require('./helpers');

let available = false;
let ctx;
let db;
let financing;
let notify;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const PREFIX = 'FR34Test';
const PHONE = '+2348030000099';
const created = { leads: [], partners: [] };

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  financing = require('../src/services/financing');
  notify = require('../src/services/notify');
  ctx = await startTestServer();
});

test.after(async () => {
  if (!available) return;
  if (ctx) await ctx.close();
  for (const id of created.leads) await db.query('DELETE FROM financing_leads WHERE id = ?', [id]).catch(() => {});
  for (const id of created.partners) await db.query('DELETE FROM finance_partners WHERE id = ?', [id]).catch(() => {});
  await db.query('DELETE FROM leads WHERE name LIKE ?', [`${PREFIX}%`]).catch(() => {});
  await db.pool.end();
});

const post = async (path, body) => {
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: ctx.baseUrl },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an HTML error page is a failure the assertion will show */
  }
  return { status: response.status, text, json };
};

async function makePartner({ active = true } = {}) {
  const result = await db.financing.createPartner({
    name: `${PREFIX} ${Math.random().toString(36).slice(2, 7)}`,
    kind: 'mfb',
    channel: 'manual',
    contact: '+2348000000099',
    note: 'test partner — deleted by test/financing.test.js',
  });
  assert.equal(result.ok, true, result.error);
  created.partners.push(result.partner.id);
  if (!active) await db.financing.setPartnerActive(result.partner.id, false);
  return result.partner;
}

async function makeLead(overrides = {}) {
  const result = await db.financing.createLead({
    name: `${PREFIX} Customer`,
    phone: PHONE,
    amountKobo: 1_200_000_000,
    downKobo: 400_000_000,
    monthlyKobo: 25_000_000,
    tenorMonths: 48,
    sourcePath: '/financing',
    plan: { headline: 'test fixture' },
    ...overrides,
  });
  assert.equal(result.ok, true, result.error);
  created.leads.push(result.lead.id);
  return result.lead;
}

// ---------------------------------------------------------------------------
// The arithmetic — no database needed, so these run everywhere
// ---------------------------------------------------------------------------

test('the plan states the gap and the principal-only monthly, and never a rate', () => {
  const plan = financing.plan({ amountKobo: 1_200_000_000, downKobo: 400_000_000, monthlyKobo: 25_000_000, tenorMonths: 48 });
  assert.equal(plan.ok, true);
  assert.equal(plan.gapKobo, 800_000_000);
  assert.equal(plan.principalPerMonthKobo, Math.ceil(800_000_000 / 48));
  assert.equal(plan.downPercent, 33);
  assert.equal(plan.monthlyCoversPrincipal, true);
  assert.match(plan.headline, /before interest and fees/);

  const wording = `${plan.headline} ${plan.detail} ${plan.caveat}`;
  assert.doesNotMatch(wording, /%\s*(apr|interest)/i, 'a rate is not ours to state');
  assert.doesNotMatch(wording, /\bapproved\b|\byou qualify\b/i, 'an approval is not ours to promise');
  assert.match(wording, /not an offer/i);
});

test('a payment that does not cover the principal says so, and names the levers', () => {
  const plan = financing.plan({ amountKobo: 1_200_000_000, downKobo: 0, monthlyKobo: 10_000_000, tenorMonths: 12 });
  assert.equal(plan.ok, true);
  assert.equal(plan.monthlyCoversPrincipal, false);
  assert.ok(plan.shortfallKobo > 0);
  assert.match(plan.headline, /does not add up yet/);
  assert.match(plan.detail, /bigger down payment/i);
  assert.match(plan.detail, /longer tenor/i);
  assert.match(plan.detail, /will not pretend to know their rate/i);
});

test('paying the whole price is answered as "you do not need financing"', () => {
  const plan = financing.plan({ amountKobo: 500_000_000, downKobo: 500_000_000, tenorMonths: 36 });
  assert.equal(plan.ok, true);
  assert.equal(plan.outright, true);
  assert.equal(plan.gapKobo, 0);
  assert.match(plan.headline, /do not need financing/i);
});

test('a blank amount is refused with a sentence, not a zero-quote', () => {
  const plan = financing.plan({ amountKobo: 0 });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /budget|car/i);
});

test('an unknown tenor falls back to a real one rather than inventing terms', () => {
  const plan = financing.plan({ amountKobo: 1_000_000_000, tenorMonths: 999 });
  assert.equal(plan.ok, true);
  assert.ok(financing.TENORS.includes(plan.tenorMonths));
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

maybe('capture refuses a nameless or malformed enquiry before writing anything', async () => {
  const noName = await financing.capture({ phone: PHONE, amount: '12000000' });
  assert.equal(noName.ok, false);
  assert.match(noName.error, /name/i);

  const badPhone = await financing.capture({ name: `${PREFIX} A`, phone: 'nope', amount: '12000000' });
  assert.equal(badPhone.ok, false);
  assert.match(badPhone.error, /phone number/i);

  const noAmount = await financing.capture({ name: `${PREFIX} B`, phone: PHONE });
  assert.equal(noAmount.ok, false);
  assert.match(noAmount.error, /budget|price/i);

  const stillNothing = await db.queryOne('SELECT COUNT(*) AS n FROM financing_leads WHERE name LIKE ?', [`${PREFIX}%`]);
  assert.equal(Number(stillNothing.n), 0, 'a refused enquiry must not leave a row');
});

maybe('an enquiry is stored with its arithmetic and an inbox copy, and with no partner', async () => {
  const captured = await financing.capture(
    {
      name: `${PREFIX} Ada`,
      phone: '08030000088',
      amount: '12000000',
      down: '4000000',
      monthly: '250000',
      tenor: '48',
      employment: 'salaried',
      timeline: 'month',
      consent: 'yes',
    },
    { sourcePath: '/financing' },
  );
  assert.equal(captured.ok, true, captured.error);
  created.leads.push(captured.lead.id);

  assert.match(captured.lead.reference, /^HC-FIN-\d{6}$/);
  assert.equal(captured.lead.status, 'new');
  assert.equal(captured.lead.partnerId, null, 'nobody has routed it, so no partner may be recorded');
  assert.equal(captured.lead.amountKobo, 1_200_000_000);
  assert.match(captured.plan.headline, /before interest and fees/);
  assert.ok(captured.readiness.length > 0, 'the customer is told what a lender will ask for');
  assert.ok(captured.whatsappUrl.includes('wa.me'), 'ops gets a way to send it even with no provider');

  // §7.3: the same enquiry is in the ops inbox, or it is not really captured.
  assert.ok(captured.lead.leadId, 'the enquiry must also exist as a lead');
  const inbox = await db.queryOne('SELECT type, status FROM leads WHERE id = ?', [captured.lead.leadId]);
  assert.equal(inbox.type, 'financing');

  // The customer is told immediately, and the record shows what was said.
  const row = await db.queryOne(
    "SELECT body, status FROM notifications WHERE entity = 'financing_lead' AND entity_id = ? AND template = 'financing_received' ORDER BY id DESC LIMIT 1",
    [captured.lead.id],
  );
  assert.ok(row, 'the customer must hear from us immediately');
  assert.match(row.body, new RegExp(captured.lead.reference));
  assert.ok(['sent', 'skipped', 'failed'].includes(row.status));
});

maybe('a named car is priced from the database, never from the request body', async () => {
  const listing = await db.queryOne("SELECT seo_slug, asking_price_kobo FROM vehicle_listings WHERE status = 'live' LIMIT 1");
  const captured = await financing.capture(
    { name: `${PREFIX} Car`, phone: PHONE, listingSlug: listing.seo_slug, amount: '1', consent: 'yes' },
    { sourcePath: '/financing' },
  );
  assert.equal(captured.ok, true, captured.error);
  created.leads.push(captured.lead.id);
  assert.equal(captured.lead.amountKobo, Number(listing.asking_price_kobo), 'the body said ₦1 and must be ignored');
  assert.ok(captured.lead.listingId);
});

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

maybe('routing records the partner and the date, and reports an undelivered message honestly', async () => {
  const lead = await makeLead();
  const partner = await makePartner();
  const routed = await financing.route(lead.id, { partnerId: partner.id });

  assert.equal(routed.ok, true, routed.error);
  assert.equal(routed.lead.partnerId, partner.id);
  assert.equal(routed.lead.partnerName, partner.name);
  assert.equal(routed.lead.status, 'shared');
  assert.ok(routed.lead.sharedAt, 'the date it went is the point of the record');

  // No email/WhatsApp provider is configured in this build, so the message can
  // only be recorded — never reported as delivered.
  assert.notEqual(routed.notification.status, 'sent');
  assert.match(routed.notification.body, new RegExp(lead.reference));
  assert.ok(routed.whatsappUrl && routed.whatsappUrl.includes('wa.me'), 'ops needs the link to send it by hand');

  const row = await db.queryOne(
    "SELECT status, body FROM notifications WHERE entity = 'financing_lead' AND entity_id = ? AND template = 'financing_handoff' ORDER BY id DESC LIMIT 1",
    [lead.id],
  );
  assert.ok(['skipped', 'failed'].includes(row.status));
  assert.match(row.body, new RegExp(lead.reference));
});

maybe('a switched-off partner cannot be routed to', async () => {
  const lead = await makeLead();
  const partner = await makePartner({ active: false });
  const refused = await financing.route(lead.id, { partnerId: partner.id });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /switched off/i);

  const unchanged = await db.financing.findById(lead.id);
  assert.equal(unchanged.status, 'new');
  assert.equal(unchanged.partnerId, null);
});

maybe('routing to a partner that does not exist is refused', async () => {
  const lead = await makeLead();
  const refused = await financing.route(lead.id, { partnerId: 999_999_999 });
  assert.equal(refused.ok, false);
});

maybe('an outcome is recorded with a note, and routing is not an outcome', async () => {
  const lead = await makeLead();
  const partner = await makePartner();
  await financing.route(lead.id, { partnerId: partner.id });

  const refusedShared = await financing.outcome(lead.id, { status: 'shared' });
  assert.equal(refusedShared.ok, false, 'routing is a separate action, not an outcome');
  const refusedNew = await financing.outcome(lead.id, { status: 'new' });
  assert.equal(refusedNew.ok, false, 'a lead cannot be un-routed by recording an outcome');

  const declined = await financing.outcome(lead.id, { status: 'declined', note: 'no payslip' });
  assert.equal(declined.ok, true, declined.error);
  assert.equal(declined.lead.status, 'declined');
  assert.equal(declined.lead.outcomeNote, 'no payslip');
});

maybe('the customer is told the outcome, in a sentence that names who decided', async () => {
  const lead = await makeLead();
  const partner = await makePartner();
  await financing.route(lead.id, { partnerId: partner.id });
  await financing.outcome(lead.id, { status: 'approved' });

  const row = await db.queryOne(
    "SELECT body, status FROM notifications WHERE entity = 'financing_lead' AND entity_id = ? AND template = 'financing_update' ORDER BY id DESC LIMIT 1",
    [lead.id],
  );
  assert.ok(row, 'the customer must hear what came back');
  assert.match(row.body, /their written offer is what counts/i);
  assert.ok(['sent', 'skipped', 'failed'].includes(row.status));

  const viewed = financing.accountView([await db.financing.findById(lead.id)])[0];
  assert.match(viewed.statusSentence, /their written offer is what counts/i, 'the account page and the message must agree');
});

// ---------------------------------------------------------------------------
// The desk view
// ---------------------------------------------------------------------------

maybe('the console summary counts what needs acting on and what is finished', async () => {
  const before = await db.financing.counts();
  const lead = await makeLead();
  const after = await db.financing.counts();
  assert.equal(after.new, before.new + 1);
  assert.equal(after.total, before.total + 1);

  const desk = await financing.desk();
  assert.ok(Array.isArray(desk.partners));
  assert.ok(desk.activePartners.every((partner) => partner.active));
  assert.ok(desk.waiting.every((row) => row.status === 'new'), 'the waiting list is only untouched enquiries');
  assert.ok(desk.awaitingOutcome.every((row) => row.status === 'shared'), 'shared means sent, not answered');
  assert.ok(desk.queue.some((row) => row.id === lead.id));
  assert.equal(desk.counts.new + desk.counts.shared, desk.counts.open - desk.counts.contacted);
});

maybe('a duplicate partner name is refused rather than silently tolerated', async () => {
  const partner = await makePartner();
  const duplicate = await db.financing.createPartner({ name: partner.name, kind: 'bank', channel: 'manual' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /already on the list/i);
});

maybe('the account view gives the customer their reference and an honest state', async () => {
  const lead = await makeLead();
  const viewed = financing.accountView([lead])[0];
  assert.equal(viewed.reference, lead.reference);
  assert.match(viewed.statusSentence, /desk/i);
  assert.equal(viewed.partner, null);
  assert.match(viewed.url, /^\/financing\?ref=/);
});

// ---------------------------------------------------------------------------
// The wording itself
// ---------------------------------------------------------------------------

test('the customer-facing templates never promise a rate or an approval', () => {
  for (const template of ['financing_received', 'financing_handoff', 'financing_update']) {
    assert.ok(notify.TEMPLATES[template], `${template} must exist`);
  }

  const received = notify.render('financing_received', {
    name: 'Ada',
    reference: 'HC-FIN-000001',
    amount: '₦12,000,000',
    car: '2015 Toyota Camry',
  });
  assert.match(received, /not a lender/i);
  assert.doesNotMatch(received, /\binterest rate\b|\bAPR\b|\bapproved\b/i);

  const handoff = notify.render('financing_handoff', {
    partner: 'Example MFB',
    reference: 'HC-FIN-000001',
    customer: 'Ada',
    phone: '+2348031234567',
    car: '2015 Toyota Camry',
    amount: '₦12,000,000',
    down: '₦4,000,000',
    monthly: '₦250,000',
    tenor: '48 months',
    employment: 'salaried',
    timeline: 'month',
    notes: 'Wants the car this month.',
    address: 'ignored',
  });
  // A lender rep must be able to decide from the message alone, without calling
  // us: reference, who, how to reach them, the car, the money, the terms.
  for (const fragment of ['HC-FIN-000001', 'Ada', '+2348031234567', '₦12,000,000', '₦4,000,000', '₦250,000', '48 months']) {
    assert.ok(handoff.includes(fragment), `handoff message is missing ${fragment}`);
  }

  const update = notify.render('financing_update', {
    reference: 'HC-FIN-000001',
    status: financing.STATUS_SENTENCE.shared,
    partner: 'Example MFB',
  });
  assert.match(update, /not come back to us yet/i, '"shared" must never read as an answer');
});

// ---------------------------------------------------------------------------
// Over HTTP — what the browser actually gets
// ---------------------------------------------------------------------------

maybe('the page says what we are not, and works without JavaScript', async () => {
  const { response, html } = await require('./helpers').getHtml(ctx.baseUrl, '/financing');
  assert.equal(response.status, 200);

  assert.match(html, /data-financing-form/, 'the form is on the page');
  assert.match(html, /data-financing-status/);
  assert.match(html, /not a lender/i, 'who is lending is stated on the page, not just in a message');
  assert.doesNotMatch(html, /\b\d{1,2}(\.\d+)?\s?%\s?(apr|interest)/i, 'no rate may be printed on the page');

  // The arithmetic has one implementation, and it is the server's: the module is
  // shipped to call it, and the page explains the calculator before it runs.
  const script = await require('./helpers').getHtml(ctx.baseUrl, '/js/financing.js');
  assert.equal(script.response.status, 200, 'the module ships');
  assert.match(script.html, /initFinancing/);
});

maybe('the concierge form carries the financing answer into the brief', async () => {
  // The server can only create a financing lead from §6.5 step 3 if the answer
  // arrives — and the answer is a radio group, which contributes nothing to
  // FormData when it is not checked. This is the contract that the module keeps.
  const page = await require('./helpers').getHtml(ctx.baseUrl, '/find-my-car');
  assert.match(page.html, /name="financing"/, 'the question is asked');
  assert.match(page.html, /value="yes"/);

  const module_ = await require('./helpers').getHtml(ctx.baseUrl, '/js/service-forms.js');
  assert.match(module_.html, /brief\.financing = 'yes'/, 'the checked answer reaches the brief');
});

maybe('the plan endpoint answers with the arithmetic, and refuses nonsense', async () => {
  const good = await post('/api/financing/plan', { amount: '12000000', down: '4000000', monthly: '250000', tenor: '48' });
  assert.equal(good.status, 200, good.text);
  assert.equal(good.json.ok, true);
  assert.match(good.json.plan.headline, /before interest and fees/);
  assert.equal(good.json.plan.gapKobo, 800_000_000);

  const empty = await post('/api/financing/plan', { amount: '' });
  assert.equal(empty.status, 422);
  assert.match(empty.json.error, /budget|car/i);
});

maybe('the capture endpoint refuses consentless enquiries and a bad phone', async () => {
  const noConsent = await post('/api/financing', { name: 'No Consent', phone: PHONE, amount: '12000000' });
  assert.equal(noConsent.status, 422);
  assert.match(noConsent.json.error, /tick the box/i, 'the refusal says which box');

  const badPhone = await post('/api/financing', { name: 'Bad Phone', phone: 'nope', amount: '12000000', consent: 'yes' });
  assert.equal(badPhone.status, 422);

  const left = await db.queryOne('SELECT COUNT(*) AS n FROM financing_leads WHERE name LIKE ?', ['No Consent%']);
  assert.equal(Number(left.n), 0);
});

maybe('a submitted enquiry comes back with its reference and its state', async () => {
  const submitted = await post('/api/financing', {
    name: `${PREFIX} Http`,
    phone: PHONE,
    amount: '12000000',
    down: '4000000',
    monthly: '250000',
    tenor: '48',
    consent: 'yes',
    sourcePath: '/financing',
  });
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.json.ok, true);
  assert.match(submitted.json.reference, /^HC-FIN-\d{6}$/);
  assert.match(submitted.json.plan.headline, /before interest and fees/);

  const lead = await db.financing.findByReference(submitted.json.reference);
  created.leads.push(lead.id);
  assert.equal(lead.status, 'new');
  assert.equal(lead.partnerId, null);
});

maybe('a concierge brief that asks for financing creates the lead, once', async () => {
  const requested = await post('/api/service-requests', {
    kind: 'concierge',
    name: `${PREFIX} Concierge`,
    phone: PHONE,
    sla: 'standard',
    brief: { budget_max: '9000000', body: 'suv', timeline: 'two_weeks', financing: 'yes' },
    sourcePath: '/find-my-car',
  });
  assert.equal(requested.status, 200, requested.text);
  assert.ok(requested.json.financing, 'the answer to §6.5 step 3 must not be dropped on the floor');
  assert.match(requested.json.financing.reference, /^HC-FIN-\d{6}$/);

  const lead = await db.financing.findByReference(requested.json.financing.reference);
  created.leads.push(lead.id);
  assert.equal(lead.amountKobo, 900_000_000, 'the brief budget is the amount');
  assert.ok(lead.requestId, 'the lead is linked to the concierge request');
  assert.equal(lead.status, 'new');

  // The request itself is cleaned up with its retainer recording, which the
  // service owns — but the financing lead must not be orphaned data either, so
  // the link back to the request is asserted above and the rows removed here.
  await db.query('DELETE FROM financing_leads WHERE request_id = ?', [lead.requestId]).catch(() => {});
  await db.query('DELETE FROM service_requests WHERE id = ?', [lead.requestId]).catch(() => {});
  await db.query('DELETE FROM leads WHERE name LIKE ?', [`${PREFIX}%`]).catch(() => {});
});

maybe('a brief that does not want financing creates no lead', async () => {
  const requested = await post('/api/service-requests', {
    kind: 'concierge',
    name: `${PREFIX} NoFinance`,
    phone: PHONE,
    sla: 'standard',
    brief: { budget_max: '9000000', body: 'suv', timeline: 'month', financing: 'no' },
    sourcePath: '/find-my-car',
  });
  assert.equal(requested.status, 200, requested.text);
  assert.equal(requested.json.financing, null);
});
