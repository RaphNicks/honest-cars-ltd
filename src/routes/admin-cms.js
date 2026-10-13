'use strict';

/**
 * CMS console — §7.3 “CMS: Blog posts & media, pages, FAQs, testimonials,
 * homepage modules, service price cards”, operated under §6.9 governance and
 * the §7.4 matrix (`cms.manage` → admin, marketing).
 *
 *   GET  /admin/cms                          hub: workflow board + everything the CMS owns
 *   GET  /admin/cms/calendar                 editorial calendar, one month at a glance (FR-35)
 *   GET  /admin/cms/posts/new                new post
 *   POST /admin/cms/posts                    create (→ editor)
 *   GET  /admin/cms/posts/:id                editor: body, meta, house rules, history
 *   POST /admin/cms/posts/:id                save
 *   POST /admin/cms/posts/:id/status         draft → in_review → scheduled → published
 *   POST /admin/cms/posts/:id/restore        restore a revision
 *   POST /admin/cms/posts/:id/delete         delete a draft
 *   GET  /admin/cms/pages                    CMS pages (§6.10)
 *   GET  /admin/cms/pages/:id                page editor
 *   POST /admin/cms/pages/:id                save page
 *   GET  /admin/cms/faqs                     FAQ console
 *   POST /admin/cms/faqs[/:id]               add / edit
 *   POST /admin/cms/faqs/:id/delete          remove
 *   GET  /admin/cms/testimonials             testimonials
 *   POST /admin/cms/testimonials[/:id]       add / edit
 *   GET  /admin/cms/modules                  homepage modules
 *   POST /admin/cms/modules/:id              save a module
 *
 * Publishing is not just a status change: every save that can alter a public
 * page calls services/publish.revalidate(), so the static build is refreshed
 * for exactly the affected routes (§12.4). The console reports what was
 * rebuilt, and reports a failure honestly instead of implying the page is live.
 *
 * The editor's body field is block markup (services/blocks.js), not HTML: the
 * textarea is the source, the preview is rendered from the same block list the
 * page will use, and `parse()` reports line-level errors rather than throwing.
 */

const express = require('express');
const db = require('../db');
const auth = require('../services/auth');
const roles = require('../services/roles');
const blocks = require('../services/blocks');
const publish = require('../services/publish');
const validate = require('../services/validate');
const { sendPage, CACHE } = require('../lib/respond');

const router = express.Router();
const cms = db.cms;

const HOME = '/admin/cms';
const PATHS = {
  home: HOME,
  calendar: `${HOME}/calendar`,
  posts: `${HOME}/posts`,
  pages: `${HOME}/pages`,
  faqs: `${HOME}/faqs`,
  testimonials: `${HOME}/testimonials`,
  modules: `${HOME}/modules`,
};

const NAV = [
  { href: HOME, label: 'Hub', icon: 'fileCheck' },
  { href: `${HOME}/calendar`, label: 'Calendar', icon: 'calendar' },
  { href: PATHS.pages, label: 'Pages', icon: 'link' },
  { href: PATHS.faqs, label: 'FAQs', icon: 'chat' },
  { href: PATHS.testimonials, label: 'Testimonials', icon: 'heart' },
  { href: PATHS.modules, label: 'Homepage', icon: 'home' },
];

/** §6.9: categories are fixed, not free text. */
const CATEGORIES = [
  ['honest_buyers_guide', "Honest Buyer's Guide"],
  ['ownership_maintenance', 'Ownership & Maintenance'],
  ['market_intel', 'Market Intelligence'],
  ['company_news', 'Company News'],
  ['video', 'Video'],
];

const MARKUP_REFERENCE = [
  ['## Heading', 'Section heading'],
  ['Plain paragraph', 'Anything else on its own line'],
  ['! Title | text', 'Callout'],
  ['!! Title | text', 'Amber callout — warnings and caveats'],
  ['- item', 'Checklist item (stack them)'],
  ['| a | b | c |', 'Table — first row is the header'],
  ['^ Caption', 'Caption under the previous block'],
  ['= 1,200 | Label', 'Big stat'],
  ['> Quote — Attribution', 'Pull quote'],
  ['[cars]', 'Live listings for this post’s tags'],
  ['[video:ID | Title | 4:12]', 'YouTube embed'],
  ['[label](/services/inspection)', 'Inline link inside any text'],
];

function capability(user) {
  return roles.can(user.role, 'cms.manage');
}

function baseLocals(user, { active, title, description, sub = false }) {
  return {
    view: null,
    page: {
      title,
      metaTitle: `${title} · Console`,
      titleSuffix: false,
      description: description || 'Content console.',
      canonical: active,
      robots: 'noindex,nofollow',
      bodyClass: 'page-admin',
      layout: 'admin',
      jsonLd: [],
    },
    data: {
      admin: {
        nav: [
          { href: '/admin', label: 'Today', icon: 'chart' },
          { href: HOME, label: 'CMS', icon: 'fileCheck' },
        ],
        active: HOME,
        user,
        roleLabel: roles.ROLE_LABELS[user.role] || user.role,
      },
      sub,
      cmsNav: NAV,
      cmsActive: active,
      ok: null,
      error: null,
    },
  };
}

function feedback(req) {
  return {
    ok: validate.text(req.query.ok, 200) || null,
    error: validate.text(req.query.err, 300) || null,
  };
}

function done(res, path, message, { error = false, params = '' } = {}) {
  const key = error ? 'err' : 'ok';
  const sep = path.includes('?') ? '&' : '?';
  return res.redirect(303, `${path}${sep}${params ? `${params}&` : ''}${key}=${encodeURIComponent(message)}`);
}

function page(req, res, { view, active, title, description, data = {}, status = 200 }) {
  const locals = baseLocals(req.user, { active, title, description });
  const { ok, error } = feedback(req);
  return sendPage(req, res, {
    ...locals,
    routePath: req.path,
    view,
    status,
    cache: CACHE.private,
    data: { ...locals.data, ...data, ok, error },
  });
}

/** Save succeeded → revalidate → one honest line back to the console. */
async function savedAndRevalidated(res, path, result, kind, key) {
  const build = result.revalidate === false ? { ok: true, message: '' } : await publish.afterChange(kind, key);
  const message = [result.message || 'Saved.', build.message].filter(Boolean).join(' ');
  return done(res, path, message, { error: false });
}

router.use((req, res, next) => {
  res.set('Cache-Control', CACHE.private);
  return next();
});

// ---------------------------------------------------------------------------
// Editorial calendar — FR-35, §6.9 “editorial calendar view”
// Registered before /posts/:id and /pages/:id so “calendar” is never an id.
// ---------------------------------------------------------------------------
router.get('/calendar', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : null;
    const calendar = await db.content.editorialCalendar(month);
    const [authors, tags] = await Promise.all([
      db.content.authorsWithCounts({ limit: 12 }),
      db.content.blogTags({ limit: 60 }),
    ]);

    return await page(req, res, {
      view: 'admin/cms-calendar',
      active: PATHS.home,
      title: `Editorial calendar — ${calendar.monthLabel}`,
      description: 'What is due, what is out, and what is still a draft.',
      data: {
        calendar,
        authors,
        tags,
        statusLabels: cms.STATUS_LABELS,
        workflow: cms.WORKFLOW,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Hub — §7.3, the whole content estate on one screen
// ---------------------------------------------------------------------------
router.get('/', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const [overview, faqs, testimonials, modules, revisions] = await Promise.all([
      cms.overview(),
      cms.listFaqs(),
      cms.listTestimonials(),
      cms.listHomepageModules(),
      cms.recentRevisions(8),
    ]);
    const board = { draft: [], in_review: [], scheduled: [], published: [] };
    for (const post of overview.posts) (board[post.status] || board.draft).push(post);

    return await page(req, res, {
      view: 'admin/cms',
      active: PATHS.home,
      title: 'Content',
      description: 'Blog posts, pages, FAQs, testimonials and homepage modules.',
      data: {
        stats: overview.stats,
        board,
        pages: overview.pages,
        awaitingCounsel: overview.awaitingCounsel,
        recent: overview.recent,
        faqCount: faqs.length,
        faqActive: faqs.filter((item) => item.isActive).length,
        testimonials,
        modules,
        revisions,
        categories: CATEGORIES,
        workflow: cms.WORKFLOW,
        statusLabels: cms.STATUS_LABELS,
        titleLimit: cms.TITLE_LIMIT,
        descriptionLimit: cms.DESCRIPTION_LIMIT,
        minLinks: cms.MIN_LINKS,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Post editor
// ---------------------------------------------------------------------------
async function editorLocals(id) {
  const post = await cms.postById(id);
  if (!post) return null;
  const check = cms.metaCheck({
    title: post.metaTitle || post.title,
    description: post.metaDescription || post.excerpt,
    links: post.links,
  });
  const [authors, allTags] = await Promise.all([
    db.content.authorsWithCounts({ limit: 40 }),
    db.content.blogTags({ limit: 60 }),
  ]);
  const embedded = (post.body || []).filter((block) => block && block.type === 'listing' && block.slug);
  const embedPreview = embedded.length
    ? new Map((await Promise.all(embedded.map((block) => db.listings.findBySlug(block.slug).catch(() => null))))
        .filter(Boolean)
        .map((listing) => [listing.slug, listing]))
    : new Map();
  return {
    post,
    preview: blocks.parse(post.markup).blocks,
    embedPreview,
    check,
    found: blocks.linksFound(post.body),
    revisions: await cms.revisionsFor('post', id),
    authors,
    allTags,
    categories: CATEGORIES,
    markupReference: MARKUP_REFERENCE,
    workflow: cms.WORKFLOW,
    statusLabels: cms.STATUS_LABELS,
    titleLimit: cms.TITLE_LIMIT,
    descriptionLimit: cms.DESCRIPTION_LIMIT,
    minLinks: cms.MIN_LINKS,
  };
}

router.get('/posts/new', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    return await page(req, res, {
      view: 'admin/cms-post',
      active: PATHS.home,
      title: 'New post',
      description: 'Write a post, check the house rules, then send it for review.',
      data: {
        post: null,
        preview: [],
        embedPreview: new Map(),
        check: null,
        found: [],
        revisions: [],
        authors: await db.content.authorsWithCounts({ limit: 40 }),
        allTags: await db.content.blogTags({ limit: 60 }),
        categories: CATEGORIES,
        markupReference: MARKUP_REFERENCE,
        workflow: cms.WORKFLOW,
        statusLabels: cms.STATUS_LABELS,
        titleLimit: cms.TITLE_LIMIT,
        descriptionLimit: cms.DESCRIPTION_LIMIT,
        minLinks: cms.MIN_LINKS,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/posts', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const parsed = cms.postInput(req.body);
    if (parsed.errors.length) {
      return done(res, '/admin/cms/posts/new', `Line ${parsed.errors[0].line}: ${parsed.errors[0].message}`, { error: true });
    }
    const result = await cms.createPost(parsed.input, { actorId: req.user.id });
    if (!result.ok) return done(res, '/admin/cms/posts/new', result.error, { error: true });
    return done(res, `${PATHS.home}/posts/${result.id}`, 'Draft created. It is private until you publish.');
  } catch (error) {
    return next(error);
  }
});

router.get('/posts/:id', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const data = await editorLocals(req.params.id);
    if (!data) return done(res, PATHS.home, 'That post does not exist.', { error: true });
    return await page(req, res, {
      view: 'admin/cms-post',
      active: PATHS.home,
      title: data.post.title,
      description: 'Edit the body, meta and workflow state.',
      data,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/posts/:id', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const parsed = cms.postInput(req.body);
    const path = `${PATHS.home}/posts/${req.params.id}`;
    if (parsed.errors.length) {
      return done(res, path, `Line ${parsed.errors[0].line}: ${parsed.errors[0].message}`, { error: true });
    }
    const result = await cms.updatePost(req.params.id, parsed.input, {
      actorId: req.user.id,
      note: validate.text(req.body.note, 240) || 'Saved from the editor',
    });
    if (!result.ok) return done(res, path, result.error, { error: true });
    // FR-35 — the saved post may have moved between tags or authors, so the
    // shelves it left and the shelves it joined are all rebuilt.
    const saved = await cms.postById(req.params.id);
    return savedAndRevalidated(res, path, { message: 'Saved.' }, 'post', {
      slug: parsed.input.slug,
      tagSlugs: parsed.input.tagSlugs,
      authorSlug: saved ? saved.authorSlug : null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/posts/:id/status', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const path = `${PATHS.home}/posts/${req.params.id}`;
    const to = validate.text(req.body.status, 20);
    const note = validate.text(req.body.note, 300) || null;
    const publishAt = req.body.publish_at ? String(req.body.publish_at) : null;
    const result = await cms.movePost(req.params.id, to, { actorId: req.user.id, note, publishAt });
    if (!result.ok) return done(res, path, result.error, { error: true });
    if (result.revalidate) {
      const post = await cms.postById(req.params.id);
      const build = await publish.afterChange('post', {
        slug: post ? post.slug : null,
        tagSlugs: post ? post.tagSlugs : [],
        authorSlug: post ? post.authorSlug : null,
      });
      return done(res, path, `${result.message} ${build.message}`);
    }
    return done(res, path, result.message);
  } catch (error) {
    return next(error);
  }
});

router.post('/posts/:id/restore', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const path = `${PATHS.home}/posts/${req.params.id}`;
    const revisionId = validate.integer(req.body.revision_id);
    // A revision carries its own entity id: refuse to apply one post's snapshot
    // to another post just because the id came from a form.
    const revision = await cms.revisionById(revisionId);
    if (!revision) return done(res, path, 'That revision no longer exists.', { error: true });
    if (revision.entity !== 'post' || String(revision.entity_id) !== String(req.params.id)) {
      return done(res, path, 'That revision belongs to a different item.', { error: true });
    }
    const result = await cms.restoreRevision(revisionId, { actorId: req.user.id });
    if (!result.ok) return done(res, path, result.error, { error: true });
    const build = await publish.afterChange('post', result.slug);
    return done(res, path, `Revision restored. ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

router.post('/posts/:id/delete', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const result = await cms.deletePost(req.params.id, { actorId: req.user.id });
    if (!result.ok) return done(res, `${PATHS.home}/posts/${req.params.id}`, result.error, { error: true });
    const build = await publish.afterChange('postRemoved');
    return done(res, PATHS.home, `Draft deleted. ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// CMS pages (§6.10)
// ---------------------------------------------------------------------------
router.get('/pages', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const pages = await cms.listPages();
    return await page(req, res, {
      view: 'admin/cms-pages',
      active: PATHS.pages,
      title: 'Pages',
      description: 'Meta, body and the counsel-review flag for every CMS page.',
      data: { pages, awaitingCounsel: pages.filter((row) => row.legal_review) },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/pages/:id', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const record = await cms.pageById(req.params.id);
    if (!record) return done(res, PATHS.pages, 'That page does not exist.', { error: true });
    return await page(req, res, {
      view: 'admin/cms-page',
      active: PATHS.pages,
      title: `${record.slug}`,
      description: 'Copy and meta for a public page.',
      data: {
        record,
        check: cms.metaCheck({ title: record.metaTitle, description: record.metaDescription }),
        revisions: await cms.revisionsFor('page', record.id),
        markupReference: MARKUP_REFERENCE,
        titleLimit: cms.TITLE_LIMIT,
        descriptionLimit: cms.DESCRIPTION_LIMIT,
        maybeClearCounsel: roles.can(req.user.role, 'users.manage'),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/pages/:id', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const path = `${PATHS.pages}/${req.params.id}`;
    const before = await cms.pageById(req.params.id);
    if (!before) return done(res, PATHS.pages, 'That page does not exist.', { error: true });

    // Clearing the counsel-review flag is an attestation, so it stays with the
    // admin role even though marketing can edit the copy (§7.4).
    const form = { ...req.body };
    if (!roles.can(req.user.role, 'users.manage')) form.legal_review = before.legalReview ? '1' : '';

    const result = await cms.updatePage(req.params.id, form, { actorId: req.user.id });
    if (!result.ok) return done(res, path, result.error, { error: true });
    const build = await publish.afterChange('page', before.slug);
    return done(res, path, `${result.message} ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// FAQs
// ---------------------------------------------------------------------------
router.get('/faqs', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const faqs = await cms.listFaqs();
    const scopes = [...new Set(faqs.map((item) => item.scope))].sort();
    return await page(req, res, {
      view: 'admin/cms-faqs',
      active: PATHS.faqs,
      title: 'FAQs',
      description: 'Question and answer content, scoped to the pages that show it.',
      data: { faqs, scopes, scopeOptions: cms.FAQ_SCOPES },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/faqs', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const result = await cms.saveFaq(null, req.body, { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.faqs, result.error, { error: true });
    const build = await publish.afterChange('faq');
    return done(res, PATHS.faqs, `${result.message} ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

router.post('/faqs/:id', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const result = await cms.saveFaq(validate.integer(req.params.id), req.body, { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.faqs, result.error, { error: true });
    const build = await publish.afterChange('faq');
    return done(res, PATHS.faqs, `${result.message} ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

router.post('/faqs/:id/delete', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const result = await cms.deleteFaq(validate.integer(req.params.id), { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.faqs, result.error, { error: true });
    const build = await publish.afterChange('faq');
    return done(res, PATHS.faqs, `${result.message} ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Testimonials
// ---------------------------------------------------------------------------
router.get('/testimonials', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const testimonials = await cms.listTestimonials();
    return await page(req, res, {
      view: 'admin/cms-testimonials',
      active: PATHS.testimonials,
      title: 'Testimonials',
      description: 'Social proof: published quotes, hidden ones, and the add form.',
      data: {
        testimonials,
        published: testimonials.filter((row) => row.isPublished).length,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/testimonials', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const result = await cms.saveTestimonial(null, req.body, { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.testimonials, result.error, { error: true });
    const build = result.revalidate ? await publish.afterChange('testimonial') : { message: 'Not published yet, so nothing to rebuild.' };
    return done(res, PATHS.testimonials, `${result.message} ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

router.post('/testimonials/:id', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const result = await cms.saveTestimonial(validate.integer(req.params.id), req.body, { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.testimonials, result.error, { error: true });
    const build = result.revalidate ? await publish.afterChange('testimonial') : { message: 'Hidden for now.' };
    return done(res, PATHS.testimonials, `${result.message} ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Homepage modules (§7.3: featured cars, trust counters, banners)
// ---------------------------------------------------------------------------
router.get('/modules', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const [modules, counters, picks] = await Promise.all([
      cms.listHomepageModules(),
      cms.listingCounters(),
      db.listings.homeFeed(6),
    ]);
    return await page(req, res, {
      view: 'admin/cms-modules',
      active: PATHS.modules,
      title: 'Homepage modules',
      description: 'Banner, hero, trust-counter wording and the hand-picked featured rail.',
      data: {
        modules,
        counts: counters,
        suggestions: picks.tabs.all.listings.slice(0, 6),
      },
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * The module forms are field-per-setting rather than one JSON blob, because a
 * JSON textarea in a CMS is how you get a typo published. This reassembles the
 * payload, merging into what is already stored so a field the form does not
 * show (a module's note, for instance) survives the save.
 */
function payloadFromForm(body, existing = {}) {
  const payload = JSON.parse(JSON.stringify(existing || {}));
  for (const [key, raw] of Object.entries(body || {})) {
    const value = String(raw == null ? '' : raw);
    if (key.startsWith('payload_')) {
      const field = key.slice('payload_'.length);
      const trimmed = value.trim();
      if (/^[[{]/.test(trimmed)) {
        try {
          payload[field] = JSON.parse(trimmed);
          continue;
        } catch {
          // Not JSON after all — fall through and store it as text, which is
          // what a one-line banner field usually is.
        }
      }
      payload[field] = trimmed;
    } else if (key.startsWith('label_')) {
      payload.labels = payload.labels || {};
      payload.labels[key.slice('label_'.length)] = value.trim();
    }
  }
  return payload;
}

router.post('/modules/:id', auth.requireStaff('cms.manage'), async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id);
    const modules = await cms.listHomepageModules();
    const existing = modules.find((module) => module.id === id);
    if (!existing) return done(res, PATHS.modules, 'That module no longer exists.', { error: true });
    const form = { ...req.body, payload: JSON.stringify(payloadFromForm(req.body, existing.payload)) };
    const result = await cms.saveHomepageModule(id, form, { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.modules, result.error, { error: true });
    const build = await publish.afterChange('homepage');
    return done(res, PATHS.modules, `${result.message} ${build.message}`);
  } catch (error) {
    return next(error);
  }
});

module.exports = { router };
