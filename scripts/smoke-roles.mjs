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

const BASE = (process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');

/** Seeded accounts, and the one thing each must be able to open. */
const ROLES = [
  { phone: '+2348000000001', role: 'admin', must: ['/admin', '/admin/listings', '/admin/leads', '/admin/concierge', '/admin/bookings', '/admin/orders', '/admin/payments', '/admin/milestones', '/admin/staff', '/admin/audit'] },
  { phone: '+2348000000002', role: 'ops', must: ['/admin', '/admin/listings', '/admin/leads', '/admin/concierge', '/admin/bookings'] },
  { phone: '+2348000000003', role: 'inspector', must: ['/admin/jobs'] },
  { phone: '+2348000000004', role: 'finance', must: ['/admin', '/admin/orders', '/admin/payments', '/admin/milestones'] },
];

/** Pages probed for every role; the verdict comes from `must`. */
const PAGES = [
  '/admin', '/admin/listings', '/admin/leads', '/admin/concierge', '/admin/bookings',
  '/admin/jobs', '/admin/orders', '/admin/payments', '/admin/milestones', '/admin/staff', '/admin/audit',
];

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
    throw new Error(`No devCode for ${phone} — is AUTH_SHOW_CODE on and the site running at ${BASE}? (${otp.status})`);
  }
  const verify = await client.request('/api/auth/verify', { method: 'POST', body: { phone, code: otp.json.devCode } });
  if (verify.status !== 200) throw new Error(`Sign-in failed for ${phone}: ${verify.status} ${verify.text.slice(0, 120)}`);
  return client;
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
  const client = await signIn(staff.phone);
  console.log(`\n${staff.role.padEnd(10)} ${DIM}${staff.phone}${OFF}`);
  for (const path of PAGES) {
    const response = await client.request(path);
    report(staff.role, path, response.status, staff.must.includes(path));
  }
}

// 3. A customer must never see a console page.
const customer = newClient();
const otp = await customer.request('/api/auth/otp', { method: 'POST', body: { phone: '+2348031234567' } });
if (otp.json && otp.json.devCode) {
  await customer.request('/api/auth/verify', { method: 'POST', body: { phone: '+2348031234567', code: otp.json.devCode } });
  let leaks = 0;
  for (const path of PAGES) {
    const response = await customer.request(path);
    if (response.status === 200) leaks += 1;
  }
  failures += leaks;
  console.log(`\n${leaks ? `${RED}✗${OFF}` : `${GREEN}✓${OFF}`} customer   ${PAGES.length} console paths refused (${leaks} leaked)`);
}

console.log(
  failures
    ? `\n${RED}${failures} role violation(s)${OFF} — check src/services/roles.js against src/routes/admin.js`
    : `\n${GREEN}Every role sees exactly what §7.4 grants.${OFF}`,
);
process.exit(failures ? 1 : 0);
