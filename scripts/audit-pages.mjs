'use strict';

/**
 * Page audit — the checks that are easy to break and expensive to notice:
 * exactly one <h1>, a title and meta description inside the §14 budgets, a
 * canonical on indexable pages, parseable JSON-LD, alt text on every image,
 * no unrendered EJS and no "undefined" leaking into the markup.
 *
 *   npm run audit:pages              (against http://127.0.0.1:3000)
 *   npm run audit:pages -- http://host:port
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TITLE_MAX = 64; // §14.3 SERP budget
const DESC_MAX = 158;

const paths = new Set(['/', '/cars', '/cars/toyota', '/cars/suv-under-15m', '/cars/compare', '/login?next=%2Faccount', '/cart', '/checkout']);
const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  paths.add(new URL(match[1]).pathname.replace(/\/$/, '') || '/');
}

/** HTML entities decoded, so budgets measure the text a search engine sees. */
function decode(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

const findings = [];
const check = (path, ok, message) => {
  if (!ok) findings.push(`${path}: ${message}`);
};

for (const path of [...paths].sort()) {
  const response = await fetch(BASE + path, { redirect: 'manual' });
  const html = await response.text();
  if (response.status !== 200 || !html.includes('<html')) {
    check(path, false, `status ${response.status}`);
    continue;
  }

  check(path, [...html.matchAll(/<h1[^>]*>/g)].length === 1, `${[...html.matchAll(/<h1[^>]*>/g)].length} <h1> elements`);
  check(path, !html.includes('<%'), 'unrendered EJS');
  check(path, !/\bundefined\b/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'the word "undefined" appears in the markup');

  const title = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '');
  check(path, title.length > 0 && title.length <= TITLE_MAX, `title is ${title.length} chars`);
  const description = decode((html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '');
  check(path, description.length > 0 && description.length <= DESC_MAX, `meta description is ${description.length} chars`);

  const privatePage = /name="robots"[^>]*noindex/.test(html);
  if (!privatePage) check(path, /<link rel="canonical"/.test(html), 'no canonical on an indexable page');

  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      JSON.parse(match[1]);
    } catch {
      check(path, false, 'invalid JSON-LD');
    }
  }
  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/alt=/.test(match[0])) check(path, false, 'image without alt');
  }
}

console.log(`${paths.size} pages audited`);
for (const finding of findings) console.log(`  • ${finding}`);
console.log(findings.length ? `\n✗ ${findings.length} finding(s)` : '\n✓ 0 findings');
if (findings.length) process.exitCode = 1;
