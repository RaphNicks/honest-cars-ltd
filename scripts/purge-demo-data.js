'use strict';

/**
 * Going live — remove every row of synthetic demo data while keeping the
 * things a real business starts from:
 *
 *   KEEPS: user accounts (the seeded logins and anyone who has signed up),
 *   settings, the service catalogue and pricing, FAQs, CMS pages, the city
 *   directory, hire classes, delivery areas, MFA secrets, and dealer
 *   profiles that an account actually owns.
 *
 *   REMOVES: all vehicle listings and their media, price bands and facets,
 *   saved cars/searches, leads, enquiries, viewings, bookings, hires,
 *   orders and payments, blog posts and tags, testimonials, notifications,
 *   referral rewards, the audit trail, analytics, sessions, and dealer
 *   profiles that no account owns.
 *
 *   node scripts/purge-demo-data.js
 *
 * Idempotent: running it twice changes nothing the second time. Note that
 * `npm run db:seed` (or a fresh setup into an empty database) puts the demo
 * data back — the test suite needs it, so demo and live are one command
 * apart in either direction.
 */

const db = require('../src/db');

const PURGE = [
  // listings and everything derived from them
  'listing_media', 'saved_cars', 'saved_searches', 'price_bands', 'facets',
  'vehicle_listings',
  // demand side: enquiries, requests, money
  'leads', 'financing_leads', 'finance_partners', 'testimonials',
  'service_requests', 'request_candidates', 'bookings',
  'hire_bookings', 'hire_incidents', 'hire_vehicles',
  'order_items', 'orders', 'payments', 'payment_events', 'payment_milestones',
  'subscriptions', 'subscription_reminders', 'referral_rewards',
  // dealer operations (profiles with an account are kept below)
  'dealer_addons', 'dealer_purchases', 'dealer_ledger', 'dealer_api_keys',
  // editorial demo content
  'blog_post_tags', 'blog_posts', 'blog_tags', 'blog_authors',
  // telemetry and housekeeping from the demo period
  'analytics_events', 'notifications', 'admin_audit', 'content_revisions',
  'consent_records', 'data_requests', 'marketing_spend',
  'auth_codes', 'sessions',
  'products',
];

(async () => {
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    let total = 0;
    for (const table of PURGE) {
      const [result] = await conn.query(`DELETE FROM \`${table}\``);
      if (result.affectedRows) {
        console.log(`  ${table}: -${result.affectedRows}`);
        total += result.affectedRows;
      }
    }

    // Dealer lots nobody signs in as were demo scenery; the lots owned by
    // the seeded dealer logins are real accounts and stay.
    const [orphan] = await conn.query('DELETE FROM dealers WHERE user_id IS NULL');
    if (orphan.affectedRows) {
      console.log(`  dealers (no account): -${orphan.affectedRows}`);
      total += orphan.affectedRows;
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.commit();

    const [[live]] = await conn.query('SELECT COUNT(*) AS n FROM vehicle_listings');
    const [[users]] = await conn.query('SELECT COUNT(*) AS n FROM users');
    console.log(`✓ purged ${total} demo rows — ${live.n} listings remain, ${users.n} accounts kept`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    process.exit(0);
  }
})().catch((err) => {
  console.error('purge failed:', err.message);
  process.exit(1);
});
