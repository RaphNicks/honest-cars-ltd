'use strict';

/**
 * XML sitemap + robots (§12.4: "XML sitemap auto-regenerating on listing
 * changes; robots directives sane").
 *
 * Only URLs that are themselves indexable go in: live/reserved listings, the
 * 7→90 day sold archive, curated facets and stable public pages. Raw filter
 * combinations are excluded on purpose — they carry noindex.
 */

const config = require('../config');

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry({ loc, lastmod, changefreq, priority }) {
  return [
    '  <url>',
    `    <loc>${esc(loc)}</loc>`,
    lastmod ? `    <lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : null,
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : null,
    priority ? `    <priority>${priority}</priority>` : null,
    '  </url>',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the full sitemap XML.
 * @param {object} db the data-access module
 * @param {object} [options]
 */
async function buildSitemap(db, { siteUrl = config.siteUrl } = {}) {
  const [listings, facets] = await Promise.all([
    db.listings.allIndexableSlugs(),
    db.facets.allIndexable(),
  ]);

  const entries = [];

  // Stable pages (§5.1 sitemap): only indexable URLs.
  entries.push(urlEntry({ loc: `${siteUrl}/`, changefreq: 'daily', priority: '1.0' }));
  entries.push(urlEntry({ loc: `${siteUrl}/cars`, changefreq: 'hourly', priority: '0.9' }));

  // §6.7 services hub + the nine service pages (car hire lives at /hire).
  entries.push(urlEntry({ loc: `${siteUrl}/services`, changefreq: 'weekly', priority: '0.8' }));
  const [services, pages] = await Promise.all([
    db.content.serviceSuite().catch(() => []),
    db.content.allPages().catch(() => []),
  ]);
  for (const service of services) {
    if (service.slug === 'hire') continue;
    entries.push(urlEntry({ loc: `${siteUrl}/services/${service.slug}`, changefreq: 'monthly', priority: '0.7' }));
  }

  // Funnels and company pages.
  entries.push(urlEntry({ loc: `${siteUrl}/find-my-car`, changefreq: 'monthly', priority: '0.9' }));
  entries.push(urlEntry({ loc: `${siteUrl}/sell-swap`, changefreq: 'monthly', priority: '0.8' }));
  entries.push(urlEntry({ loc: `${siteUrl}/hire`, changefreq: 'monthly', priority: '0.7' }));
  // FR-34 — the financing page is real content (what we do, what we refuse to
  // claim, the questions people ask), not a form bolted to a nav item.
  entries.push(urlEntry({ loc: `${siteUrl}/financing`, changefreq: 'monthly', priority: '0.7' }));
  entries.push(urlEntry({ loc: `${siteUrl}/verification`, changefreq: 'monthly', priority: '0.8' }));
  entries.push(urlEntry({ loc: `${siteUrl}/how-it-works`, changefreq: 'monthly', priority: '0.7' }));
  entries.push(urlEntry({ loc: `${siteUrl}/about`, changefreq: 'monthly', priority: '0.6' }));
  entries.push(urlEntry({ loc: `${siteUrl}/faq`, changefreq: 'monthly', priority: '0.6' }));
  entries.push(urlEntry({ loc: `${siteUrl}/contact`, changefreq: 'monthly', priority: '0.6' }));
  entries.push(urlEntry({ loc: `${siteUrl}/partner`, changefreq: 'monthly', priority: '0.7' }));
  entries.push(urlEntry({ loc: `${siteUrl}/guide`, changefreq: 'weekly', priority: '0.7' }));
  entries.push(urlEntry({ loc: `${siteUrl}/blog`, changefreq: 'daily', priority: '0.8' }));

  // §6.8 shop + products.
  entries.push(urlEntry({ loc: `${siteUrl}/shop`, changefreq: 'weekly', priority: '0.6' }));
  const products = await db.content.products().catch(() => []);
  for (const product of products) {
    entries.push(urlEntry({ loc: `${siteUrl}${product.url}`, changefreq: 'weekly', priority: '0.5' }));
  }

  // Blog posts — the organic-growth engine.
  const feed = await db.content.blogIndex({ page: 1, perPage: 100 }).catch(() => ({ posts: [] }));
  for (const post of feed.posts) {
    entries.push(
      urlEntry({
        loc: `${siteUrl}${post.url}`,
        lastmod: post.updatedAt || post.publishedAt,
        changefreq: 'monthly',
        priority: '0.6',
      }),
    );
  }

  // FR-35 — author pages and tag pages. Only shelves with a published post
  // ship: an empty author page is a thin page and Google says so.
  const [authors, tags] = await Promise.all([
    db.content.authorsWithCounts({ limit: 24 }).catch(() => []),
    db.content.blogTags({ limit: 40 }).catch(() => []),
  ]);
  for (const author of authors) {
    if (!author.count) continue;
    entries.push(urlEntry({ loc: `${siteUrl}${author.url}`, changefreq: 'monthly', priority: '0.4' }));
  }
  for (const tag of tags) {
    if (!tag.count) continue;
    entries.push(urlEntry({ loc: `${siteUrl}${tag.url}`, changefreq: 'weekly', priority: '0.5' }));
  }

  // CMS pages that are cleared for indexing. Legal pages stay out until
  // counsel's wording replaces the placeholder text (pages.indexable = 0).
  for (const page of pages) {
    if (!page.indexable) continue;
    if (['about', 'how-it-works', 'contact'].includes(page.slug)) continue; // already added above
    entries.push(
      urlEntry({
        loc: `${siteUrl}/${page.slug}`,
        lastmod: page.updatedAt,
        changefreq: 'monthly',
        priority: '0.5',
      }),
    );
  }

  // Curated facets only (§14.1)
  for (const facet of facets) {
    entries.push(
      urlEntry({
        loc: `${siteUrl}${facet.canonicalPath}`,
        changefreq: 'daily',
        // A city page is a whole market's front door (FR-32) — as important
        // to a crawler as a make page, and more important than a budget cut.
        priority: ['make', 'city'].includes(facet.pageType) ? '0.8' : '0.7',
      }),
    );
  }

  // Listings. A sold car keeps its live URL for the first few days (§6.2), so
  // the sitemap must point there — advertising /cars/sold/{slug} while the
  // archive page does not exist yet would send crawlers to a 404. Only inside
  // the archive window does the sold URL exist.
  const visibleMs = config.soldArchive.visibleDays * 86_400_000;
  for (const listing of listings) {
    const soldAt = listing.sold_at ? new Date(listing.sold_at).getTime() : null;
    const archived = listing.status === 'sold' && soldAt !== null && Date.now() - soldAt > visibleMs;
    entries.push(
      urlEntry({
        loc: `${siteUrl}/cars/${archived ? 'sold/' : ''}${listing.seo_slug}`,
        lastmod: listing.updated_at || listing.published_at,
        changefreq: listing.status === 'sold' ? 'monthly' : 'daily',
        priority: listing.status === 'sold' ? '0.4' : '0.7',
      }),
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
}

/** robots.txt — sane defaults, nothing clever (§12.4). */
function buildRobots({ siteUrl = config.siteUrl } = {}) {
  return `# honestcarsltd.com
User-agent: *
Allow: /

# Raw filter combinations and search results are noindex, but keep crawlers
# out of them entirely so crawl budget goes to inventory and facets (§14.1).
Disallow: /cars?*
Disallow: /cars/*?*
Disallow: /api/
Disallow: /account
Disallow: /dealer
Disallow: /admin

Sitemap: ${siteUrl}/sitemap.xml
`;
}

module.exports = { buildSitemap, buildRobots, urlEntry };
