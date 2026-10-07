'use strict';

/**
 * Server entry point. Binds 0.0.0.0 so the sandbox preview (and any container
 * host) can reach it, and fails loudly if MySQL is unreachable — the storefront
 * has no useful degraded mode without inventory.
 */

const config = require('./config');
const { createApp } = require('./app');
const db = require('./db');

async function start() {
  const app = createApp();

  let health;
  try {
    health = await db.healthcheck();
    console.log(`✓ MySQL ${health.version} · database "${health.database}"`);
  } catch (error) {
    console.error(`\n✗ Cannot reach MySQL at ${config.db.host}:${config.db.port}`);
    console.error(`  ${error.code || error.message}`);
    console.error('  → copy .env.example to .env and point DB_* at your instance, then run: npm run db:setup\n');
    process.exit(1);
  }

  // §5.1 settings (migration 027) — the overrides the console has saved are read
  // once here and again after every save, so the storefront, the API and the
  // messages all use the same numbers without a query per read.
  const settings = require('./services/settings');
  const loaded = await settings.hydrate();
  if (loaded.loaded) console.log(`  settings: ${loaded.loaded} override${loaded.loaded === 1 ? '' : 's'} in force from /admin/settings`);
  if (loaded.ignored && loaded.ignored.length) {
    console.warn(`  ! ${loaded.ignored.length} setting row(s) ignored — not in the registry: ${loaded.ignored.join(', ')}`);
  }

  const counts = await db.listings.networkCounters().catch(() => null);
  if (counts) {
    console.log(`  inventory: ${counts.carsLive} live cars · ${counts.partnerDealers} verified dealers · ${counts.certified} certified`);
  } else {
    console.warn('  ! listings tables look empty — run `npm run db:setup` to load schema + seed data');
  }

  const server = app.listen(config.port, config.host, () => {
    console.log(`✓ honestcarsltd listening on http://${config.host}:${config.port} (${config.env})`);
    console.log(`  static pages: ${config.features.serveStaticPages ? config.features.staticDir : 'disabled (always dynamic)'}`);
  });

  const shutdown = (signal) => () => {
    console.log(`\n${signal} received — closing server`);
    server.close(() => db.pool.end().then(() => process.exit(0)).catch(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start:', error);
    process.exit(1);
  });
}

module.exports = { start };
