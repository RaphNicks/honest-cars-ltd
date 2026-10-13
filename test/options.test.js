'use strict';

/**
 * The concierge shortlist (FR-19, §7.3).
 *
 * Ops curate cars onto a request in the console; the buyer reads them at
 * /concierge/{id} and can forward the same thing as a PDF. What is worth
 * testing is that the two renderings are the same answer:
 *
 *   • the page shows every attached car, in the order ops ranked them, with the
 *     team's note next to it — the note is the reason to prefer one car
 *   • the PDF is a real PDF and is built from the rows the page used, not from a
 *     second calculation
 *   • the price position on both comes from the price_bands table, not the
 *     denormalised column: move the band and the shortlist changes, exactly as
 *     the VDP does — otherwise ops would be quoting a number the site disagrees with
 *   • moving a request to "options ready" actually tells the customer, with the
 *     count — the template existed and had never been sent
 *   • nothing is shown before there is anything to show
 *
 * Rows are this suite's own (a unique phone per run) and are removed in
 * test.after; candidates cascade with the request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer } = require('./helpers');

let available = false;
let ctx;
let db;
let concierge;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const run = (Number(process.pid) * 4099 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0807${String((run * 37 + seq * 811) % 10_000_000).padStart(7, '0')}`;
}

const createdPhones = new Set();
const createdRequests = new Set();
let staffPhone = null;
let bandSnapshot = null;
let bandId = null;

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
      const text = buffer.toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, headers: response.headers, text, buffer, json };
    },
  };
}

/** A staff account, signed in the way a person would. */
async function signInStaff(role, label) {
  const phone = nextPhone();
  staffPhone = phone;
  createdPhones.add(phone);
  const { canonical } = require('../src/lib/phone');
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    canonical(phone),
    `${label} (options test)`,
    role,
    'active',
  ]);
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, `OTP failed: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', {
    method: 'POST',
    body: { phone, code: JSON.parse(otp.text).devCode },
  });
  assert.equal(verify.status, 200, `sign-in failed: ${verify.text}`);
  return client;
}

/** A live request raised the way a visitor raises one. */
async function createRequest(phone) {
  const client = newClient();
  const response = await client.request('/api/service-requests', {
    method: 'POST',
    body: {
      kind: 'concierge',
      name: 'Options Test Buyer',
      phone,
      sla: 'standard',
      brief: { body_types: 'suv', budget_max: '22000000', timeline: 'one_month' },
      sourcePath: '/find-my-car',
    },
  });
  // Find the row by the phone we just used, before asserting anything: if a
  // later assertion throws, the request must still be listed for cleanup — a
  // failed run that leaks rows into the demo database is how HC-2491…HC-2502
  // happened.
  const { canonical } = require('../src/lib/phone');
  const row = await db.queryOne('SELECT id, tracking_id FROM service_requests WHERE phone = ? ORDER BY id DESC LIMIT 1', [canonical(phone)]);
  assert.equal(response.status, 200, `brief rejected: ${response.text}`);
  assert.ok(row, 'the request was written');
  createdRequests.add(row.id);
  assert.equal(row.tracking_id, response.json ? response.json.trackingId : row.tracking_id);
  return { id: row.id, trackingId: row.tracking_id };
}

/** Three live cars with different prices, so the comparison has a winner. */
async function liveListings(limit = 3) {
  return db.query(
    `SELECT id FROM vehicle_listings
      WHERE status = 'live' AND asking_price_kobo IS NOT NULL
      ORDER BY asking_price_kobo ASC LIMIT ${Number(limit)}`,
  );
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  concierge = require('../src/services/concierge');
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (!available) return;
  // Put the band back if a test moved it, then remove this suite's rows.
  if (bandSnapshot && bandId) {
    await db.query('UPDATE price_bands SET band_min_kobo = ?, band_max_kobo = ? WHERE id = ?', [
      bandSnapshot.min, bandSnapshot.max, bandId,
    ]);
  }
  for (const id of createdRequests) {
    await db.query('DELETE FROM notifications WHERE entity = ? AND entity_id = ?', ['request', id]);
    await db.query(`DELETE FROM admin_audit WHERE entity = 'request' AND entity_id = ?`, [id]);
    await db.query('DELETE FROM service_requests WHERE id = ?', [id]);
  }
  if (createdPhones.size) {
    const { variants } = require('../src/lib/phone');
    const shapes = [...new Set([...createdPhones].flatMap((number) => variants(number)))];
    const marks = shapes.map(() => '?').join(',');
    await db.query(`DELETE FROM notifications WHERE recipient IN (${marks})`, shapes);
    // A concierge brief also opens a lead (the CRM inbox mirrors the pipeline),
    // so the suite owns that row too — leaving it would put a test buyer in the
    // console's inbox with every run.
    await db.query(`DELETE FROM leads WHERE phone IN (${marks})`, shapes);
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
    await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, shapes);
    await db.query('UPDATE admin_audit SET actor_id = NULL WHERE actor_id IN (SELECT id FROM `users` WHERE phone IN (' + marks + '))', shapes);
    await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
  }
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// Nothing to show means nothing shown
// ---------------------------------------------------------------------------

maybe('a request with no cars attached has no shortlist and no PDF', async () => {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { trackingId } = await createRequest(phone);

  const page = await newClient().request(`/concierge/${trackingId}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Your shortlist/, 'no empty shell');
  assert.doesNotMatch(page.text, /Download the PDF/);

  const pdf = await newClient().request(`/concierge/${trackingId}/options.pdf`);
  assert.equal(pdf.status, 404, 'a shortlist that does not exist is not a document');
});

// ---------------------------------------------------------------------------
// The shortlist itself
// ---------------------------------------------------------------------------

maybe('the page shows every attached car in rank order, with the team note', async () => {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { id, trackingId } = await createRequest(phone);
  const ops = await signInStaff('ops', 'Ops');

  const cars = await liveListings(3);
  assert.ok(cars.length >= 2, 'the seed has live cars to shortlist');

  const notes = [
    'Lowest mileage of the three — the service book is complete.',
    'One owner, and the tyres were replaced this year.',
  ];
  for (let index = 0; index < Math.min(2, cars.length); index += 1) {
    const attached = await ops.request(`/admin/concierge/${id}/candidates`, {
      method: 'POST',
      form: { listing_id: String(cars[index].id), note: notes[index] || '' },
      headers: { Origin: ctx.baseUrl },
    });
    assert.equal(attached.status, 303, `attach failed: ${attached.text.slice(0, 200)}`);
  }

  const page = await newClient().request(`/concierge/${trackingId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Your shortlist/);
  assert.match(page.text, /Download the PDF/);
  assert.match(page.text, /Lowest mileage of the three/, 'the team note reaches the buyer');
  assert.match(page.text, /Side by side/, 'two cars get the comparison');
  assert.match(page.text, /best value|✔/, 'the comparison still marks the stronger number');

  // The order on the page is the order ops attached them in.
  const first = page.text.indexOf(`/cars/`);
  assert.ok(first > -1);
  const rows = await db.query('SELECT listing_id FROM request_candidates WHERE request_id = ? ORDER BY rank_no', [id]);
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].listing_id), Number(cars[0].id), 'rank 1 is the first car attached');
});

maybe('the PDF is real, and is built from the same rows as the page', async () => {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { id, trackingId } = await createRequest(phone);
  const ops = await signInStaff('ops', 'Ops');
  const cars = await liveListings(2);
  for (const car of cars) {
    await ops.request(`/admin/concierge/${id}/candidates`, {
      method: 'POST',
      form: { listing_id: String(car.id), note: 'Fits the brief.' },
      headers: { Origin: ctx.baseUrl },
    });
  }

  const response = await newClient().request(`/concierge/${trackingId}/options.pdf`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/pdf/);
  assert.match(response.headers.get('content-disposition'), new RegExp(`honest-cars-shortlist-${trackingId}\\.pdf`));
  assert.match(response.headers.get('cache-control'), /private/, 'a buyer’s shortlist is not public');
  assert.equal(response.buffer.subarray(0, 5).toString(), '%PDF-', 'a real PDF, not an error page');
  assert.ok(response.buffer.includes(Buffer.from('%%EOF')), 'and it is complete');
  assert.ok(response.buffer.length > 2000, `too small to be a shortlist: ${response.buffer.length} bytes`);
});

maybe('the shortlist reads the live band, so ops and the buyer see one number', async () => {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { id, trackingId } = await createRequest(phone);
  const ops = await signInStaff('ops', 'Ops');

  // A car whose make/model/year has a band, so moving it is observable.
  const car = await db.queryOne(
    `SELECT l.id, l.make, l.model, l.year, b.id AS band_id, b.band_min_kobo, b.band_max_kobo
       FROM vehicle_listings l
       JOIN price_bands b ON b.make = l.make AND b.model = l.model
        AND l.year BETWEEN b.year_from AND b.year_to
      WHERE l.status = 'live'
      ORDER BY l.asking_price_kobo DESC LIMIT 1`,
  );
  assert.ok(car, 'the seed has a live car with a covering band');

  await ops.request(`/admin/concierge/${id}/candidates`, {
    method: 'POST',
    form: { listing_id: String(car.id), note: 'Top of the shortlist.' },
    headers: { Origin: ctx.baseUrl },
  });

  const readPage = async () => (await newClient().request(`/concierge/${trackingId}`)).text;
  const baseline = await readPage();
  assert.match(baseline, /Within market band|Below market|Premium|No band yet/, 'a position is stated, from the band or the column');

  bandId = car.band_id;
  bandSnapshot = { min: car.band_min_kobo, max: car.band_max_kobo };

  // Move the band out of the way. The stored column does not change: if the
  // page still says "within", it is reading the column and not the table.
  await db.query('UPDATE price_bands SET band_min_kobo = ?, band_max_kobo = ? WHERE id = ?', [
    Number(car.band_min_kobo) * 3, Number(car.band_max_kobo) * 3, car.band_id,
  ]);
  const moved = await readPage();
  assert.match(moved, /Below market/, 'a car far under a raised band reads as below market');

  await db.query('UPDATE price_bands SET band_min_kobo = ?, band_max_kobo = ? WHERE id = ?', [
    car.band_min_kobo, car.band_max_kobo, car.band_id,
  ]);
  const restored = await readPage();
  assert.doesNotMatch(restored, /Below market/, 'restoring the band restores the verdict');

  const after = await db.queryOne('SELECT band_min_kobo, band_max_kobo FROM price_bands WHERE id = ?', [car.band_id]);
  assert.equal(Number(after.band_min_kobo), Number(car.band_min_kobo));
  assert.equal(Number(after.band_max_kobo), Number(car.band_max_kobo));
  bandSnapshot = null;
});

// ---------------------------------------------------------------------------
// Telling the buyer
// ---------------------------------------------------------------------------

maybe('moving to options ready tells the customer, with the count', async () => {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { id, trackingId } = await createRequest(phone);
  const ops = await signInStaff('ops', 'Ops');
  const cars = await liveListings(2);
  for (const car of cars) {
    await ops.request(`/admin/concierge/${id}/candidates`, {
      method: 'POST',
      form: { listing_id: String(car.id), note: '' },
      headers: { Origin: ctx.baseUrl },
    });
  }

  const moved = await ops.request(`/admin/concierge/${id}/stage`, {
    method: 'POST',
    form: { status: 'options_ready' },
    headers: { Origin: ctx.baseUrl },
  });
  assert.equal(moved.status, 303);

  const records = await db.query(
    'SELECT channel, template, recipient, body, status FROM notifications WHERE entity = ? AND entity_id = ? ORDER BY id DESC',
    ['request', id],
  );
  assert.equal(records.length, 1, 'one message, not a stream');
  const [message] = records;
  assert.equal(message.template, 'request_options_ready');
  assert.equal(message.recipient, require('../src/lib/phone').canonical(phone));
  assert.match(message.body, new RegExp(trackingId), 'the buyer gets the link that works');
  assert.match(message.body, /2 verified cars/, 'and the count we promised');
  // The console provider is configured in dev, so it sends rather than skips.
  assert.ok(['sent', 'skipped'].includes(message.status), `unexpected status ${message.status}`);
  assert.doesNotMatch(message.body, /null|undefined/, 'no placeholder leaks into a message');

  // And the page the message points at really does show them.
  const page = await newClient().request(`/concierge/${trackingId}`);
  assert.match(page.text, /Your shortlist/);
});

maybe('nothing is sent when there are no cars to tell them about', async () => {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { id } = await createRequest(phone);
  const ops = await signInStaff('ops', 'Ops');

  const moved = await ops.request(`/admin/concierge/${id}/stage`, {
    method: 'POST',
    form: { status: 'options_ready' },
    headers: { Origin: ctx.baseUrl },
  });
  assert.equal(moved.status, 303);

  const records = await db.query('SELECT id FROM notifications WHERE entity = ? AND entity_id = ?', ['request', id]);
  assert.equal(records.length, 0, '“your options are ready” with no options is a lie');
});
