'use strict';

/**
 * Console end-to-end (§7.3 modules, §7.4 role matrix, §7.5 daily workflow).
 *
 * Drives the real forms over HTTP against the real database: sign in as each
 * role, open every module, then do the work — moderate a listing, set a grade,
 * override a price, work a lead, move a concierge request, dispatch a job,
 * file an inspection report, run the freshness sweep, change a role.
 *
 * The suite makes its own staff accounts (unique numbers, roles granted by
 * direct SQL — that step is the operator's, not the thing under test) and its
 * own scratch listings, then removes everything in test.after. It never signs
 * in as the seeded +2348000000001 account: the per-phone OTP cap is 5 an
 * hour, and five runs of the suite would lock the demo admin out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer } = require('./helpers');
const roles = require('../src/services/roles');

let available = false;
let ctx;
let db;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

/** Unique numbers per run, and per role, so the OTP cap is never the problem. */
const run = (Number(process.pid) * 6151 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0807${String((run * 13 + seq * 331) % 10_000_000).padStart(7, '0')}`;
}

const createdPhones = new Set();
const createdListings = [];
const accounts = {};
/**
 * The freshness sweep is deliberately global: it flags every idle live listing
 * in the database. That includes seeded stock, so the suite records what was
 * already flagged or expired before it runs and puts everything else back —
 * a test must never leave the demo site looking stale.
 */
let flaggedBefore = new Set();
let expiredBefore = new Set();

function newClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, { method = 'GET', body, headers = {}, form } = {}) {
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
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        if (pair.split('=')[0] === 'hc_session') cookie = pair.endsWith('=') ? '' : pair;
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
    /** A form POST as a browser sends it, following the 303 back to the page. */
    async post(path, form, headers = {}) {
      const response = await this.request(path, { method: 'POST', form, headers });
      return response;
    },
  };
}

/** Create a throwaway account with a staff role and sign it in. */
async function createAccount(role, label) {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { canonical } = require('../src/lib/phone');
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    canonical(phone),
    `${label} (console test)`,
    role,
    'active',
  ]);
  const row = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [canonical(phone)]);
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, `OTP request failed for ${label}: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', {
    method: 'POST',
    body: { phone, code: otp.json.devCode },
  });
  assert.equal(verify.status, 200, `sign-in failed for ${label}: ${verify.text}`);
  return { id: row.id, phone, role, client };
}

/** A listing the tests can push around without disturbing the storefront. */
async function scratchListing({ status = 'in_review', idleDays = 0 } = {}) {
  const dealer = await db.queryOne('SELECT id FROM dealers ORDER BY id LIMIT 1');
  const stamp = `${run}${createdListings.length}${seq}${Date.now() % 1000}`;
  const stockNo = `HC-CA-${stamp}`.slice(0, 24);
  const result = await db.query(
    `INSERT INTO vehicle_listings
       (stock_no, dealer_id, status, make, model, year, transmission, fuel_type, \`condition\`,
        mileage_km, asking_price_kobo, area, documents, seo_slug, honest_note, created_at, updated_at)
     VALUES (?, ?, ?, 'Toyota', 'Console Test', 2013, 'automatic', 'petrol', 'nigerian_used',
             88000, 550000000, 'Woji', '{"customs_verified":true,"registration":true,"duty_sighted":false,"tinted_permit":false}',
             ?, 'Test row created by test/admin.test.js.', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [stockNo, dealer.id, status, `console-test-${stamp}`],
  );
  const id = result.insertId;
  createdListings.push(id);
  if (idleDays) {
    await db.query('UPDATE vehicle_listings SET created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY), updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) WHERE id = ?', [idleDays, idleDays, id]);
  }
  return id;
}

const listing = (id) => db.queryOne('SELECT * FROM vehicle_listings WHERE id = ? LIMIT 1', [id]);
const auditFor = (entity, entityId) =>
  db.query('SELECT * FROM admin_audit WHERE entity = ? AND entity_id = ? ORDER BY id DESC', [entity, entityId]);

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  ctx = await startTestServer();
  flaggedBefore = new Set(
    (await db.query('SELECT id FROM vehicle_listings WHERE stale_flagged_at IS NOT NULL')).map((row) => row.id),
  );
  expiredBefore = new Set(
    (await db.query("SELECT id FROM vehicle_listings WHERE status = 'expired'")).map((row) => row.id),
  );
  accounts.admin = await createAccount('admin', 'Console admin');
  accounts.ops = await createAccount('ops', 'Console ops');
  accounts.inspector = await createAccount('inspector', 'Console inspector');
  accounts.customer = await createAccount('customer', 'Console customer');
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (available) {
    // Undo the sweep before removing this run's scratch rows.
    for (const row of await db.query('SELECT id FROM vehicle_listings WHERE stale_flagged_at IS NOT NULL')) {
      if (!flaggedBefore.has(row.id)) {
        await db.query('UPDATE vehicle_listings SET stale_flagged_at = NULL, refresh_requested_at = NULL WHERE id = ?', [row.id]);
      }
    }
    for (const row of await db.query("SELECT id FROM vehicle_listings WHERE status = 'expired' AND unlisted_at IS NOT NULL")) {
      if (!expiredBefore.has(row.id)) {
        await db.query("UPDATE vehicle_listings SET status = 'live', unlisted_at = NULL WHERE id = ?", [row.id]);
      }
    }
    for (const id of createdListings) await db.query('DELETE FROM vehicle_listings WHERE id = ?', [id]);
    if (createdPhones.size) {
      const { variants } = require('../src/lib/phone');
      const shapes = [...new Set([...createdPhones].flatMap((number) => variants(number)))];
      const marks = shapes.map(() => '?').join(',');
      for (const table of ['service_requests', 'bookings', 'leads']) {
        await db.query(`DELETE FROM ${table} WHERE phone IN (${marks})`, shapes);
      }
      await db.query(`UPDATE admin_audit SET actor_id = NULL WHERE actor_id IN (SELECT id FROM \`users\` WHERE phone IN (${marks}))`, shapes);
      await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
    }
    // Release the pool so the test runner exits instead of waiting on MySQL.
    await db.pool.end();
  }
});

// ---------------------------------------------------------------------------
// The gate (§7.4)
// ---------------------------------------------------------------------------
maybe('the console is closed to the public and to customers', async () => {
  const anon = newClient();
  const redirect = await anon.request('/admin');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/login?next=%2Fadmin');

  const customer = await accounts.customer.client.request('/admin');
  assert.equal(customer.status, 403);
  assert.match(customer.text, /not yours to open/);
  assert.match(customer.text, /signed in as <strong>customer<\/strong>/);
  assert.match(customer.headers.get('cache-control') || '', /no-store/);
});

maybe('each role sees exactly the modules the matrix grants', async () => {
  const expected = {
    admin: { '/admin': 200, '/admin/listings': 200, '/admin/leads': 200, '/admin/concierge': 200, '/admin/bookings': 200, '/admin/jobs': 403, '/admin/staff': 200, '/admin/audit': 200 },
    ops: { '/admin': 200, '/admin/listings': 200, '/admin/leads': 200, '/admin/concierge': 200, '/admin/bookings': 200, '/admin/jobs': 403, '/admin/staff': 403, '/admin/audit': 403 },
    inspector: { '/admin': 403, '/admin/listings': 403, '/admin/leads': 403, '/admin/concierge': 403, '/admin/bookings': 403, '/admin/jobs': 200, '/admin/staff': 403, '/admin/audit': 403 },
  };

  for (const [role, paths] of Object.entries(expected)) {
    for (const [path, status] of Object.entries(paths)) {
      const response = await accounts[role].client.request(path);
      assert.equal(response.status, status, `${role} ${path} should be ${status}`);
      if (status === 200) assert.match(response.headers.get('cache-control') || '', /private/);
    }
  }
});

maybe('the console navigation only offers what the role holds', async () => {
  const ops = await accounts.ops.client.request('/admin/listings');
  assert.match(ops.text, /href="\/admin\/listings"/);
  assert.doesNotMatch(ops.text, /href="\/admin\/staff"/);
  assert.doesNotMatch(ops.text, /href="\/admin\/jobs"/);

  const inspector = await accounts.inspector.client.request('/admin/jobs');
  assert.match(inspector.text, /href="\/admin\/jobs"/);
  assert.doesNotMatch(inspector.text, /href="\/admin\/listings"/);
  assert.doesNotMatch(inspector.text, /href="\/admin\/concierge"/);
});

maybe('the console is never indexed, and never shared by a cache', async () => {
  const response = await accounts.admin.client.request('/admin');
  assert.match(response.text, /name="robots" content="noindex, nofollow"/);
  assert.match(response.headers.get('cache-control') || '', /private, no-store/);
  assert.doesNotMatch(response.text, /rel="canonical"/, 'a console screen is not a canonical document');
});

maybe('a mutating form from another site is refused', async () => {
  const id = await scratchListing({ status: 'in_review' });
  const response = await accounts.admin.client.post(
    `/admin/listings/${id}/publish`,
    { grade: 'network_listed' },
    { Origin: 'https://evil.example' },
  );
  assert.equal(response.status, 403);
  const after = await listing(id);
  assert.equal(after.status, 'in_review', 'a cross-site post must not publish anything');
});

maybe('every role can do only what the matrix says, on the write paths too', async () => {
  const id = await scratchListing({ status: 'in_review' });
  const opsGrade = await accounts.ops.client.post(`/admin/listings/${id}/grade`, { grade: 'field_checked' });
  assert.equal(opsGrade.status, 303, 'ops holds listings.grade');
  assert.equal((await listing(id)).verification_grade, 'field_checked', 'ops may grade, with the checklist recorded');

  const inspectorPublish = await accounts.inspector.client.post(`/admin/listings/${id}/publish`, { grade: 'field_checked' });
  assert.equal(inspectorPublish.status, 403);
  const customerPublish = await accounts.customer.client.post(`/admin/listings/${id}/publish`, { grade: 'field_checked' });
  assert.equal(customerPublish.status, 403);
});

// ---------------------------------------------------------------------------
// Listings moderation (§7.3)
// ---------------------------------------------------------------------------
maybe('the moderation queue opens on the work waiting for a human', async () => {
  const response = await accounts.admin.client.request('/admin/listings?status=in_review');
  assert.equal(response.status, 200);
  assert.match(response.text, /Flagged stale/);
  assert.match(response.text, /Freshness rule/);
  assert.match(response.text, /Verification grade/);
});

maybe('publishing sets the grade, the checklist and the moderation stamps', async () => {
  const id = await scratchListing({ status: 'in_review' });
  const response = await accounts.admin.client.post(`/admin/listings/${id}/publish`, {
    grade: 'field_checked',
    vin_checked: 'on',
    docs_sighted: 'on',
    obd2_scanned: 'on',
  });
  assert.equal(response.status, 303);

  const after = await listing(id);
  assert.equal(after.status, 'live');
  assert.equal(after.verification_grade, 'field_checked');
  assert.equal(Number(after.moderated_by), accounts.admin.id);
  assert.ok(after.moderated_at, 'moderated_at must be stamped');
  assert.ok(after.published_at, 'published_at must be stamped');
  const checklist = typeof after.grade_checklist === 'string' ? JSON.parse(after.grade_checklist) : after.grade_checklist;
  assert.equal(checklist.vin_checked, true);
  assert.equal(checklist.road_tested, false);
  assert.equal(checklist.checked_on, new Date().toISOString().slice(0, 10));

  const [entry] = await auditFor('listing', id);
  assert.equal(entry.action, 'listing.publish');
  assert.equal(Number(entry.actor_id), accounts.admin.id);
});

maybe('a certified grade without the whole checklist is refused, and nothing changes', async () => {
  const id = await scratchListing({ status: 'live' });

  // Nothing ticked at all.
  const bare = await accounts.admin.client.post(`/admin/listings/${id}/grade`, { grade: 'certified' });
  assert.equal(bare.status, 303);
  assert.match(decodeURIComponent(bare.headers.get('location')), /err=/);

  // Three of four is not certified either.
  const partial = await accounts.admin.client.post(`/admin/listings/${id}/grade`, {
    grade: 'certified',
    vin_checked: 'on',
    docs_sighted: 'on',
    obd2_scanned: 'on',
  });
  assert.equal(partial.status, 303);
  assert.match(decodeURIComponent(partial.headers.get('location')), /err=/);

  const after = await listing(id);
  assert.equal(after.verification_grade, 'network_listed', 'a refused grade must not be written');
  assert.equal((await auditFor('listing', id)).length, 0);

  // All four, and it lands.
  const full = await accounts.admin.client.post(`/admin/listings/${id}/grade`, {
    grade: 'certified',
    vin_checked: 'on',
    docs_sighted: 'on',
    obd2_scanned: 'on',
    road_tested: 'on',
    note: 'Bench test — all four checks recorded',
  });
  assert.equal(full.status, 303);
  assert.equal((await listing(id)).verification_grade, 'certified');
});

maybe('a grade change is audited with its checklist', async () => {
  const id = await scratchListing({ status: 'live' });
  const response = await accounts.admin.client.post(`/admin/listings/${id}/grade`, {
    grade: 'field_checked',
    note: 'Bench test row',
  });
  assert.equal(response.status, 303);
  const after = await listing(id);
  assert.equal(after.verification_grade, 'field_checked');
  assert.equal(Number(after.grade_set_by), accounts.admin.id);
  assert.ok(after.grade_set_at);
  const [entry] = await auditFor('listing', id);
  assert.equal(entry.action, 'listing.grade');
});

maybe('a price override is written and audited', async () => {
  const id = await scratchListing({ status: 'live' });
  const response = await accounts.admin.client.post(`/admin/listings/${id}/price`, {
    price_naira: '5,150,000',
    note: 'Dealer agreed a drop after the inspection',
  });
  assert.equal(response.status, 303);
  const after = await listing(id);
  assert.equal(Number(after.asking_price_kobo), 515_000_000);
  const [entry] = await auditFor('listing', id);
  assert.equal(entry.action, 'listing.price');
});

maybe('a nonsensical price is refused with a message, not a crash', async () => {
  const id = await scratchListing({ status: 'live' });
  const before = await listing(id);
  for (const bad of ['', '0', 'free', '-500']) {
    const response = await accounts.admin.client.post(`/admin/listings/${id}/price`, { price_naira: bad });
    assert.equal(response.status, 303, `price "${bad}" should not blow up`);
    assert.match(decodeURIComponent(response.headers.get('location')), /err=/);
  }
  const after = await listing(id);
  assert.equal(after.asking_price_kobo, before.asking_price_kobo);
});

maybe('the lifecycle actions move a listing and refuse an unknown status', async () => {
  const id = await scratchListing({ status: 'live' });
  const reserved = await accounts.admin.client.post(`/admin/listings/${id}/status`, { status: 'reserved' });
  assert.equal(reserved.status, 303);
  assert.equal((await listing(id)).status, 'reserved');

  const nonsense = await accounts.admin.client.post(`/admin/listings/${id}/status`, { status: 'launched' });
  assert.equal(nonsense.status, 303);
  assert.match(decodeURIComponent(nonsense.headers.get('location')), /err=/);
  assert.equal((await listing(id)).status, 'reserved');
});

maybe('marking a listing fresh clears the stale flag and restarts the clock', async () => {
  const id = await scratchListing({ status: 'live', idleDays: 40 });
  await db.query('UPDATE vehicle_listings SET stale_flagged_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 DAY) WHERE id = ?', [id]);
  const response = await accounts.admin.client.post(`/admin/listings/${id}/refresh`, {});
  assert.equal(response.status, 303);
  const after = await listing(id);
  assert.ok(after.refreshed_at);
  assert.equal(after.stale_flagged_at, null);
});

maybe('the freshness sweep flags idle stock, then unlists what was never refreshed', async () => {
  const idle = await scratchListing({ status: 'live', idleDays: 30 });

  const dry = await accounts.admin.client.post('/admin/listings/stale-sweep', { dry_run: '1' });
  assert.equal(dry.status, 303);
  assert.match(decodeURIComponent(dry.headers.get('location')), /Dry run/);
  assert.equal((await listing(idle)).stale_flagged_at, null, 'a dry run must change nothing');

  const first = await accounts.admin.client.post('/admin/listings/stale-sweep', {});
  assert.equal(first.status, 303);
  const flagged = await listing(idle);
  assert.ok(flagged.stale_flagged_at, 'idle stock gets flagged for a refresh');
  assert.equal(flagged.status, 'live', 'the first pass asks the dealer, it does not unlist');
  assert.ok((await auditFor('listing', idle)).some((row) => row.action === 'listing.stale_flag'), 'the flag is on the car’s own history');

  // Pretend the grace period passed with nobody confirming.
  await db.query('UPDATE vehicle_listings SET stale_flagged_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) WHERE id = ?', [require('../src/db/admin').REFRESH_GRACE_DAYS + 1, idle]);
  const second = await accounts.admin.client.post('/admin/listings/stale-sweep', {});
  assert.equal(second.status, 303);
  const unlisted = await listing(idle);
  assert.equal(unlisted.status, 'expired');
  assert.ok(unlisted.unlisted_at);
  assert.ok((await auditFor('listing', idle)).some((row) => row.action === 'listing.stale_unlist'));
});

// ---------------------------------------------------------------------------
// Leads inbox (§7.3)
// ---------------------------------------------------------------------------
maybe('the inbox shows enquiries and requests in one stream', async () => {
  const response = await accounts.admin.client.request('/admin/leads');
  assert.equal(response.status, 200);
  assert.match(response.text, /Listing enquiries/);
  assert.match(response.text, /Service requests/);
  assert.match(response.text, /Reply template/);
  assert.match(response.text, /Round-robin assign unowned/);
});

maybe('a lead can be assigned, moved and closed with a lost reason', async () => {
  const phone = nextPhone();
  await db.query(
    'INSERT INTO leads (type, name, phone, message, source_path, status) VALUES (?, ?, ?, ?, ?, ?)',
    ['viewing', 'Console lead', phone, 'Is it still available?', '/cars', 'new'],
  );
  const row = await db.queryOne('SELECT id FROM leads WHERE phone = ? LIMIT 1', [phone]);

  const assigned = await accounts.admin.client.post(`/admin/leads/${row.id}/assign`, {
    kind: 'lead',
    assigned_to: String(accounts.ops.id),
  });
  assert.equal(assigned.status, 303);
  let after = await db.queryOne('SELECT * FROM leads WHERE id = ?', [row.id]);
  assert.equal(Number(after.assigned_to), accounts.ops.id);
  assert.equal(after.status, 'assigned');
  assert.ok(after.assigned_at);

  const lost = await accounts.admin.client.post(`/admin/leads/${row.id}/status`, {
    kind: 'lead',
    status: 'lost',
    lost_reason: 'Bought elsewhere — price',
  });
  assert.equal(lost.status, 303);
  after = await db.queryOne('SELECT * FROM leads WHERE id = ?', [row.id]);
  assert.equal(after.status, 'lost');
  assert.equal(after.lost_reason, 'Bought elsewhere — price');

  const [entry] = await auditFor('lead', row.id);
  assert.ok(['lead.status', 'lead.assign'].includes(entry.action));

  await db.query('DELETE FROM leads WHERE id = ?', [row.id]);
});

maybe('a request moved through the inbox carries its own audit trail', async () => {
  const phone = nextPhone();
  await db.query(
    "INSERT INTO service_requests (tracking_id, type, status, name, phone, source_path) VALUES (?, 'concierge', 'new', 'Console request', ?, '/find-my-car')",
    [`HC-CT-${run % 9000 + 1000}`, phone],
  );
  const row = await db.queryOne('SELECT id FROM service_requests WHERE phone = ? LIMIT 1', [phone]);

  const response = await accounts.admin.client.post(`/admin/leads/${row.id}/status`, {
    kind: 'request',
    status: 'searching',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location').startsWith('/admin/concierge'), true);
  const after = await db.queryOne('SELECT * FROM service_requests WHERE id = ?', [row.id]);
  assert.equal(after.status, 'searching');
  assert.ok(after.last_contacted_at, 'moving a request forward stamps contact');

  await db.query('DELETE FROM service_requests WHERE id = ?', [row.id]);
});

maybe('unknown status values are refused instead of written', async () => {
  const phone = nextPhone();
  await db.query(
    'INSERT INTO leads (type, name, phone, source_path, status) VALUES (?, ?, ?, ?, ?)',
    ['viewing', 'Guarded lead', phone, '/cars', 'new'],
  );
  const row = await db.queryOne('SELECT id FROM leads WHERE phone = ?', [phone]);
  const response = await accounts.admin.client.post(`/admin/leads/${row.id}/status`, {
    kind: 'lead',
    status: 'ignored-forever',
  });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /err=/);
  assert.equal((await db.queryOne('SELECT status FROM leads WHERE id = ?', [row.id])).status, 'new');
  await db.query('DELETE FROM leads WHERE id = ?', [row.id]);
});

// ---------------------------------------------------------------------------
// Concierge pipeline (§7.3)
// ---------------------------------------------------------------------------
maybe('the pipeline board renders every stage with its SLA clock', async () => {
  const response = await accounts.admin.client.request('/admin/concierge');
  assert.equal(response.status, 200);
  for (const stage of ['new', 'searching', 'options_ready', 'viewings', 'closed']) {
    assert.match(response.text, new RegExp(`id="col-${stage}"`), `stage ${stage} must be on the board`);
  }
  assert.match(response.text, /SLA overdue/);
  assert.match(response.text, /HC-2482/);
});

maybe('a request opens into its brief and its attached cars', async () => {
  const board = await db.queryOne("SELECT id, tracking_id FROM service_requests WHERE tracking_id = 'HC-2481'");
  const response = await accounts.admin.client.request(`/admin/concierge?open=${board.id}`);
  assert.equal(response.status, 200);
  assert.match(response.text, /The brief/);
  assert.match(response.text, /Attached cars/);
  assert.match(response.text, /Cleanest papers of the three|service book is complete/);
});

maybe('cars can be attached to a request and removed again', async () => {
  const request = await db.queryOne("SELECT id FROM service_requests WHERE tracking_id = 'HC-2487'");
  const id = await scratchListing({ status: 'live' });

  const attached = await accounts.admin.client.post(`/admin/concierge/${request.id}/candidates`, {
    listing_id: String(id),
    note: 'Fits the brief on paper — needs photos before it goes to the buyer',
  });
  assert.equal(attached.status, 303);
  const rows = await db.query('SELECT * FROM request_candidates WHERE request_id = ? AND listing_id = ?', [request.id, id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'Fits the brief on paper — needs photos before it goes to the buyer');
  assert.equal(Number(rows[0].added_by), accounts.admin.id);

  const removed = await accounts.admin.client.post(`/admin/concierge/${request.id}/candidates/${id}/remove`, {});
  assert.equal(removed.status, 303);
  assert.equal((await db.query('SELECT id FROM request_candidates WHERE request_id = ? AND listing_id = ?', [request.id, id])).length, 0);
});

maybe('attaching a car that does not exist is refused', async () => {
  const request = await db.queryOne("SELECT id FROM service_requests WHERE tracking_id = 'HC-2487'");
  const response = await accounts.admin.client.post(`/admin/concierge/${request.id}/candidates`, {
    listing_id: '999999999',
    note: 'ghost',
  });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /err=/);
});

maybe('stage moves are audited, and a lost request keeps its reason', async () => {
  const phone = nextPhone();
  await db.query(
    "INSERT INTO service_requests (tracking_id, type, status, name, phone, source_path) VALUES (?, 'concierge', 'searching', 'Pipeline probe', ?, '/find-my-car')",
    [`HC-CT-${(run + 47) % 9000 + 1000}`, phone],
  );
  const row = await db.queryOne('SELECT id FROM service_requests WHERE phone = ?', [phone]);

  const moved = await accounts.admin.client.post(`/admin/concierge/${row.id}/stage`, { status: 'options_ready' });
  assert.equal(moved.status, 303);
  const lost = await accounts.admin.client.post(`/admin/concierge/${row.id}/stage`, {
    status: 'lost',
    lost_reason: 'Found one on his own',
  });
  assert.equal(lost.status, 303);

  const after = await db.queryOne('SELECT * FROM service_requests WHERE id = ?', [row.id]);
  assert.equal(after.status, 'lost');
  assert.equal(after.lost_reason, 'Found one on his own');
  const entries = await auditFor('request', row.id);
  assert.equal(entries.filter((entry) => entry.action === 'request.stage').length, 2);

  await db.query('DELETE FROM service_requests WHERE id = ?', [row.id]);
});

// ---------------------------------------------------------------------------
// Dispatch and the inspector's view (§7.3)
// ---------------------------------------------------------------------------
maybe('the dispatch sheet shows the day, the inspector and the verdict', async () => {
  const response = await accounts.admin.client.request('/admin/bookings');
  assert.equal(response.status, 200);
  assert.match(response.text, /HC-BK-0002/);
  assert.match(response.text, /pass with advisory/);
  assert.match(response.text, /Inspector/);
});

maybe('a booking can be dispatched to an inspector and moved on', async () => {
  const phone = nextPhone();
  await db.query(
    `INSERT INTO bookings (reference, type, service_slug, slot_at, name, phone, amount_kobo, payment_status, status)
     VALUES (?, 'inspection', 'inspection', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), 'Dispatch probe', ?, 4500000, 'paid', 'requested')`,
    [`HC-CB-${(run + 11) % 9000 + 1000}`, phone],
  );
  const booking = await db.queryOne('SELECT id FROM bookings WHERE phone = ?', [phone]);

  const dispatched = await accounts.admin.client.post(`/admin/bookings/${booking.id}/dispatch`, {
    inspector_id: String(accounts.inspector.id),
  });
  assert.equal(dispatched.status, 303);
  let after = await db.queryOne('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert.equal(Number(after.inspector_id), accounts.inspector.id);
  assert.equal(after.status, 'dispatched', 'assigning an inspector sends the job');
  assert.ok(after.dispatched_at);

  const completed = await accounts.admin.client.post(`/admin/bookings/${booking.id}/status`, { status: 'completed' });
  assert.equal(completed.status, 303);
  after = await db.queryOne('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert.equal(after.status, 'completed');
  assert.ok(after.completed_at);

  const [entry] = await auditFor('booking', booking.id);
  assert.ok(['booking.dispatch', 'booking.status'].includes(entry.action));

  await db.query('DELETE FROM bookings WHERE id = ?', [booking.id]);
});

maybe('an inspector sees only their own jobs, and files the checklist', async () => {
  const phone = nextPhone();
  await db.query(
    `INSERT INTO bookings (reference, type, service_slug, slot_at, location, vehicle, name, phone,
                           amount_kobo, payment_status, status, inspector_id)
     VALUES (?, 'inspection', 'inspection', UTC_TIMESTAMP(), 'Woji, Port Harcourt',
             '{"make":"Toyota","model":"Camry","year":2010}', 'Inspector probe', ?, 4500000, 'paid', 'dispatched', ?)`,
    [`HC-CB-${(run + 29) % 9000 + 1000}`, phone, accounts.inspector.id],
  );
  const booking = await db.queryOne('SELECT id FROM bookings WHERE phone = ?', [phone]);

  const jobs = await accounts.inspector.client.request('/admin/jobs');
  assert.equal(jobs.status, 200);
  assert.match(jobs.text, /Inspector probe/);
  assert.match(jobs.text, /Engine &amp; fluids|Engine & fluids/);
  assert.match(jobs.text, /Verdict/);

  const report = await accounts.inspector.client.post(`/admin/jobs/${booking.id}/report`, {
    section_engine: 'ok',
    section_transmission: 'ok',
    section_suspension: 'attention',
    section_brakes: 'ok',
    section_electricals: 'ok',
    section_body: 'fail',
    section_documents: 'ok',
    obd2_codes: 'P0420 stored, cleared and re-read clean',
    photos: 'inspection-photos/hc-cb-probe',
    verdict: 'pass_with_advisory',
    report_notes: 'Boot floor shows old repair; everything else sound. Client told before paying.',
  });
  assert.equal(report.status, 303);

  const after = await db.queryOne('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert.equal(after.status, 'completed');
  assert.equal(after.verdict, 'pass_with_advisory');
  assert.ok(after.completed_at);
  assert.match(after.report_notes, /Boot floor shows old repair/);
  assert.equal(after.checklist.sections.suspension, 'attention');
  assert.equal(after.checklist.sections.body, 'fail');
  assert.equal(after.checklist.obd2_codes, 'P0420 stored, cleared and re-read clean');

  await db.query('DELETE FROM bookings WHERE id = ?', [booking.id]);
});

maybe('an inspector cannot file a report on somebody else’s job', async () => {
  const phone = nextPhone();
  await db.query(
    `INSERT INTO bookings (reference, type, service_slug, slot_at, name, phone, amount_kobo, payment_status, status)
     VALUES (?, 'inspection', 'inspection', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY), 'Not mine', ?, 4500000, 'unpaid', 'requested')`,
    [`HC-CB-${(run + 61) % 9000 + 1000}`, phone],
  );
  const booking = await db.queryOne('SELECT id FROM bookings WHERE phone = ?', [phone]);

  const response = await accounts.inspector.client.post(`/admin/jobs/${booking.id}/report`, {
    verdict: 'pass',
    report_notes: 'Should never be written.',
  });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /err=/);
  const after = await db.queryOne('SELECT * FROM bookings WHERE id = ?', [booking.id]);
  assert.equal(after.verdict, null);
  assert.equal(after.status, 'requested');

  await db.query('DELETE FROM bookings WHERE id = ?', [booking.id]);
});

// ---------------------------------------------------------------------------
// Staff, roles and the audit log (§7.3, §7.4)
// ---------------------------------------------------------------------------
maybe('the capability matrix on screen is the one the routes enforce', async () => {
  const response = await accounts.admin.client.request('/admin/staff');
  assert.equal(response.status, 200);
  for (const capability of Object.keys(roles.MATRIX)) {
    assert.match(response.text, new RegExp(capability.replace('.', '\\.')), `${capability} must be listed`);
  }
  assert.match(response.text, /users\.manage/);
  assert.match(response.text, /Super Admin/);
});

maybe('a role change takes effect on the next request, and is audited', async () => {
  const phone = nextPhone();
  createdPhones.add(phone);
  const { canonical } = require('../src/lib/phone');
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    canonical(phone),
    'Promotion probe',
    'customer',
    'active',
  ]);
  const row = await db.queryOne('SELECT id FROM `users` WHERE phone = ?', [canonical(phone)]);
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });

  assert.equal((await client.request('/admin')).status, 403, 'a customer is not staff yet');

  const promoted = await accounts.admin.client.post(`/admin/staff/${row.id}/role`, { role: 'ops' });
  assert.equal(promoted.status, 303);
  assert.equal((await db.queryOne('SELECT role FROM `users` WHERE id = ?', [row.id])).role, 'ops');
  assert.equal((await client.request('/admin')).status, 200, 'the new role applies immediately');
  assert.equal((await client.request('/admin/staff')).status, 403, 'but only what ops holds');

  const [entry] = await auditFor('user', row.id);
  assert.equal(entry.action, 'user.role');
  assert.equal(JSON.parse(JSON.stringify(entry.detail)).to, 'ops');

  const demoted = await accounts.admin.client.post(`/admin/staff/${row.id}/role`, { role: 'customer' });
  assert.equal(demoted.status, 303);
  assert.equal((await client.request('/admin')).status, 403, 'the session loses the console at once');
});

maybe('an admin cannot demote themselves out of the last seat', async () => {
  const response = await accounts.admin.client.post(`/admin/staff/${accounts.admin.id}/role`, { role: 'customer' });
  assert.equal(response.status, 303);
  assert.match(decodeURIComponent(response.headers.get('location')), /cannot drop your own admin role/);
  assert.equal((await db.queryOne('SELECT role FROM `users` WHERE id = ?', [accounts.admin.id])).role, 'admin');
});

maybe('a customer can be put on the watchlist, and the count follows', async () => {
  const before = await db.queryOne("SELECT COUNT(*) AS n FROM `users` WHERE role = 'customer' AND watchlisted = 1");
  const response = await accounts.admin.client.post(`/admin/staff/${accounts.customer.id}/watchlist`, { watchlisted: '1' });
  assert.equal(response.status, 303);
  const after = await db.queryOne("SELECT COUNT(*) AS n FROM `users` WHERE role = 'customer' AND watchlisted = 1");
  assert.equal(Number(after.n), Number(before.n) + 1);

  const page = await accounts.admin.client.request('/admin/staff');
  assert.match(page.text, /Customers/);

  await accounts.admin.client.post(`/admin/staff/${accounts.customer.id}/watchlist`, { watchlisted: '0' });
  const cleared = await db.queryOne('SELECT watchlisted FROM `users` WHERE id = ?', [accounts.customer.id]);
  assert.equal(Number(cleared.watchlisted), 0);
});

maybe('the audit log lists the sensitive actions in reverse order', async () => {
  const response = await accounts.admin.client.request('/admin/audit');
  assert.equal(response.status, 200);
  assert.match(response.text, /Audit log/);
  assert.match(response.text, /listing\.publish|listing\.grade|user\.role/);

  const filtered = await accounts.admin.client.request('/admin/audit?entity=user');
  assert.equal(filtered.status, 200);
  assert.match(filtered.text, /user\.role/);
  assert.doesNotMatch(filtered.text, /listing\.price/);
});

// ---------------------------------------------------------------------------
// The daily summary and the KPI home (§7.3)
// ---------------------------------------------------------------------------
maybe('the KPI home answers the five questions the PRD puts on it', async () => {
  const response = await accounts.admin.client.request('/admin');
  assert.equal(response.status, 200);
  assert.match(response.text, /New leads today/);
  assert.match(response.text, /Bookings today/);
  assert.match(response.text, /Order value today/);
  assert.match(response.text, /Pending verification/);
  assert.match(response.text, /Listings due a refresh/);
  assert.match(response.text, /Daily summary/);
  assert.match(response.text, /Revenue by service line/);
});

maybe('the daily summary is generated from the live numbers', async () => {
  const admin = require('../src/db/admin');
  const summary = await admin.dailySummary();
  assert.match(summary, /^HonestCars — /);
  assert.match(summary, /New leads today: \d+/);
  assert.match(summary, /Bookings today: \d+/);
  assert.match(summary, /Concierge requests awaiting options: \d+/);
  assert.match(summary, /Listings pending review: \d+/);

  const page = await accounts.admin.client.request('/admin');
  assert.match(page.text, /New leads today: \d+/);
});

maybe('the analytics it exposes match what the database holds', async () => {
  const admin = require('../src/db/admin');
  const kpis = await admin.kpis();
  const expected = await db.queryOne(
    `SELECT
       (SELECT COUNT(*) FROM leads WHERE status = 'new') AS leads_open,
       (SELECT COUNT(*) FROM vehicle_listings WHERE status = 'in_review') AS pending_verification`,
  );
  assert.equal(kpis.leads_open, Number(expected.leads_open));
  assert.equal(kpis.pending_verification, Number(expected.pending_verification));
  assert.equal(typeof kpis.order_value_today, 'number');
  assert.ok(Array.isArray((await admin.listingsTrend({ days: 7 })).slice(0, 1)));

  const funnel = await admin.leadFunnel({ days: 30 });
  assert.ok(funnel.stages.length >= 4);
  assert.equal(typeof funnel.requests.open, 'number');
});
