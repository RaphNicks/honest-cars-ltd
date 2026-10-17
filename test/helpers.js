'use strict';

/**
 * Test helpers. Database-backed suites skip themselves (rather than fail) when
 * MySQL is not reachable, so `npm test` is useful on a laptop with no DB up.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Tests must be deterministic, and a build on disk is not part of the source:
// point the renderer at a directory with no manifest so every page is rendered
// per request, exactly as it is on a fresh checkout. Set before anything
// requires src/config.
process.env.STATIC_DIR = process.env.TEST_STATIC_DIR || '.test-static';
// A suite signs in many times from one address (the test runner's loopback
// IP). The per-IP ceiling is a production anti-enumeration guard, not the
// per-email cap that actually governs codes — lift it for test runs only.
process.env.AUTH_EMAIL_OTP_IP_MAX = process.env.AUTH_EMAIL_OTP_IP_MAX || '500';
process.env.AUTH_EMAIL_VERIFY_IP_MAX = process.env.AUTH_EMAIL_VERIFY_IP_MAX || '500';

const ROOT = path.join(__dirname, '..');

async function dbAvailable() {
  try {
    const db = require('../src/db');
    await db.healthcheck();
    return true;
  } catch {
    return false;
  }
}

/** Boot the app on an ephemeral port and return { server, baseUrl, close }. */
async function startTestServer() {
  const { createApp } = require('../src/app');
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function runScript(script, args = []) {
  return execFileSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/** Fetch HTML from the test server. */
async function getHtml(baseUrl, routePath) {
  const response = await fetch(`${baseUrl}${routePath}`, { redirect: 'manual' });
  return { response, html: await response.text() };
}

// ---------------------------------------------------------------------------
// Test-only housekeeping
// ---------------------------------------------------------------------------

/**
 * Which table each audited entity names. Every entry here is a row this
 * project's tests create and then hard-delete.
 */
const AUDIT_SUBJECTS = {
  booking: 'bookings',
  faq: 'faqs',
  homepage: 'homepage_modules',
  lead: 'leads',
  listing: 'vehicle_listings',
  milestone: 'payment_milestones',
  order: 'orders',
  payment: 'payments',
  post: 'blog_posts',
  referral_reward: 'referral_rewards',
  request: 'service_requests',
  testimonial: 'testimonials',
  user: 'users',
};

/**
 * Drop audit rows whose subject no longer exists.
 *
 * `admin_audit` is append-only on purpose: production history must outlive the
 * row it describes, so the application never prunes it. A test suite is the one
 * caller that should — it creates a fixture, exercises it, deletes it again, and
 * otherwise leaves records in /admin/audit naming rows that are gone, which reads
 * as real (and confusing) history in the console. Call it from a suite's
 * teardown, never from application code.
 */
async function sweepOrphanAudit(query) {
  let removed = 0;
  for (const [entity, table] of Object.entries(AUDIT_SUBJECTS)) {
    const marked = (await query(
      `SELECT id FROM admin_audit WHERE entity = ? AND entity_id NOT IN (SELECT id FROM \`${table}\`)`,
      [entity],
    )).map((row) => row.id);
    if (!marked.length) continue;
    const marks = marked.map(() => '?').join(',');
    const result = await query(`DELETE FROM admin_audit WHERE id IN (${marks})`, marked);
    removed += result.affectedRows || 0;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// §12.2 — the second factor, for suites that sign in as staff
// ---------------------------------------------------------------------------

/**
 * Enrol a fixture account directly, the way a person would have done at
 * /admin/security before the test started. Fixture accounts created with a
 * required role (`admin`, `finance`) are otherwise sent to the enrolment screen
 * by the gate — which is correct behaviour and useless to a suite that wants to
 * test something else.
 *
 * Returns the secret, so a caller can generate codes for that account.
 */
async function enrolMfa(userId, { confirm = true } = {}) {
  const db = require('../src/db');
  const totp = require('../src/lib/totp');
  const secret = totp.generateSecret();
  await db.mfa.beginEnrolment(userId, secret);
  // Confirmed against a step five minutes *ago*, which is what enrolment really
  // looks like from the sign-in path's point of view: the code that proved the
  // secret was spent at setup time, and the current step is still fresh for the
  // sign-in that follows. (Consuming "now" here would make the fixture's first
  // sign-in a replay, correctly and unhelpfully.)
  if (confirm) await db.mfa.confirmEnrolment(userId, totp.stepAt(Date.now()) - 10);
  return secret;
}

/**
 * Finish a sign-in that stopped at the second factor.
 *
 * Call it right after the first factor: it reads the account's secret from the
 * database (a test harness has the database; a person has their phone) and
 * posts the code the way the challenge page does. Returns the fetch response,
 * so a caller can assert on it. The account is found by `userId`, `email` or a
 * legacy `phone` — whichever the fixture holds.
 *
 * Codes are single-use — `mfa_last_step` refuses a replay — so two sign-ins in
 * the same 30-second window need different steps. `offset` picks which one.
 */
async function completeMfa(client, { request, userId = null, email = null, phone = null, next = '', offset = 0, code = null } = {}) {
  const db = require('../src/db');
  const totp = require('../src/lib/totp');
  const phones = require('../src/lib/phone');
  let user = null;
  if (userId) user = await db.users.findById(userId);
  if (!user && email) user = await db.users.findByVerifiedEmail(email);
  if (!user && phone) {
    // The caller may hold the number in whatever form the fixture used; accounts
    // are stored canonical, so look it up the way the app does.
    const canonical = phones.canonical(phone, { fallback: phone });
    user = await db.users.findByPhone(canonical);
  }
  if (!user) throw new Error(`completeMfa could not find ${email || phone || userId}`);
  const row = await db.mfa.secretFor(user.id);
  if (!row) throw new Error(`no second factor for ${email || phone || userId} — call enrolMfa first`);
  const value = code || totp.code(row.secret, { time: Date.now() + offset * totp.STEP_SECONDS * 1000 });
  const post = request || ((path, options) => client.request(path, options));
  return post('/api/auth/mfa', { method: 'POST', body: { code: value, next } });
}

// ---------------------------------------------------------------------------
// Accounts and sign-in fixtures — every account signs in with a verified email
// (one-time code) or Google. There is no phone sign-in to fall back on, so a
// suite that needs an account gives it an email identity up front.
// ---------------------------------------------------------------------------

let emailSeq = 0;

/** A throwaway address, unique per call, for fixtures and sign-ins. */
function nextEmail(tag = 'test') {
  emailSeq += 1;
  return `${tag}-${process.pid}-${Date.now() % 100000}-${emailSeq}@example.net`;
}

/**
 * A ready-made account of any role, with a verified sign-in email already on
 * it. Staff and dealer fixtures use this because those surfaces only sign in
 * accounts that already hold an identity — exactly like production.
 */
async function makeAccount({ role = 'customer', name = 'Test Fixture', email = null, phone = null } = {}) {
  const db = require('../src/db');
  const address = email || nextEmail(role);
  const result = await db.query(
    'INSERT INTO `users` (phone, name, email, role, status) VALUES (?, ?, ?, ?, ?)',
    [phone || null, name, address, role, 'active'],
  );
  const userId = Number(result.insertId);
  await db.query(
    'INSERT INTO user_email_identities (user_id, email, google_subject, verified_at) VALUES (?, ?, NULL, UTC_TIMESTAMP())',
    [userId, address],
  );
  return { id: userId, email: address, role, name, phone: phone || null };
}

/**
 * §12.2 / 038 — finish the self-set password step if a staff or dealer sign-in
 * stopped there (a fixture account has no password, so its first email sign-in
 * is always password-pending). A customer sign-in never stops here, so the call
 * is a no-op for the customer door. Returns the /password/set body (or the
 * verify body when there was nothing to set).
 */
async function completePassword(client, verifyResponse, { baseUrl = null, password = 'Test-Pass-1234' } = {}) {
  const body = verifyResponse.json || {};
  if (!body.password || !body.password.required) return body;
  const headers = baseUrl ? { Origin: baseUrl } : {};
  const set = await client.request('/api/auth/password/set', {
    method: 'POST',
    body: { password, confirm: password },
    headers,
  });
  if (set.status !== 200) throw new Error(`set-password step failed (${set.status}): ${set.text}`);
  return set.json;
}

module.exports = {
  ROOT,
  dbAvailable,
  startTestServer,
  runScript,
  getHtml,
  sweepOrphanAudit,
  enrolMfa,
  completeMfa,
  completePassword,
  nextEmail,
  makeAccount,
};
