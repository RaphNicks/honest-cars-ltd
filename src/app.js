'use strict';

/**
 * Express application.
 *
 * Hybrid rendering per PRD §12.4:
 *   • stable pages are prebuilt to disk and served straight from there
 *   • /cars and the VDP are rendered per request
 *   • vanilla JS only upgrades behaviour on top of complete HTML
 */

const path = require('node:path');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');

const config = require('./config');
const render = require('./lib/render');
const { router: publicRoutes, sendNotFound } = require('./routes/public');
const { router: apiRoutes } = require('./routes/api');
const og = require('./services/og');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.set('etag', 'strong');

  // --- Security headers (§12.2) --------------------------------------------
  // Note on framing: the site is embedded in a preview iframe in some
  // environments, so frameguard is off and no frame-ancestors directive is set.
  // The CSP still locks scripting to self + the analytics tag.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", 'https://www.google-analytics.com', 'https://region1.google-analytics.com'],
          formAction: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          // JSON-LD needs 'unsafe-inline' for script-src; every value it emits
          // is escaped in src/services/seo.js and the templates.
        },
      },
      crossOriginEmbedderPolicy: false,
      frameguard: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // --- Compression + parsers ----------------------------------------------
  app.use(compression({ threshold: 1024 }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '128kb' }));

  // --- Static assets --------------------------------------------------------
  // Prebuilt HTML lives under STATIC_DIR but is NEVER served by express.static
  // (it would bypass routing, headers and the dynamic routes entirely). Only
  // the public/ assets are static.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(
    express.static(publicDir, {
      maxAge: config.isProduction ? '30d' : 0,
      setHeaders(res, filePath) {
        if (/\.(woff2?|png|jpe?g|webp|avif|svg)$/.test(filePath)) {
          res.set('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=86400');
        }
        if (/\.(css|js)$/.test(filePath)) {
          res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
        }
      },
      index: false,
      redirect: false,
    }),
  );

  // Build manifest (what `npm run build:static` produced). Absent is fine:
  // every static-capable route then renders at request time.
  app.locals.staticManifest = config.features.serveStaticPages
    ? render.loadManifest(config.features.staticPath)
    : { routes: new Map() };
  app.locals.staticManifestPath = path.join(config.features.staticPath, '.static-manifest.json');

  // --- Redirect map (§14.1 legacy + archived sold URLs) --------------------
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      const entry = await require('./db').redirects.findByPath(req.path);
      if (entry) return res.redirect(entry.statusCode, entry.to);
    } catch {
      /* a missing redirect table must never take the site down */
    }
    return next();
  });

  // --- Routes ---------------------------------------------------------------
  app.use('/api', apiRoutes);
  app.use('/', publicRoutes);

  // --- 404 ------------------------------------------------------------------
  app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    try {
      return await sendNotFound(req, res);
    } catch (error) {
      return next(error);
    }
  });

  // --- Error handler (never leak a stack to a browser) ---------------------
  app.use(async (err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[error]', err && err.stack ? err.stack : err);
    if (res.headersSent) return;
    res.status(err.statusCode || 500);
    if (req.path.startsWith('/api/')) {
      return res.json({ ok: false, error: 'Something went wrong on our side.' });
    }
    try {
      return await require('./lib/respond').sendPage(req, res, {
        routePath: req.path,
        view: 'error',
        status: err.statusCode || 500,
        cache: 'no-store',
        page: { title: 'Something went wrong', metaTitle: 'Something went wrong | HonestCars', canonical: '/', robots: 'noindex,nofollow' },
        data: {},
      });
    } catch {
      return res.type('text/plain').send('Something went wrong.');
    }
  });

  // The default OG card should exist before the first request needs it.
  og.ensureDefaultCard().catch(() => {});

  return app;
}

module.exports = { createApp };
