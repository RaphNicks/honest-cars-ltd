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
 * Call it right after `/api/auth/verify`: it reads the account's secret from the
 * database (a test harness has the database; a person has their phone) and posts
 * the code the way the challenge page does. Returns the fetch response, so a
 * caller can assert on it.
 *
 * Codes are single-use — `mfa_last_step` refuses a replay — so two sign-ins in
 * the same 30-second window need different steps. `offset` picks which one.
 */
async function completeMfa(client, { request, phone = null, next = '', offset = 0, code = null } = {}) {
  const db = require('../src/db');
  const totp = require('../src/lib/totp');
  const phones = require('../src/lib/phone');
  // The caller may hold the number in whatever form the fixture used; accounts
  // are stored canonical, so look it up the way the app does.
  const canonical = phone ? phones.canonical(phone, { fallback: phone }) : null;
  const user = canonical ? await db.users.findByPhone(canonical) : null;
  if (!user) throw new Error(`completeMfa could not find ${phone}`);
  const row = await db.mfa.secretFor(user.id);
  if (!row) throw new Error(`no second factor for ${phone} — call enrolMfa first`);
  const value = code || totp.code(row.secret, { time: Date.now() + offset * totp.STEP_SECONDS * 1000 });
  const post = request || ((path, options) => client.request(path, options));
  return post('/api/auth/mfa', { method: 'POST', body: { code: value, next } });
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
};
