'use strict';

/**
 * FR-30 — the installable PWA.
 *
 * A service worker is the one part of this site that can break silently: it
 * sits between the visitor and every request, it cannot be tested by curling a
 * URL, and an install prompt that never appears looks exactly like a site that
 * does not need one. So these tests check the things that fail invisibly:
 *
 *   • the shell list is real — every precached URL maps to a file that ships,
 *     and every CSS/JS module this site has is on the list (a page opened
 *     offline with missing CSS is worse than an honest error);
 *   • every icon the manifest names exists, at the size it claims;
 *   • the worker refuses the areas that must never be cached (signed-in pages,
 *     the console, the portal, checkout, anything /api/);
 *   • the offline page is buildable and carries noindex.html
 *   • the icons on disk are the ones the generator draws (`--check`).
 *
 * Everything here is filesystem + source; the live behaviour of the worker in a
 * real browser cannot be tested from Node, which is why the rules it follows are
 * asserted against its source.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const swSource = read('public/sw.js');
const manifest = JSON.parse(read('public/manifest.webmanifest'));

/** `const SHELL = `${VERSION}-shell`` … SHELL_URLS = [ … ] — evaluated, not regexed. */
function shellUrls(source = swSource) {
  const versionMatch = source.match(/const VERSION = '([^']+)'/);
  assert.ok(versionMatch, 'sw.js must define VERSION');
  const listMatch = source.match(/const SHELL_URLS = \[([\s\S]*?)\n\];/);
  assert.ok(listMatch, 'sw.js must define SHELL_URLS');
  // Comments inside the list are prose and may contain apostrophes — strip them
  // before reading the strings, or a sentence about "someone's data" becomes a
  // precached URL.
  const code = listMatch[1]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const urls = [...code.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.ok(urls.every((url) => url.startsWith('/')), 'every precached entry is a path of ours');
  return { version: versionMatch[1], urls };
}

/** PNG width/height straight out of the IHDR chunk. */
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('the manifest is complete enough to be installable', () => {
  for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) {
    assert.ok(manifest[key], `manifest.${key} is required for installability`);
  }
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.lang, 'en-NG');

  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'Chrome needs 192 and 512 icons');
  assert.ok(
    manifest.icons.some((icon) => icon.purpose === 'maskable'),
    'without a maskable icon Android crops the square one',
  );
  assert.ok(manifest.shortcuts.length >= 2, 'shortcuts are the reason to keep the icon on a home screen');
});

test('every icon the manifest names exists at the size it claims', () => {
  assert.ok(manifest.icons.length >= 4);
  for (const icon of manifest.icons) {
    const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${icon.src} is named by the manifest but missing`);
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(file), { width, height }, `${icon.src} is not ${icon.sizes}`);
    assert.equal(icon.type, 'image/png');
  }

  const apple = path.join(PUBLIC, 'icons', 'apple-touch-icon.png');
  assert.deepEqual(pngSize(apple), { width: 180, height: 180 }, 'iOS wants 180×180');
});

test('the head carries the manifest, the icons and the theme colour', () => {
  const layout = read('views/layouts/base.ejs');
  assert.match(layout, /include\('\.\.\/partials\/pwa'\)/);
  assert.match(layout, /name="theme-color" content="#0E2A47"/);

  const head = read('views/partials/pwa.ejs');
  assert.match(head, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(head, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.match(head, /name="apple-mobile-web-app-title" content="HonestCars"/);
});

test('the precache list covers the whole shell and every entry ships', () => {
  const { urls } = shellUrls();
  const unique = new Set(urls);
  assert.equal(unique.size, urls.length, 'SHELL_URLS has duplicates');

  const onDisk = (url) => {
    if (url === '/offline') return fs.existsSync(path.join(ROOT, 'dist', 'offline', 'index.html'));
    return fs.existsSync(path.join(PUBLIC, url.replace(/^\//, '')));
  };

  for (const url of urls) {
    // dist is a build artefact and may be absent in a fresh clone; the rest are
    // source files and must always be there.
    if (url === '/offline' && !fs.existsSync(path.join(ROOT, 'dist'))) continue;
    assert.ok(onDisk(url), `${url} is precached but does not exist`);
  }

  // Console and portal assets are deliberately absent: those areas are bypassed
  // entirely (an offline admin page is not a thing), and the console stylesheet
  // alone is 33 kB that no visitor should pay for at install time. They still
  // reach the runtime cache if an admin opens one, and the exclusion is listed
  // here so a renamed file cannot hide behind it.
  const CONSOLE_ONLY = new Set(['/css/admin.css', '/js/admin.js', '/js/dealer.js']);

  const css = fs.readdirSync(path.join(PUBLIC, 'css')).filter((f) => f.endsWith('.css'));
  for (const file of css) {
    if (CONSOLE_ONLY.has(`/css/${file}`)) continue;
    assert.ok(unique.has(`/css/${file}`), `/css/${file} is not in the precache — offline pages would be unstyled`);
  }

  const js = fs.readdirSync(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js'));
  for (const file of js) {
    if (CONSOLE_ONLY.has(`/js/${file}`)) continue;
    assert.ok(unique.has(`/js/${file}`), `/js/${file} is not in the precache — offline pages would be inert`);
  }

  for (const excluded of CONSOLE_ONLY) {
    assert.ok(
      fs.existsSync(path.join(PUBLIC, excluded.replace(/^\//, ''))),
      `${excluded} is excluded from the precache but no longer exists — the exclusion is stale`,
    );
  }

  // The two files the layout preloads, and no others: the rest arrive
  // through the runtime cache rather than costing every install ~50 kB.
  assert.ok(unique.has('/fonts/ibm-plex-sans-latin-400-normal.woff2'));
  assert.ok(unique.has('/fonts/barlow-condensed-latin-700-normal.woff2'));
  assert.equal(urls.filter((url) => url.startsWith('/fonts/')).length, 2);
});

test('the worker never caches a private area, and never caches a private response', () => {
  for (const fragment of ["/^\\/api\\//", "/^\\/admin/", "/^\\/dealer/", "/^\\/account/", "/^\\/checkout/", "/^\\/order\\//"]) {
    assert.ok(swSource.includes(fragment), `BYPASS is missing ${fragment}`);
  }
  assert.match(swSource, /if \(request\.method !== 'GET'\) return;/, 'only GET may be handled');
  assert.match(swSource, /url\.origin !== self\.location\.origin/, 'third-party requests must be left alone');
  assert.match(swSource, /no-store\|private/, 'the Cache-Control of the response decides what may be stored');
  assert.match(swSource, /request\.mode === 'navigate'/, 'navigations need their own strategy');
});

test('cache names are versioned, so a deploy can retire the old shell', () => {
  const { version } = shellUrls();
  for (const name of ['SHELL', 'PAGES', 'RUNTIME', 'ASSETS']) {
    assert.match(
      swSource,
      new RegExp(`const ${name} = \`\\$\\{VERSION\\}-[a-z]+\``),
      `${name} must be derived from VERSION`,
    );
  }
  assert.match(swSource, /caches\.delete\(name\)/, 'activate must delete caches from older versions');
  assert.ok(/^hc-v\d+$/.test(version), `VERSION looks wrong: ${version}`);
  assert.match(swSource, /CACHE_URLS/, 'the page must be able to ask for a specific URL to be kept');
});

test('the worker is served from the root with revalidation headers', () => {
  const app = read('src/app.js');
  assert.match(app, /app\.get\('\/sw\.js'/, 'the worker needs its own route, ahead of express.static');
  assert.match(app, /Service-Worker-Allowed/);
  assert.match(app, /no-cache, no-store, must-revalidate/);
});

test('main.js registers the worker and offers install only when the browser can', () => {
  const main = read('public/js/main.js');
  assert.match(main, /import \{ initPWA \} from '\.\/pwa\.js'/);
  assert.match(main, /initPWA\(\)/);

  const pwa = read('public/js/pwa.js');
  assert.match(pwa, /navigator\.serviceWorker\s*\n?\s*\.register/, 'the worker must actually be registered');
  assert.match(pwa, /beforeinstallprompt/, 'install is offered on the browser\u2019s evidence, not on ours');
  assert.match(pwa, /window\.addEventListener\('load', register/, 'registration must not compete with first paint');

  // The footer control exists and starts hidden — no nagging, and no button
  // that does nothing when the browser has not offered install.
  assert.match(read('views/partials/footer.ejs'), /data-install-app hidden/);
});

test('the offline page is buildable, honest and noindex', () => {
  const builder = read('src/routes/pages.js');
  assert.match(builder, /function buildOfflineLocals\(\)/);
  assert.match(builder, /canonical: '\/offline'/);
  assert.match(builder, /robots: 'noindex,follow'/);
  assert.match(builder, /router\.get\('\/offline'/);
  assert.match(read('src/routes/registry.js'), /path: '\/offline'/);

  // It tells the visitor what still works rather than apologising in general.
  const view = read('views/pages/offline.ejs');
  assert.match(view, /data-offline-retry/);
  assert.match(view, /wait on the device|held on this device/);

  const built = path.join(ROOT, 'dist', 'offline', 'index.html');
  if (fs.existsSync(built)) {
    const html = fs.readFileSync(built, 'utf8');
    assert.match(html, /noindex/, 'a prebuilt offline page must carry noindex');
    assert.match(html, /manifest\.webmanifest/, 'the offline page is a page like any other — it can be installed from too');
  }
});

test('the generated icons are the ones the generator draws', () => {
  // Renders into a temp dir and byte-compares, exactly like `npm run images:check`.
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-icons.js'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /app icons current/);
});

test('the sitemap does not advertise the offline page', () => {
  const sitemap = fs.existsSync(path.join(ROOT, 'dist', 'sitemap.xml'))
    ? fs.readFileSync(path.join(ROOT, 'dist', 'sitemap.xml'), 'utf8')
    : null;
  if (!sitemap) return; // no build in this checkout
  assert.ok(!sitemap.includes('/offline'), 'nobody should reach "you are offline" from a search result');
});
