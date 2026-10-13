'use strict';

/**
 * Renewal reminders — FR-20, §7.3 “renewal queue + auto reminders (30/7/1 day)”.
 *
 *   npm run renewals              # send what is due (up to the per-run cap)
 *   npm run renewals -- --dry-run # show the exact sentences, send nothing
 *
 * This is the cron entry point: point a daily job at it and a subscription is
 * reminded once inside each 30, 7 and 1-day window. Running it twice in a
 * morning does nothing the second time — the dedupe is a unique key in
 * `subscription_reminders`, not a flag in memory, so it survives restarts and
 * concurrent runs.
 *
 * The same function is behind the button on /admin/subscriptions, and neither
 * path is privileged over the other: the console just prints the report, a cron
 * job gets it on stdout (and exits non-zero only if the run itself failed).
 */

const db = require('../src/db');
const renewals = require('../src/services/renewals');

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

  const report = await renewals.runReminders({ dryRun, limit });

  console.log(`\n${dryRun ? 'DRY RUN — nothing sent, nothing written' : 'Renewal sweep'} · ${report.checked} subscription(s) inside the window · ${report.ms}ms`);

  if (report.lapsed) console.log(`  ${report.lapsed} moved to lapsed (past the grace window)`);

  if (report.wouldSend.length) {
    console.log('\nWould send:');
    for (const item of report.wouldSend) {
      console.log(`  [${item.windowDays}d] ${item.phone || 'no number'} · ${item.kind}`);
      console.log(`        ${item.body}`);
    }
  }

  if (report.sent) console.log(`\n✓ ${report.sent} reminder(s) sent`);

  if (report.skipped.length) {
    console.log(`\n! ${report.skipped.length} recorded but not delivered — the ops desk has to send these by hand:`);
    for (const item of report.skipped) {
      console.log(`  [${item.windowDays}d] ${item.phone || 'no number'} — ${item.reason}`);
      console.log(`        ${item.body}`);
    }
  }

  if (report.alreadySent.length) console.log(`\n· ${report.alreadySent.length} already reminded for their current window (skipped)`);

  if (report.errors.length) {
    console.error(`\n✗ ${report.errors.length} error(s):`);
    for (const error of report.errors) console.error(`  #${error.id} [${error.windowDays}d] ${error.error}`);
  }

  if (!report.checked) console.log('\nNothing renews inside 30 days. Nothing to do.');

  await db.pool.end();
  process.exit(report.errors.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error('Renewal sweep failed:', error.message);
  try {
    await db.pool.end();
  } catch {
    /* the pool may never have opened */
  }
  process.exit(1);
});
