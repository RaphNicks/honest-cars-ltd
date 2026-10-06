'use strict';

/**
 * Dealer partner portal — §7.2.
 *
 * Two halves, like the rest of the suite:
 *   1. the data layer, driven directly — scoping, the lifecycle gate, leads,
 *      performance, statements, and the FR-25 handoff when a lot changes a price;
 *   2. the routes over real HTTP — the door, the role gate, and the fact that a
 *      lot cannot read or write another lot's stock.
 *
 * The HTTP half signs in like a person: it creates its own account through the
 * OTP endpoint (a fresh number every run — the per-phone limit is real), then
 * promotes it to `dealer` and links a lot, which is exactly what ops does on
 * /admin/staff. Everything it creates is removed in test.after, so the dev
 * database is left as it was found.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, sweepOrphanAudit } = require('./helpers');

/** One column, one row — for the small "what does the database say now" checks. */
async function scalar(db, sql, params) {
  const row = await db.queryOne(sql, params);
  return row ? Object.values(row)[0] : null;
}

let available = false;
let ctx;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

/** A phone number no other suite is using. */
const run = (Number(process.pid) * 104_729 + (Date.now() % 100_000)) % 1_000_000;
let seq = 0;
const nextPhone = () => `0804${String((run * 5 + (seq += 1) * 811) % 10_000_000).padStart(7, '0')}`;

const created = { userIds: [], listingIds: [], dealerIds: [] };

function client() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
      const response = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
          ...(body && raw ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: raw ? new URLSearchParams(body).toString() : body ? JSON.stringify(body) : undefined,
      });
      for (const rawCookie of response.headers.getSetCookie()) {
        const [pair] = rawCookie.split(';');
        if (pair.split('=')[0] === 'hc_session') cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html */
      }
      return { status: response.status, location: response.headers.get('location'), headers: response.headers, text, json };
    },
  };
}

/**
 * Sign in with a fresh number and hand back the session plus the account row it
 * created, ready to be promoted to `dealer` and linked to a lot.
 */
async function signIn() {
  const db = require('../src/db');
  const web = client();
  const phone = nextPhone();
  const otp = await web.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, otp.text);
  const verify = await web.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  assert.equal(verify.status, 200, verify.text);

  const account = await db.queryOne('SELECT id, phone, role FROM `users` WHERE phone = ? LIMIT 1', [otp.json.phone]);
  assert.ok(account, 'signing in created the account');
  if (!created.userIds.includes(account.id)) created.userIds.push(account.id);
  return { web, phone, normalised: otp.json.phone, account };
}

/** Promote the fresh account to a dealer and link a lot — what ops does on /admin/staff. */
async function linkFreshLot(webSession) {
  const db = require('../src/db');
  await db.query("UPDATE `users` SET role = 'dealer' WHERE id = ?", [webSession.account.id]);
  const unclaimed = (await db.dealers.unclaimed(5)).find((row) => row.id !== 3);
  assert.ok(unclaimed, 'a lot to link');
  if (!created.dealerIds.includes(unclaimed.id)) created.dealerIds.push(unclaimed.id);
  const linked = await db.dealers.linkUser(unclaimed.id, webSession.account.id);
  assert.equal(linked.ok, true, `linking ${unclaimed.name} to the fresh account: ${linked.error || 'ok'}`);
  return unclaimed;
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (!available) return;
  const db = require('../src/db');
  if (created.listingIds.length) {
    await db.query(`DELETE FROM listing_media WHERE listing_id IN (${created.listingIds.map(() => '?').join(',')})`, created.listingIds);
    await db.query(`DELETE FROM leads WHERE listing_id IN (${created.listingIds.map(() => '?').join(',')})`, created.listingIds);
    await db.query(`DELETE FROM vehicle_listings WHERE id IN (${created.listingIds.map(() => '?').join(',')})`, created.listingIds);
  }
  for (const dealerId of created.dealerIds) await db.query('UPDATE dealers SET user_id = NULL WHERE id = ?', [dealerId]);
  if (created.userIds.length) {
    await db.query(`DELETE FROM saved_cars WHERE user_id IN (${created.userIds.map(() => '?').join(',')})`, created.userIds);
    await db.query(`DELETE FROM sessions WHERE user_id IN (${created.userIds.map(() => '?').join(',')})`, created.userIds);
    await db.query(`DELETE FROM users WHERE id IN (${created.userIds.map(() => '?').join(',')})`, created.userIds);
  }
  // Fixtures gone; drop the audit rows naming them (see test/helpers.js).
  await sweepOrphanAudit(db.query);
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The data layer
// ---------------------------------------------------------------------------

maybe('a dealer account resolves to its own lot, and nothing else', async () => {
  const db = require('../src/db');
  const account = await db.queryOne("SELECT u.id FROM `users` u WHERE u.role = 'dealer' AND u.phone = '+2348000000006' LIMIT 1");
  assert.ok(account, 'the seed ships a dealer account with a linked lot');

  const lot = await db.dealers.forUser(account.id);
  assert.ok(lot, 'the account resolves to a lot');
  assert.equal(lot.name, 'Woji Car Mart');
  assert.ok(lot.listingsTotal > 0, 'and the lot has stock to manage');

  assert.equal(await db.dealers.forUser(999_999_999), null, 'an unknown account owns no lot');
});

maybe('every read and write is scoped to the lot, never to the URL', async () => {
  const db = require('../src/db');
  const woji = await db.dealers.byId(3);
  const other = await db.dealers.byId(1);
  assert.notEqual(woji.id, other.id);

  const [wojiListing] = await db.query('SELECT id FROM vehicle_listings WHERE dealer_id = ? LIMIT 1', [woji.id]);
  assert.ok(wojiListing, 'Woji has stock');

  assert.ok(await db.dealers.listingForDealer(woji.id, wojiListing.id), 'the owner can open it');
  assert.equal(await db.dealers.listingForDealer(other.id, wojiListing.id), null, 'another lot cannot even read it');

  const blocked = await db.dealers.updateListing(other.id, wojiListing.id, { priceKobo: 1, mileageKm: 1, area: 'Woji', documents: {} });
  assert.equal(blocked.ok, false);
  const blockedStatus = await db.dealers.setListingStatus(other.id, wojiListing.id, 'sold');
  assert.equal(blockedStatus.ok, false);
  const blockedPhoto = await db.dealers.addPhoto(other.id, wojiListing.id, { url: '/img/cars/honda-crv-silver.jpg' });
  assert.equal(blockedPhoto.ok, false);
  const blockedFresh = await db.dealers.confirmFresh(other.id, wojiListing.id);
  assert.equal(blockedFresh.ok, false);

  // And an enquiry about another lot's car is not this lot's to move.
  const [foreignLead] = await db.query(
    'SELECT le.id FROM leads le JOIN vehicle_listings l ON l.id = le.listing_id WHERE l.dealer_id = ? LIMIT 1',
    [other.id],
  );
  if (foreignLead) {
    const leadBlocked = await db.dealers.setLeadStatus(woji.id, foreignLead.id, 'contacted');
    assert.equal(leadBlocked.ok, false, 'lead writes are scoped too');
  }
});

maybe('a listing goes live only through review — the dealer submits, ops publishes', async () => {
  const db = require('../src/db');
  const lot = await db.dealers.byId(3);

  const draft = await db.dealers.createListing(lot.id, {
    year: 2014,
    make: 'Mazda',
    model: 'CX-5',
    trim: 'Touring',
    bodyType: 'suv',
    transmission: 'automatic',
    fuelType: 'petrol',
    engineSize: '2.0L',
    drivetrain: 'fwd',
    extColour: 'Grey',
    condition: 'nigerian_used',
    mileageKm: 132_000,
    features: ['Reverse camera'],
    priceKobo: 9_500_000_00,
    negotiable: true,
    area: 'Woji',
    documents: { registration: true },
    description: 'Test draft',
    honestNote: 'Test note',
  });
  created.listingIds.push(draft.id);
  assert.match(draft.stockNo, /^HC-PH-\d{4}$/, 'stock numbers are minted from the network sequence');
  assert.match(draft.slug, /^2014-mazda-cx-5-hc-ph-\d{4}$/, 'and the VDP slug follows the §14 contract');

  let listing = await db.dealers.listingForDealer(lot.id, draft.id);
  assert.equal(listing.status, 'draft', 'a new car starts as a draft');
  assert.equal(listing.priceKobo, 9_500_000_00);

  const tooFewPhotos = await db.dealers.setListingStatus(lot.id, draft.id, 'in_review');
  assert.equal(tooFewPhotos.ok, false, 'no photographs, no submission');
  assert.match(tooFewPhotos.error, /three photos/i);

  await db.dealers.addPhoto(lot.id, draft.id, { url: '/img/cars/honda-crv-silver.jpg', shot: 'Front three-quarter' });
  await db.dealers.addPhoto(lot.id, draft.id, { url: '/img/cars/toyota-camry-white.jpg', shot: 'Rear three-quarter' });
  assert.equal((await db.dealers.setListingStatus(lot.id, draft.id, 'in_review')).ok, false, 'two is still not three');

  const badUrl = await db.dealers.addPhoto(lot.id, draft.id, { url: 'javascript:alert(1)' });
  assert.equal(badUrl.ok, false, 'a photo has to be an image URL we can serve');

  await db.dealers.addPhoto(lot.id, draft.id, { url: '/img/cars/lexus-rx350-black.jpg', shot: 'Interior' });
  const submitted = await db.dealers.setListingStatus(lot.id, draft.id, 'in_review');
  assert.equal(submitted.ok, true, 'three photographs and a documents tick clears the gate');

  listing = await db.dealers.listingForDealer(lot.id, draft.id);
  assert.equal(listing.status, 'in_review');
  assert.equal(
    await scalar(db, "SELECT status FROM vehicle_listings WHERE id = ?", [draft.id]),
    'in_review',
    'and it waits there: the dealer cannot publish',
  );

  const cannotPublish = await db.dealers.setListingStatus(lot.id, draft.id, 'live');
  assert.equal(cannotPublish.ok, false, 'there is no dealer transition into live');
  assert.match(cannotPublish.error, /cannot be moved/i);

  const withdrawn = await db.dealers.setListingStatus(lot.id, draft.id, 'draft');
  assert.equal(withdrawn.ok, true, 'a dealer may pull a submission back');
  assert.equal(
    await scalar(db, 'SELECT published_at FROM vehicle_listings WHERE id = ?', [draft.id]),
    null,
    'and a withdrawn car is not marked published',
  );
});

maybe('a price edit feeds the FR-25 watch, and the drop reaches the buyer once', async () => {
  const db = require('../src/db');
  const alerts = require('../src/services/alerts');
  const lot = await db.dealers.byId(3);

  const draft = await db.dealers.createListing(lot.id, {
    year: 2015,
    make: 'Nissan',
    model: 'X-Trail',
    trim: 'SV',
    bodyType: 'suv',
    transmission: 'automatic',
    fuelType: 'petrol',
    condition: 'nigerian_used',
    mileageKm: 120_000,
    features: [],
    priceKobo: 12_000_000_00,
    area: 'Woji',
    documents: {},
    description: 'Price watch fixture',
    honestNote: null,
  });
  created.listingIds.push(draft.id);
  await db.query("UPDATE vehicle_listings SET status = 'live', expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 DAY) WHERE id = ?", [draft.id]);

  // A customer saves the car at the price they saw.
  const account = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', ['+2348031234567']);
  await db.query('DELETE FROM saved_cars WHERE user_id = ? AND listing_id = ?', [account.id, draft.id]);
  await db.query('INSERT INTO saved_cars (user_id, listing_id, last_price_kobo, last_alerted_at) VALUES (?, ?, ?, UTC_TIMESTAMP())', [
    account.id,
    draft.id,
    12_000_000_00,
  ]);

  // `watchList()` is what the alerts console shows and what a sweep acts on,
  // so asserting on it is the same contract without moving every other saved
  // car in the database — this suite shares that table with the alerts suite.
  const before = await alerts.watchList();
  const watched = before.cars.find((car) => car.listing.id === draft.id);
  assert.ok(watched, 'the saved car is being watched');
  assert.equal(watched.pendingDrop, 0, 'nothing to say while the price holds');

  const edit = await db.dealers.updateListing(lot.id, draft.id, {
    priceKobo: 11_400_000_00,
    mileageKm: 120_000,
    area: 'Woji',
    documents: {},
    description: 'Price watch fixture',
    negotiable: true,
  });
  assert.equal(edit.ok, true);
  assert.equal(edit.priceChanged, true, 'the portal is told the price moved');
  assert.equal(edit.previousPriceKobo, 12_000_000_00);

  const after = await alerts.watchList();
  const watchedAfter = after.cars.find((car) => car.listing.id === draft.id);
  assert.ok(watchedAfter, 'still watched after the edit');
  assert.equal(watchedAfter.pendingDrop, 600_000_00, 'the next sweep will find the dealer’s own price cut');

  // And the message it would send is the FR-25 price-drop text.
  const message = alerts.dropMessage(watchedAfter.listing, 12_000_000_00, 11_400_000_00);
  assert.match(message, /₦600,000/, 'the alert names the fall');
  assert.match(message, /down/, 'and says which direction the price moved');

  // Housekeeping: the saved row is this test's, and the run above was a dry
  // run, so it wrote nothing else.
  await db.query('DELETE FROM saved_cars WHERE user_id = ? AND listing_id = ?', [account.id, draft.id]);
});

maybe('the leads inbox is scoped, maskable and feeds the ops pipeline', async () => {
  const db = require('../src/db');
  const admin = require('../src/db/admin');
  const lot = await db.dealers.byId(3);

  const rows = await db.dealers.leads(lot.id);
  assert.ok(rows.length, 'the seeded lot has enquiries');
  for (const row of rows) assert.ok(row.phoneMasked.includes('•••'), 'the list shows a masked number');

  const lead = rows[0];
  const original = lead.status;
  const moved = await db.dealers.setLeadStatus(lot.id, lead.id, 'contacted');
  assert.equal(moved.ok, true);
  assert.equal(moved.from, original);

  const after = (await db.dealers.leads(lot.id)).find((row) => row.id === lead.id);
  assert.equal(after.status, 'contacted');
  assert.ok(after.contacted, 'answering stamps the contact time the scorecard averages');
  assert.ok(after.lastContactedAt, 'and that timestamp is stored');

  // §7.2: the dealer’s update is the ops inbox’s update — same record, not a
  // copy. The inbox merges leads and service_requests, whose ids collide, so
  // the match has to name the kind as well.
  const inbox = await admin.leadsInbox({ limit: 200 });
  const seen = inbox.rows.find((row) => row.id === lead.id && row.kind === 'lead');
  assert.ok(seen, 'the enquiry is in the ops inbox too');
  assert.equal(seen.status, 'contacted', 'ops sees the dealer’s move, not a parallel copy');
  assert.ok(seen.lastContactedAt, 'and the contact stamp the scorecard reads');

  const unknown = await db.dealers.setLeadStatus(lot.id, lead.id, 'not-a-status');
  assert.equal(unknown.ok, false);

  // Put it back so the dev database reads as it did.
  await db.query('UPDATE leads SET status = ?, lost_reason = ?, last_contacted_at = ? WHERE id = ?', [
    original,
    lead.lostReason,
    lead.lastContactedAt,
    lead.id,
  ]);
});

maybe('performance measures speed and freshness, and names the stale cars', async () => {
  const db = require('../src/db');
  const lot = await db.dealers.byId(3);
  const performance = await db.dealers.performance(lot.id);

  assert.ok(performance.totals.listings > 0);
  assert.ok(performance.totals.views >= performance.totals.enquiries, 'views ≥ enquiries, always');
  assert.ok(performance.enquiryRate >= 0 && performance.enquiryRate <= 1, 'the rate is a proportion');
  assert.match(performance.response.verdict, /Fast|Fine|Slow|No enquiries/);
  assert.ok(performance.response.answered + performance.response.unanswered <= performance.totals.enquiries);

  assert.ok(performance.freshness.length, 'live cars appear in the freshness scorecard');
  for (const row of performance.freshness) {
    assert.ok(row.url.startsWith('/cars/'), 'each row links to the public page');
    assert.ok(Number.isFinite(row.daysSinceUpdate), 'and carries a number of days');
    assert.equal(typeof row.stale, 'boolean');
  }
});

maybe('commission is the sum of the ledger, and the statement names its rows', async () => {
  const db = require('../src/db');
  const lot = await db.dealers.byId(3);
  const statements = await db.dealers.statements(lot.id);
  assert.ok(statements.length, 'the seeded lot has a ledger');

  const dashboard = await db.dealers.dashboard(lot.id);
  const summed = statements.reduce((total, row) => total + row.amountKobo, 0);
  assert.equal(summed, dashboard.commission.balance_kobo, 'the balance is the rows, added up');
  assert.equal(
    dashboard.commission.owed_kobo - dashboard.commission.paid_kobo,
    dashboard.commission.balance_kobo,
    'earned minus paid equals the balance',
  );
  assert.ok(statements.some((row) => row.type === 'sale_commission'), 'commission entries are named');
  assert.ok(statements.every((row) => row.amountKobo !== 0), 'a zero row would be noise');
});

maybe('one account per lot, and the link can be moved but not duplicated', async () => {
  const db = require('../src/db');
  const session = await signIn();

  const unclaimed = await db.dealers.unclaimed(5);
  assert.ok(unclaimed.length, 'the seed leaves lots unclaimed for onboarding');
  const lotId = unclaimed[0].id;
  created.dealerIds.push(lotId);

  const linked = await db.dealers.linkUser(lotId, session.account.id);
  assert.equal(linked.ok, true);
  assert.equal((await db.dealers.forUser(session.account.id)).id, lotId, 'the account now runs that lot');

  const other = unclaimed.find((row) => row.id !== lotId);
  if (other) {
    created.dealerIds.push(other.id);
    const second = await db.dealers.linkUser(other.id, session.account.id);
    assert.equal(second.ok, false, 'one account cannot own two lots');
    assert.match(second.error, /already owns/i);
  }

  const taken = await db.queryOne('SELECT id FROM dealers WHERE user_id IS NOT NULL AND user_id <> ? LIMIT 1', [session.account.id]);
  if (taken) {
    const clash = await db.dealers.linkUser(taken.id, session.account.id);
    assert.equal(clash.ok, false, 'and two accounts cannot share one lot');
  }

  assert.equal((await db.dealers.unlinkUser(lotId)).ok, true);
  assert.equal(await db.dealers.forUser(session.account.id), null, 'unlinked, the portal has nothing to show');
  assert.equal((await db.dealers.linkUser(lotId, session.account.id)).ok, true, 'and it can be linked again');
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

maybe('signed out, /dealer is the partner door and stays out of search', async () => {
  const anonymous = client();
  const response = await anonymous.request('/dealer');

  assert.equal(response.status, 200);
  assert.match(response.text, /Run your lot from one screen/);
  assert.match(response.text, /Sign in to the portal/);
  assert.match(response.text, /noindex/i, 'the portal never advertises itself to search');
  assert.doesNotMatch(response.text, /undefined|NaN|<%/, 'no template artefacts');
});

maybe('a customer account is refused, and told why', async () => {
  const { web } = await signIn();
  const response = await web.request('/dealer/dashboard');
  assert.equal(response.status, 403, 'a customer does not open the portal');
  assert.match(response.text, /not yours to open|No access/i);

  const landing = await web.request('/dealer');
  assert.equal(landing.status, 200);
  assert.match(landing.text, /customer<\/strong> account|Go to my account/, 'the landing page tells them which role they hold');
});

maybe('a linked dealer account gets its own lot, and only its own lot', async () => {
  const db = require('../src/db');
  const session = await signIn();
  const { web } = session;

  // What ops does on /admin/staff after the account signs in for the first time.
  const unclaimed = await linkFreshLot(session);

  const home = await web.request('/dealer');
  assert.equal(home.status, 302);
  assert.equal(home.location, '/dealer/dashboard', 'the door opens straight onto the dashboard');

  const dashboard = await web.request('/dealer/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, new RegExp(unclaimed.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'named as their own lot');
  assert.match(dashboard.text, /Dealer portal/, 'in the dealer chrome, not the ops chrome');
  assert.doesNotMatch(dashboard.text, /undefined|NaN|<%/, 'no template artefacts');
  assert.match(dashboard.headers.get('cache-control') || '', /no-store/, 'a personalised page is never cached publicly');

  for (const path of ['/dealer/listings', '/dealer/listings/new', '/dealer/leads', '/dealer/performance', '/dealer/billing', '/dealer/profile']) {
    const page = await web.request(path);
    assert.equal(page.status, 200, `${path} renders for a signed-in lot`);
    assert.doesNotMatch(page.text, /undefined|NaN|<%/, `${path} has no template artefacts`);
  }

  // Another lot's car is not reachable, and the refusal is a sentence.
  // A *live* car of another lot: the assertion below is that this write changed
  // nothing, so the fixture has to be something the write could have changed.
  const foreign = await db.queryOne(
    "SELECT id, stock_no FROM vehicle_listings WHERE dealer_id = ? AND status = 'live' LIMIT 1",
    [3],
  );
  const peek = await web.request(`/dealer/listings/${foreign.id}`);
  assert.equal(peek.status, 303, 'not found is answered by a redirect back to the inbox');
  assert.match(decodeURIComponent(peek.location), /not one of yours/i);
  assert.doesNotMatch(peek.text, new RegExp(foreign.stock_no), 'and the stock number is not leaked');

  const write = await web.request(`/dealer/listings/${foreign.id}/status`, { method: 'POST', raw: true, body: { status: 'sold' } });
  assert.equal(write.status, 303);
  assert.match(decodeURIComponent(write.location), /not one of yours/i);
  assert.equal(
    await scalar(db, 'SELECT status FROM vehicle_listings WHERE id = ?', [foreign.id]),
    'live',
    'and the other lot’s car is untouched',
  );
});

maybe('the wizard posts a real car, gates the photographs, and lands in the ops queue', async () => {
  const db = require('../src/db');
  const admin = require('../src/db/admin');
  const session = await signIn();
  const { web } = session;
  const unclaimed = await linkFreshLot(session);

  const created405 = await web.request('/dealer/listings', {
    method: 'POST',
    raw: true,
    body: {
      year: '2016',
      make: 'Hyundai',
      model: 'Tucson',
      body_type: 'suv',
      transmission: 'automatic',
      fuel_type: 'petrol',
      mileage_km: '98000',
      asking_price: '₦9,750,000',
      area: 'Woji',
      registration: '1',
      description: 'Wizard fixture',
      honest_note: 'Wizard fixture',
      photo_front: 'https://cdn.example.com/tucson-front.jpg',
      photo_rear: 'https://cdn.example.com/tucson-rear.jpg',
      photo_interior: 'https://cdn.example.com/tucson-inside.jpg',
    },
  });
  assert.equal(created405.status, 303, created405.text);
  const location = decodeURIComponent(created405.location);
  assert.match(location, /^\/dealer\/listings\/\d+\?ok=Draft saved/);
  assert.match(location, /3 photographs/);

  const listingId = Number(location.match(/\/dealer\/listings\/(\d+)/)[1]);
  created.listingIds.push(listingId);

  const row = await db.queryOne('SELECT id, dealer_id, status, asking_price_kobo, seo_slug FROM vehicle_listings WHERE id = ?', [listingId]);
  assert.equal(row.dealer_id, unclaimed.id, 'the car belongs to the lot that posted it');
  assert.equal(row.status, 'draft', 'and it is a draft, not a published listing');
  assert.equal(row.asking_price_kobo, 9_750_000_00, '₦9,750,000 from a browser is stored as kobo, server-side');
  assert.match(row.seo_slug, /^2016-hyundai-tucson-hc-ph-\d{4}$/);

  const media = await db.query('SELECT url, shot_label FROM listing_media WHERE listing_id = ? ORDER BY position', [listingId]);
  assert.equal(media.length, 3, 'the guided shot list is attached');
  assert.equal(media[0].shot_label, 'Front three-quarter');

  const submit = await web.request(`/dealer/listings/${listingId}/status`, { method: 'POST', raw: true, body: { status: 'in_review' } });
  assert.equal(submit.status, 303);
  assert.match(decodeURIComponent(submit.location), /with the HonestCars team for review/);

  // The ops side of the same hand-off.
  const queue = await admin.moderationList({ status: 'in_review', limit: 100 });
  const queued = queue.rows.find((item) => item.id === listingId);
  assert.ok(queued, 'ops finds the dealer submission in the moderation queue (§7.3)');

  const published = await admin.publishListing(listingId, { grade: 'network_listed', actorId: null });
  assert.equal(published.ok, true, 'and publishing it is ops’ call, not the dealer’s');
  assert.equal(await scalar(db, 'SELECT status FROM vehicle_listings WHERE id = ?', [listingId]), 'live');
});

maybe('a cross-site POST cannot move a listing, even with a valid dealer session', async () => {
  const db = require('../src/db');
  const session = await signIn();
  const { web } = session;
  const unclaimed = await linkFreshLot(session);

  const [own] = await db.query('SELECT id, status FROM vehicle_listings WHERE dealer_id = ? LIMIT 1', [unclaimed.id]);
  if (!own) return;

  const crossSite = await web.request(`/dealer/listings/${own.id}/status`, {
    method: 'POST',
    raw: true,
    headers: { Origin: 'https://evil.example' },
    body: { status: 'sold' },
  });
  assert.ok(crossSite.status >= 400, '§12.2: an off-site form post is refused');
  assert.equal(
    await scalar(db, 'SELECT status FROM vehicle_listings WHERE id = ?', [own.id]),
    own.status,
    'and nothing moved',
  );
});
