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
const { router: serviceRoutes } = require('./routes/services');
const { router: flowRoutes } = require('./routes/flow');
const { router: blogRoutes } = require('./routes/blog');
const { router: shopRoutes } = require('./routes/shop');
const { router: pageRoutes } = require('./routes/pages');
const { router: financingRoutes } = require('./routes/financing');
const { router: authRoutes } = require('./routes/auth');
const { router: accountRoutes } = require('./routes/account');
const { router: adminRoutes } = require('./routes/admin');
const { router: adminCmsRoutes } = require('./routes/admin-cms');
const { router: dealerRoutes } = require('./routes/dealer');
const auth = require('./services/auth');
const publish = require('./services/publish');
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
  // PSP webhooks verify an HMAC over the exact bytes they sent, so those two
  // paths get the raw body before any JSON parsing happens (§12.2).
  app.use(['/api/payments/webhook/paystack', '/api/payments/webhook/flutterwave'], express.raw({ type: '*/*', limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '128kb' }));

  // --- Static assets --------------------------------------------------------
  // Prebuilt HTML lives under STATIC_DIR but is NEVER served by express.static
  // (it would bypass routing, headers and the dynamic routes entirely). Only
  // the public/ assets are static.
  const publicDir = path.join(__dirname, '..', 'public');

  // The service worker (FR-30) is served deliberately, not by express.static:
  // a worker script must be revalidated on every visit or a new version can sit
  // unnoticed for the whole of its 24-hour cache ceiling, and its scope is
  // decided by the path it is served from — root, so it can handle the whole
  // site. `Service-Worker-Allowed` makes that explicit rather than accidental.
  app.get('/sw.js', (req, res) => {
    res.set('Content-Type', 'text/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Service-Worker-Allowed', '/');
    res.sendFile(path.join(publicDir, 'sw.js'));
  });

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
  // Content saves revalidate the affected pages; publish.js refreshes this map
  // so a newly published post is served from disk straight away.
  publish.setApp(app);

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

  // --- Who is asking? (§7.1) ------------------------------------------------
  // Attaches req.user and req.savedCarIds; it never blocks a request, so the
  // public site behaves identically for signed-out visitors.
  app.use(auth.attachUser);

  // --- Routes ---------------------------------------------------------------
  // Account and sign-in come first: /login, /account and the /api/auth and
  // /api/account endpoints must win over the marketing-page routes below.
  app.use('/api/auth', authRoutes);
  app.use('/', accountRoutes);
  // The console: /admin is gated by §7.4 and mounted before the public pages,
  // so the old "phase 2" stub for /admin can never shadow it.
  app.use('/admin/cms', adminCmsRoutes);
  app.use('/admin', adminRoutes);
  // §7.2 dealer portal. Mounted before the marketing pages so /dealer is the
  // portal, not the phase-2 stub it used to be.
  app.use('/dealer', dealerRoutes);
  app.use('/api', apiRoutes);
  app.use('/services', serviceRoutes);
  app.use('/', flowRoutes);
  app.use('/blog', blogRoutes);
  app.use('/', shopRoutes);
  app.use('/', financingRoutes); // FR-34 — /financing, before the generic page routes
  app.use('/', pageRoutes);
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
