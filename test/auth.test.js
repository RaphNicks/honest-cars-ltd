'use strict';

/**
 * Auth + account end-to-end (§7.1, §12.2).
 *
 * Drives the real HTTP endpoints against the real database: request a code,
 * trade it for a session, save a car and a search, close the account. Skips
 * itself when MySQL is unreachable, like the other DB-backed suites.
 *
 * Every sign-in uses its own number: the per-phone OTP limit is 5 an hour, so
 * sharing one across the suite would fail for the wrong reason. Numbers are
 * typed in the local shape on purpose — normalisation is part of the contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer } = require('./helpers');

let available = false;
let ctx;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

/** A fresh number for every sign-in: 11 digits, local shape (0803…). */
const run = (Number(process.pid) * 7919 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0803${String((run * 3 + seq * 977) % 10_000_000).padStart(7, '0')}`;
}

/** Accounts created by this run — removed again in test.after so the dev DB stays tidy. */
const createdRequests = new Set();
const createdPhones = new Set();

/** Cookie-aware fetch: keeps hc_session between calls, manual redirects. */
function newClient() {
  let cookie = '';
  let rawCookies = [];
  return {
    get cookie() {
      return cookie;
    },
    /** Every raw Set-Cookie header seen — attributes included. */
    get rawCookies() {
      return rawCookies;
    },
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const raw of response.headers.getSetCookie()) {
        rawCookies = [raw];
        const [pair] = raw.split(';');
        const name = pair.split('=')[0];
        if (name === 'hc_session') cookie = pair.endsWith('=') ? '' : pair;
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

/** Request a code, trade it for a session, return the ready-to-use client. */
async function signIn(phone = nextPhone()) {
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(otp.status, 200, otp.text);
  assert.equal(otp.json.ok, true);
  assert.equal(otp.json.phone, `+234${phone.replace(/^0/, '')}`, 'stored normalised as +234…');
  assert.match(otp.json.maskedPhone, /•••/, 'the response masks the number');

  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  assert.equal(verify.status, 200, verify.text);
  assert.equal(verify.json.ok, true);

  const normalised = `+234${phone.replace(/^0/, '')}`;
  createdPhones.add(normalised);
  return { client, code: otp.json.devCode, phone, normalised };
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (available) {
    const db = require('../src/db');
    // Test accounts are throwaway: clean them up so the dev database stays
    // readable. Sessions, saved cars and saved searches cascade with the user.
    if (createdPhones.size) {
      const { variants } = require('../src/lib/phone');
      const shapes = [...new Set([...createdPhones].flatMap((number) => variants(number)))];
      const marks = shapes.map(() => '?').join(',');
      // Payment rows point at orders (ON DELETE SET NULL) and hold the customer
      // phone themselves, so they are removed first — otherwise a test run
      // leaves orphaned money in the demo console.
      await db.query(`DELETE FROM payments WHERE customer_phone IN (${marks})`, shapes);
      for (const table of ['service_requests', 'bookings', 'leads', 'orders', 'subscriptions']) {
        const column = table === 'subscriptions' ? 'customer_phone' : 'phone';
        await db.query(`DELETE FROM ${table} WHERE ${column} IN (${marks})`, shapes);
      }
      await db.query(`DELETE FROM notifications WHERE recipient IN (${marks})`, shapes);
      if (createdRequests.size) {
        const requestMarks = [...createdRequests].map(() => '?').join(',');
        await db.query(`DELETE FROM service_requests WHERE tracking_id IN (${requestMarks})`, [...createdRequests]);
      }
      await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, shapes);
      await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
    }
    await db.pool.end();
  }
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

maybe('sign-in page is a real page, noindex, and offers the phone-first form', async () => {
  const response = await fetch(`${ctx.baseUrl}/login`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const html = await response.text();
  assert.match(html, /noindex, ?nofollow/i);
  assert.match(html, /name="phone"/);
  assert.match(html, /name="consent"/);
  assert.match(html, /WhatsApp/);
});

maybe('a code arrives, is single-use, and buys a session cookie', async () => {
  const { client, code, phone } = await signIn();

  const cookie = client.rawCookies.join('\n');
  assert.match(cookie, /hc_session=[^;]+/);
  assert.match(cookie, /HttpOnly/i, 'the session cookie is not readable from JavaScript');
  assert.match(cookie, /SameSite=Lax/i, '§12.2: Lax keeps the cookie off cross-site form posts');
  assert.doesNotMatch(cookie, /Secure/i, 'dev runs over http');

  const dashboard = await client.request('/account');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Your cars and requests/);
  assert.match(dashboard.headers.get('cache-control'), /no-store/, 'a signed-in page is never publicly cached');

  const reuse = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code } });
  assert.equal(reuse.json.ok, false);
  assert.equal(reuse.status, 410, 'a used code is gone, not merely wrong');
  assert.match(reuse.json.error, /expired/i);
});

maybe('a wrong code is refused without burning the real one', async () => {
  const phone = nextPhone();
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  const wrong = await client.request('/api/auth/verify', {
    method: 'POST',
    body: { phone, code: otp.json.devCode === '000000' ? '111111' : '000000' },
  });
  assert.equal(wrong.json.ok, false);

  const right = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  assert.equal(right.json.ok, true, 'the correct code still works after a wrong guess');
  createdPhones.add(`+234${phone.replace(/^0/, '')}`);
});

maybe('accounts are keyed on the number, whatever shape it was typed in', async () => {
  const { normalised } = await signIn();
  const db = require('../src/db');
  const local = `0${normalised.slice(4)}`;

  const [{ id: first }] = await db.query('SELECT id FROM `users` WHERE phone = ?', [normalised]);
  for (const shape of [local, normalised.slice(1), normalised, `${normalised.slice(1, 4)} ${normalised.slice(4)}`]) {
    assert.equal(require('../src/lib/phone').normalise(shape), normalised, `normalises ${shape}`);
  }
  const again = await db.users.upsertByPhone({ phone: normalised });
  assert.equal(again.id, first, 'no duplicate account for the same number');
});

maybe('unauthenticated account APIs answer 401, not a page', async () => {
  const client = newClient();
  const response = await client.request('/api/account/saved-cars', { method: 'POST', body: { listingId: 1, action: 'add' } });
  assert.equal(response.status, 401);
  assert.equal(response.json.ok, false);
  assert.match(response.json.error, /Sign in/i);
});

maybe('a cross-site POST is refused even with a valid session (§12.2)', async () => {
  const { client } = await signIn();
  const response = await client.request('/api/account/saved-cars', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: { listingId: 1, action: 'add' },
  });
  assert.equal(response.status, 403);
  assert.match(response.json.error, /Cross-site/i);
});

// ---------------------------------------------------------------------------
// Dashboard records
// ---------------------------------------------------------------------------

maybe('saving a car twice is idempotent, and removing it is honest about it', async () => {
  const { client } = await signIn();
  const db = require('../src/db');
  const [listing] = await db.query("SELECT id, seo_slug FROM vehicle_listings WHERE status = 'live' LIMIT 1");

  const first = await client.request('/api/account/saved-cars', { method: 'POST', body: { listingId: listing.id } });
  assert.equal(first.json.saved, true);
  const second = await client.request('/api/account/saved-cars', { method: 'POST', body: { listingId: listing.id } });
  assert.equal(second.json.saved, true);
  assert.equal(second.json.count, 1, 'saving twice does not double the record');

  const dashboard = await client.request('/account');
  assert.match(dashboard.text, new RegExp(listing.seo_slug), 'the saved car is on the dashboard');

  const removed = await client.request('/api/account/saved-cars', {
    method: 'POST',
    body: { listingId: listing.id, action: 'remove' },
  });
  assert.equal(removed.json.saved, false);
  assert.equal(removed.json.count, 0);
});

maybe('the save button is the right control for the visitor', async () => {
  const db = require('../src/db');
  const [listing] = await db.query("SELECT id, seo_slug FROM vehicle_listings WHERE status = 'live' LIMIT 1");

  const signedOut = await fetch(`${ctx.baseUrl}/cars/${listing.seo_slug}`);
  assert.match(await signedOut.text(), /\/login\?next=[^"]*&amp;save=/, 'signed out: the save control is a link into sign-in');

  const { client } = await signIn();
  const signedIn = await client.request(`/cars/${listing.seo_slug}`);
  assert.match(signedIn.text, /data-save-car/, 'signed in: the save control posts to the account');
});

maybe('saved searches keep their query, their alerts, and can be deleted', async () => {
  const { client, normalised } = await signIn();
  const created = await client.request('/api/account/saved-searches', {
    method: 'POST',
    body: { action: 'add', query: 'make=toyota&max_price=15000000', label: 'Toyota under ₦15m' },
  });
  assert.equal(created.json.ok, true);
  const id = created.json.savedSearch.id;

  // The master switch is still accepted (older clients used it) and switches
  // both channels off.
  const off = await client.request('/api/account/saved-searches', {
    method: 'POST',
    body: { action: 'toggle', id, alertsEnabled: false },
  });
  assert.equal(off.json.savedSearch.priceDrop, false);
  assert.equal(off.json.savedSearch.newMatch, false);
  assert.equal(off.json.savedSearch.alertsEnabled, false);

  const dashboard = await client.request('/account');
  assert.match(dashboard.text, /Toyota under/);

  const deleted = await client.request('/api/account/saved-searches', { method: 'POST', body: { action: 'delete', id } });
  assert.equal(deleted.json.ok, true);
  const db = require('../src/db');
  const user = await db.users.findByPhone(normalised);
  assert.equal((await db.users.savedSearches(user.id)).filter((row) => row.id === id).length, 0, 'the row is gone');
});

maybe('profile details round-trip and marketing consent is explicit', async () => {
  const { client, normalised } = await signIn();
  const saved = await client.request('/api/account/profile', {
    method: 'POST',
    body: { name: 'Test Buyer', email: 'buyer@example.com', marketingOptIn: true },
  });
  assert.equal(saved.json.ok, true);

  const db = require('../src/db');
  const user = await db.users.findByPhone(normalised);
  assert.equal(user.name, 'Test Buyer');
  assert.equal(user.email, 'buyer@example.com');
  assert.equal(user.marketingOptIn, true);

  const html = await client.request('/account');
  assert.match(html.text, /Test Buyer/);
});

maybe('data export returns everything keyed to the number and no analytics', async () => {
  const { client, normalised } = await signIn();
  const response = await client.request('/account/export');
  assert.equal(response.status, 200);
  assert.equal(response.json.account.phone, normalised);
  for (const key of ['requests', 'bookings', 'orders', 'subscriptions', 'savedCars', 'savedSearches']) {
    assert.ok(key in response.json, `export includes ${key}`);
  }
  assert.doesNotMatch(response.text, /analytics_events|listing_view/);
});

maybe('records written by the public forms surface in the dashboard (§7.1)', async () => {
  const { client, phone } = await signIn();
  const created = await client.request('/api/service-requests', {
    method: 'POST',
    body: { type: 'concierge', name: 'Test Buyer', phone, brief: { budget: '8-12m', must_haves: 'SUV, low mileage' } },
  });
  assert.equal(created.json.ok, true);
  const dashboard = await client.request('/account');
  assert.match(dashboard.text, new RegExp(created.json.trackingId), 'the request is on the dashboard');
});

// ---------------------------------------------------------------------------
// §7.1 cards: referrals, hire, documents, alert switches
// ---------------------------------------------------------------------------

maybe('every account gets a referral code and a shareable link', async () => {
  const { client, normalised } = await signIn();
  const db = require('../src/db');
  const user = await db.users.findByPhone(normalised);
  assert.match(user.referralCode, /^[2-9A-HJ-NP-Z]{6}$/, 'a readable, unambiguous code');

  const page = await client.request('/account');
  assert.match(page.text, /id="referrals"/);
  assert.match(page.text, new RegExp(`ref=${user.referralCode}`), 'the link carries the code');
});

maybe('an invitation code is recorded once, on the new account, and never on itself', async () => {
  const inviter = await signIn();
  const db = require('../src/db');
  const inviterUser = await db.users.findByPhone(inviter.normalised);

  // A new person arrives through the link.
  const guest = await signIn();
  const guestUser = await db.users.findByPhone(guest.normalised);
  assert.equal(guestUser.referredBy, null, 'no code sent yet → no referrer');

  const invited = newClient();
  const phone = nextPhone();
  const otp = await invited.request('/api/auth/otp', { method: 'POST', body: { phone } });
  const verify = await invited.request('/api/auth/verify', {
    method: 'POST',
    body: { phone, code: otp.json.devCode, ref: inviterUser.referralCode },
  });
  assert.equal(verify.json.ok, true);
  const normalised = `+234${phone.replace(/^0/, '')}`;
  createdPhones.add(normalised);

  const invitedUser = await db.users.findByPhone(normalised);
  assert.equal(invitedUser.referredBy, inviterUser.id, 'the inviter is recorded');

  // The inviter's own dashboard counts them, and cannot refer themselves.
  const stats = await db.users.referralStats(inviterUser);
  assert.equal(stats.joined, 1);
  assert.equal(await db.users.findReferrer(inviterUser.referralCode, inviterUser.id), null, 'never self-referral');

  const { client: fresh } = await signIn(inviter.phone);
  const page = await fresh.request('/account');
  assert.match(page.text, /1<\/strong> signed up/);
});

maybe('hire gets its own card and is not double-counted in requests', async () => {
  const { client, phone } = await signIn();
  const created = await client.request('/api/service-requests', {
    method: 'POST',
    body: {
      kind: 'hire',
      name: 'Hire Tester',
      phone,
      brief: { vehicle_class: 'SUV (Prado / Highlander)', date_from: '2026-11-01', date_to: '2026-11-04', with_driver: 'yes', location: 'GRA' },
    },
  });
  assert.equal(created.json.ok, true);

  const page = await client.request('/account');
  const hireCard = page.text.slice(page.text.indexOf('id="hire"'), page.text.indexOf('id="bookings"'));
  assert.match(hireCard, /SUV \(Prado \/ Highlander\)/, 'the brief is on the hire card');
  assert.match(hireCard, /3 days/, 'the dates are turned into a duration');
  assert.match(hireCard, new RegExp(created.json.trackingId));

  const requestsCard = page.text.slice(page.text.indexOf('id="requests"'), page.text.indexOf('id="hire"'));
  assert.doesNotMatch(requestsCard, new RegExp(created.json.trackingId), 'not listed twice');
});

maybe('shop receipts land in Documents', async () => {
  const { client, phone } = await signIn();
  const order = await client.request('/api/orders', {
    method: 'POST',
    body: {
      name: 'Receipt Tester',
      phone,
      deliveryArea: 'Port Harcourt — GRA',
      items: [{ slug: 'obd2-scanner-basic', qty: 1 }],
    },
  });
  assert.equal(order.json.ok, true);

  // Documents now files the *payment* receipt (§7.3) rather than the order, so
  // a refunded or partially-refunded order shows what actually happened.
  assert.equal(order.json.payment.reference.startsWith('HC-PAY-'), true, 'checkout opened a payment row');

  const page = await client.request('/account');
  const documents = page.text.slice(page.text.indexOf('id="documents"'));
  assert.match(documents, new RegExp(order.json.orderNo), 'the order number is on the receipt');
  assert.match(documents, new RegExp(`/account/receipts/${order.json.payment.reference}`), 'the receipt opens');

  const receipt = await client.request(`/account/receipts/${order.json.payment.reference}`);
  assert.equal(receipt.status, 200);
  assert.match(receipt.text, /obd2/i, 'the receipt lists what was bought');
  assert.match(receipt.text, /pending/i, 'and its honest status');

  // Someone else’s reference is not theirs to read.
  const other = await client.request('/account/receipts/HC-PAY-000001');
  assert.equal(other.status, 404, 'a receipt that is not on this account is not shown');

  // And the order page turns the pending payment into transfer instructions.
  const orderPage = await client.request(`/order/${order.json.orderNo}`);
  assert.equal(orderPage.status, 200);
  assert.match(orderPage.text, new RegExp(order.json.payment.reference));
  assert.match(orderPage.text, /Account number/);
});

maybe('price-drop and new-match are separate switches, and the master derives from them', async () => {
  const { client } = await signIn();
  const created = await client.request('/api/account/saved-searches', {
    method: 'POST',
    body: { action: 'add', query: 'make=Toyota&max=15000000&body=suv', label: 'Toyota SUVs' },
  });
  const id = created.json.savedSearch.id;
  assert.equal(created.json.savedSearch.priceDrop, true);
  assert.equal(created.json.savedSearch.newMatch, true);

  const oneOff = await client.request('/api/account/saved-searches', {
    method: 'POST',
    body: { action: 'toggle', id, priceDrop: false, newMatch: true },
  });
  assert.equal(oneOff.json.savedSearch.priceDrop, false);
  assert.equal(oneOff.json.savedSearch.newMatch, true);
  assert.equal(oneOff.json.savedSearch.alertsEnabled, true, 'one switch on → alerts on');

  const bothOff = await client.request('/api/account/saved-searches', {
    method: 'POST',
    body: { action: 'toggle', id, priceDrop: false, newMatch: false },
  });
  assert.equal(bothOff.json.savedSearch.alertsEnabled, false, 'no switches on → alerts off');

  const page = await client.request('/account');
  assert.match(page.text, /Price drops/);
  assert.match(page.text, /New matches/);
  assert.match(page.text, /Make: Toyota/, 'the stored query is shown as readable chips');
});

// ---------------------------------------------------------------------------
// Sign-out and deletion
// ---------------------------------------------------------------------------

maybe('a blocked account loses its session on the next request', async () => {
  const { client, normalised } = await signIn();
  const db = require('../src/db');
  const user = await db.users.findByPhone(normalised);

  await db.query('UPDATE `users` SET status = ? WHERE id = ?', ['blocked', user.id]);
  const blocked = await client.request('/account');
  assert.equal(blocked.status, 302, 'a blocked account is not let in');

  const [{ n }] = await db.query(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    [user.id],
  );
  assert.equal(Number(n), 0, 'and its sessions are revoked, not left live');
});

maybe('a dead cookie sends the visitor back to /login and says why', async () => {
  // A cookie that no longer maps to a live session — exactly what an expired
  // session looks like from the browser's side.
  const response = await fetch(`${ctx.baseUrl}/account`, {
    redirect: 'manual',
    headers: { Cookie: 'hc_session=not-a-real-token' },
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /reason=expired/);
});

maybe('a blocked number can prove it owns the phone but still cannot sign in', async () => {
  const phone = nextPhone();
  const { client, normalised } = await signIn(phone);
  const db = require('../src/db');
  const user = await db.users.findByPhone(normalised);
  await db.query('UPDATE `users` SET status = ? WHERE id = ?', ['blocked', user.id]);

  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  assert.equal(verify.status, 403);
  assert.match(verify.json.error, /cannot sign in/i);

  const [{ n }] = await db.query(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP()',
    [user.id],
  );
  assert.equal(Number(n), 0);
});

maybe('signing out revokes the session', async () => {
  const { client } = await signIn();
  const out = await client.request('/api/auth/logout', { method: 'POST', body: { source: 'test' } });
  assert.equal(out.json.ok, true);
  const after = await client.request('/account');
  assert.equal(after.status, 302, 'signed out visitors are sent to /login');
  assert.match(after.headers.get('location'), /^\/login\?next=/);
});

maybe('closing an account deletes the person and anonymises the paperwork', async () => {
  const phone = nextPhone();
  const { client, normalised } = await signIn(phone);
  const db = require('../src/db');
  const request = await client.request('/api/service-requests', {
    method: 'POST',
    body: { type: 'concierge', name: 'Delete Me', phone, brief: { budget: '5-8m' } },
  });
  // Closing the account rewrites this row's phone to DELETED-…, so the
  // phone-keyed sweep in test.after can no longer match it. Remember it by
  // tracking id and remove it there by name.
  createdRequests.add(request.json.trackingId);

  const withoutConfirm = await client.request('/api/account/delete', { method: 'POST', body: { confirm: 'yes' } });
  assert.equal(withoutConfirm.json.ok, false, 'deletion needs the typed confirmation');

  const gone = await client.request('/api/account/delete', { method: 'POST', body: { confirm: 'delete' } });
  assert.equal(gone.json.ok, true);

  assert.equal(await db.users.findByPhone(normalised), null, 'the user row is gone');

  const [row] = await db.query('SELECT name, phone FROM service_requests WHERE tracking_id = ?', [request.json.trackingId]);
  assert.ok(row, 'the ops record survives for finance and warranty');
  assert.equal(row.name, 'Deleted account');
  assert.match(row.phone, /^DELETED-\d+$/);
  assert.doesNotMatch(row.phone, /234|803/);
});
