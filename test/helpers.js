'use strict';

/**
 * Test helpers. Database-backed suites skip themselves (rather than fail) when
 * MySQL is not reachable, so `npm test` is useful on a laptop with no DB up.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

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

module.exports = { ROOT, dbAvailable, startTestServer, runScript, getHtml };
