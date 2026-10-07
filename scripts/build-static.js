'use strict';

/**
 * Static page build (PRD §12.4: "server-rendered or statically generated public
 * pages — no client-only content").
 *
 *   node scripts/build-static.js            # build, then report
 *   node scripts/build-static.js --quiet
 *
 * Writes real HTML files into STATIC_DIR plus .static-manifest.json (used by
 * the server to decide whether to serve from disk) and records every page in
 * the static_pages table. Exits non-zero if any route fails, so it can gate a
 * deploy.
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/config');
const db = require('../src/db');
const render = require('../src/lib/render');
const sitemap = require('../src/services/sitemap');
const { staticRoutes } = require('../src/routes/registry');
const og = require('../src/services/og');

const quiet = process.argv.includes('--quiet');

async function main() {
  const started = Date.now();
  const staticDir = config.features.staticPath;

  // §5.1 settings: static pages bake the footer's phone number, the CAC line and
  // the home feed size into HTML, so the build has to read the same overrides the
  // server does — otherwise a rebuild silently reverts the desk's change.
  await require('../src/services/settings').hydrate();

  if (!quiet) console.log(`→ building static pages into ${staticDir}`);

  const routes = await staticRoutes({ db });
  const failures = [];

  const manifest = await render.buildStaticSite({
    routes: routes.map((route) => ({
      ...route,
      build: async (ctx) => {
        try {
          return await route.build(ctx);
        } catch (error) {
          failures.push({ path: route.path, error: error.message });
          throw error;
        }
      },
    })),
    staticDir,
    db,
    onProgress(entry) {
      if (!quiet) console.log(`  ✓ ${entry.path}  ${(entry.bytes / 1024).toFixed(1)} kB`);
    },
  });

  // --- Social card ----------------------------------------------------------
  // The site-wide 1200×630 default must exist before the first share.
  const defaultCard = await og.ensureDefaultCard();
  if (!quiet) console.log(`  ${defaultCard ? '✓' : '·'} /og/default.png${defaultCard ? '' : ' (sharp/fontconfig unavailable — skipped)'}`);

  // --- Sitemap + robots -----------------------------------------------------
  const xml = await sitemap.buildSitemap(db);
  fs.writeFileSync(path.join(staticDir, 'sitemap.xml'), xml);
  fs.writeFileSync(path.join(staticDir, 'robots.txt'), sitemap.buildRobots());
  const urlCount = (xml.match(/<url>/g) || []).length;
  if (!quiet) console.log(`  ✓ /sitemap.xml  ${urlCount} URLs`);

  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  console.log(
    `\n${failures.length ? '✗' : '✓'} static build ${failures.length ? 'incomplete' : 'complete'} — ` +
      `${manifest.routeCount} pages, ${(manifest.bytes / 1024).toFixed(1)} kB total, ${seconds}s`,
  );
  if (failures.length) {
    for (const failure of failures) console.error(`  ! ${failure.path}: ${failure.error}`);
    process.exit(1);
  }

  await db.pool.end();
}

main().catch(async (error) => {
  console.error('\n✗ static build failed:', error.message);
  try {
    await db.pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
