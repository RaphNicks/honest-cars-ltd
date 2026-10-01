'use strict';

/**
 * CMS content repository: services, testimonials, blog posts, FAQs.
 * Powers the homepage modules (§6.1) and the FAQPage schema (§12.4).
 */

const { query, queryOne } = require('./pool');

const CATEGORY_LABELS = {
  honest_buyers_guide: "Honest Buyer's Guide",
  ownership_maintenance: 'Ownership & Maintenance',
  market_intel: 'Market Intel & Prices',
  company_news: 'Company News',
  video: 'Video',
};

async function serviceSuite() {
  const rows = await query(
    'SELECT * FROM services WHERE is_active = 1 ORDER BY position ASC, id ASC',
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    promise: row.promise,
    icon: row.icon,
    fromPriceKobo: row.from_price_kobo === null ? null : Number(row.from_price_kobo),
    ctaLabel: row.cta_label,
    url: `/services/${row.slug}`,
  }));
}

async function publishedTestimonials(limit = 4) {
  const rows = await query(
    'SELECT * FROM testimonials WHERE is_published = 1 ORDER BY position ASC, id ASC LIMIT ?',
    [String(limit)],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.customer_name,
    area: row.area,
    quote: row.quote,
    serviceTag: row.service_tag,
    rating: row.rating,
  }));
}

async function latestPosts(limit = 3) {
  const rows = await query(
    `SELECT * FROM blog_posts WHERE status = 'published' AND published_at <= UTC_TIMESTAMP()
      ORDER BY is_featured DESC, published_at DESC LIMIT ?`,
    [String(limit)],
  );
  return rows.map(shapePost);
}

async function featuredPost() {
  const row = await queryOne(
    `SELECT * FROM blog_posts WHERE status = 'published' AND published_at <= UTC_TIMESTAMP()
      ORDER BY is_featured DESC, published_at DESC LIMIT 1`,
  );
  return row ? shapePost(row) : null;
}

function shapePost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    excerpt: row.excerpt,
    heroImage: row.hero_image,
    heroAlt: row.hero_alt,
    author: { name: row.author_name, role: row.author_role },
    readMinutes: row.read_minutes,
    publishedAt: row.published_at,
    isFeatured: Boolean(row.is_featured),
    url: `/blog/${row.slug}`,
  };
}

/** FAQs by scope: 'global', 'facet:toyota', 'home', … (§12.4 FAQPage). */
async function faqsForScope(scope) {
  const rows = await query(
    'SELECT question, answer FROM faqs WHERE scope = ? AND is_active = 1 ORDER BY position ASC, id ASC',
    [scope],
  );
  return rows.map((row) => ({ question: row.question, answer: row.answer }));
}

module.exports = {
  CATEGORY_LABELS,
  serviceSuite,
  publishedTestimonials,
  latestPosts,
  featuredPost,
  faqsForScope,
};
