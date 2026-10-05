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

module.exports = { ROOT, dbAvailable, startTestServer, runScript, getHtml, sweepOrphanAudit };
