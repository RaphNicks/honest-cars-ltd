'use strict';

/**
 * Saved-car and saved-search alert sweep — FR-25.
 *
 *   npm run alerts                 # detect, send, record
 *   npm run alerts -- --dry-run    # print what would go out; write nothing
 *   npm run alerts -- --user 12    # one account only (support)
 *   npm run alerts -- --limit 10   # cap the messages this run
 *
 * Safe to run on a cron every 15 minutes, or by hand from /admin/alerts. Running
 * it twice does nothing the second time: the baselines it moves are what make a
 * drop fire once per price, not once per run.
 *
 * Delivery goes through the configured notify channel. With no provider set the
 * message is recorded `skipped` with its text intact, so it is never silently
 * lost — /admin/payments shows both the sent and the skipped ones.
 *
 * The same run settles lapsed paid windows (FR-18): an add-on whose paid window
 * has closed is marked `expired` and, if it was a featured placement, the car
 * gives its featured rank back. A cron that runs the alerts is therefore also a
 * cron that keeps the paid window honest.
 */

import { createRequire } from 'node:module';

// The application is CommonJS (package.json has no "type": "module"); this
// script is ESM so it can run as a .mjs like crawl.mjs. createRequire bridges
// the two without duplicating any module.
const require = createRequire(import.meta.url);
const alerts = require('../src/services/alerts');
const notify = require('../src/services/notify');
const money = require('../src/lib/money');
const db = require('../src/db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const userIndex = args.indexOf('--user');
const limitIndex = args.indexOf('--limit');
const userId = userIndex >= 0 ? Number(args[userIndex + 1]) || null : null;
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) || null : undefined;

async function main() {
  const report = await alerts.runWatch({ dryRun, userId, limit });

  console.log(`${dryRun ? 'DRY RUN — nothing sent, nothing written' : 'Alert sweep'} · ${report.at}`);
  console.log(`  watching ${report.checked.cars} saved car(s), ${report.checked.searches} saved search(es)`);

  for (const drop of report.priceDrops) {
    console.log(`  ↓ ${drop.userName || drop.userId} · ${drop.title}: ${money.formatNaira(drop.fromKobo)} → ${money.formatNaira(drop.toKobo)} (−${money.formatNaira(drop.dropKobo)})`);
  }
  for (const match of report.newMatches) {
    console.log(`  ✚ ${match.userName || match.userId} · “${match.label}”: ${match.count} new`);
  }
  for (const gone of report.soldOff) {
    console.log(`  · ${gone.slug} is no longer live (${gone.status}) — no alert`);
  }
  for (const skip of report.skipped) {
    console.log(`  ! ${skip.kind} for user ${skip.userId} was not delivered: ${skip.reason}`);
  }

  if (!dryRun) {
    // FR-18: paid windows that have closed give their benefit up.
    const settled = await db.addons.expireDue();
    if (settled.expired) console.log(`  ⌛ ${settled.expired} paid add-on window(s) closed — featured placement released`);
    console.log(`  sent ${report.sent}, deferred ${report.remaining}`);
  }
  if (report.ms !== undefined) console.log(`  ${report.ms}ms`);

  if (!dryRun && (report.sent > 0 || report.skipped.length)) {
    const config = require('../src/config');
    void config;
    const channels = [...new Set(report.priceDrops.concat(report.newMatches).map((entry) => entry.delivery).filter(Boolean))];
    console.log(`  channel: ${channels.join(', ') || config.notifications.defaultChannel} — an unconfigured channel is recorded as skipped, never dropped`);
    if (!notify.providers[config.notifications.defaultChannel]) {
      console.log('  note: no provider for that channel yet, so those messages are in /admin/alerts waiting to be sent by hand');
    }
  }

  await db.pool.end();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n✗ alert sweep failed:', error.message);
  try {
    await db.pool.end();
  } catch {
    // already closed
  }
  process.exit(1);
});
