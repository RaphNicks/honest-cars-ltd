'use strict';

/**
 * Blog — “Home of the Honest Buyer’s Guide” (§6.9) and /guide.
 *
 *   GET /blog              featured hero + category chips + 9-per-load-more
 *   GET /blog/rss.xml      RSS 2.0 feed (linked in <head> and in the chip bar)
 *   GET /blog/tag/:slug    FR-35 tag page — the governed taxonomy, one shelf
 *   GET /blog/author/:slug FR-35 author page — everything one writer published
 *   GET /blog/:slug        post: hero, TOC, body blocks, “cars mentioned”,
 *                          author card, share row, related posts, prev/next,
 *                          contextual service CTA, helpful feedback widget
 *   GET /guide             curated evergreen shelf — start-here reading path
 *
 * Paginated, filtered and searched blog URLs are indexable-friendly for humans
 * but noindex for crawlers, with the canonical pointing at /blog.
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const seo = require('../services/seo');
const sitemap = require('../services/sitemap');
const { sendPrebuiltOrRender, sendPage, CACHE } = require('../lib/respond');

const router = express.Router();

// ---------------------------------------------------------------------------
// /blog
// ---------------------------------------------------------------------------
async function buildBlogLocals({ page = 1, category = null, q = null } = {}) {
  const feed = await db.content.blogIndex({ page, category, q });
  const [faqs, counters] = await Promise.all([
    db.content.faqsForScope('page:blog'),
    db.listings.networkCounters(),
  ]);

  const featured = feed.posts.find((post) => post.isFeatured) || feed.posts[0] || null;
  const rest = feed.posts.filter((post) => post !== featured);
  const filtered = Boolean(category || q || page > 1);

  const trail = [{ label: 'Blog' }];

  return {
    view: 'blog',
    page: {
      title: 'The Honest Buyer’s Guide — buying cars in Port Harcourt',
      metaTitle: 'Car-buying guides for Port Harcourt',
      titleSuffix: true,
      description:
        'Straight answers about buying, running and selling cars in Port Harcourt — real inspections, real prices, real mistakes, and what they cost.',
      canonical: '/blog',
      robots: filtered ? 'noindex,follow' : 'index,follow',
      breadcrumbs: trail,
      bodyClass: 'page-blog',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }]),
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: "HonestCars — the Honest Buyer's Guide",
          url: seo.absolute('/blog'),
          publisher: { '@id': `${config.siteUrl}/#organization` },
          blogPost: feed.posts.slice(0, 9).map((post) => ({
            '@type': 'BlogPosting',
            headline: post.title,
            url: seo.absolute(post.url),
            datePublished: post.publishedAt ? new Date(post.publishedAt).toISOString() : undefined,
            author: { '@type': 'Person', name: post.author.name },
          })),
        },
        seo.faqSchema(faqs),
      ],
    },
    data: { feed, featured, rest, category, q, pageNumber: page, faqs, counters, trail, tags: feed.tags },
  };
}

router.get('/', async (req, res, next) => {
  try {
    const locals = await buildBlogLocals({
      page: Math.max(1, Number.parseInt(req.query.page, 10) || 1),
      category: req.query.category ? String(req.query.category).slice(0, 40) : null,
      q: req.query.q ? String(req.query.q).slice(0, 60) : null,
    });
    return await sendPage(req, res, { routePath: '/blog', ...locals, cache: CACHE.ssr });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /blog/rss.xml — registered before /blog/:slug so “rss.xml” is never a slug.
// ---------------------------------------------------------------------------
router.get('/rss.xml', async (req, res, next) => {
  try {
    const xml = await db.content.rssFeed(20, config.siteUrl);
    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.set('Cache-Control', CACHE.static);
    return res.send(xml);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /blog/:slug
// ---------------------------------------------------------------------------
async function buildPostLocals(slug) {
  const post = await db.content.postBySlug(slug);
  if (!post) return null;

  const [related, neighbours, faqs, ctaService] = await Promise.all([
    db.content.relatedPosts(post, 3),
    db.content.postNeighbours(post),
    db.content.faqsForScope(`post:${post.slug}`),
    post.serviceCta ? db.content.serviceBySlug(post.serviceCta) : Promise.resolve(null),
  ]);

  // “Cars mentioned in this article” — live listings matching the post's tags.
  let mentioned = [];
  if (post.makeTags && post.makeTags.length) {
    const results = await Promise.all(
      post.makeTags.slice(0, 3).map((make) => db.listings.browse({ make }, { perPage: 3, sort: 'recommended' }).catch(() => null)),
    );
    mentioned = results.filter(Boolean).flatMap((result) => result.listings).slice(0, 3);
  }

  // FR-35 dynamic embeds — [listing:slug] blocks name a specific car. A block
  // whose car has sold or been pulled renders nothing rather than a dead card.
  const embedSlugs = [...new Set(
    (post.body || [])
      .filter((block) => block && block.type === 'listing' && block.slug)
      .map((block) => block.slug),
  )];
  const embedded = embedSlugs.length
    ? (await Promise.all(embedSlugs.map((slug) => db.listings.findBySlug(slug).catch(() => null)))).filter(Boolean)
    : [];
  const embeds = new Map(embedded.map((listing) => [listing.slug, listing]));
  const author = post.authorSlug ? await db.content.authorBySlug(post.authorSlug).catch(() => null) : null;

  const meta = seo.postMeta(post);
  const trail = [{ label: 'Blog', href: '/blog' }, { label: post.title }];

  return {
    view: 'post',
    page: {
      title: meta.title,
      metaTitle: meta.title,
      titleSuffix: false,
      description: meta.description,
      canonical: post.url,
      ogType: 'article',
      ogImage: post.heroImage,
      ogImageAlt: post.heroAlt,
      breadcrumbs: trail,
      bodyClass: 'page-post',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }, { label: post.title, href: post.url }]),
        seo.articleSchema(post),
        seo.faqSchema(faqs),
      ].filter(Boolean),
    },
    data: { post, related, neighbours, faqs, ctaService, mentioned, embeds, author, trail },
  };
}

// ---------------------------------------------------------------------------
// /blog/tag/:slug and /blog/author/:slug — FR-35
// Registered before /:slug so “tag” and “author” are never read as post slugs.
// ---------------------------------------------------------------------------
async function buildTagLocals(slug, { page = 1 } = {}) {
  const shelf = await db.content.postsByTag(slug, { page });
  if (!shelf || !shelf.tag) return null;

  const [siblings, faqs] = await Promise.all([
    db.content.blogTags({ limit: 24 }),
    db.content.faqsForScope('page:blog'),
  ]);

  const trail = [{ label: 'Blog', href: '/blog' }, { label: shelf.tag.label }];
  const filtered = page > 1;

  return {
    view: 'blog-tag',
    page: {
      title: `${shelf.tag.label} — every post on ${shelf.tag.label.toLowerCase()}`,
      metaTitle: `${shelf.tag.label} guides`,
      titleSuffix: true,
      description: shelf.tag.description
        || `Everything we have written about ${shelf.tag.label.toLowerCase()} — written by the people who inspect the cars, not by a content farm.`,
      canonical: shelf.tag.url,
      robots: filtered ? 'noindex,follow' : 'index,follow',
      breadcrumbs: trail,
      bodyClass: 'page-blog page-blog-tag',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }, { label: shelf.tag.label, href: shelf.tag.url }]),
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: `${shelf.tag.label} — Honest Cars blog`,
          url: seo.absolute(shelf.tag.url),
          isPartOf: { '@id': `${config.siteUrl}/#website` },
          mainEntity: {
            '@type': 'ItemList',
            itemListElement: shelf.posts.map((post, index) => ({
              '@type': 'ListItem',
              position: index + 1,
              url: seo.absolute(post.url),
              name: post.title,
            })),
          },
        },
        seo.faqSchema(faqs),
      ],
    },
    data: { shelf, tag: shelf.tag, siblings: siblings.filter((entry) => entry.slug !== shelf.tag.slug), faqs, pageNumber: page, trail },
  };
}

async function buildAuthorLocals(slug, { page = 1 } = {}) {
  const shelf = await db.content.postsByAuthor(slug, { page });
  if (!shelf || !shelf.author) return null;

  const [authors, faqs] = await Promise.all([
    db.content.authorsWithCounts({ limit: 8 }),
    db.content.faqsForScope('page:blog'),
  ]);

  const trail = [{ label: 'Blog', href: '/blog' }, { label: shelf.author.name }];
  const filtered = page > 1;

  return {
    view: 'blog-author',
    page: {
      title: `${shelf.author.name} — Honest Cars editorial`,
      metaTitle: `${shelf.author.name}, ${shelf.author.role}`,
      titleSuffix: true,
      description: shelf.author.bio || `Everything ${shelf.author.name} has written for Honest Cars.`,
      canonical: shelf.author.url,
      robots: filtered ? 'noindex,follow' : 'index,follow',
      breadcrumbs: trail,
      bodyClass: 'page-blog page-blog-author',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Blog', href: '/blog' }, { label: shelf.author.name, href: shelf.author.url }]),
        {
          '@context': 'https://schema.org',
          '@type': 'ProfilePage',
          url: seo.absolute(shelf.author.url),
          mainEntity: {
            '@type': 'Person',
            name: shelf.author.name,
            jobTitle: shelf.author.role,
            description: shelf.author.bio || undefined,
            url: seo.absolute(shelf.author.url),
            worksFor: { '@id': `${config.siteUrl}/#organization` },
          },
        },
        seo.faqSchema(faqs),
      ],
    },
    data: { shelf, author: shelf.author, authors: authors.filter((entry) => entry.slug !== shelf.author.slug), faqs, pageNumber: page, trail },
  };
}

router.get('/tag/:slug', async (req, res, next) => {
  try {
    const locals = await buildTagLocals(req.params.slug, { page: Math.max(1, Number.parseInt(req.query.page, 10) || 1) });
    if (!locals) return next();
    return await sendPage(req, res, { routePath: `/blog/tag/${req.params.slug}`, ...locals, cache: CACHE.ssr });
  } catch (error) {
    return next(error);
  }
});

router.get('/author/:slug', async (req, res, next) => {
  try {
    const locals = await buildAuthorLocals(req.params.slug, { page: Math.max(1, Number.parseInt(req.query.page, 10) || 1) });
    if (!locals) return next();
    return await sendPage(req, res, { routePath: `/blog/author/${req.params.slug}`, ...locals, cache: CACHE.ssr });
  } catch (error) {
    return next(error);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const locals = await buildPostLocals(req.params.slug);
    if (!locals) return next();
    return await sendPage(req, res, { routePath: `/blog/${req.params.slug}`, ...locals, cache: CACHE.ssr });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router, buildBlogLocals, buildPostLocals, buildTagLocals, buildAuthorLocals };
