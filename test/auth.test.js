'use strict';

/**
 * Auth + account end-to-end (§7.1, §12.2).
 *
 * Drives the real HTTP endpoints against the real database: request a code,
 * trade it for a session, save a car and a search, close the account. Skips
 * itself when MySQL is unreachable, like the other DB-backed suites.
 *
 * Sign-in is email OTP (or Google) for every account — there is no phone
 * sign-in anywhere in this build. Every sign-in uses its own address: the
 * per-email code limit is 5 an hour, so sharing one across the suite would
 * fail for the wrong reason. Phone numbers still appear as *contact*
 * information on forms, and as the key on legacy records — those contracts are
 * tested here too, with legacy accounts built directly in the database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, nextEmail, makeAccount } = require('./helpers');

let available = false;
let ctx;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

/** A fresh contact number for every form that asks for one: 11 digits, local shape (0803…). */
const run = (Number(process.pid) * 7919 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0803${String((run * 3 + seq * 977) % 10_000_000).padStart(7, '0')}`;
}

/** Accounts created by this run — removed again in test.after so the dev DB stays tidy. */
const createdRequests = new Set();
/** Leads opened while creating those requests. Their phone is anonymised with the
 *  account, so they are remembered by id rather than swept by number. */
const createdLeadIds = new Set();
const createdPhones = new Set();
const createdEmails = new Set();

/** Cookie-aware fetch: keeps hc_session between calls, manual redirects. */
function newClient({ sessionToken = '' } = {}) {
  let cookie = sessionToken ? `hc_session=${sessionToken}` : '';
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

/** Request an email code, trade it for a session, return the ready-to-use client. */
async function signIn({ email = nextEmail('auth'), name = 'Test Buyer', ref = null, audience = 'customer' } = {}) {
  const client = newClient();
  const otp = await client.request('/api/auth/email/otp', { method: 'POST', body: { email, audience } });
  assert.equal(otp.status, 200, otp.text);
  assert.equal(otp.json.ok, true);
  assert.match(otp.json.maskedEmail, /@/, 'the response masks the address');
  assert.ok(otp.json.devCode, 'development exposes only the local test code');
  createdEmails.add(email);

  const verify = await client.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email, code: otp.json.devCode, name, ...(ref ? { ref } : {}), audience },
  });
  assert.equal(verify.status, 200, verify.text);
  assert.equal(verify.json.ok, true);

  return { client, code: otp.json.devCode, email, verify };
}

/**
 * A legacy phone-era account: the row still carries its sign-in phone and
 * phone-keyed history, but nobody can sign in with that number any more. The
 * session is minted the way the app mints one, because the suite is testing
 * what such an *account* can see — not the retired sign-in path.
 */
async function legacyPhoneAccount(name = 'Legacy Phone Owner') {
  const db = require('../src/db');
  const auth = require('../src/services/auth');
  const phones = require('../src/lib/phone');
  const phone = nextPhone();
  const normalised = phones.canonical(phone);
  const user = await db.users.upsertByPhone({ phone: normalised, name });
  createdPhones.add(normalised);
  const token = auth.newSessionToken();
  await db.users.createSession({
    userId: user.id,
    tokenHash: auth.hashToken(token),
    expiresAt: new Date(Date.now() + 86_400_000),
    mfaPending: false,
  });
  return { client: newClient({ sessionToken: token }), phone, normalised, user };
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
      for (const table of ['service_requests', 'bookings', 'leads', 'orders', 'subscriptions', 'financing_leads']) {
        const column = table === 'subscriptions' ? 'customer_phone' : 'phone';
        await db.query(`DELETE FROM ${table} WHERE ${column} IN (${marks})`, shapes);
      }
      await db.query(`DELETE FROM consent_records WHERE phone IN (${marks})`, shapes);
      await db.query(`DELETE FROM notifications WHERE recipient IN (${marks})`, shapes);
      if (createdRequests.size) {
        const requestMarks = [...createdRequests].map(() => '?').join(',');
        await db.query(`DELETE FROM service_requests WHERE tracking_id IN (${requestMarks})`, [...createdRequests]);
      }
      if (createdLeadIds.size) {
        const leadMarks = [...createdLeadIds].map(() => '?').join(',');
        await db.query(`DELETE FROM leads WHERE id IN (${leadMarks})`, [...createdLeadIds]);
      }
      await db.query(`DELETE FROM auth_codes WHERE phone IN (${marks})`, shapes);
      await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, shapes);
    }
    if (createdEmails.size) {
      const emails = [...createdEmails];
      const marks = emails.map(() => '?').join(',');
      await db.query(`DELETE FROM email_auth_codes WHERE email IN (${marks})`, emails);
      await db.query(`DELETE FROM \`users\` WHERE email IN (${marks})`, emails);
    }
    await db.pool.end();
  }
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

maybe('sign-in page offers customer email and Google sign-in, and no phone path', async () => {
  const response = await fetch(`${ctx.baseUrl}/login`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const html = await response.text();
  assert.match(html, /noindex, ?nofollow/i);
  assert.match(html, /name="email"/);
  assert.match(html, /Continue with email/);
  assert.match(html, /auth-option-divider/);
  assert.match(html, /Continue with Google/);
  assert.match(html, /You do not need a phone number to open an account/);
  assert.doesNotMatch(html, /name="phone"/, 'customer sign-in does not expose a phone-account path');
  assert.doesNotMatch(html, /staff|existing phone account/i, 'staff access is not advertised on the customer site');
  assert.doesNotMatch(html, /href="\/admin(?:\/|["?])/i, 'there is no public link into the staff console');
});

maybe('staff and dealer sign-in is closed to provisioned accounts and cannot create one', async () => {
  const db = require('../src/db');
  const unknown = nextEmail('unknown');
  createdEmails.add(unknown);

  for (const audience of ['staff', 'dealer']) {
    const client = newClient();
    const attempt = await client.request('/api/auth/email/otp', { method: 'POST', body: { email: unknown, audience } });
    assert.equal(attempt.status, 404, `${audience} surfaces do not hand out codes for unknown addresses`);
    assert.equal(attempt.json.code, 'SIGN_IN_UNAVAILABLE');
  }
  assert.equal(await db.users.findByVerifiedEmail(unknown), null, 'no account was created');

  // A customer account cannot use the closed surfaces either.
  const customer = await signIn();
  createdEmails.add(customer.email);
  for (const audience of ['staff', 'dealer']) {
    const client = newClient();
    const attempt = await client.request('/api/auth/email/otp', { method: 'POST', body: { email: customer.email, audience } });
    assert.equal(attempt.status, 404, `${audience} surfaces refuse customer addresses`);
  }

  // A provisioned account of the right role signs in and lands on its home.
  const ops = await makeAccount({ role: 'ops', name: 'Portal Staff' });
  createdEmails.add(ops.email);
  const staffClient = newClient();
  const staffOtp = await staffClient.request('/api/auth/email/otp', { method: 'POST', body: { email: ops.email, audience: 'staff' } });
  assert.equal(staffOtp.status, 200, staffOtp.text);
  const staffVerify = await staffClient.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email: ops.email, code: staffOtp.json.devCode, audience: 'staff' },
  });
  assert.equal(staffVerify.status, 200, staffVerify.text);
  assert.equal(staffVerify.json.redirect, '/admin');

  const dealer = await makeAccount({ role: 'dealer', name: 'Portal Dealer' });
  createdEmails.add(dealer.email);
  const dealerClient = newClient();
  const dealerOtp = await dealerClient.request('/api/auth/email/otp', { method: 'POST', body: { email: dealer.email, audience: 'dealer' } });
  assert.equal(dealerOtp.status, 200, dealerOtp.text);
  const dealerVerify = await dealerClient.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email: dealer.email, code: dealerOtp.json.devCode, audience: 'dealer' },
  });
  assert.equal(dealerVerify.status, 200, dealerVerify.text);
  assert.equal(dealerVerify.json.redirect, '/dealer/dashboard');
});

maybe('staff sign-in adds a password first factor, self-set on first login', async () => {
  const db = require('../src/db');
  const config = require('../src/config');
  // The general suite runs with the flag off (historical no-password fixtures);
  // this test turns it on, exercises the on path, then restores it.
  const flagBefore = config.auth.passwordForStaffDealers;
  config.auth.passwordForStaffDealers = true;
  try {
    // An ops account (no authenticator) sets its password on first sign-in.
    const ops = await makeAccount({ role: 'ops', name: 'Password Staff' });
    createdEmails.add(ops.email);
    const client = newClient();
    const otp = await client.request('/api/auth/email/otp', { method: 'POST', body: { email: ops.email, audience: 'staff' } });
    assert.equal(otp.status, 200, otp.text);
    const verify = await client.request('/api/auth/email/verify', { method: 'POST', body: { email: ops.email, code: otp.json.devCode, audience: 'staff' } });
    assert.equal(verify.status, 200, verify.text);
    assert.deepEqual(verify.json.password, { required: true }, 'first login stops at the set-password step');

    // The password-pending session has no authority: the console is off-limits.
    const protectedPage = await client.request('/admin', { headers: { Accept: 'text/html' } });
    assert.ok([302, 303, 401, 403].includes(protectedPage.status), 'a password-pending session cannot open the console');

    // Choose the password — the same session continues.
    const setPw = await client.request('/api/auth/password/set', { method: 'POST', body: { password: 'correct-horse-99', confirm: 'correct-horse-99' } });
    assert.equal(setPw.status, 200, setPw.text);
    assert.equal(setPw.json.redirect, '/admin', 'an ops account with no authenticator lands on the console');

    // The password is stored as an scrypt hash, never the plaintext.
    const stored = await db.users.passwordHashFor(ops.id);
    assert.ok(stored && stored.startsWith('scrypt$'), 'the password is stored as an scrypt hash');

    // Second sign-in: the password is now the first factor.
    const fresh = newClient();
    const noPw = await fresh.request('/api/auth/email/otp', { method: 'POST', body: { email: ops.email, audience: 'staff' } });
    assert.equal(noPw.status, 401, 'no code is sent without the password');
    assert.equal(noPw.json.code, 'PASSWORD_REQUIRED');
    const wrongPw = await fresh.request('/api/auth/email/otp', { method: 'POST', body: { email: ops.email, audience: 'staff', password: 'not-the-password' } });
    assert.equal(wrongPw.status, 401, 'a wrong password is refused');
    assert.equal(wrongPw.json.code, 'PASSWORD_WRONG');

    const otp2 = await fresh.request('/api/auth/email/otp', { method: 'POST', body: { email: ops.email, audience: 'staff', password: 'correct-horse-99' } });
    assert.equal(otp2.status, 200, otp2.text);
    const verify2 = await fresh.request('/api/auth/email/verify', { method: 'POST', body: { email: ops.email, code: otp2.json.devCode, audience: 'staff' } });
    assert.equal(verify2.status, 200, verify2.text);
    assert.equal(verify2.json.redirect, '/admin', 'a password-bearing staff account signs straight through');

    // The customer door cannot be used to skip the password first factor.
    const onCustomerDoor = await fresh.request('/api/auth/email/otp', { method: 'POST', body: { email: ops.email, audience: 'customer' } });
    assert.equal(onCustomerDoor.status, 403, 'a staff account cannot sign in through the customer door');
    assert.equal(onCustomerDoor.json.code, 'WRONG_SURFACE');
  } finally {
    config.auth.passwordForStaffDealers = flagBefore;
  }
});

maybe('production email sign-in fails closed without a configured mailer', async () => {
  const db = require('../src/db');
  const signin = require('../src/services/signin');
  const config = require('../src/config');
  const ops = await makeAccount({ role: 'ops', name: 'Delivery Test Staff' });
  createdEmails.add(ops.email);

  const [before] = await db.query(
    'SELECT COUNT(*) AS n FROM email_auth_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL',
    [ops.email, 'sign_in'],
  );
  const productionBefore = config.isProduction;
  const pepperBefore = config.auth.pepper;
  config.isProduction = true;
  config.auth.pepper = 'a-production-pepper-for-the-test-only-000000';
  let result;
  try {
    result = await signin.requestEmailCode({ rawEmail: ops.email, audience: 'staff' });
  } finally {
    config.isProduction = productionBefore;
    config.auth.pepper = pepperBefore;
  }

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'SMTP_NOT_CONFIGURED');
  assert.equal(result.devCode, undefined, 'production never reveals a console code');
  const [after] = await db.query(
    'SELECT COUNT(*) AS n FROM email_auth_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL',
    [ops.email, 'sign_in'],
  );
  assert.equal(Number(after.n), Number(before.n), 'an undelivered code is killed, not left stored for the taking');
});

maybe('an existing phone-era customer must verify an email from that signed-in account before it becomes a login', async () => {
  const db = require('../src/db');
  const { client, normalised, user: owner } = await legacyPhoneAccount();
  const email = nextEmail('legacy');
  createdEmails.add(email);
  await db.users.updateProfile(owner.id, { email });

  const visitor = newClient();
  const unverifiedOtp = await visitor.request('/api/auth/email/otp', { method: 'POST', body: { email } });
  assert.equal(unverifiedOtp.status, 200);
  const blocked = await visitor.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email, code: unverifiedOtp.json.devCode, name: 'Duplicate Account' },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.code, 'LEGACY_EMAIL_REQUIRES_PHONE_LINK');
  assert.equal(await db.users.findByVerifiedEmail(email), null, 'a profile email alone is not an identity');

  const linkOtp = await client.request('/api/account/email/otp', { method: 'POST', body: { email } });
  assert.equal(linkOtp.status, 200, linkOtp.text);
  assert.ok(linkOtp.json.devCode);
  const linked = await client.request('/api/account/email/verify', {
    method: 'POST',
    body: { email, code: linkOtp.json.devCode },
  });
  assert.equal(linked.status, 200, linked.text);
  assert.equal(linked.json.ok, true);
  const sameOwner = await db.users.findByVerifiedEmail(email);
  assert.equal(Number(sameOwner.id), Number(owner.id), 'email links to the existing phone-era account, not a duplicate');
  assert.equal(sameOwner.phone, normalised);

  const emailClient = newClient();
  const signInOtp = await emailClient.request('/api/auth/email/otp', { method: 'POST', body: { email } });
  const emailSignIn = await emailClient.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email, code: signInOtp.json.devCode, name: 'Ignored Existing Name' },
  });
  assert.equal(emailSignIn.status, 200, emailSignIn.text);
  assert.equal(emailSignIn.json.ok, true);
  assert.equal(Number((await db.users.findByVerifiedEmail(email)).id), Number(owner.id));
});

maybe('a code arrives, is single-use, and buys a session cookie', async () => {
  const { client, code, email } = await signIn();

  const cookie = client.rawCookies.join('\n');
  assert.match(cookie, /hc_session=[^;]+/);
  assert.match(cookie, /HttpOnly/i, 'the session cookie is not readable from JavaScript');
  assert.match(cookie, /SameSite=Lax/i, '§12.2: Lax keeps the cookie off cross-site form posts');
  assert.doesNotMatch(cookie, /Secure/i, 'dev runs over http');

  const dashboard = await client.request('/account');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /cars and requests/);
  assert.match(dashboard.headers.get('cache-control'), /no-store/, 'a signed-in page is never publicly cached');

  const reuse = await client.request('/api/auth/email/verify', { method: 'POST', body: { email, code } });
  assert.equal(reuse.json.ok, false);
  assert.equal(reuse.status, 410, 'a used code is gone, not merely wrong');
  assert.match(reuse.json.error, /expired/i);
});

maybe('a wrong code is refused without burning the real one', async () => {
  const email = nextEmail('auth');
  createdEmails.add(email);
  const client = newClient();
  const otp = await client.request('/api/auth/email/otp', { method: 'POST', body: { email } });
  const wrong = await client.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email, code: otp.json.devCode === '000000' ? '111111' : '000000', name: 'Test Buyer' },
  });
  assert.equal(wrong.json.ok, false);

  const right = await client.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email, code: otp.json.devCode, name: 'Test Buyer' },
  });
  assert.equal(right.json.ok, true, 'the correct code still works after a wrong guess');
});

maybe('legacy phone-era accounts are keyed on the number, whatever shape it was typed in', async () => {
  const db = require('../src/db');
  const phones = require('../src/lib/phone');
  const phone = nextPhone();
  createdPhones.add(phones.canonical(phone));
  const first = await db.users.upsertByPhone({ phone: phones.canonical(phone), name: 'Shape Test' });
  const local = `0${first.phone.slice(4)}`;

  for (const shape of [local, first.phone.slice(1), first.phone, `${first.phone.slice(1, 4)} ${first.phone.slice(4)}`]) {
    assert.equal(phones.normalise(shape), first.phone, `normalises ${shape}`);
  }
  const again = await db.users.upsertByPhone({ phone: first.phone });
  assert.equal(again.id, first.id, 'no duplicate account for the same number');
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
  const { client, email } = await signIn();
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
  const user = await db.users.findByVerifiedEmail(email);
  assert.equal((await db.users.savedSearches(user.id)).filter((row) => row.id === id).length, 0, 'the row is gone');
});

maybe('profile details keep contact phone separate from sign-in and require email verification', async () => {
  const { client, email } = await signIn();
  const rejectedEmail = await client.request('/api/account/profile', {
    method: 'POST',
    body: { email: 'buyer@example.com' },
  });
  assert.equal(rejectedEmail.status, 422);
  assert.match(rejectedEmail.json.error, /verification/i);

  const saved = await client.request('/api/account/profile', {
    method: 'POST',
    body: { name: 'Test Buyer', contactPhone: '08031231234', marketingOptIn: true },
  });
  assert.equal(saved.json.ok, true);

  const db = require('../src/db');
  const user = await db.users.findByVerifiedEmail(email);
  assert.equal(user.name, 'Test Buyer');
  assert.equal(user.phone, null, 'the sign-in identity is the verified email, never a phone');
  assert.equal(user.contactPhone, '+2348031231234', 'contact information is stored separately');
  assert.equal(user.email, email, 'email cannot be changed without verification — the verified address stands');
  assert.equal(user.marketingOptIn, true);

  const html = await client.request('/account');
  assert.match(html.text, /Test Buyer/);
});

maybe('data export returns everything keyed to the account and no analytics', async () => {
  const { client, email } = await signIn();
  const response = await client.request('/account/export');
  assert.equal(response.status, 200);
  assert.equal(response.json.account.email, email);
  for (const key of ['requests', 'bookings', 'orders', 'subscriptions', 'savedCars', 'savedSearches']) {
    assert.ok(key in response.json, `export includes ${key}`);
  }
  assert.doesNotMatch(response.text, /analytics_events|listing_view/);
});

maybe('records written by the public forms surface in the dashboard (§7.1)', async () => {
  const { client } = await signIn();
  const contactPhone = nextPhone();
  const created = await client.request('/api/service-requests', {
    method: 'POST',
    body: { type: 'concierge', name: 'Test Buyer', phone: contactPhone, brief: { budget: '8-12m', must_haves: 'SUV, low mileage' } },
  });
  assert.equal(created.json.ok, true);
  const dashboard = await client.request('/account');
  assert.match(dashboard.text, new RegExp(created.json.trackingId), 'the request is on the dashboard');
});

// ---------------------------------------------------------------------------
// §7.1 cards: referrals, hire, documents, alert switches
// ---------------------------------------------------------------------------

maybe('every account gets a referral code and a shareable link', async () => {
  const { client, email } = await signIn();
  const db = require('../src/db');
  const user = await db.users.findByVerifiedEmail(email);
  assert.match(user.referralCode, /^[2-9A-HJ-NP-Z]{6}$/, 'a readable, unambiguous code');

  const page = await client.request('/account');
  assert.match(page.text, /id="referrals"/);
  assert.match(page.text, new RegExp(`ref=${user.referralCode}`), 'the link carries the code');
});

maybe('an invitation code is recorded once, on the new account, and never on itself', async () => {
  const inviter = await signIn();
  const db = require('../src/db');
  const inviterUser = await db.users.findByVerifiedEmail(inviter.email);

  // A new person arrives through the link.
  const guest = await signIn();
  const guestUser = await db.users.findByVerifiedEmail(guest.email);
  assert.equal(guestUser.referredBy, null, 'no code sent yet → no referrer');

  const invitedEmail = nextEmail('invited');
  createdEmails.add(invitedEmail);
  const invited = newClient();
  const otp = await invited.request('/api/auth/email/otp', { method: 'POST', body: { email: invitedEmail } });
  const verify = await invited.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email: invitedEmail, code: otp.json.devCode, name: 'Invited Guest', ref: inviterUser.referralCode },
  });
  assert.equal(verify.json.ok, true);

  const invitedUser = await db.users.findByVerifiedEmail(invitedEmail);
  assert.equal(invitedUser.referredBy, inviterUser.id, 'the inviter is recorded');

  // The inviter's own dashboard counts them, and cannot refer themselves.
  const stats = await db.users.referralStats(inviterUser);
  assert.equal(stats.joined, 1);
  assert.equal(await db.users.findReferrer(inviterUser.referralCode, inviterUser.id), null, 'never self-referral');

  const { client: fresh } = await signIn({ email: inviter.email });
  const page = await fresh.request('/account');
  assert.match(page.text, /1<\/strong> signed up/);
});

maybe('hire gets its own card and is not double-counted in requests', async () => {
  const { client } = await signIn();
  const contactPhone = nextPhone();
  const created = await client.request('/api/service-requests', {
    method: 'POST',
    body: {
      kind: 'hire',
      name: 'Hire Tester',
      phone: contactPhone,
      brief: { vehicle_class: 'SUV (Prado / Highlander)', date_from: '2026-11-01', date_to: '2026-11-04', with_driver: 'yes', location: 'GRA' },
    },
  });
  assert.equal(created.json.ok, true);

  const page = await client.request('/account');
  const hireCard = page.text.slice(page.text.indexOf('id="hire"'), page.text.indexOf('id="bookings"'));
  assert.match(hireCard, /SUV \(Prado \/ Highlander\)/, 'the brief is on the hire card');
  // 1 → 4 November is four hire days: the pick-up day counts, exactly as the
  // quote bills it (services/hire.js counts both ends). The number on this card
  // and the number on the invoice have to be the same number.
  assert.match(hireCard, /4 days/, 'the dates are turned into a duration');
  assert.match(hireCard, new RegExp(created.json.trackingId));

  const requestsCard = page.text.slice(page.text.indexOf('id="requests"'), page.text.indexOf('id="hire"'));
  assert.doesNotMatch(requestsCard, new RegExp(created.json.trackingId), 'not listed twice');
});

maybe('shop receipts land in Documents', async () => {
  const { client } = await signIn();
  const contactPhone = nextPhone();
  const order = await client.request('/api/orders', {
    method: 'POST',
    body: {
      name: 'Receipt Tester',
      phone: contactPhone,
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
  const { client, email } = await signIn();
  const db = require('../src/db');
  const user = await db.users.findByVerifiedEmail(email);

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

maybe('a blocked account can prove its email but still cannot sign in', async () => {
  const { client, email } = await signIn();
  const db = require('../src/db');
  const user = await db.users.findByVerifiedEmail(email);
  await db.query('UPDATE `users` SET status = ? WHERE id = ?', ['blocked', user.id]);

  const otp = await client.request('/api/auth/email/otp', { method: 'POST', body: { email } });
  assert.equal(otp.status, 200, otp.text);
  const verify = await client.request('/api/auth/email/verify', { method: 'POST', body: { email, code: otp.json.devCode, name: 'Test Buyer' } });
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
  const { client, email } = await signIn();
  const db = require('../src/db');
  const contactPhone = nextPhone();
  const contactShapes = require('../src/lib/phone').variants(contactPhone);
  const request = await client.request('/api/service-requests', {
    method: 'POST',
    body: { type: 'concierge', name: 'Delete Me', phone: contactPhone, brief: { budget: '5-8m' } },
  });
  // Closing the account rewrites these rows' phones to DELETED-…, so the
  // phone-keyed sweep in test.after can no longer match them. Remember both by
  // identity — the request by tracking id, the lead it opened by id.
  createdRequests.add(request.json.trackingId);
  const lead = await db.queryOne(`SELECT id FROM leads WHERE phone IN (${contactShapes.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, contactShapes);
  if (lead) createdLeadIds.add(lead.id);

  const withoutConfirm = await client.request('/api/account/delete', { method: 'POST', body: { confirm: 'yes' } });
  assert.equal(withoutConfirm.json.ok, false, 'deletion needs the typed confirmation');

  const gone = await client.request('/api/account/delete', { method: 'POST', body: { confirm: 'delete' } });
  assert.equal(gone.json.ok, true);

  assert.equal(await db.users.findByVerifiedEmail(email), null, 'the user row is gone');

  const [row] = await db.query('SELECT name, phone FROM service_requests WHERE tracking_id = ?', [request.json.trackingId]);
  assert.ok(row, 'the ops record survives for finance and warranty');
  assert.equal(row.name, 'Deleted account');
  assert.match(row.phone, /^DELETED-\d+$/);
  assert.notEqual(row.phone, contactPhone, 'the stored phone is an anonymised reference, not the original contact number');
});
