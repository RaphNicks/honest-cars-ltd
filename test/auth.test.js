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
      const marks = [...createdPhones].map(() => '?').join(',');
      await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, [...createdPhones]);
      await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, [...createdPhones]);
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

  const off = await client.request('/api/account/saved-searches', {
    method: 'POST',
    body: { action: 'toggle', id, alertsEnabled: false },
  });
  assert.equal(off.json.alertsEnabled, false);

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
// Sign-out and deletion
// ---------------------------------------------------------------------------

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
