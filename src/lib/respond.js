'use strict';

/**
 * Response helpers. One place decides cache headers (§12.1: TTFB < 600ms
 * cached / < 1.2s dynamic) so no route guesses.
 */

const fs = require('node:fs');
const config = require('../config');
const render = require('./render');
const overrides = require('./overrides');
const { buildLocals } = require('./locals');

/** HTML cache policy. Static pages can sit at the edge; SSR pages must be fresh. */
const CACHE = {
  static: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  ssr: 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
  private: 'private, no-store',
};

/**
 * Render a page and send it.
 *
 * @param {import('express').Response} res
 * @param {object} options
 * @param {string} options.routePath
 * @param {string} options.view
 * @param {object} options.page
 * @param {object} [options.data]
 * @param {number} [options.status]
 * @param {string} [options.cache]
 */
async function sendPage(req, res, { routePath, view, page, data = {}, status = 200, cache = CACHE.ssr, headers = {} }) {
  const saveData = wantsLessData(req);
  const locals = await buildLocals(
    routePath,
    { ...page, layout: page.layout || 'base' },
    { ...personalise(req, data), saveData },
  );
  const html = await render.renderPageHtml(view, locals);
  res.status(status);
  res.set('Content-Type', 'text/html; charset=utf-8');
  // A signed-in response is personalised (header state, save buttons) and must
  // never be cached publicly, whatever the route asked for.
  res.set('Cache-Control', req.user ? CACHE.private : cache);
  // The page really does differ per Save-Data, so a cache between us and the
  // visitor must not serve one variant for the other (§13.2).
  res.append('Vary', 'Save-Data');
  for (const [key, value] of Object.entries(headers)) res.set(key, value);
  res.send(html);
}

/**
 * §13.2 — is this visitor asking us to spend less of their data?
 *
 * `Save-Data: on` is the header Chrome and Opera send when Data Saver is on;
 * it is a request, not a guarantee, so when it is absent we spend normally and
 * the client-side check (`navigator.connection.saveData`) picks it up instead —
 * which is also the only way to adapt a prebuilt static page.
 */
function wantsLessData(req) {
  return String(req.get('save-data') || '').toLowerCase() === 'on';
}

/**
 * Serve a prebuilt static file when the build has already produced it,
 * otherwise fall through to a renderer. This is the "static where stable"
 * half of §12.4; it never applies to /cars or the VDP.
 */
async function sendPrebuiltOrRender(req, res, options) {
  // Signed-in users always get a fresh render: the prebuilt file is the
  // signed-out view, and it is publicly cacheable.
  if (config.features.serveStaticPages && !req.user) {
    const manifest = req.app.locals.staticManifest || { routes: new Map() };
    const file = render.staticFileFor(config.features.staticPath, manifest, options.routePath);
    // §5.1: a prebuilt page has the footer's phone number, the CAC line and the
    // retainer prices baked in. If the console has saved a setting since the
    // build, that HTML is wrong — so render on request until the next
    // `npm run build:static`, rather than serving a page we know to be stale.
    //
    // The same applies to a build older than the code, which is what a pull
    // without a rebuild leaves behind: the markup on disk is the previous
    // revision's. `app.js` works that out once at boot (`staticManifestStale`),
    // because it is a property of the process, not of the request.
    // Two independent reasons a build goes out of date, and the setting is named
    // first when both are true: it is the recent, deliberate act whose operator
    // was told the page would rebuild.
    const codeStale = req.app.locals.staticManifestStale || null;
    const settingStale = overrides.changedSince(manifest.generatedAt);
    if (file && (settingStale || codeStale)) {
      // Say what happened and why: the header names the reason the prebuilt file
      // was skipped, and the render header still reports the path taken — this is
      // a dynamic render like any other, just for an unusual reason.
      res.set('X-HonestCars-Stale-Build', settingStale ? 'settings-changed-since-build' : 'build-older-than-code');
      res.set('X-HonestCars-Render', 'dynamic');
      return sendPage(req, res, options);
    }
    if (file) {
      res.set('Cache-Control', CACHE.static);
      res.set('X-HonestCars-Render', 'static');
      // A prebuilt page cannot be trimmed per request, so it is the *client*
      // that drops to the small images on Save-Data for these. Vary still
      // belongs here: the inline config the page carries tells the client
      // whether the server saw the header.
      res.append('Vary', 'Save-Data');
      return res.sendFile(file);
    }
  }
  res.set('X-HonestCars-Render', 'dynamic');
  return sendPage(req, res, options);
}

function sendFragment(res, html, { status = 200 } = {}) {
  res.status(status);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', CACHE.private);
  res.send(html);
}

function sendJson(res, payload, { status = 200, cache = CACHE.private } = {}) {
  res.status(status);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', cache);
  res.send(JSON.stringify(payload));
}

/**
 * Everything a template needs to know about the current visitor. Pages that
 * render car cards or the header read `user` and `savedIds` from here, so no
 * route has to remember to pass them.
 */
function personalise(req, data = {}) {
  return { user: req.user || null, savedIds: req.savedCarIds || [], ...data };
}

module.exports = { CACHE, sendPage, sendPrebuiltOrRender, sendFragment, sendJson, personalise, wantsLessData, fs };
