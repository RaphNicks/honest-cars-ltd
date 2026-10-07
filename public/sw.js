/* ==========================================================================
   HonestCars service worker (FR-30 + §13.2 "offline-tolerant PWA shell")

   Three jobs, and nothing else:

   1. APP SHELL — precache the CSS, the two fonts the layout preloads and every
      JS module, plus /offline, so a page you have already opened renders
      *properly* offline instead of as bare HTML.
   2. PAGES — network-first for navigations, falling back to the last copy this
      device saw, and finally to /offline. Listing pages you browsed stay
      readable; "cached listings shell" is exactly this.
   3. ENQUIRIES — not here. §13.2's queued enquiries live in drafts.js, which
      already holds a failed send on the device and flushes it on `online`. A
      second, invisible queue in the worker would be a second place for a lead
      to go missing.

   Rules this worker will not break:

   • Never cache anything the server marked `private` or `no-store`. Signed-in
     pages, the dealer portal, the console, carts and checkout all say so, and
     respecting the header — rather than a hand-kept path list — is what keeps a
     cache from ever handing one person another person's page.
   • Never touch anything but GET, and never intercept /api/.
   • Never serve a stale page in preference to a working network. Assets go
     stale-while-revalidate, HTML goes network-first.

   Bump VERSION to ship new shell assets; activate() deletes every older cache.
   ========================================================================== */

/* eslint-env serviceworker */

const VERSION = 'hc-v2';
const SHELL = `${VERSION}-shell`;
const PAGES = `${VERSION}-pages`;
const RUNTIME = `${VERSION}-runtime`; // shell assets discovered later (other font weights)
const ASSETS = `${VERSION}-assets`;

/* The shell. Every path here must exist after `npm run build:static` + the
   asset files in public/ — test/pwa.test.js walks public/js, public/css and the
   layouts and fails if this list drifts from them. */
const SHELL_URLS = [
  '/offline',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icons/icon-192.png',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/sections.css',
  '/css/pages.css',
  '/css/account.css',
  // Only the two weights the layout preloads are worth ~50 KB of someone's
  // data up front (§13.2); 500/600 land in the runtime asset cache the first
  // time a page that uses them is opened, and are then available offline too.
  '/fonts/inter-latin-400-normal.woff2',
  '/fonts/inter-latin-700-normal.woff2',
  // `/js/admin.js` and `/js/dealer.js` are deliberately absent: /admin and
  // /dealer are bypassed by this worker, so precaching them would only cost
  // every other visitor bytes — their pages fill the runtime cache when used.
  '/js/main.js',
  '/js/account.js',
  '/js/area.js',
  '/js/blog.js',
  '/js/cart.js',
  '/js/drafts.js',
  '/js/events.js',
  '/js/financing.js',
  '/js/filters.js',
  '/js/flow.js',
  '/js/header.js',
  '/js/leads.js',
  '/js/pwa.js',
  '/js/service-forms.js',
  '/js/ui.js',
  '/js/valuation.js',
];

/* Hosts and paths that are never cached, whatever the headers say. Belt and
   braces for the no-store rule above. */
const BYPASS = [/^\/api\//, /^\/admin/, /^\/dealer/, /^\/account/, /^\/login/, /^\/logout/, /^\/auth\//, /^\/checkout/, /^\/order\//, /^\/cart\//, /^\/sitemap\.xml$/, /^\/robots\.txt$/];

const PAGE_CAP = 24; // pages kept for offline reading
const ASSET_CAP = 80; // images and other runtime assets
const RUNTIME_CAP = 40; // extra CSS/JS/fonts picked up after install

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Individually, not addAll: one missing file must not leave the site with
      // no offline shell at all.
      await Promise.allSettled(
        SHELL_URLS.map(async (url) => {
          try {
            const response = await fetch(new Request(url, { cache: 'reload' }));
            if (response.ok) await cache.put(url, response);
          } catch {
            /* offline at install time — the runtime cache will fill in later */
          }
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, PAGES, RUNTIME, ASSETS]);
      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

function bypass(url) {
  return BYPASS.some((pattern) => pattern.test(url.pathname));
}

/** Drop the oldest entries once a cache grows past its cap (insertion order). */
async function trim(cacheName, cap) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let index = 0; index < keys.length - cap; index += 1) await cache.delete(keys[index]);
}

/** Cache a response only when the server did not forbid it. */
function storable(response) {
  if (!response || !response.ok || response.type === 'opaque') return false;
  const cacheControl = response.headers.get('Cache-Control') || '';
  return !/no-store|private/i.test(cacheControl);
}

/** Network first, with a ceiling: a slow connection should get the last copy
    rather than a spinner, but a working network always wins. */
async function networkFirst(request, { cacheName, cap, fallbackUrl }) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: true });
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ]);
    if (storable(response)) {
      await cache.put(request, response.clone());
      await trim(cacheName, cap);
    }
    return response;
  } catch {
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw new Error('offline');
  }
}

/** The first cache that holds this request, in the order the caller trusts. */
async function readFromAny(request, names) {
  for (const name of names) {
    const hit = await (await caches.open(name)).match(request);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Serve from cache, refresh in the background. Assets only.
 *
 * `readFrom` matters: the shell assets live in SHELL because install put them
 * there, while anything the visitor happened to load later lives in RUNTIME.
 * Reading only the write cache would mean a visitor who opened /cars on a click
 * — and so cached the CSS into RUNTIME — was fine offline, while one who
 * installed the app and went straight out of signal got an unstyled page.
 */
async function staleWhileRevalidate(request, { cacheName, cap, readFrom = [] }) {
  const cache = await caches.open(cacheName);
  const cached = (await readFromAny(request, readFrom)) || (await cache.match(request));
  const network = fetch(request)
    .then(async (response) => {
      if (storable(response)) {
        await cache.put(request, response.clone());
        await trim(cacheName, cap);
      }
      return response;
    })
    .catch(() => null);

  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch third parties
  if (bypass(url)) return; // let the network answer for private areas

  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request, { cacheName: PAGES, cap: PAGE_CAP, fallbackUrl: '/offline' }).catch(
        async () =>
          (await caches.match('/offline')) ||
          new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title><p>You are offline and this page has not been saved on this device yet.',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          ),
      ),
    );
    return;
  }

  const isShellAsset = /^\/(css|js|fonts|icons)\//.test(url.pathname);
  if (isShellAsset) {
    // CSS, JS, fonts and icons: cache-first with a background refresh, so a
    // page opened offline is not rendered with missing styles or no JS. Writes
    // go to RUNTIME, never to SHELL — the precached shell must not be evicted by
    // whatever else the visitor happens to load — but reads check SHELL first,
    // because that is where install put the core files.
    event.respondWith(
      staleWhileRevalidate(request, { cacheName: RUNTIME, cap: RUNTIME_CAP, readFrom: [SHELL] }),
    );
    return;
  }

  if (/^\/(img|video)\//.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, { cacheName: ASSETS, cap: ASSET_CAP }));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  // The page asks the worker to hold what it is looking at right now — used
  // when a visitor saves a listing to read later.
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(PAGES);
        for (const url of data.urls.slice(0, 5)) {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (storable(response)) await cache.put(url, response);
          } catch {
            /* not reachable now; the runtime cache already has the page */
          }
        }
        await trim(PAGES, PAGE_CAP);
      })(),
    );
  }
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});
