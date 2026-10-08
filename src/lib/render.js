'use strict';

/**
 * Hybrid rendering pipeline (PRD §12.4: "Server-rendered or statically
 * generated public pages — no client-only content").
 *
 *   • STABLE pages  → rendered once, written to STATIC_DIR as real HTML files
 *                     (and recorded in the static_pages table), then served
 *                     from disk. Homepage, curated facets, service pages…
 *   • DYNAMIC pages → rendered per request with EJS. /cars (filters, sort,
 *                     pagination) and the VDP (stock moves hourly).
 *
 * Nothing here is client-rendered: the HTML arrives complete. Vanilla JS only
 * upgrades interactions (§17.2).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'views');

const ejsOptions = {
  root: VIEWS,
  views: [VIEWS],
  async: false, // includes resolve synchronously; the page is complete at send
  rmWhitespace: false,
  cache: false,
};

/** Render a view file to an HTML string. */
function renderView(view, locals) {
  return ejs.renderFile(path.join(VIEWS, `${view}.ejs`), locals, ejsOptions);
}

/**
 * Render a page inside its layout chain:
 *   views/pages/<view>.ejs → views/layouts/<layout>.ejs (default: base)
 * Returns the complete document.
 */
async function renderPageHtml(view, locals) {
  const page = locals.page || {};
  const layout = page.layout || 'base';
  const body = await renderView(`pages/${view}`, locals);
  if (layout === false) return body;
  return renderView(`layouts/${layout}`, { ...locals, body });
}

/** A fragment has no layout — used for AJAX results and htmx-style swaps. */
async function renderFragment(view, locals) {
  return renderView(`pages/${view}`, { ...locals, fragment: true });
}

function hashOf(html) {
  return crypto.createHash('sha1').update(html).digest('hex');
}

/** '/cars/toyota' → dist/cars/toyota/index.html · '/sitemap.xml' → dist/sitemap.xml */
function filePathFor(staticDir, routePath) {
  if (/\.[a-z0-9]+$/i.test(routePath)) return path.join(staticDir, routePath);
  const clean = routePath === '/' ? '' : routePath.replace(/\/+$/, '');
  return path.join(staticDir, clean, 'index.html');
}

async function writeStaticFile(staticDir, routePath, html) {
  const file = filePathFor(staticDir, routePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  return file;
}

/**
 * Load the build manifest. The site boots whether or not a build has run —
 * no manifest simply means "render everything at request time".
 */
function loadManifest(staticDir) {
  const manifestPath = path.join(staticDir, '.static-manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const map = new Map();
    for (const entry of manifest.routes || []) map.set(entry.path, entry);
    return { generatedAt: manifest.generatedAt, routes: map };
  } catch {
    return { generatedAt: null, routes: new Map() };
  }
}

/**
 * The newest mtime under the directories a build reads.
 *
 * This is what makes "the build is older than the code" detectable rather than a
 * mystery. A `git pull` rewrites the files it changed and leaves `dist/` exactly
 * where it was, so the server would go on serving HTML built from yesterday's
 * templates — a page that renders, and is wrong. Comparing the manifest's
 * `generatedAt` with the newest source mtime says so in one number.
 *
 * Only the directories a build actually reads are walked: `views`, `src`,
 * `public/css`, `public/js`. A touched file elsewhere (a migration, a test, an
 * uploaded photo) does not invalidate 74 pages, and pretending it does would
 * make the warning noise rather than signal.
 */
const BUILD_SOURCES = ['views', 'src', 'public/css', 'public/js'];
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.test-static', 'uploads']);

function newestSourceTime(root, dirs = BUILD_SOURCES) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const { mtimeMs } = fs.statSync(full);
        if (mtimeMs > newest) newest = mtimeMs;
      } catch {
        /* a file that vanished mid-walk cannot make a build stale */
      }
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return newest || null;
}

/** Serve a prebuilt file when it exists; otherwise signal "render me". */
function staticFileFor(staticDir, manifest, routePath) {
  if (!manifest.routes.has(routePath)) return null;
  const file = filePathFor(staticDir, routePath);
  return fs.existsSync(file) ? file : null;
}

/**
 * Build every route the registry marks as static.
 *
 * @param {object} options
 * @param {Array<{path: string, view: string, layout?: string, build: Function}>} options.routes
 * @param {string} options.staticDir
 * @param {object} options.db
 * @param {Function} [options.onProgress]
 */
async function buildStaticSite({ routes, staticDir, db, onProgress = () => {} }) {
  const manifestRoutes = [];
  let bytes = 0;

  // Loaded lazily: locals.js and render.js are siblings, and this keeps the
  // build script free to import render.js without a cycle.
  const { buildLocals } = require('./locals');

  for (const route of routes) {
    const built = await route.build({ db, siteUrl: require('../config').siteUrl });
    // Same locals contract as an SSR request — static and dynamic pages can
    // never drift apart.
    const locals = await buildLocals(route.path, built.page || {}, built.data || {});
    const html = await renderPageHtml(route.view, locals);
    await writeStaticFile(staticDir, route.path, html);

    const entry = {
      path: route.path,
      view: route.view,
      hash: hashOf(html),
      bytes: Buffer.byteLength(html),
      renderedAt: new Date().toISOString(),
    };
    manifestRoutes.push(entry);
    bytes += entry.bytes;
    onProgress(entry);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    routeCount: manifestRoutes.length,
    bytes,
    routes: manifestRoutes,
  };
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, '.static-manifest.json'), JSON.stringify(manifest, null, 2));

  if (db && db.staticPages) await db.staticPages.record(manifestRoutes);

  return manifest;
}

module.exports = {
  VIEWS,
  ROOT,
  renderView,
  renderPageHtml,
  renderFragment,
  writeStaticFile,
  filePathFor,
  loadManifest,
  newestSourceTime,
  staticFileFor,
  buildStaticSite,
  hashOf,
};
