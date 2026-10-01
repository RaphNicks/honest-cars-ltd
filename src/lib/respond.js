'use strict';

/**
 * Response helpers. One place decides cache headers (§12.1: TTFB < 600ms
 * cached / < 1.2s dynamic) so no route guesses.
 */

const fs = require('node:fs');
const config = require('../config');
const render = require('./render');
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
  const locals = await buildLocals(routePath, { ...page, layout: page.layout || 'base' }, data);
  const html = await render.renderPageHtml(view, locals);
  res.status(status);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', cache);
  for (const [key, value] of Object.entries(headers)) res.set(key, value);
  res.send(html);
}

/**
 * Serve a prebuilt static file when the build has already produced it,
 * otherwise fall through to a renderer. This is the "static where stable"
 * half of §12.4; it never applies to /cars or the VDP.
 */
async function sendPrebuiltOrRender(req, res, options) {
  if (config.features.serveStaticPages) {
    const manifest = req.app.locals.staticManifest || { routes: new Map() };
    const file = render.staticFileFor(config.features.staticPath, manifest, options.routePath);
    if (file) {
      res.set('Cache-Control', CACHE.static);
      res.set('X-HonestCars-Render', 'static');
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

module.exports = { CACHE, sendPage, sendPrebuiltOrRender, sendFragment, sendJson, fs };
