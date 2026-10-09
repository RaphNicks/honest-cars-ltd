'use strict';

/**
 * Inventory pricing intel — §7.3, the market price-band table.
 *
 * The table is load-bearing, so the rules worth testing are the ones that make
 * it trustworthy:
 *   • §7.4 sends it to admin and ops; marketing may read it and nobody else
 *     may see it at all
 *   • the weekly form creates a band or moves the existing one — one row per
 *     make/model/years/condition, never a duplicate
 *   • a band really drives the price-position indicator: move the band and the
 *     live VDP changes its verdict, without re-seeding
 *   • every move and every "still accurate" is audited with the numbers before
 *     and after, because a band quietly edited is a price claim changed
 *
 * Bands are created at make/model values that do not exist in the seed, so the
 * suite never edits demo data; they are deleted in test.after along with their
 * audit rows and any test accounts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, enrolMfa, completeMfa } = require('./helpers');
const roles = require('../src/services/roles');

let available = false;
let ctx;
let db;
let pricing;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const run = (Number(process.pid) * 4099 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0808${String((run * 23 + seq * 619) % 10_000_000).padStart(7, '0')}`;
}

/** A make/model no seeded listing uses, so nothing real is ever touched. */
const PROBE_MAKE = 'Zastava';
/** Each test gets its own model: assertions about "nothing was written" must
 *  not see the rows a previous test in the same file created. */
function probeModel() {
  seq += 1;
  return `Testaro-${String(run).slice(0, 4)}-${seq}`;
}

const createdPhones = new Set();
const createdBands = new Set();
/** Everything this suite writes to the audit log is above this id. */
let auditIdBefore = 0;

/** Create a band through the console form and remember it for cleanup. */
async function postBand(client, model, patch = {}) {
  const response = await client.request('/admin/intel/bands', {
    method: 'POST',
    form: form({ model, ...patch }),
    headers: { Origin: ctx.baseUrl },
  });
  const rows = await pricing.bands({ q: model });
  for (const row of rows) createdBands.add(row.id);
  return { response, rows };
}

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
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    },
  };
}

async function createAccount(role, label) {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { canonical } = require('../src/lib/phone');
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    canonical(phone),
    `${label} (intel test)`,
    role,
    'active',
  ]);
  const row = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [canonical(phone)]);
  // §12.2 — `admin` and `finance` carry a second factor before they can work.
  if (roles.MFA_ROLES.includes(role)) await enrolMfa(row.id);
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, `OTP failed: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', {
    method: 'POST',
    body: { phone, code: JSON.parse(otp.text).devCode },
  });
  assert.equal(verify.status, 200, `sign-in failed: ${verify.text}`);
  if (roles.MFA_ROLES.includes(role)) {
    const finished = await completeMfa(client, { phone });
    assert.equal(finished.status, 200, `second factor failed: ${finished.text}`);
  }
  return { id: row.id, role, client };
}

/** The weekly form's fields, with a call's own probe model filled in. */
const form = (extra = {}) => ({
  make: PROBE_MAKE,
  model: extra.model || 'Testaro',
  year_from: '2014',
  year_to: '2016',
  condition: 'any',
  band_min: '7,000,000',
  band_max: '9,500,000',
  sample_size: '11',
  ...extra,
});

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  pricing = db.pricing;
  const highest = await db.queryOne('SELECT MAX(id) AS id FROM admin_audit');
  auditIdBefore = Number((highest && highest.id) || 0);
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (!available) return;
  for (const id of createdBands) await db.query('DELETE FROM price_bands WHERE id = ?', [id]);
  // The VDP test takes over a seeded band and puts it back, so its audit rows
  // are the only trace of a test in a log the console shows. Scoped to
  // price_band, which nothing else in the suite run writes.
  await db.query('DELETE FROM admin_audit WHERE entity = ? AND id > ?', ['price_band', auditIdBefore]);
  if (createdPhones.size) {
    // Every form the number might be stored in (0808… and +234808…), the same
    // expansion test/admin.test.js uses — a local-only match deletes nothing.
    const { variants } = require('../src/lib/phone');
    const shapes = [...new Set([...createdPhones].flatMap((number) => variants(number)))];
    const marks = shapes.map(() => '?').join(',');
    await db.query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
    await db.query(`UPDATE admin_audit SET actor_id = NULL WHERE actor_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
    await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, shapes);
    await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
  }
  await db.pool.end();
});

maybe('ops writes a band, and the table remembers who did it', async () => {
  const ops = await createAccount('ops', 'Ops');
  const model = probeModel();
  const { response: created, rows } = await postBand(ops.client, model);
  assert.equal(created.status, 303, `band not created: ${created.text.slice(0, 160)}`);
  assert.equal(rows.length, 1);

  const [band] = rows;
  assert.equal(band.make, PROBE_MAKE);
  assert.equal(band.minKobo, 700_000_000, '₦7,000,000 read from a comma-grouped field');
  assert.equal(band.maxKobo, 950_000_000);
  assert.equal(band.sampleSize, 11);
  assert.equal(band.ageDays, 0, 'a band saved now is checked now');

  const audit = await db.admin.auditLog({ limit: 1, entity: 'price_band' });
  assert.equal(audit[0].action, 'price_band.created');
  assert.equal(audit[0].actor, 'Ops (intel test)', 'the audit row names the person, not just the id');
  assert.equal(audit[0].detail.make, PROBE_MAKE);
});

maybe('the weekly form moves the existing band instead of duplicating it', async () => {
  const ops = await createAccount('ops', 'Ops');
  const model = probeModel();
  const first = await postBand(ops.client, model);
  const before = first.rows[0];

  const moved = await ops.client.request('/admin/intel/bands', {
    method: 'POST',
    form: form({ model, band_min: '8,100,000', band_max: '10,400,000', sample_size: '15' }),
    headers: { Origin: ctx.baseUrl },
  });
  assert.equal(moved.status, 303);

  const rows = await pricing.bands({ q: model });
  assert.equal(rows.length, 1, 'one row per make/model/years/condition — the form updates, it does not stack');
  assert.equal(rows[0].id, before.id);
  assert.equal(rows[0].minKobo, 810_000_000);

  const audit = await db.admin.auditLog({ limit: 1, entity: 'price_band' });
  assert.equal(audit[0].action, 'price_band.updated');
  assert.equal(audit[0].detail.before.minKobo, before.minKobo, 'the old numbers are kept, not overwritten');
  assert.equal(audit[0].detail.after.minKobo, 810_000_000);
});

maybe('a malformed band is refused with a reason a person can act on', async () => {
  const ops = await createAccount('ops', 'Ops');
  const cases = [
    [{ band_min: '12,000,000', band_max: '9,000,000' }, 'low above high'],
    [{ band_min: 'free' }, 'not money'],
    [{ year_from: '2019', year_to: '2014' }, 'years run backwards'],
    [{ make: '' }, 'no make'],
  ];
  const model = probeModel();
  for (const [patch, label] of cases) {
    const response = await ops.client.request('/admin/intel/bands', {
      method: 'POST',
      form: form({ model, ...patch }),
      headers: { Origin: ctx.baseUrl },
    });
    assert.equal(response.status, 303, `${label}: refused`);
    assert.match(response.headers.get('location') || '', /err=/, `${label}: the refusal is reported, not silent`);
  }
  const rows = await pricing.bands({ q: model });
  assert.equal(rows.length, 0, 'and nothing was written');
});

maybe('"still accurate" re-stamps the week and says so in the audit trail', async () => {
  const ops = await createAccount('ops', 'Ops');
  const model = probeModel();
  const { rows } = await postBand(ops.client, model);
  const band = rows[0];

  // Age it past the weekly window, then confirm it is still true.
  await db.query('UPDATE price_bands SET refreshed_at = DATE_SUB(CURDATE(), INTERVAL 30 DAY) WHERE id = ?', [band.id]);
  const stale = await pricing.bandById(band.id);
  assert.equal(stale.stale, true, 'a 30-day-old band is due for the weekly pass');
  assert.ok(stale.ageDays >= 30);

  const stamped = await ops.client.request(`/admin/intel/bands/${band.id}/refresh`, {
    method: 'POST',
    headers: { Origin: ctx.baseUrl },
  });
  assert.equal(stamped.status, 303);

  const fresh = await pricing.bandById(band.id);
  assert.equal(fresh.stale, false, 'checked today, so it drops out of the due list');
  assert.equal(fresh.ageDays, 0);

  const audit = await db.admin.auditLog({ limit: 1, entity: 'price_band' });
  assert.equal(audit[0].action, 'price_band.refreshed');
  assert.equal(audit[0].detail.checkedAgainst, 11);
});

maybe('the band drives the live price-position indicator on a VDP', async () => {
  const ops = await createAccount('ops', 'Ops');

  // A live car whose make/model/year is genuinely covered by a band — found the
  // way the storefront finds one, so the test edits a row that really decides a
  // verdict. The band's numbers are snapshotted and put back exactly.
  const car = await db.queryOne(
    `SELECT l.id, l.seo_slug, l.make, l.model, l.year, l.\`condition\`, l.asking_price_kobo
       FROM vehicle_listings l
       JOIN price_bands b
         ON b.make = l.make AND b.model = l.model
        AND l.year BETWEEN b.year_from AND b.year_to
        AND (b.\`condition\` = l.\`condition\` OR b.\`condition\` = 'any')
      WHERE l.status = 'live'
      ORDER BY l.id LIMIT 1`,
  );
  assert.ok(car, 'the seed leaves at least one live car inside a band');

  const band = await db.queryOne(
    `SELECT * FROM price_bands
      WHERE make = ? AND model = ? AND ? BETWEEN year_from AND year_to
        AND (\`condition\` = ? OR \`condition\` = 'any')
      ORDER BY (\`condition\` = ?) DESC LIMIT 1`,
    [car.make, car.model, car.year, car.condition, car.condition],
  );

  const snapshot = {
    make: band.make,
    model: band.model,
    year_from: String(band.year_from),
    year_to: String(band.year_to),
    condition: band.condition,
    band_min: String(Number(band.band_min_kobo) / 100),
    band_max: String(Number(band.band_max_kobo) / 100),
    sample_size: String(band.sample_size),
  };

  const post = (bandForm) =>
    ops.client.request('/admin/intel/bands', { method: 'POST', form: bandForm, headers: { Origin: ctx.baseUrl } });

  const priceNaira = Number(car.asking_price_kobo) / 100;
  try {
    // A band far above the car's price: the verdict must flip to "below".
    const moved = await post({
      ...snapshot,
      band_min: String(Math.round(priceNaira * 3)),
      band_max: String(Math.round(priceNaira * 3.4)),
    });
    assert.equal(moved.status, 303);

    const page = await newClient().request(`/cars/${car.seo_slug}`);
    assert.equal(page.status, 200, `VDP did not render: ${page.status}`);
    assert.match(
      page.text,
      /price-position price-position--below/,
      'a car well under its band is labelled below — the band decided it, not the column written at seed time',
    );
  } finally {
    // Put the demo band back exactly as it was, whatever happened above.
    await post(snapshot);
  }

  const restored = await db.queryOne('SELECT * FROM price_bands WHERE id = ?', [band.id]);
  assert.equal(Number(restored.band_min_kobo), Number(band.band_min_kobo), 'the original low end is back');
  assert.equal(Number(restored.band_max_kobo), Number(band.band_max_kobo), 'and the original high end');

  const back = await newClient().request(`/cars/${car.seo_slug}`);
  assert.ok(
    !/price-position price-position--below/.test(back.text),
    'and the car reads its original verdict again',
  );
});

maybe('§7.4: marketing reads the table, finance does not, and only admin/ops write', async () => {
  const marketing = await createAccount('marketing', 'Content');
  const finance = await createAccount('finance', 'Finance');

  const view = await marketing.client.request('/admin/intel');
  assert.equal(view.status, 200, 'marketing may view the price-intel table');
  assert.match(view.text, /Read-only/, 'and is told the write card is not theirs');
  assert.ok(!/Weekly update/.test(view.text), 'no write form is drawn for them');
  assert.ok(!/Still accurate/.test(view.text), 'and no refresh button either');

  const model = probeModel();
  const write = await marketing.client.request('/admin/intel/bands', {
    method: 'POST',
    form: form({ model }),
    headers: { Origin: ctx.baseUrl },
  });
  assert.equal(write.status, 403, 'a viewer cannot write, whatever the page draws');

  const refused = await finance.client.request('/admin/intel');
  assert.equal(refused.status, 403, 'finance has no business in the price table');

  const rows = await pricing.bands({ q: model });
  assert.equal(rows.length, 0, 'and none of that wrote anything');
});
