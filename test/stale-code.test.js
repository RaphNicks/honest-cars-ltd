'use strict';

/**
 * A pull is not a deploy: the code on disk is newer than the code that is
 * running, and newer than the pages that were built from it.
 *
 * This suite exists because a reader hit exactly that, and saw it as a broken
 * feature: the city picker's panel came up empty and a search box answered "no
 * city matches" for every city in Nigeria. The cause was not the picker. The
 * server process had been started before the pull, so Express was rendering the
 * new `views/` with modules from the previous release in memory — `site
 * .cityDirectory` did not exist yet, the panel fell back to a markets list whose
 * rows carry a different shape, and every market row was filtered out.
 *
 * Three promises, one per layer of that story:
 *
 *   • **A partial must degrade, never break.** Rendered with locals that predate
 *     it, the switcher still lists the markets it can see and does not draw a
 *     search box over a list of four — a control that can only answer "no match"
 *     is worse than no control.
 *   • **A build older than the code must not be served.** `git pull` does not
 *     rebuild `dist/`, so the server works out at boot whether the files on disk
 *     predate the source and renders per request instead — visibly, with
 *     `X-HonestCars-Stale-Build: build-older-than-code`.
 *   • **Scripts and styles must not outlive a deploy.** The worker is
 *     network-first for `.js` and `.css`, because cache-first shell assets are
 *     how a fresh page ends up running last release's modules.
 */

// Before `./helpers`, which points STATIC_DIR at the test build: this suite
// wants a directory of its own to write fixture builds into.
process.env.TEST_STATIC_DIR = '.test-static/stale-code';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const { ROOT } = require('./helpers');

const VIEWS = path.join(ROOT, 'views');

/**
 * This suite is not about the database, but booting the real app opens the MySQL
 * pool — the redirect middleware queries on the first request — and a pool left
 * open keeps the process alive for ever. `node --test` then hangs on a suite
 * whose assertions all passed, which is a miserable thing to debug: close it.
 */
test.after(async () => {
  await require('../src/db').pool.end().catch(() => {});
});

/** The markets list as `db.areas.cities()` returns it — no `served` flag. */
const MARKETS = [
  { id: 1, slug: 'port-harcourt', name: 'Port Harcourt', state: 'Rivers', stockKey: 'HC-PH', position: 10, active: true, live: 43, cars: 47 },
  { id: 2, slug: 'owerri', name: 'Owerri', state: 'Imo', stockKey: 'HC-OW', position: 20, active: true, live: 7, cars: 8 },
  { id: 3, slug: 'aba', name: 'Aba', state: 'Abia', stockKey: 'HC-AB', position: 30, active: true, live: 6, cars: 6 },
  { id: 4, slug: 'benin-city', name: 'Benin City', state: 'Edo', stockKey: 'HC-BN', position: 40, active: true, live: 4, cars: 5 },
];

/** The catalogue as `city-directory.directory()` returns it: markets + the rest. */
const CATALOGUE = [
  { slug: 'port-harcourt', name: 'Port Harcourt', state: 'Rivers', stateLabel: 'Rivers State', live: 43, served: true },
  { slug: 'owerri', name: 'Owerri', state: 'Imo', stateLabel: 'Imo State', live: 7, served: true },
  { slug: 'aba', name: 'Aba', state: 'Abia', stateLabel: 'Abia State', live: 6, served: true },
  { slug: 'benin-city', name: 'Benin City', state: 'Edo', stateLabel: 'Edo State', live: 4, served: true },
  { slug: 'lagos', name: 'Lagos', state: 'Lagos', stateLabel: 'Lagos State', live: 0, served: false },
  { slug: 'kano', name: 'Kano', state: 'Kano', stateLabel: 'Kano State', live: 0, served: false },
];

/**
 * Render a partial the way Express does — synchronously, with the filename set so
 * a relative `<%- include('./other') %>` resolves the same way it does in a page.
 */
function renderPartial(name, locals) {
  const file = path.join(VIEWS, 'partials', name);
  return ejs.render(fs.readFileSync(file, 'utf8'), locals, { filename: file });
}

// ---------------------------------------------------------------------------
// The partial: old locals, still a working panel
// ---------------------------------------------------------------------------

test('a switcher rendered with locals from before the picker still lists the markets', () => {
  const html = renderPartial('area-switcher.ejs', {
    site: { cities: MARKETS }, // the previous release's locals: no cityDirectory
    helpers: { icon: () => '<svg></svg>' },
    variant: 'header',
  });

  // The markets are the whole list, and they are real links.
  for (const market of MARKETS) {
    assert.ok(html.includes(`href="/cars?city=${market.slug}"`), `${market.name} is still a link`);
    assert.ok(html.includes(`>${market.name}<`), `${market.name} is still named`);
  }
  assert.match(html, /data-area-option="all"/, '“All cities” is still the reset');
  assert.match(html, /class="count">60/, '“All cities” still totals the network (43 + 7 + 6 + 4)');
  assert.match(html, /class="count">43/, 'and each market keeps its own count');

  // And no search box: a box over four cities that cannot search the country is
  // the broken control the reader was looking at.
  assert.doesNotMatch(html, /data-area-search/, 'no search box when there is nothing to search');
  assert.doesNotMatch(html, /data-area-item-template/, 'and no template for cities that cannot arrive');
});

test('the catalogue island is skipped, not empty, when the catalogue is missing', () => {
  const html = renderPartial('city-index.ejs', { site: { cities: MARKETS } });
  assert.doesNotMatch(html, /data-city-index/, 'no island to parse');

  const withCatalogue = renderPartial('city-index.ejs', { site: { cityDirectory: CATALOGUE } });
  assert.match(withCatalogue, /data-city-index/);
  assert.match(withCatalogue, /"slug":"kano"/, 'the whole country rides along');
  assert.match(withCatalogue, /\\u003c|\"slug\"/, 'and a payload with no bare “<” in it');
});

test('the current locals draw the whole country, with the search box', () => {
  const html = renderPartial('area-switcher.ejs', {
    site: { cities: MARKETS, cityDirectory: CATALOGUE },
    helpers: { icon: () => '<svg></svg>' },
    variant: 'header',
  });

  assert.match(html, /placeholder="Search 6 cities"/, 'the box counts what it can actually search');
  assert.match(html, /data-area-search/);
  assert.match(html, /data-area-item-template/);
  // Only the markets are server-rendered; the rest arrive from the island.
  assert.ok(html.includes('href="/cars?city=port-harcourt"'));
  assert.ok(!html.includes('href="/cars?city=kano"'), 'a city with no stock is not markup — it is data');
});

// ---------------------------------------------------------------------------
// The build: older than the code it was built from
// ---------------------------------------------------------------------------

const FIXTURE_PAGE = '/contact';
const FIXTURE_HTML = '<!doctype html><html><body><p id="fixture">A prebuilt page.</p></body></html>';

/** Write a one-page build into the test static dir, dated as asked. */
function fixtureBuild({ generatedAt }) {
  const dir = require('../src/config').features.staticPath;
  const file = path.join(dir, FIXTURE_PAGE.replace(/^\//, ''), 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, FIXTURE_HTML);
  fs.writeFileSync(
    path.join(dir, '.static-manifest.json'),
    JSON.stringify({
      generatedAt,
      routeCount: 1,
      bytes: Buffer.byteLength(FIXTURE_HTML),
      routes: [{ path: FIXTURE_PAGE, view: 'contact', hash: 'fixture', bytes: Buffer.byteLength(FIXTURE_HTML), renderedAt: generatedAt }],
    }),
  );
  return dir;
}

/** Boot the real app on an ephemeral port, so `locals` can be inspected. */
async function bootApp() {
  const { createApp } = require('../src/app');
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        app,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('a build older than the code is not served, and says why', async (t) => {
  const past = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // six hours old
  const dir = fixtureBuild({ generatedAt: past });

  // The source walk is the whole mechanism: it must find files, and the newest
  // must beat a build dated six hours ago.
  const render = require('../src/lib/render');
  const newest = render.newestSourceTime(ROOT);
  assert.ok(newest && newest > new Date(past).getTime(), 'the checkout is newer than the fixture build');

  const ctx = await bootApp();
  try {
    assert.deepEqual(ctx.app.locals.staticBuild, {
      generatedAt: past,
      routeCount: 1,
      stale: ctx.app.locals.staticBuild.stale,
    });
    assert.ok(ctx.app.locals.staticBuild.stale, 'the app knows the build is out of date');

    const response = await fetch(`${ctx.baseUrl}${FIXTURE_PAGE}`);
    assert.notEqual(await response.text(), FIXTURE_HTML, 'the prebuilt file is not served');
    assert.equal(response.headers.get('x-honestcars-stale-build'), 'build-older-than-code');
    assert.equal(response.headers.get('x-honestcars-render'), 'dynamic');
  } finally {
    await ctx.close();
  }

  // A rebuild makes the same file valid again — the rule is a comparison, not a
  // flag that latches on.
  fixtureBuild({ generatedAt: new Date(Date.now() + 60_000).toISOString() });
  const fresh = await bootApp();
  try {
    assert.equal(fresh.app.locals.staticBuild.stale, null, 'a build newer than the code is fine');
    const response = await fetch(`${fresh.baseUrl}${FIXTURE_PAGE}`);
    assert.equal(await response.text(), FIXTURE_HTML, 'and it is served from disk');
    assert.equal(response.headers.get('x-honestcars-render'), 'static');
    assert.equal(response.headers.get('x-honestcars-stale-build'), null);
  } finally {
    await fresh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the walk ignores what a build does not read, and survives a missing tree', () => {
  const render = require('../src/lib/render');
  assert.equal(render.newestSourceTime('/nonexistent-root'), null, 'no tree, no signal');
  assert.equal(render.newestSourceTime(ROOT, ['views/not-a-directory']), null);

  // Only the directories a build reads are walked: a touched file elsewhere is
  // not a reason to stop serving 74 prebuilt pages.
  const only = render.newestSourceTime(ROOT, ['public/js']);
  const every = render.newestSourceTime(ROOT);
  assert.ok(only && every && every >= only);
});

// ---------------------------------------------------------------------------
// The worker: a fresh page must not run last release's modules
// ---------------------------------------------------------------------------

test('scripts and styles are network-first, so a deploy cannot be outrun by the cache', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const version = (source.match(/const VERSION = 'hc-v(\d+)'/) || [])[1];
  assert.ok(version && Number(version) >= 5, `scripts and styles became network-first in v5, found v${version}`);

  // The branch that decides between the two strategies.
  const branch = source.slice(source.indexOf('const isScriptOrStyle'), source.indexOf("self.addEventListener('message'"));
  assert.match(branch, /isScriptOrStyle\)\s*\{[\s\S]*?networkFirst\(request/, '.js and .css go to the network first');
  assert.match(branch, /isShellAsset\)\s*\{[\s\S]*?staleWhileRevalidate\(request/, 'fonts and icons keep the cheaper bargain');

  // Network-first has to be able to fall back to what install precached, or a
  // page opened offline loses its styles and its modules.
  assert.match(source, /async function networkFirst\(request, \{ cacheName, cap, fallbackUrl, readFrom = \[\] \}\)/);
  assert.match(source, /readFrom: \[SHELL\]/, 'reads check the precached shell');
  assert.match(source, /request\.mode === 'navigate'/, 'navigations keep their own strategy');
  assert.match(source, /self\.addEventListener\('fetch'/, 'and the worker still handles fetches');
});

test('a new worker takes over, instead of waiting for every tab to close', () => {
  const swSource = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const pwaSource = fs.readFileSync(path.join(ROOT, 'public/js/pwa.js'), 'utf8');

  // The worker accepts the request...
  assert.match(swSource, /SKIP_WAITING'\) self\.skipWaiting\(\)/, 'the message has a handler');
  // ...and the page makes it. Without a sender, a worker installs and then waits
  // for every controlled tab to close — which is how a browser runs last
  // release's modules for days while showing fresh HTML.
  assert.match(pwaSource, /postMessage\(\{ type: 'SKIP_WAITING' \}\)/, 'the page asks the waiting worker to take over');
  assert.match(pwaSource, /if \(registration\.waiting\) \{/, 'including a worker that was already waiting at load');

  // Taking over is not a reload: the reader keeps the page they are on. (The
  // one reload in this file is the /offline retry button, which is a person
  // pressing a button — so the check is scoped to the update path.)
  const updatePath = pwaSource.slice(pwaSource.indexOf('function watchForUpdates'), pwaSource.indexOf('function initInstallPrompt'));
  assert.doesNotMatch(updatePath, /location\.reload\(\)/, 'a page is never reloaded underneath the reader');
  // And the toast still tells them what will happen.
  assert.match(pwaSource, /newer version of HonestCars is ready/);
});

test('hydration is lazy but the panel never depends on it being possible', () => {
  const areaSource = fs.readFileSync(path.join(ROOT, 'public/js/area.js'), 'utf8');
  // The catalogue costs nothing until the panel is opened...
  assert.match(areaSource, /let hydrated = false;/);
  assert.match(areaSource, /if \(hydrated \|\| !list \|\| !index\.length\) return;/);
  // ...and every path through the module leaves the server-rendered links alone
  // when there is no island to read. That is the difference between a picker
  // that degrades to four markets and one that renders an empty panel.
  assert.match(areaSource, /function readIndex\(\)[\s\S]*?catch \(error\) \{[\s\S]*?return \[\];/);
});
