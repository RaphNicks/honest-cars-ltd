'use strict';

/**
 * CMS content repository: services, testimonials, blog posts, FAQs, CMS pages,
 * hire classes and shop products.
 * Powers the service pages (§6.7), the blog (§6.9), the trust/legal pages
 * (§6.10), hire (§6.7) and the shop (§6.8), plus FAQPage schema (§12.4).
 */

const { query, queryOne } = require('./pool');
const { parseJson } = require('./shape');

const CATEGORY_LABELS = {
  honest_buyers_guide: "Honest Buyer's Guide",
  ownership_maintenance: 'Ownership & Maintenance',
  market_intel: 'Market Intel & Prices',
  company_news: 'Company News',
  video: 'Video',
};

const CATEGORY_ORDER = [
  'honest_buyers_guide',
  'ownership_maintenance',
  'market_intel',
  'company_news',
  'video',
];

const PRODUCT_CATEGORIES = {
  trackers: 'Trackers & Security',
  diagnostics: 'OBD2 & Diagnostics',
  care_kits: 'Care Kits',
};

const POSTS_PER_PAGE = 9;

// ---------------------------------------------------------------------------
// Services (§6.7)
// ---------------------------------------------------------------------------
function shapeService(row, { full = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    promise: row.promise,
    icon: row.icon,
    fromPriceKobo: row.from_price_kobo === null ? null : Number(row.from_price_kobo),
    ctaLabel: row.cta_label,
    // §6.7: car hire is the one service with a top-level URL of its own.
    url: row.slug === 'hire' ? '/hire' : `/services/${row.slug}`,
  };
  if (!full) return base;

  return {
    ...base,
    heroCopy: row.hero_copy || row.promise,
    slaCopy: row.sla_copy,
    jobsDone: Number(row.jobs_done || 0),
    bookingKind: row.booking_kind || 'request',
    deliverables: parseJson(row.deliverables, []) || [],
    included: parseJson(row.included, []) || [],
    excluded: parseJson(row.excluded, []) || [],
    steps: parseJson(row.steps, []) || [],
    pricing: parseJson(row.pricing, []) || [],
    proof: parseJson(row.proof, []) || [],
  };
}

async function serviceSuite() {
  const rows = await query('SELECT * FROM services WHERE is_active = 1 ORDER BY position ASC, id ASC');
  return rows.map((row) => shapeService(row));
}

async function serviceBySlug(slug) {
  const row = await queryOne('SELECT * FROM services WHERE slug = ? AND is_active = 1 LIMIT 1', [slug]);
  return shapeService(row, { full: true });
}

/** Related services for the cross-sell strip at the foot of every service page. */
async function relatedServices(slug, limit = 3) {
  const rows = await query(
    'SELECT * FROM services WHERE slug <> ? AND is_active = 1 ORDER BY RAND() LIMIT ?',
    [slug, String(limit)],
  );
  return rows.map((row) => shapeService(row));
}

// ---------------------------------------------------------------------------
// Testimonials
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Blog (§6.9)
// ---------------------------------------------------------------------------
function shapePost(row, { full = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    excerpt: row.excerpt,
    heroImage: row.hero_image,
    heroAlt: row.hero_alt,
    author: { name: row.author_name, role: row.author_role, bio: row.author_bio || null },
    readMinutes: row.read_minutes,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    isFeatured: Boolean(row.is_featured),
    makeTags: parseJson(row.make_tags, []) || [],
    url: `/blog/${row.slug}`,
  };
  if (!full) return base;
  return {
    ...base,
    body: parseJson(row.body, []) || [],
    serviceCta: row.service_cta || null,
  };
}

/**
 * Blog home feed — featured pin first, then published posts, 9 per “load more”.
 * Category chips come from a count query so an empty category never renders.
 */
async function blogIndex({ page = 1, perPage = POSTS_PER_PAGE, category = null, q = null } = {}) {
  const where = ["status = 'published'", 'published_at <= UTC_TIMESTAMP()'];
  const params = [];

  if (category && CATEGORY_LABELS[category]) {
    where.push('category = ?');
    params.push(category);
  }
  if (q) {
    where.push('(title LIKE ? OR excerpt LIKE ?)');
    const term = `%${String(q).slice(0, 60)}%`;
    params.push(term, term);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const counted = await queryOne(`SELECT COUNT(*) AS total FROM blog_posts ${whereSql}`, params);
  const total = counted ? Number(counted.total) : 0;
  const offset = (Math.max(1, page) - 1) * perPage;

  const rows = await query(
    `SELECT * FROM blog_posts ${whereSql}
      ORDER BY is_featured DESC, published_at DESC
      LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params,
  );

  const counts = await query(
    `SELECT category, COUNT(*) AS count FROM blog_posts
      WHERE status = 'published' AND published_at <= UTC_TIMESTAMP()
      GROUP BY category`,
  );

  return {
    posts: rows.map((row) => shapePost(row)),
    total,
    page: Math.max(1, page),
    pages: Math.max(1, Math.ceil(total / perPage)),
    categories: CATEGORY_ORDER.map((key) => ({
      key,
      label: CATEGORY_LABELS[key],
      count: Number((counts.find((c) => c.category === key) || {}).count || 0),
    })),
  };
}

async function featuredPost() {
  const row = await queryOne(
    `SELECT * FROM blog_posts WHERE status = 'published' AND published_at <= UTC_TIMESTAMP()
      ORDER BY is_featured DESC, published_at DESC LIMIT 1`,
  );
  return shapePost(row, { full: true });
}

async function latestPosts(limit = 3) {
  const rows = await query(
    `SELECT * FROM blog_posts WHERE status = 'published' AND published_at <= UTC_TIMESTAMP()
      ORDER BY is_featured DESC, published_at DESC LIMIT ?`,
    [String(limit)],
  );
  return rows.map((row) => shapePost(row));
}

async function postBySlug(slug) {
  const row = await queryOne('SELECT * FROM blog_posts WHERE slug = ? AND status = \'published\' LIMIT 1', [slug]);
  return shapePost(row, { full: true });
}

/** Related posts: same category first, then anything recent. */
async function relatedPosts(post, limit = 3) {
  const rows = await query(
    `SELECT * FROM blog_posts
      WHERE status = 'published' AND published_at <= UTC_TIMESTAMP() AND id <> ?
      ORDER BY (category = ?) DESC, published_at DESC
      LIMIT ?`,
    [post.id, post.category, String(limit)],
  );
  return rows.map((row) => shapePost(row));
}

/** Prev / next navigation in publication order. */
async function postNeighbours(post) {
  const [previous] = await query(
    `SELECT * FROM blog_posts WHERE status = 'published' AND published_at > ?
      ORDER BY published_at ASC LIMIT 1`,
    [post.publishedAt],
  );
  const [next] = await query(
    `SELECT * FROM blog_posts WHERE status = 'published' AND published_at < ?
      ORDER BY published_at DESC LIMIT 1`,
    [post.publishedAt],
  );
  return { previous: shapePost(previous), next: shapePost(next) };
}

/** /guide — the curated evergreen shelf (§6.9). */
async function guideShelf(limit = 12) {
  const rows = await query(
    `SELECT * FROM blog_posts
      WHERE status = 'published' AND category = 'honest_buyers_guide'
      ORDER BY published_at DESC LIMIT ?`,
    [String(limit)],
  );
  return rows.map((row) => shapePost(row));
}

/** RSS 2.0 feed for the blog (§6.9 “RSS link”). */
async function rssFeed(limit = 20, siteUrl) {
  const rows = await query(
    `SELECT * FROM blog_posts WHERE status = 'published' AND published_at <= UTC_TIMESTAMP()
      ORDER BY published_at DESC LIMIT ?`,
    [String(limit)],
  );
  const esc = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const items = rows
    .map((row) => {
      const post = shapePost(row);
      return `    <item>
      <title>${esc(post.title)}</title>
      <link>${siteUrl}${post.url}</link>
      <guid isPermaLink="true">${siteUrl}${post.url}</guid>
      <description>${esc(post.excerpt)}</description>
      <category>${esc(post.categoryLabel)}</category>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>HonestCars — the Honest Buyer's Guide</title>
    <link>${siteUrl}/blog</link>
    <description>Straight-talking guides to buying, running and selling cars in Port Harcourt.</description>
    <language>en-ng</language>
    <atom:link href="${siteUrl}/blog/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// CMS pages (§6.10)
// ---------------------------------------------------------------------------
function shapePage(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    h1: row.h1,
    heroCopy: row.hero_copy,
    metaTitle: row.meta_title,
    metaDescription: row.meta_description,
    body: parseJson(row.body, []) || [],
    indexable: Boolean(row.indexable),
    legalReview: Boolean(row.legal_review),
    updatedAt: row.updated_at,
  };
}

async function pageBySlug(slug) {
  const row = await queryOne('SELECT * FROM pages WHERE slug = ? LIMIT 1', [slug]);
  return shapePage(row);
}

async function allPages() {
  const rows = await query('SELECT * FROM pages ORDER BY slug ASC');
  return rows.map(shapePage);
}

// ---------------------------------------------------------------------------
// Hire (§6.7)
// ---------------------------------------------------------------------------
async function hireClasses() {
  const rows = await query('SELECT * FROM hire_classes ORDER BY position ASC, id ASC');
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    seats: row.seats,
    examples: row.examples,
    image: row.image || null,
    imageAlt: row.image ? `${row.name} hire car — ${row.examples}` : null,
    dailyRateKobo: Number(row.daily_rate_kobo),
    weeklyRateKobo: row.weekly_rate_kobo === null ? null : Number(row.weekly_rate_kobo),
    withDriverKobo: row.with_driver_kobo === null ? null : Number(row.with_driver_kobo),
    airportPickup: Boolean(row.airport_pickup),
    corporate: Boolean(row.corporate),
  }));
}

// ---------------------------------------------------------------------------
// Shop (§6.8)
// ---------------------------------------------------------------------------
function shapeProduct(row, { full = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    slug: row.slug,
    category: row.category,
    categoryLabel: PRODUCT_CATEGORIES[row.category] || row.category,
    name: row.name,
    summary: row.summary,
    priceKobo: Number(row.price_kobo),
    installIncluded: Boolean(row.install_included),
    stockStatus: row.stock_status,
    image: row.image,
    url: `/shop/${row.slug}`,
  };
  if (!full) return base;
  return {
    ...base,
    description: row.description,
    specs: parseJson(row.specs, []) || [],
    warrantyText: row.warranty_text,
    deliveryOptions: parseJson(row.delivery_options, []) || [],
  };
}

async function products({ category = null, limit = 48 } = {}) {
  const where = ['is_active = 1'];
  const params = [];
  if (category && PRODUCT_CATEGORIES[category]) {
    where.push('category = ?');
    params.push(category);
  }
  params.push(String(limit));
  const rows = await query(
    `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY category ASC, position ASC LIMIT ?`,
    params,
  );
  return rows.map((row) => shapeProduct(row));
}

async function productBySlug(slug) {
  const row = await queryOne('SELECT * FROM products WHERE slug = ? AND is_active = 1 LIMIT 1', [slug]);
  return shapeProduct(row, { full: true });
}

/** Category chips with counts, so an empty category never renders. */
async function productCategories() {
  const rows = await query(
    'SELECT category, COUNT(*) AS count FROM products WHERE is_active = 1 GROUP BY category',
  );
  return Object.entries(PRODUCT_CATEGORIES)
    .map(([key, label]) => ({ key, label, count: Number((rows.find((r) => r.category === key) || {}).count || 0) }))
    .filter((entry) => entry.count > 0);
}

// ---------------------------------------------------------------------------
// FAQs (§12.4)
// ---------------------------------------------------------------------------
async function faqsForScope(scope) {
  const rows = await query(
    'SELECT question, answer FROM faqs WHERE scope = ? AND is_active = 1 ORDER BY position ASC, id ASC',
    [scope],
  );
  return rows.map((row) => ({ question: row.question, answer: row.answer }));
}

/** Case-insensitive FAQ search for /faq (§6.10 “searchable, grouped”). */
async function searchFaqs(term) {
  const like = `%${String(term).slice(0, 60)}%`;
  const rows = await query(
    `SELECT scope, question, answer FROM faqs
      WHERE is_active = 1 AND (question LIKE ? OR answer LIKE ?)
      ORDER BY scope ASC, position ASC`,
    [like, like],
  );
  return rows.map((row) => ({ scope: row.scope, question: row.question, answer: row.answer }));
}

async function allFaqs() {
  const rows = await query('SELECT scope, question, answer FROM faqs WHERE is_active = 1 ORDER BY scope ASC, position ASC, id ASC');
  return rows.map((row) => ({ scope: row.scope, question: row.question, answer: row.answer }));
}

module.exports = {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  PRODUCT_CATEGORIES,
  POSTS_PER_PAGE,
  serviceSuite,
  serviceBySlug,
  relatedServices,
  publishedTestimonials,
  blogIndex,
  featuredPost,
  latestPosts,
  postBySlug,
  relatedPosts,
  postNeighbours,
  guideShelf,
  rssFeed,
  pageBySlug,
  allPages,
  hireClasses,
  products,
  productBySlug,
  productCategories,
  faqsForScope,
  searchFaqs,
  allFaqs,
};
