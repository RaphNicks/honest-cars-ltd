'use strict';

/**
 * Referral sweep — FR-28, §7.1 “Referrals (personal link + reward status)”.
 *
 *   npm run referrals              # count referrals that have qualified
 *   npm run referrals -- --dry-run # show who would count, write nothing
 *
 * This is the cron entry point: point a daily job at it and a referral starts to
 * count within a day of the order that earned it. Running it twice does nothing
 * the second time — the guard is `users.referral_qualified_at IS NULL` in SQL
 * plus the unique (referrer, referred) key on `referral_rewards`, so it survives
 * restarts and concurrent runs rather than living in a flag.
 *
 * The same function is behind the button on /admin/referrals. Counting is all
 * this does: no amount is ever set here, because the reward is a decision a
 * human makes in the console.
 */

const db = require('../src/db');
const referrals = require('../src/services/referrals');
const money = require('../src/lib/money');

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

  const result = await referrals.sweep({ limit, dryRun });

  console.log(`\n${dryRun ? 'DRY RUN — nothing written' : 'Referral sweep'} · ${result.considered} referred account(s) with a paid order and no qualification yet`);

  if (!result.considered) {
    console.log('\nNothing to count. Every referral that has bought is already on the desk’s queue.');
  } else {
    for (const item of result.qualified) {
      console.log(`  ${dryRun ? '→' : '✓'} ${item.referralCode || '(no code)'} · ${item.paidOrders} paid order(s)`
        + `${dryRun ? ' (would be queued)' : ` · reward #${item.rewardId}`}`);
    }
  }

  const summary = await db.referrals.summary();
  console.log(`${dryRun ? '(queue unchanged)' : ''}`.trim() || '');
  console.log(
    `\nQueue: ${summary.pending} pending · ${summary.approved} approved (${money.formatNaira(summary.approvedKobo)}) · `
    + `${summary.paid} paid (${money.formatNaira(summary.paidKobo)}) · ${summary.void} voided`,
  );
  console.log(`${summary.qualified} of ${summary.brought} referred account(s) count, from ${summary.referrers} link(s).`);

  await db.pool.end();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('Referral sweep failed:', error.message);
  try {
    await db.pool.end();
  } catch {
    /* the pool may never have opened */
  }
  process.exit(1);
});
