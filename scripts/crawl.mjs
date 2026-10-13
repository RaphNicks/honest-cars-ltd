'use strict';

/**
 * Crawl every internal link the site exposes and report the status of each.
 *
 *   npm run crawl              (against http://127.0.0.1:3000)
 *   npm run crawl -- http://host:port
 *
 * Sources: the homepage, then every page reachable from it, then the URLs in
 * sitemap.xml so nothing only-linked-from-nowhere is missed. Signed-out only —
 * /account and the console redirect to /login, which is the correct answer for
 * an anonymous crawler and is reported as such.
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const SKIP = /\.(png|jpe?g|svg|webp|ico|woff2?|avif)$/i;
const MAX_PAGES = 400;

const seen = new Map();
const queue = ['/'];

async function statusOf(path) {
  const response = await fetch(BASE + path, { redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location') };
}

function linksFrom(html) {
  const out = new Set();
  for (const match of html.matchAll(/href="([^"#?]+)"/g)) {
    let href = match[1];
    if (!href.startsWith('/')) continue;
    if (SKIP.test(href) || href.startsWith('/og/') || href.startsWith('/fonts/')) continue;
    if (href.length > 1) href = href.replace(/\/$/, '');
    out.add(href);
  }
  return out;
}

while (queue.length && seen.size < MAX_PAGES) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  const { status, location } = await statusOf(path);
  seen.set(path, { status, location });
  if (status !== 200) continue;
  const html = await (await fetch(BASE + path)).text();
  if (!html.includes('<html')) continue;
  for (const href of linksFrom(html)) if (!seen.has(href)) queue.push(href);
}

const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  // The sitemap holds absolute URLs on the configured SITE_URL; take the path.
  const path = new URL(match[1]).pathname.replace(/\/$/, '') || '/';
  if (!seen.has(path)) seen.set(path, await statusOf(path));
}

const rows = [...seen].sort(([a], [b]) => a.localeCompare(b));
const bad = rows.filter(([, info]) => info.status >= 400);
const redirects = rows.filter(([, info]) => info.status === 301 || info.status === 302);

for (const [path, info] of rows) {
  const tag = info.status === 200 ? '✓' : info.status < 400 ? '·' : '✗';
  console.log(`${tag} ${String(info.status).padEnd(4)} ${path}${info.location ? ` → ${info.location}` : ''}`);
}
console.log(`\n${rows.length} URLs · ${rows.filter(([, i]) => i.status === 200).length} × 200 · ${redirects.length} redirect · ${bad.length} broken`);
if (bad.length) process.exitCode = 1;
