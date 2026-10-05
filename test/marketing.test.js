'use strict';

/**
 * §15.2 Marketing dashboard — channel → lead → paid, and the CAC guardrail.
 *
 * A marketing report is the easiest thing in a console to get quietly wrong: it
 * merges four sources that share no key, and every merge is an assumption. The
 * assumptions are what this suite pins down, in the order a reader would check
 * them:
 *
 *   • the campaign the browser captured survives the server's sanitiser, and a
 *     hostile query string cannot put anything else in the events table
 *   • a lead's campaign is cleaned at the single choke point every form shares,
 *     so the viewing, concierge, sell/swap and service paths cannot disagree
 *   • money is credited to the *first* enquiry from that phone number, and a
 *     payer with no enquiry reads "(unattributed)" — never merged into direct
 *   • CAC divides spend by paid transactions only; pending money is not revenue
 *   • spend upserts on channel + period, so correcting an invoice cannot
 *     double-count it, and every write leaves an audit row
 *   • §7.4: admin, ops and marketing read the dashboard; finance and inspectors
 *     do not; only admin and marketing may enter spend
 *
 * Fixtures are created under a channel name of their own and deleted afterwards,
 * including the leads and payments the maths depends on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer } = require('./helpers');

let available = false;
let ctx;
let db;
let analytics;
let campaign;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const run = (Number(process.pid) * 4099 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0808${String((run * 31 + seq * 733) % 10_000_000).padStart(7, '0')}`;
}

/**
 * The window the fixtures live in. Far enough back to be entirely inside every
 * query the dashboard runs, and named so a leaked fixture is obvious.
 */
const TAG = `mkt-${String(run).slice(-5)}`;
const CHANNEL = `${TAG}-channel`;

const created = { leads: [], payments: [], events: [], spend: [], users: [], phones: new Set() };

function newClient() {
  let cookie = '';
  return {
    setCookie(value) {
      cookie = value;
    },
    async request(path, { method = 'GET', body, form, headers = {} } = {}) {
      const payload = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined;
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
      return { status: response.status, text, json, headers: response.headers };
    },
  };
}

/**
 * A signed-in staff account, without the OTP dance.
 *
 * The gate is what these tests are about, not sign-in, and every OTP round trip
 * is a database write the auth flow will not take back — the events it records
 * carry no phone number, so a suite that signs in five people cannot clean up
 * after itself. Minting the session directly is exact: create the user, create
 * the session the same way the verify route does, hand the client the cookie.
 */
async function createAccount(role, label) {
  const phone = nextPhone();
  created.phones.add(phone);
  const { canonical } = require('../src/lib/phone');
  const auth = require('../src/services/auth');
  const number = canonical(phone);
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    number,
    `${label} (marketing test)`,
    role,
    'active',
  ]);
  created.users.push(number);
  const user = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [number]);
  const token = auth.newSessionToken();
  await db.query('INSERT INTO sessions (user_id, token_hash, expires_at, user_agent) VALUES (?, ?, ?, ?)', [
    user.id,
    auth.hashToken(token),
    new Date(Date.now() + 30 * 86_400_000),
    'marketing test',
  ]);
  const client = newClient();
  client.setCookie(`hc_session=${token}`);
  return { phone: number, id: user.id, role, client };
}

/** A lead for a fixture phone, with the campaign the browser would have sent. */
async function createLead({ phone, utm, createdAt, status = 'new', type = 'viewing' }) {
  const { canonical } = require('../src/lib/phone');
  const result = await db.query(
    `INSERT INTO leads (type, name, phone, message, source_path, utm, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      type,
      `${TAG} buyer`,
      canonical(phone),
      'fixture — marketing test',
      '/cars',
      utm ? JSON.stringify(utm) : null,
      status,
      createdAt,
    ],
  );
  created.leads.push(result.insertId);
  return result.insertId;
}

async function createPayment({ phone, amountKobo, purpose = 'order', status = 'paid', paidAt = null, createdAt }) {
  const { canonical } = require('../src/lib/phone');
  const result = await db.query(
    `INSERT INTO payments (reference, provider, purpose, customer_name, customer_phone, amount_kobo, currency, status, paid_at, created_at)
     VALUES (?, 'manual', ?, ?, ?, ?, 'NGN', ?, ?, ?)`,
    [
      `${TAG.slice(0, 12).toUpperCase()}-${created.payments.length + 1}`,
      purpose,
      `${TAG} buyer`,
      canonical(phone),
      amountKobo,
      status,
      status === 'paid' ? (paidAt || createdAt) : null,
      createdAt,
    ],
  );
  created.payments.push(result.insertId);
  return result.insertId;
}

/** One page view by one visitor, carrying the campaign the browser captured. */
async function createEvent({ sessionId, name = 'listing_view', utm = null, createdAt }) {
  const result = await db.query(
    `INSERT INTO analytics_events (event_name, payload, source_path, session_id, created_at)
     VALUES (?, ?, '/cars', ?, ?)`,
    [name, utm ? JSON.stringify({ utm }) : null, sessionId, createdAt],
  );
  created.events.push(result.insertId);
  return result.insertId;
}

/** A date inside the fixture window: N days ago at noon UTC. */
function daysAgo(n) {
  const day = new Date(Date.now() - n * 86_400_000);
  return `${day.toISOString().slice(0, 10)} 12:00:00`;
}

const from = daysAgo(20).slice(0, 10);
const toIso = new Date().toISOString().slice(0, 10);
const window = { from, to: toIso };
const bounds = () => require('../src/db/reports').windowBounds(window);

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  analytics = db.analytics;
  campaign = require('../src/lib/campaign');
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (!available) return;
  const marks = (n) => Array.from({ length: n }, () => '?').join(',');
  if (created.events.length) await db.query(`DELETE FROM analytics_events WHERE id IN (${marks(created.events.length)})`, created.events);
  if (created.spend.length) await db.query(`DELETE FROM marketing_spend WHERE id IN (${marks(created.spend.length)})`, created.spend);
  if (created.payments.length) await db.query(`DELETE FROM payments WHERE id IN (${marks(created.payments.length)})`, created.payments);
  if (created.leads.length) await db.query(`DELETE FROM leads WHERE id IN (${marks(created.leads.length)})`, created.leads);
  if (created.users.length) {
    // Audit rows first: history that points at a deleted actor is worse than none.
    await db.query(`DELETE FROM admin_audit WHERE actor_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks(created.users.length)}))`, created.users);
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks(created.users.length)}))`, created.users);
    await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks(created.users.length)})`, created.users);
    await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks(created.users.length)})`, created.users);
  }
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The campaign itself
// ---------------------------------------------------------------------------

test('a campaign keeps its five keys, is capped, and drops everything else', () => {
  const clean = campaign.sanitizeUtm({
    source: 'instagram',
    medium: 'social',
    campaign: 'x'.repeat(200),
    content: 'reel-3',
    term: 'suv port harcourt',
    junk: 'not stored',
    'source; DROP': 'no',
  });
  assert.deepEqual(Object.keys(clean), ['source', 'medium', 'campaign', 'content', 'term']);
  assert.equal(clean.campaign.length, 80, 'values are capped, not truncated by the caller');
  assert.equal(clean.junk, undefined);

  // Shapes that are not a campaign object at all: no half-kept rubbish.
  assert.equal(campaign.sanitizeUtm(null), null);
  assert.equal(campaign.sanitizeUtm('instagram'), null);
  assert.equal(campaign.sanitizeUtm(['instagram']), null);
  assert.equal(campaign.sanitizeUtm({ source: { nested: true }, medium: 3 }), null);
  assert.equal(campaign.sanitizeUtm({ source: '   ' }), null);
});

test('a click id means the network that issued it, and no campaign means direct', () => {
  assert.equal(campaign.channelOf({ source: 'google', medium: 'cpc' }), 'google');
  assert.equal(campaign.channelOf(null), '(direct / none)');
  assert.equal(campaign.channelOf({ medium: 'social' }), '(direct / none)', 'a medium without a source is not a channel');
});

test('the server keeps a campaign on an event and refuses anything else in it', async () => {
  const events = require('../src/services/events');
  const kept = events.sanitizePayload({ utm: { source: 'facebook', medium: 'social', evil: 'x' } });
  assert.deepEqual(kept, { utm: { source: 'facebook', medium: 'social' } });

  const hostile = events.sanitizePayload({ utm: { source: { $ne: 1 }, medium: ['a'] } });
  assert.equal(hostile, null, 'a campaign that is not five strings is not a campaign');
});

maybe('every form path cleans the campaign at the one choke point they share', async () => {
  // Four public forms open a lead — viewing, concierge, sell/swap, services —
  // and they all call db.leads.createLead. Cleaning there is what stops the
  // channel report depending on which form someone happened to use.
  const phone = nextPhone();
  const created1 = await db.leads.createLead({
    type: 'concierge',
    name: `${TAG} brief`,
    phone,
    sourcePath: '/find-my-car',
    utm: { source: 'google', medium: 'cpc', campaign: 'ph-inspection', junk: 'drop me' },
  });
  created.leads.push(created1.id);
  const row = await db.queryOne('SELECT utm FROM leads WHERE id = ?', [created1.id]);
  const parsed = typeof row.utm === 'string' ? JSON.parse(row.utm) : row.utm;
  assert.deepEqual(parsed, { source: 'google', medium: 'cpc', campaign: 'ph-inspection' });

  // A visitor who came in with no campaign stores nothing, rather than an
  // empty object that would report as a channel of its own.
  const created2 = await db.leads.createLead({
    type: 'viewing',
    name: `${TAG} direct`,
    phone: nextPhone(),
    sourcePath: '/cars',
    utm: null,
  });
  created.leads.push(created2.id);
  const direct = await db.queryOne('SELECT utm FROM leads WHERE id = ?', [created2.id]);
  assert.equal(direct.utm, null);
});

// ---------------------------------------------------------------------------
// The join: channel → lead → paid
// ---------------------------------------------------------------------------

maybe('money is credited to the first enquiry from that phone, not the last', async () => {
  const phone = nextPhone();
  // The same buyer, twice: Instagram brought them in a fortnight earlier, a
  // Google search re-found them this week. First touch wins.
  await createLead({ phone, utm: { source: 'instagram', medium: 'social' }, createdAt: daysAgo(14) });
  await createLead({ phone, utm: { source: 'google', medium: 'cpc' }, createdAt: daysAgo(2) });
  await createPayment({ phone, amountKobo: 5_000_000, createdAt: daysAgo(1) });

  const summary = await analytics.marketingSummary(window);
  const instagram = summary.rows.find((row) => row.channel === 'instagram');
  const google = summary.rows.find((row) => row.channel === 'google');
  assert.ok(instagram, 'the first-touch channel has a row');
  assert.ok(instagram.paidKobo >= 5_000_000, 'the payment is credited to Instagram');
  assert.ok(!google || google.paidKobo < 5_000_000 || google.channel !== 'google');
});

maybe('a payer with no enquiry behind them is unattributed, not direct traffic', async () => {
  const phone = nextPhone();
  await createPayment({ phone, amountKobo: 3_300_000, createdAt: daysAgo(3) });

  const summary = await analytics.marketingSummary(window);
  const unattributed = summary.rows.find((row) => row.channel === '(unattributed)');
  assert.ok(unattributed, 'the payer gets their own row');
  assert.ok(unattributed.paidKobo >= 3_300_000);
  const direct = summary.rows.find((row) => row.channel === '(direct / none)');
  assert.ok(!direct || direct.paidKobo === 0, 'direct is not padded with unattributed money');
});

maybe('CAC divides spend by paid transactions, and pending money is not revenue', async () => {
  const channel = CHANNEL;
  const phone = nextPhone();
  await createLead({ phone, utm: { source: channel, medium: 'test' }, createdAt: daysAgo(6) });
  await createPayment({ phone, amountKobo: 4_000_000, createdAt: daysAgo(4) });
  // Pending: on the screen it is money in flight, never revenue.
  await createPayment({ phone, amountKobo: 9_000_000, status: 'pending', createdAt: daysAgo(4) });
  const spend = await analytics.recordSpend({
    channel,
    periodStart: from,
    periodEnd: toIso,
    amountKobo: 8_000_000,
    note: 'fixture',
  });
  created.spend.push(spend.id);

  const summary = await analytics.marketingSummary(window);
  const row = summary.rows.find((entry) => entry.channel === channel);
  assert.ok(row, 'the fixture channel is in the report');
  assert.equal(row.payments, 1, 'one paid transaction');
  assert.equal(row.paidKobo, 4_000_000, 'the pending payment is excluded');
  assert.equal(row.spendKobo, 8_000_000);
  assert.equal(row.cac, 8_000_000, 'spend ÷ paid transactions');
  assert.equal(row.roas, 0.5);

  assert.ok(summary.pending.payments >= 1, 'pending money is reported separately');
  assert.ok(summary.pending.kobo >= 9_000_000);
  assert.ok(summary.spendPeriods.length >= 1, 'the screen can say which periods it counted');
});

maybe('traffic is counted once per visit, not once per event', async () => {
  const sessionId = `${TAG}-session-1`;
  await createEvent({ sessionId, name: 'listing_impression', utm: { source: CHANNEL, medium: 'test' }, createdAt: daysAgo(7) });
  await createEvent({ sessionId, name: 'listing_view', utm: { source: CHANNEL, medium: 'test' }, createdAt: daysAgo(7) });
  await createEvent({ sessionId, name: 'listing_view', utm: { source: CHANNEL, medium: 'test' }, createdAt: daysAgo(7) });

  const summary = await analytics.marketingSummary(window);
  const row = summary.rows.find((entry) => entry.channel === CHANNEL);
  assert.equal(row.sessions, 1, 'three events, one visit');
  assert.equal(row.listingViews, 2);
});

maybe('recording the same channel and period again corrects it instead of doubling it', async () => {
  const channel = `${CHANNEL}-upsert`;
  const first = await analytics.recordSpend({
    channel,
    periodStart: from,
    periodEnd: toIso,
    amountKobo: 1_000_000,
  });
  created.spend.push(first.id);
  assert.equal(first.updated, false);

  const again = await analytics.recordSpend({
    channel,
    periodStart: from,
    periodEnd: toIso,
    amountKobo: 2_500_000,
    note: 'corrected',
  });
  created.spend.push(again.id);
  assert.equal(again.updated, true, 'the second write is an update');
  assert.equal(again.id, first.id, 'and it is the same row');

  const summary = await analytics.marketingSummary(window);
  const row = summary.rows.find((entry) => entry.channel === channel);
  assert.equal(row.spendKobo, 2_500_000, 'corrected, not 1,000,000 + 2,500,000');
  assert.equal(row.spendEntries, 1);
});

// ---------------------------------------------------------------------------
// The page and its gate (§7.4)
// ---------------------------------------------------------------------------

maybe('admin, ops and marketing read the dashboard; finance and inspectors do not', async () => {
  const accounts = {};
  for (const role of ['admin', 'ops', 'marketing', 'finance', 'inspector']) {
    accounts[role] = await createAccount(role, `Marketing ${role}`);
  }
  for (const role of ['admin', 'ops', 'marketing']) {
    const response = await accounts[role].client.request('/admin/marketing');
    assert.equal(response.status, 200, `${role} should read the marketing dashboard`);
    assert.match(response.text, /Channel/, 'and gets the report itself');
  }
  for (const role of ['finance', 'inspector']) {
    const response = await accounts[role].client.request('/admin/marketing');
    assert.equal(response.status, 403, `${role} should be refused (§7.4)`);
  }
  const anonymous = await newClient().request('/admin/marketing');
  assert.equal(anonymous.status, 302, 'anonymous is sent to sign in');
  assert.match(anonymous.headers.get('location') || '', /login/);

  global.__marketingAccounts = accounts;
});

maybe('only admin and marketing may enter spend, and the write is audited', async () => {
  const accounts = global.__marketingAccounts;
  assert.ok(accounts, 'the role fixtures ran first');

  const body = {
    channel: `${CHANNEL}-route`,
    period_start: from,
    period_end: toIso,
    amount: '₦12,500',
    note: 'fixture via route',
  };

  const refused = await accounts.ops.client.request('/admin/marketing/spend', { method: 'POST', form: body });
  assert.equal(refused.status, 403, 'ops reads the dashboard but does not enter invoices');

  const saved = await accounts.marketing.client.request('/admin/marketing/spend', { method: 'POST', form: body });
  assert.equal(saved.status, 303, `marketing may enter spend: ${saved.text.slice(0, 160)}`);
  const row = await db.queryOne('SELECT id, amount_kobo, note FROM marketing_spend WHERE channel = ? LIMIT 1', [body.channel]);
  assert.ok(row, 'the invoice landed');
  created.spend.push(row.id);
  assert.equal(Number(row.amount_kobo), 1_250_000, '₦12,500 parsed to kobo');

  const audit = await db.queryOne(
    "SELECT action FROM admin_audit WHERE entity = 'marketing_spend' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [row.id],
  );
  assert.equal(audit.action, 'marketing.spend_recorded', 'a number that moves a CAC has a name on it');

  // Nonsense in, refusal out — never a silently wrong number.
  const bad = await accounts.marketing.client.request('/admin/marketing/spend', {
    method: 'POST',
    form: { channel: body.channel, period_start: from, period_end: toIso, amount: 'lots' },
  });
  assert.equal(bad.status, 303, 'a bad amount returns to the screen');
  assert.match(decodeURIComponent(bad.headers.get('location') || ''), /err=/);
});

maybe('the screen flags a channel that spends without converting', async () => {
  const accounts = global.__marketingAccounts;
  const spend = await analytics.recordSpend({
    channel: `${CHANNEL}-idle`,
    periodStart: from,
    periodEnd: toIso,
    amountKobo: 4_500_000,
    note: 'fixture — no conversions',
  });
  created.spend.push(spend.id);

  const response = await accounts.admin.client.request('/admin/marketing');
  assert.equal(response.status, 200);
  assert.match(response.text, /no paid conversions yet/, 'spend with nothing back is called out');
  assert.match(response.text, /Record what a channel cost/, 'and the spend form is there for those who may use it');

  const marketingView = await accounts.marketing.client.request('/admin/marketing');
  assert.match(marketingView.text, /Record what a channel cost/, 'the marketing desk may enter spend');

  const opsView = await accounts.ops.client.request('/admin/marketing');
  assert.doesNotMatch(opsView.text, /Record what a channel cost/, 'ops reads the report without the write form');
});

// ---------------------------------------------------------------------------
// The browser half — the campaign has to be captured before any of the above
// can report anything, and this is the only place the shipped client module
// runs without a browser.
// ---------------------------------------------------------------------------

/**
 * Load public/js/events.js with just enough of a DOM to run.
 *
 * The real module is what ships, not a copy: a test that reimplements the
 * capture would pass while the site stayed broken.
 */
async function loadEventsModule({ url = 'https://honestcarsltd.com/cars', storage = new Map() } = {}) {
  const sessionStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const listeners = { click: [], pagehide: [], visibilitychange: [] };
  global.window = {
    HonestCars: { config: { source: 'web' }, eventNames: ['listing_view', 'listing_impression', 'whatsapp_click'] },
    addEventListener: (type, fn) => listeners[type]?.push(fn),
    gtag: undefined,
  };
  global.document = {
    addEventListener: (type, fn) => listeners[type]?.push(fn),
    visibilityState: 'visible',
  };
  global.location = new URL(url);
  global.sessionStorage = sessionStorage;
  global.navigator.sendBeacon = undefined;

  // Imported through a data URL, because the repository is CommonJS (a bare
  // import of a `.js` file here is parsed as CJS and cannot hold `export`).
  // The bytes are the shipped file, read fresh — nothing is stubbed away.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'public', 'js', 'events.js'),
    'utf8',
  );
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const module = await import(`data:text/javascript;base64,${encoded}#${Date.now()}`);
  return { module, storage, listeners };
}

test('the landing campaign is captured once and survives the rest of the visit', async () => {
  const { module, storage } = await loadEventsModule({
    url: 'https://honestcarsltd.com/cars?utm_source=instagram&utm_medium=social&utm_campaign=ph-suv-september',
  });
  assert.deepEqual(module.utm(), { source: 'instagram', medium: 'social', campaign: 'ph-suv-september' });
  assert.ok(storage.get('hc_utm'), 'kept for the tab, not re-read from every URL');

  // A second page view in the same session, with no campaign on the URL at all.
  global.location = new URL('https://honestcarsltd.com/cars/2015-toyota-camry');
  assert.deepEqual(module.utm(), { source: 'instagram', medium: 'social', campaign: 'ph-suv-september' },
    'first touch wins — browsing on does not erase where they came from');
});

test('a paid click id is a channel, and no campaign is no campaign', async () => {
  const gclid = await loadEventsModule({ url: 'https://honestcarsltd.com/find-my-car?gclid=abc123' });
  assert.deepEqual(gclid.module.utm(), { source: 'google', medium: 'cpc' });

  const fbclid = await loadEventsModule({ url: 'https://honestcarsltd.com/cars?fbclid=xyz' });
  assert.deepEqual(fbclid.module.utm(), { source: 'facebook', medium: 'cpc' });

  const plain = await loadEventsModule({ url: 'https://honestcarsltd.com/' });
  assert.deepEqual(plain.module.utm(), {}, 'direct traffic is not assigned an invented channel');
});

test('every queued event carries the campaign to the server', async () => {
  const { module } = await loadEventsModule({
    url: 'https://honestcarsltd.com/cars?utm_source=tiktok&utm_medium=social',
  });
  let sent = null;
  const realFetch = global.fetch;
  global.fetch = async (path, options) => {
    sent = JSON.parse(options.body);
    return { ok: true };
  };
  try {
    module.track('listing_view', { listing_id: 12 });
    await module.flush();
  } finally {
    global.fetch = realFetch;
  }
  assert.ok(sent, 'the batch went out');
  assert.equal(sent.events.length, 1);
  assert.deepEqual(sent.events[0].payload.utm, { source: 'tiktok', medium: 'social' });
  assert.equal(sent.events[0].name, 'listing_view');
});
