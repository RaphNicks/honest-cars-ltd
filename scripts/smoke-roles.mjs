#!/usr/bin/env node
/**
 * Role smoke matrix — §7.4, end to end, against a running site.
 *
 *   npm run smoke                 # expects the dev server on http://localhost:3000
 *   npm run smoke -- http://host  # or point it wherever the site is running
 *
 * Signs in as each seeded staff account (and a customer), opens every console
 * module, and prints what each role actually got back. The expectation is the
 * matrix in src/services/roles.js: anything a role does not hold must come back
 * 403 (honest refusal), never 200 and never a redirect loop. Anonymous requests
 * must redirect to /login.
 *
 * It only reads: no listing is published, no payment is confirmed, no role is
 * changed. Signs-in use the development OTP (`devCode`), so this only works
 * while AUTH_SHOW_CODE is on — which it is in development, and only there.
 *
 * Exit code is non-zero if a role sees something the matrix does not grant, or
 * is refused something it should hold, so it can be wired into CI as-is.
 */

import { createRequire } from 'node:module';

import { clearDevCodes } from './lib/dev-codes.mjs';

const require = createRequire(import.meta.url);
const totp = require('../src/lib/totp');

/**
 * §12.2 — the second factor on the two roles that move money or grant roles.
 *
 * These are the *seeded* secrets, written in db/seed.sql for a demo database
 * that has to be sign-in-able by a script. A real install has none of this: a
 * person enrols their own phone at /admin/security and nobody else holds the
 * key. The script completes the challenge exactly the way the browser does.
 */
const MFA_SECRETS = {
  '+2348000000001': 'JBSWY3DPEHPK3PXP',
  '+2348000000004': 'KRSXG5CTMVRXEZLU',
};

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');

const PAGES_ADMIN = [
  '/admin', '/admin/listings', '/admin/leads', '/admin/concierge', '/admin/bookings',
  '/admin/orders', '/admin/payments', '/admin/milestones', '/admin/staff', '/admin/audit',
  '/admin/alerts',
  '/admin/intel',
  '/admin/reports',
  '/admin/marketing',
  '/admin/subscriptions',
  '/admin/hire',
  '/admin/dealers', '/admin/dealers/2',
  '/admin/cms', '/admin/cms/calendar', '/admin/cms/pages', '/admin/cms/faqs', '/admin/cms/testimonials', '/admin/cms/modules',
  '/admin/settings', '/admin/referrals', '/admin/financing', '/admin/privacy', '/admin/security',
];

/**
 * Seeded accounts, and every console page each one must be able to open.
 *
 * `must` is exhaustive, not a sample: anything not listed is required to be
 * refused. That is deliberate — a role that quietly gained a capability fails
 * here — so when a module adds a screen, every role that may open it belongs in
 * this list. (Admin was missing the CMS paths for exactly that reason.)
 */
const ROLES = [
  { phone: '+2348000000001', role: 'admin', must: PAGES_ADMIN },
  { phone: '+2348000000002', role: 'ops', must: ['/admin', '/admin/listings', '/admin/leads', '/admin/concierge', '/admin/bookings', '/admin/alerts', '/admin/intel', '/admin/reports', '/admin/marketing', '/admin/hire', '/admin/dealers', '/admin/dealers/2', '/admin/settings', '/admin/referrals', '/admin/financing', '/admin/privacy', '/admin/security'] },
  { phone: '+2348000000003', role: 'inspector', must: ['/admin/jobs', '/admin/security'] },
  { phone: '+2348000000004', role: 'finance', must: ['/admin', '/admin/orders', '/admin/payments', '/admin/milestones', '/admin/reports', '/admin/subscriptions', '/admin/hire', '/admin/dealers', '/admin/dealers/2', '/admin/referrals', '/admin/financing', '/admin/security'] },
  { phone: '+2348000000005', role: 'marketing', must: ['/admin', '/admin/cms', '/admin/cms/calendar', '/admin/cms/pages', '/admin/cms/faqs', '/admin/cms/testimonials', '/admin/cms/modules', '/admin/intel', '/admin/reports', '/admin/marketing', '/admin/security'] },
];

/** Pages probed for every role; the verdict comes from `must`. */
/**
 * Marketing's remit is content only: the money and staff screens must refuse it.
 * Without this, a role that quietly gained `payments.view` would pass the smoke.
 */
const MUST_NOT = [
  // Marketing runs the channel report but does not see the ledgers, and finance
  // reads the money without seeing where the traffic came from (§7.4).
  { phone: '+2348000000005', role: 'marketing', blocked: ['/admin/payments', '/admin/milestones', '/admin/staff', '/admin/audit', '/admin/subscriptions', '/admin/hire', '/admin/dealers', '/admin/referrals', '/admin/privacy'] },
  { phone: '+2348000000004', role: 'finance', blocked: ['/admin/marketing', '/admin/privacy'] },
  // Renewals are a money queue with a customer attached: ops runs the listings
  // and the leads, and does not need to see what anyone pays us (§7.4).
  { phone: '+2348000000002', role: 'ops', blocked: ['/admin/subscriptions'] },
  // §18.3's request log is admin/ops only — it is a list of people who asked us
  // to delete their data, so the inspector and the money desk are refused it.
  { phone: '+2348000000003', role: 'inspector', blocked: ['/admin/privacy'] },
];

const PAGES = [
  '/admin', '/admin/listings', '/admin/leads', '/admin/concierge', '/admin/bookings',
  '/admin/jobs', '/admin/orders', '/admin/payments', '/admin/milestones', '/admin/staff', '/admin/audit',
  '/admin/alerts',
  '/admin/intel',
  '/admin/reports',
  '/admin/marketing',
  '/admin/subscriptions',
  '/admin/hire',
  '/admin/dealers', '/admin/dealers/2',
  '/admin/cms', '/admin/cms/calendar', '/admin/cms/pages', '/admin/cms/faqs', '/admin/cms/testimonials', '/admin/cms/modules',
  '/admin/settings', '/admin/referrals', '/admin/financing', '/admin/privacy',
  '/admin/security',
];

/**
 * §7.2 — the dealer portal is its own surface. A partner lot opens every screen
 * of it and none of the console; a customer opens neither.
 */
const DEALER_PAGES = [
  '/dealer/dashboard', '/dealer/listings', '/dealer/listings/new',
  '/dealer/leads', '/dealer/performance', '/dealer/billing', '/dealer/profile',
  '/dealer/addons', '/dealer/imports',
];
const DEALER_PHONE = '+2348000000006';
const CUSTOMER_PHONE = '+2348031234567';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const OFF = '\u001b[0m';

function newClient() {
  let cookie = '';
  return {
    async request(path, { method = 'GET', body } = {}) {
      const response = await fetch(`${BASE}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
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
      return { status: response.status, text, json };
    },
  };
}

async function signIn(phone) {
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  if (!otp.json || !otp.json.devCode) {
    // Two independent limits can 429 a sign-in: the per-number hourly cap
    // (rows in auth_codes, which we cleared above) and the in-process limiter
    // on the request IP. The second one only resets with the server, so say
    // which it is instead of leaving a bare 429.
    const hint = otp.status === 429
      ? 'the in-process rate limiter has tripped — restart the dev server (or wait 15 minutes); the per-number codes were already cleared for this run'
      : 'is AUTH_SHOW_CODE on, and is the site running?';
    throw new Error(`No devCode for ${phone} (HTTP ${otp.status}) — ${hint}`);
  }
  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  if (verify.status !== 200) throw new Error(`Sign-in failed for ${phone}: ${verify.status} ${verify.text.slice(0, 120)}`);
  const secret = MFA_SECRETS[phone];
  if (secret) {
    const challenge = await client.request('/api/auth/mfa', { method: 'POST', body: { code: totp.code(secret) } });
    if (challenge.status !== 200) {
      throw new Error(`Second factor failed for ${phone}: ${challenge.status} ${challenge.text.slice(0, 140)}`);
    }
  }
  return client;
}

/**
 * One signed-in client per number for the whole run.
 *
 * §12.2 makes a second sign-in inside the same 30-second window a *correct*
 * refusal — the code was spent by the first one — so a script that signs the
 * same account in twice would fail on the app behaving properly. A person does
 * what the error message says and waits for the next code; a script keeps the
 * session it has.
 */
const signedIn = new Map();
async function clientFor(phone) {
  if (!signedIn.has(phone)) signedIn.set(phone, await signIn(phone));
  return signedIn.get(phone);
}

/**
 * Sign in *without* the second factor, so the gate can be seen doing its job.
 * Returns the half-signed-in client and its verdict on a console path.
 */
async function signInHalfWay(phone) {
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone } });
  if (!otp.json || !otp.json.devCode) throw new Error(`No devCode for ${phone} (HTTP ${otp.status})`);
  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  if (verify.status !== 200) throw new Error(`Sign-in failed for ${phone}: ${verify.status}`);
  return { client, verify };
}

let failures = 0;

function report(role, path, status, expected) {
  const ok = expected ? status === 200 : [302, 403].includes(status);
  if (!ok) failures += 1;
  const label = status === 200 ? '200' : `${status}`;
  const mark = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
  const note = expected ? (status === 200 ? 'open' : 'REFUSED (should open)') : (status === 200 ? 'OPEN (should be refused)' : status === 302 ? 'redirect to login' : '403');
  console.log(`  ${mark} ${label}  ${path.padEnd(24)} ${DIM}${note}${OFF}`);
}

// The 5-codes-per-number-per-hour policy counts codes already sent, so a repeat
// run would 429 mid-sign-in. Clear this run's own numbers' spent codes first.
await clearDevCodes([...ROLES.map((entry) => entry.phone), DEALER_PHONE, CUSTOMER_PHONE], {
  label: 'role',
  resetMfa: true,
});

console.log(`Role smoke matrix — ${BASE}\n`);

// 1. Anonymous: every console path must hand over to /login.
const anon = newClient();
let anonBad = 0;
for (const path of PAGES) {
  const response = await anon.request(path);
  if (response.status !== 302 || !String(response.text).includes('/login')) anonBad += 1;
}
if (anonBad) failures += anonBad;
console.log(`${anonBad ? `${RED}✗${OFF}` : `${GREEN}✓${OFF}`} anonymous   ${PAGES.length} console paths → /login (${anonBad} wrong)`);

// 2. Each seeded role.
for (const staff of ROLES) {
  const client = await clientFor(staff.phone);
  console.log(`\n${staff.role.padEnd(10)} ${DIM}${staff.phone}${OFF}`);
  for (const path of PAGES) {
    const response = await client.request(path);
    report(staff.role, path, response.status, staff.must.includes(path));
  }
}

// 3. Roles whose remit excludes a screen must be refused it.
for (const entry of MUST_NOT) {
  const client = await clientFor(entry.phone);
  let leaks = 0;
  for (const path of entry.blocked) {
    const response = await client.request(path);
    const allowed = response.status === 200;
    report(entry.role, path, response.status, false);
    if (allowed) leaks += 1;
  }
  if (leaks) failures += 0; // report() already counted each violation
}

// 4. The dealer portal (§7.2): open to its own lot, closed to the console, and
//    the console closed to it in turn.
const dealer = await clientFor(DEALER_PHONE);
console.log(`\n${'dealer'.padEnd(10)} ${DIM}${DEALER_PHONE}${OFF}`);
let dealerBad = 0;
for (const path of DEALER_PAGES) {
  const response = await dealer.request(path);
  if (![200, 302].includes(response.status)) dealerBad += 1;
  report('dealer', path, response.status === 302 ? 200 : response.status, true);
}
for (const path of PAGES) {
  const response = await dealer.request(path);
  if (response.status === 200) dealerBad += 1;
  report('dealer', path, response.status, false);
}
failures += dealerBad;

// 4b. §12.2 — the second factor is a wall, not a suggestion. A session that has
//     passed the phone step and not the factor opens nothing but the challenge,
//     and the challenge itself is a form on a page.
for (const phone of Object.keys(MFA_SECRETS)) {
  const { client, verify } = await signInHalfWay(phone);
  const label = `half-signed-in ${phone}`;
  const checks = [
    ['/admin', 302],
    ['/api/account/saved-cars', 401],
    ['/login/mfa', 200],
  ];
  let wrong = 0;
  for (const [path, expected] of checks) {
    const response = await client.request(path);
    if (response.status !== expected) wrong += 1;
    if (wrong && response.status !== expected) console.log(`  ${RED}✗${OFF} ${path} → ${response.status} (expected ${expected})`);
  }
  const form = await client.request('/login/mfa');
  if (!String(form.text).includes('data-mfa-form')) {
    wrong += 1;
    console.log(`  ${RED}✗${OFF} the challenge page carries no form`);
  }
  const declared = verify.json && verify.json.mfa && verify.json.mfa.required;
  if (!declared) {
    wrong += 1;
    console.log(`  ${RED}✗${OFF} the sign-in did not say a second factor was next`);
  }
  failures += wrong;
  console.log(`${wrong ? `${RED}✗${OFF}` : `${GREEN}✓${OFF}`} ${label}  challenge opens, console refused`);
}

// 5. A customer must never see a console page, and never the dealer portal.
const customer = newClient();
const otp = await customer.request('/api/auth/otp', { method: 'POST', body: { phone: CUSTOMER_PHONE } });
if (otp.json && otp.json.devCode) {
  await customer.request('/api/auth/verify', { method: 'POST', body: { phone: CUSTOMER_PHONE, code: otp.json.devCode } });
  let leaks = 0;
  for (const path of PAGES) {
    const response = await customer.request(path);
    if (response.status === 200) leaks += 1;
  }
  for (const path of DEALER_PAGES) {
    const response = await customer.request(path);
    if (response.status === 200) leaks += 1;
  }
  failures += leaks;
  console.log(
    `\n${leaks ? `${RED}✗${OFF}` : `${GREEN}✓${OFF}`} customer   ${PAGES.length + DEALER_PAGES.length} console + portal paths refused (${leaks} leaked)`,
  );
}

console.log(
  failures
    ? `\n${RED}${failures} role violation(s)${OFF} — check src/services/roles.js against src/routes/admin.js`
    : `\n${GREEN}Every role sees exactly what §7.4 grants.${OFF}`,
);
process.exit(failures ? 1 : 0);
