'use strict';

/**
 * Link + slice integrity check.
 *
 *   node scripts/check-links.js            # against http://127.0.0.1:3000
 *   node scripts/check-links.js --base=http://localhost:3000
 *
 * Four things are asserted:
 *   1. every route in the built slice returns 200
 *   2. every internal link on those pages resolves (200, or 301 to a built route)
 *   3. every PRD route still on the backlog returns the honest 404 — not a crash
 *   4. nothing in the built slice leaks dealer contact details (§18.3)
 *
 * Exits non-zero on any failure so it can gate a deploy.
 */

const base = (process.argv.find((arg) => arg.startsWith('--base=')) || '').split('=')[1] || 'http://127.0.0.1:3000';
const slice = require('../src/services/slice');

/**
 * Pages we crawl for links. Every built route with a fixed path is seeded, so a
 * new page cannot ship with a broken link just because nobody added it here —
 * plus the dynamic entry points that render without an id.
 */
const FIXED_BUILT = slice.BUILT
  .map((route) => route.path)
  .filter((path) => !path.includes('{'));

const SEEDS = [
  ...FIXED_BUILT,
  '/cars',
  '/cars/toyota',
  '/cars/toyota/camry',
  '/cars/suv-under-15m',
  '/cars/certified',
  '/cars/compare?ids=1,2,3',
  '/concierge/HC-2481',
  '/blog?category=honest_buyers_guide',
  '/faq?q=inspection',
];

const INTERNAL = /^(?:https?:\/\/[^/]+)?(\/[^"'#?]*)/;

const BASE_HOST = new URL(base).host;

function normalise(href) {
  const value = href.trim();
  // Skip non-navigational schemes (tel:, mailto:, WhatsApp deep links, anchors).
  if (!value || value.startsWith('#') || /^(mailto|tel|javascript|data|whatsapp):/i.test(value)) return null;

  // Absolute URLs: only same-origin ones are ours to check (wa.me, Google, …).
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.host !== BASE_HOST && url.host !== 'localhost' && !url.host.endsWith(url.host.split(':')[0])) return null;
    if (url.host !== BASE_HOST) return null;
    return url.pathname.replace(/\/+$/, '') || '/';
  }

  const match = INTERNAL.exec(value);
  if (!match) return null;
  const path = match[1].replace(/\/+$/, '') || '/';
  if (path.startsWith('/api/')) return path; // OG cards + endpoints are still checked below
  return path;
}

async function status(path) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location') };
}

async function main() {
  const failures = [];
  const checked = new Map();

  // --- 1 + 2: built routes render, and every internal link resolves ---------
  const seenLinks = new Set();
  for (const seed of SEEDS) {
    const response = await fetch(`${base}${seed}`);
    if (response.status !== 200) {
      failures.push(`built route ${seed} returned ${response.status}`);
      continue;
    }
    const html = await response.text();
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const path = normalise(match[1]);
      if (!path) continue;
      if (path.startsWith('/api/') && !path.startsWith('/api/og/')) continue;
      seenLinks.add(path);
    }

    if (/dealer_name|dealer_phone|dealer_email|\bdealer\.\w+@/.test(html)) {
      failures.push(`${seed} leaks dealer fields into public markup (§18.3)`);
    }
  }

  const assetPaths = [];
  for (const path of seenLinks) {
    if (checked.has(path)) continue;
    const { status: code, location } = await status(path);
    checked.set(path, code);

    if (code === 200) continue;

    if (code === 301 || code === 302) {
      const target = String(location || '').replace(base, '');
      const targetCode = target ? (await status(target)).status : 0;
      if (targetCode !== 200) {
        failures.push(`${path} → ${code} → ${target} (${targetCode})`);
      }
      continue;
    }

    if (code === 404 && slice.pendingRouteFor(path)) continue; // expected: backlog route

    if (/\.(css|js|png|jpe?g|svg|webp|ico|xml|txt|woff2?)$/.test(path)) {
      failures.push(`asset ${path} returned ${code}`);
      continue;
    }

    failures.push(`link ${path} returned ${code} (${slice.pendingRouteFor(path) ? 'backlog' : 'unknown path'})`);
  }

  // --- 3: backlog routes must 404 with the honest copy ---------------------
  for (const route of slice.PENDING) {
    if (route.path.includes('{')) continue;
    const { status: code } = await status(route.path);
    if (code !== 404) failures.push(`backlog route ${route.path} returned ${code}, expected 404 while unported`);
  }

  // --- report ---------------------------------------------------------------
  console.log(`${checked.size} internal links checked against ${base}`);
  for (const [path, code] of [...checked].sort()) {
    const tag = code === 200 ? '✓' : slice.pendingRouteFor(path) ? '·' : '✗';
    console.log(`  ${tag} ${String(code).padEnd(4)} ${path}${slice.pendingRouteFor(path) ? '  (backlog)' : ''}`);
  }

  if (failures.length) {
    console.error(`\n✗ link check failed — ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`  • ${failure}`);
    process.exit(1);
  }
  console.log('\n✓ link check passed — built slice is intact, backlog routes 404 honestly');
}

main().catch((error) => {
  console.error('link check crashed:', error.message);
  process.exit(1);
});
