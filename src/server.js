'use strict';

/**
 * Server entry point. Binds 0.0.0.0 so the sandbox preview (and any container
 * host) can reach it, and fails loudly if MySQL is unreachable — the storefront
 * has no useful degraded mode without inventory.
 */

const path = require('node:path');

const config = require('./config');
const render = require('./lib/render');
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

  // The picker's size, printed because it is the number that tells a stale
  // process from a broken one. The catalogue lives in `src/lib/nigeria-cities.js`,
  // so anything less than the whole country here means the code in memory is not
  // the code on disk — which is what a pull without a restart leaves behind, and
  // what a reader then sees as "no cities are coming up".
  const directory = await require('./services/city-directory').directory().catch(() => null);
  if (directory) {
    const markets = directory.filter((city) => city.served).length;
    console.log(`  picker: ${directory.length} cities, ${markets} of them markets we operate`);
  }

  // And the build. `git pull` does not rebuild `dist/`, so a prebuilt page can be
  // a revision behind while everything about it looks fine; app.js refuses to
  // serve those, and this says why rather than leaving it to be noticed later.
  const build = app.locals.staticBuild || null;
  if (build && build.stale) {
    console.warn(`  ! ${config.features.staticDir}/ was built ${build.generatedAt || 'before this checkout was written'} — older than the code.`);
    console.warn('    Run `npm run build:static` to use the prebuilt pages; until then every page renders per request.');
  }

  const server = app.listen(config.port, config.host, () => {
    console.log(`✓ honestcarsltd listening on http://${config.host}:${config.port} (${config.env})`);
    console.log(`  static pages: ${config.features.serveStaticPages ? config.features.staticDir : 'disabled (always dynamic)'}`);
  });

  // A pull while this process is running leaves the views new and the modules
  // old: Express re-reads `.ejs` from disk on every render, but `require()`
  // cached everything else at boot. The result is a page that half-exists — new
  // markup, old locals — which is confusing to debug from a browser and obvious
  // in a terminal. So: watch the same directories a build reads, and say it once.
  const startedAt = Date.now();
  const watcher = setInterval(() => {
    const newest = render.newestSourceTime(path.join(__dirname, '..'));
    if (newest && newest > startedAt) {
      console.warn('  ! the code changed while this process was running — restart (Ctrl-C, then `npm start`) to run it');
      clearInterval(watcher);
    }
  }, 60_000);
  watcher.unref();

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
