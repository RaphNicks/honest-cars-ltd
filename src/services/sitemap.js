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

  // Stable pages — extended as the remaining routes are ported.
  entries.push(urlEntry({ loc: `${siteUrl}/`, changefreq: 'daily', priority: '1.0' }));
  entries.push(urlEntry({ loc: `${siteUrl}/cars`, changefreq: 'hourly', priority: '0.9' }));

  // Curated facets only (§14.1)
  for (const facet of facets) {
    entries.push(
      urlEntry({
        loc: `${siteUrl}${facet.canonicalPath}`,
        changefreq: 'daily',
        priority: facet.pageType === 'make' ? '0.8' : '0.7',
      }),
    );
  }

  // Listings — live and reserved index their VDP; sold ≤90 days index the archive.
  for (const listing of listings) {
    const sold = listing.status === 'sold';
    entries.push(
      urlEntry({
        loc: sold ? `${siteUrl}/cars/sold/${listing.seo_slug}` : `${siteUrl}/cars/${listing.seo_slug}`,
        lastmod: listing.updated_at || listing.published_at,
        changefreq: sold ? 'monthly' : 'daily',
        priority: sold ? '0.4' : '0.7',
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
