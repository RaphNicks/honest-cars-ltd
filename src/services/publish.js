'use strict';

/**
 * Content revalidation — the other half of §12.4's hybrid rendering.
 *
 * Stable pages live on disk (dist/) and are served straight from there. That is
 * what makes the site fast, and it is also the trap: a CMS that only updates a
 * row would leave the published page stale until the next deploy. So every
 * content save that can change a public page calls `revalidate()`, which
 * re-renders exactly the affected routes and rewrites the manifest entry for
 * each one — leaving every other page on disk untouched.
 *
 * The rules:
 *   • Only routes the registry marks as static can be revalidated. /cars and
 *     the VDPs are server-rendered, so there is nothing to invalidate there.
 *   • A path that is not in the current manifest is skipped, not invented —
 *     publishing a post never quietly adds new URLs to the build.
 *   • Failure is reported, never swallowed: the row is saved either way, and
 *     the console is told the build failed so nobody assumes the page is live.
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../config');
const render = require('../lib/render');
const { staticRoutes } = require('../routes/registry');

/** Everything the CMS can put on a public page, in one place. */
const TOUCHES = {
  // FR-35: a post carries tags and an author, so publishing one can change
  // every shelf it appears on — the tag pages it is filed under and its
  // author's page. Callers pass `{slug, tagSlugs, authorSlug}`; a bare slug
  // still works and rebuilds just the post itself.
  post: (key) => {
    const spec = typeof key === 'object' && key ? key : { slug: key };
    const paths = ['/', '/guide', '/blog', `/blog/${spec.slug}`, '/sitemap.xml'];
    for (const tag of spec.tagSlugs || []) paths.push(`/blog/tag/${tag}`);
    if (spec.authorSlug) paths.push(`/blog/author/${spec.authorSlug}`);
    return paths;
  },
  postRemoved: () => ['/', '/guide', '/blog', '/sitemap.xml'],
  page: (slug) => [`/${slug}`, '/sitemap.xml'],
  faq: () => ['/', '/faq', '/how-it-works', '/services/inspection', '/sitemap.xml', '/verification'],
  testimonial: () => ['/', '/about'],
  homepage: () => ['/'],
  service: (slug) => [`/services/${slug}`, '/services', '/sitemap.xml'],
};

/**
 * The server keeps the build manifest in memory (app.locals) so it can answer
 * “is this route static?” without touching the disk per request. Registering the
 * app here means a publish refreshes that map too — otherwise a brand-new post
 * would not be served statically until the next restart.
 */
let appRef = null;
function setApp(app) {
  appRef = app;
}

async function revalidate(paths = []) {
  const wanted = [...new Set((paths || []).filter(Boolean))];
  if (!wanted.length) return { ok: true, rebuilt: [], skipped: [], bytes: 0 };

  const staticDir = config.features.staticPath;
  const manifest = render.loadManifest(staticDir);
  if (!manifest.routes.size) {
    // No build has run in this deployment: pages are rendered per request, so
    // there is nothing stale to fix.
    return { ok: true, rebuilt: [], skipped: wanted, bytes: 0, note: 'no static build present — pages render per request' };
  }

  const routes = await staticRoutes({ db: require('../db') });
  const byPath = new Map(routes.map((route) => [route.path, route]));
  const { buildLocals } = require('../lib/locals');

  const rebuilt = [];
  const skipped = [];
  let bytes = 0;

  for (const routePath of wanted) {
    const route = byPath.get(routePath);
    if (!route || !manifest.routes.has(routePath)) {
      skipped.push(routePath);
      continue;
    }
    const built = await route.build({ db: require('../db'), siteUrl: config.siteUrl });
    const locals = await buildLocals(route.path, built.page || {}, built.data || {});
    const html = await render.renderPageHtml(route.view, locals);
    await render.writeStaticFile(staticDir, route.path, html);

    const entry = {
      path: route.path,
      view: route.view,
      hash: render.hashOf(html),
      bytes: Buffer.byteLength(html),
      renderedAt: new Date().toISOString(),
    };
    manifest.routes.set(route.path, entry);
    bytes += entry.bytes;
    rebuilt.push(entry);
  }

  if (rebuilt.length) {
    const all = [...manifest.routes.values()];
    const next = {
      generatedAt: new Date().toISOString(),
      routeCount: all.length,
      bytes: all.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
      routes: all,
    };
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, '.static-manifest.json'), JSON.stringify(next, null, 2));
    try {
      await require('../db').staticPages.record(rebuilt);
    } catch {
      // Bookkeeping only — the files on disk are already correct.
    }
    if (appRef) appRef.locals.staticManifest = render.loadManifest(staticDir);
  }

  return { ok: true, rebuilt: rebuilt.map((entry) => entry.path), skipped, bytes };
}

/** Revalidate a content change, and never let a build error lose the save. */
async function afterChange(kind, key) {
  const paths = typeof TOUCHES[kind] === 'function' ? TOUCHES[kind](key) : TOUCHES[kind] || [];
  try {
    const result = await revalidate(paths);
    const count = result.rebuilt.length;
    return {
      ok: true,
      message: count ? `Rebuilt ${count} page${count === 1 ? '' : 's'}.` : result.note || 'No static page to rebuild.',
      result,
    };
  } catch (error) {
    return { ok: false, message: `Saved, but the page rebuild failed: ${error.message}` };
  }
}

module.exports = { TOUCHES, setApp, revalidate, afterChange };
