'use strict';

/**
 * §7.3 Reports — date-ranged exports by pillar, inspector, dealer and UTM.
 *
 * The rules worth pinning down, because a report that is wrong is worse than no
 * report at all:
 *   • the window is half-open — a record created on the `to` day is in, the day
 *     after is out, and two adjacent windows never count it twice
 *   • the four shapes read the data the console already shows, and the money
 *     totals come from the ledger rather than through a multiplied join
 *   • a lead with no UTM is a row ("direct / none"), not a silently dropped one
 *   • CSV and PDF are the same table as the page, header and all
 *   • §7.4: every role with reports.view may read it, and nobody else reaches it
 *     at all — it is a read, and it is the one console screen everyone shares
 *
 * The suite writes nothing. That is the point of a report, and it is asserted:
 * the tables it reads are snapshotted before and compared after.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer } = require('./helpers');

let available = false;
let ctx;
let db;
let reports;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const run = (Number(process.pid) * 4099 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0809${String((run * 31 + seq * 733) % 10_000_000).padStart(7, '0')}`;
}

const createdPhones = new Set();
/** Row counts for every table a report reads, taken before the suite runs. */
let identityBefore = null;

function newClient() {
  let cookie = '';
  return {
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
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        headers: response.headers,
        text: buffer.toString('utf8'),
        buffer,
      };
    },
  };
}

async function createAccount(role, label) {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { canonical } = require('../src/lib/phone');
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    canonical(phone),
    `${label} (reports test)`,
    role,
    'active',
  ]);
  const row = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [canonical(phone)]);
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, `OTP failed: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', {
    method: 'POST',
    body: { phone, code: JSON.parse(otp.text).devCode },
  });
  assert.equal(verify.status, 200, `sign-in failed: ${verify.text}`);
  return { id: row.id, role, client };
}

/** What the database holds in the tables these reports read. */
async function identity() {
  const [requests, bookings, orders, leads, ledger] = await Promise.all([
    db.query('SELECT id FROM service_requests ORDER BY id'),
    db.query('SELECT id, status, payment_status FROM bookings ORDER BY id'),
    db.query('SELECT id, status FROM orders ORDER BY id'),
    db.query('SELECT id, utm FROM leads ORDER BY id'),
    db.query('SELECT id, amount_kobo FROM dealer_ledger ORDER BY id'),
  ]);
  return { requests, bookings, orders, leads, ledger };
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  reports = db.reports;
  identityBefore = await identity();
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (!available) return;
  if (createdPhones.size) {
    const { variants } = require('../src/lib/phone');
    const shapes = [...new Set([...createdPhones].flatMap((number) => variants(number)))];
    const marks = shapes.map(() => '?').join(',');
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
    await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, shapes);
    await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
  }
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The window — everything else depends on getting this right
// ---------------------------------------------------------------------------

test('the window includes its end day and never overlaps the next one', () => {
  const window = reports.windowBounds({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(window.start, '2026-09-01 00:00:00', 'from is the first instant of its day');
  assert.equal(window.end, '2026-10-01 00:00:00', 'to runs to the next midnight, so its own day is inside');

  // Two adjacent months share no instant: September ends where October starts.
  const october = reports.windowBounds({ from: '2026-10-01', to: '2026-10-31' });
  assert.equal(window.end, october.start, 'the months meet exactly');
});

test('an empty or absent window still returns something a reader can use', () => {
  const fallback = reports.windowBounds({});
  assert.match(fallback.start, /^\d{4}-\d{2}-\d{2} 00:00:00$/);
  assert.ok(fallback.start < fallback.end, 'a default window is a real range');
  const days = (new Date(fallback.end) - new Date(fallback.start)) / 86_400_000;
  assert.equal(days, 30, 'the default is a month, not a single day');
});

// ---------------------------------------------------------------------------
// The four shapes
// ---------------------------------------------------------------------------

maybe('pillar counts what actually came in, across every source table', async () => {
  const window = { from: '2020-01-01', to: '2026-12-31' };
  const rows = await reports.pillars(window);
  assert.ok(rows.length >= 3, 'the seed spans several pillars');
  for (const row of rows) {
    assert.ok(Number(row.total) >= 1, `${row.pillar}: a row exists because records exist`);
    assert.ok(Number(row.closed) <= Number(row.total), `${row.pillar}: closed cannot exceed total`);
    assert.ok(Number(row.paidKobo) >= 0);
  }
  // The same window read twice must agree with itself.
  assert.deepEqual(rows, await reports.pillars(window));

  // The pillar label is what the reader sees, and an unknown slug is not lost.
  assert.equal(reports.pillarLabel('concierge'), 'Concierge (find my car)');
  assert.equal(reports.pillarLabel('something-new'), 'something-new');
});

maybe('inspector names the unassigned work instead of hiding it', async () => {
  const rows = await reports.inspectors({ from: '2020-01-01', to: '2026-12-31' });
  assert.ok(rows.length >= 1);
  const total = rows.reduce((sum, row) => sum + Number(row.assigned), 0);
  const seen = await db.queryOne('SELECT COUNT(*) AS n FROM bookings');
  assert.equal(total, Number(seen.n), 'every booking is counted once, assigned or not');
  for (const row of rows) {
    assert.ok(Number(row.reports) <= Number(row.assigned), `${row.name || 'unassigned'}: more reports than jobs`);
    assert.ok(Number(row.passed) + Number(row.failed) <= Number(row.assigned));
  }
});

maybe('dealer money comes from the ledger, unmultiplied by the join', async () => {
  const rows = await reports.dealers({ from: '2020-01-01', to: '2026-12-31' });
  assert.ok(rows.length >= 5, 'the seed has a dozen lots');

  for (const row of rows) {
    const ledger = await db.queryOne(
      `SELECT COALESCE(SUM(amount_kobo), 0) AS net,
              COALESCE(SUM(CASE WHEN amount_kobo > 0 THEN amount_kobo ELSE 0 END), 0) AS earned,
              COALESCE(SUM(CASE WHEN amount_kobo < 0 THEN -amount_kobo ELSE 0 END), 0) AS paid
         FROM dealer_ledger WHERE dealer_id = ?`,
      [row.id],
    );
    assert.equal(Number(row.netKobo), Number(ledger.net), `${row.name}: net must match the ledger`);
    assert.equal(Number(row.earnedKobo), Number(ledger.earned), `${row.name}: commission must match`);
    assert.equal(Number(row.paidKobo), Number(ledger.paid), `${row.name}: payouts must match`);
    assert.equal(Number(row.netKobo), Number(row.earnedKobo) - Number(row.paidKobo), `${row.name}: net is the difference`);
  }

  // A lot with ledger entries really does report money — this is the assertion
  // the multiplied-join bug would fail.
  const withMoney = rows.filter((row) => Number(row.earnedKobo) > 0);
  assert.ok(withMoney.length >= 1, 'the seed pays commission to at least one lot');
  for (const row of withMoney) assert.ok(Number(row.listings) > 0, `${row.name}: a lot that earns has stock`);
});

maybe('a lead that arrived without a UTM is a row, not a gap', async () => {
  const rows = await reports.sources({ from: '2020-01-01', to: '2026-12-31' });
  assert.ok(rows.length >= 2, 'the seed has tracked and untracked leads');
  const direct = rows.find((row) => row.source === '(direct / none)');
  assert.ok(direct, 'untracked traffic is named');
  assert.equal(direct.medium, '—');
  const total = rows.reduce((sum, row) => sum + Number(row.leads), 0);
  const leads = await db.queryOne('SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at < ?', [
    '2020-01-01 00:00:00',
    '2027-01-01 00:00:00',
  ]);
  assert.equal(total, Number(leads.n), 'every lead lands in exactly one bucket');
});

maybe('a narrow window really narrows the answer', async () => {
  const empty = await reports.pillars({ from: '2019-01-01', to: '2019-01-31' });
  assert.equal(empty.length, 0, 'nothing existed then, and the report says so');

  const wide = await reports.pillars({ from: '2020-01-01', to: '2026-12-31' });
  assert.ok(wide.length > 0);
});

// ---------------------------------------------------------------------------
// The screen and the two files
// ---------------------------------------------------------------------------

maybe('the console shows the table, and offers both download formats', async () => {
  const ops = await createAccount('ops', 'Ops');
  const page = await ops.client.request('/admin/reports?by=dealer');
  assert.equal(page.status, 200);
  assert.match(page.text, /Report — Dealer/);
  assert.match(page.text, /Download CSV/);
  assert.match(page.text, /Download PDF/);
  // The tabs are the other three reports.
  for (const label of ['Pillar', 'Inspector', 'UTM']) assert.match(page.text, new RegExp(`>${label}<`), `${label} tab`);
  // The page carries the same rows the data layer returned.
  const rows = await reports.dealers({});
  assert.match(page.text, new RegExp(String(rows.length) + ' rows?'));
  if (rows.length) assert.match(page.text, new RegExp(rows[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'a dealer is named on the page');
});

maybe('the CSV is the same table, quoted correctly and dated', async () => {
  const ops = await createAccount('ops', 'Ops');
  const response = await ops.client.request('/admin/reports?by=utm&format=csv&from=2026-09-01&to=2026-09-30');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(response.headers.get('content-disposition'), /honest-cars-utm-2026-09-01-to-2026-09-30\.csv/);
  assert.ok(response.text.startsWith('\uFEFF'), 'the BOM that keeps Excel from mangling the naira sign');

  const lines = response.text.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], 'Honest Cars Ltd,UTM');
  const header = lines.findIndex((line) => line.startsWith('Source,'));
  assert.ok(header > -1, 'the table has a header row');
  assert.equal(lines[header], 'Source,Medium,Campaign,Leads,Closed,Lost');

  const rows = await reports.sources({ from: '2026-09-01', to: '2026-09-30' });
  const body = lines.slice(header + 1).filter(Boolean);
  assert.equal(body.length, rows.length, 'the file has exactly the rows the report returned');
  // A leading space or a missing quote would silently shift every column.
  for (const line of body) assert.equal(line.split(',').length >= 6, true, `wrong column count: ${line}`);
});

maybe('a value with a comma does not shift the columns in the CSV', async () => {
  const { csv } = require('../src/services/report-export');
  const text = csv({
    title: 'Test',
    description: 'Quoting',
    columns: [{ key: 'name', label: 'Name' }, { key: 'note', label: 'Note' }],
    rows: [{ name: 'Aba Road Autos, Ltd', note: 'He said "come tomorrow"' }],
  });
  const last = text.trim().split('\r\n').pop();
  assert.equal(last, '"Aba Road Autos, Ltd","He said ""come tomorrow"""');
});

maybe('the PDF is a real PDF with the report inside it', async () => {
  const ops = await createAccount('ops', 'Ops');
  const response = await ops.client.request('/admin/reports?by=pillar&format=pdf&from=2026-09-01&to=2026-09-30');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.match(response.headers.get('content-disposition'), /honest-cars-pillar-2026-09-01-to-2026-09-30\.pdf/);
  assert.equal(response.buffer.subarray(0, 5).toString(), '%PDF-', 'a real PDF stream, not an error page');
  assert.ok(response.buffer.includes(Buffer.from('%%EOF')), 'and it is complete');
  assert.ok(response.buffer.length > 2000, `too small to be a report: ${response.buffer.length} bytes`);
});

maybe('money reaches both files as naira, never as raw kobo', async () => {
  const { cell, naira } = require('../src/services/report-export');
  assert.equal(naira(18_000_000), '₦180,000');
  assert.equal(cell({ key: 'netKobo', format: 'money' }, { netKobo: 1_200_000_000 }), '₦12,000,000');
  assert.equal(cell({ key: 'earnedKobo', format: 'money' }, { earnedKobo: 0 }), '₦0');
  assert.equal(cell({ key: 'closed' }, { closed: 0 }), '0', 'a real zero is not a dash');
  assert.equal(cell({ key: 'avgHours' }, { avgHours: null }), '—', 'no value is a dash');
  assert.equal(cell({ key: 'name', format: 'name' }, { name: null }), 'Unassigned');
});

// ---------------------------------------------------------------------------
// §7.4 — it is a read, and everyone who may report may read it
// ---------------------------------------------------------------------------

maybe('every role with reports.view may read it, and the rest cannot reach it', async () => {
  const { can } = require('../src/services/roles');
  for (const role of ['admin', 'ops', 'finance', 'marketing']) {
    assert.ok(can(role, 'reports.view'), `${role} may report (§7.4)`);
  }
  for (const role of ['inspector', 'dealer', 'customer']) {
    assert.ok(!can(role, 'reports.view'), `${role} must not`);
  }

  // And the gate is real, not just the matrix: an inspector is refused.
  const inspector = await createAccount('inspector', 'Field');
  const refused = await inspector.client.request('/admin/reports');
  assert.equal(refused.status, 403, 'an inspector does not read the books');
  const csvRefused = await inspector.client.request('/admin/reports?by=dealer&format=csv');
  assert.equal(csvRefused.status, 403, 'not through the download either');
});

maybe('a report writes nothing at all', async () => {
  const ops = await createAccount('ops', 'Ops');
  for (const by of ['pillar', 'inspector', 'dealer', 'utm']) {
    for (const format of ['', '&format=csv', '&format=pdf']) {
      const response = await ops.client.request(`/admin/reports?by=${by}${format}`);
      assert.equal(response.status, 200, `${by}${format} failed`);
    }
  }
  assert.deepEqual(await identity(), identityBefore, 'the tables a report reads are untouched');
});
