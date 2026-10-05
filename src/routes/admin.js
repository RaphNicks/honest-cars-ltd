'use strict';

/**
 * Admin console — §7.3, gated by the §7.4 role matrix.
 *
 *   GET  /admin                     KPI home + daily summary
 *   GET  /admin/listings            moderation queue, grades, expiry sweep
 *   GET  /admin/leads               unified CRM-lite inbox
 *   GET  /admin/concierge           pipeline board, candidates, SLA
 *   GET  /admin/bookings            dispatch calendar
 *   GET  /admin/jobs                inspector mobile view + checklist
 *   GET  /admin/jobs/:id/report     the client-facing inspection report (FR-07)
 *   GET  /admin/orders              shop orders + fulfilment
 *   GET  /admin/payments            transactions, receipts, refunds, dealer ledger
 *   GET  /admin/milestones          protected-purchase & parts escrow tracker
 *   GET  /admin/alerts              saved-car / saved-search deal alerts (FR-25)
 *   GET  /admin/staff               staff, roles, watchlist
 *   GET  /admin/audit               sensitive-action log
 *
 * Every mutation is a real form POST that redirects back with a one-line
 * result, so the console works without JavaScript and every action is a
 * bookmarkable URL. Who may do what is decided here; how it is done lives in
 * src/db/admin.js; the matrix itself is src/services/roles.js.
 */

const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../services/auth');
const roles = require('../services/roles');
const validate = require('../services/validate');
const paymentService = require('../services/payments');
const alertsService = require('../services/alerts');
const money = require('../lib/money');
const report = require('../services/report');
const { sendPage, CACHE } = require('../lib/respond');

const router = express.Router();
const admin = db.admin;
const dealers = db.dealers;

const HOME = '/admin';
const PATHS = {
  listings: `${HOME}/listings`,
  leads: `${HOME}/leads`,
  concierge: `${HOME}/concierge`,
  bookings: `${HOME}/bookings`,
  jobs: `${HOME}/jobs`,
  orders: `${HOME}/orders`,
  payments: `${HOME}/payments`,
  milestones: `${HOME}/milestones`,
  alerts: `${HOME}/alerts`,
  intel: `${HOME}/intel`,
  staff: `${HOME}/staff`,
  audit: `${HOME}/audit`,
};

/** Navigation, filtered by what this role may actually open (§7.4). */
const NAV = [
  { href: HOME, label: 'Today', icon: 'chart', capability: 'reports.view' },
  { href: PATHS.listings, label: 'Listings', icon: 'car', capability: 'listings.moderate' },
  { href: PATHS.leads, label: 'Leads', icon: 'inbox', capability: 'leads.manage' },
  { href: PATHS.concierge, label: 'Concierge', icon: 'search', capability: 'concierge.manage' },
  { href: PATHS.bookings, label: 'Dispatch', icon: 'calendar', capability: 'bookings.dispatch' },
  { href: PATHS.jobs, label: 'My jobs', icon: 'check', capability: 'bookings.own_jobs' },
  { href: PATHS.orders, label: 'Orders', icon: 'package', capability: 'payments.view' },
  { href: PATHS.payments, label: 'Money', icon: 'chart', capability: 'payments.view' },
  { href: PATHS.milestones, label: 'Escrow', icon: 'shield', capability: 'payments.view' },
  { href: PATHS.alerts, label: 'Alerts', icon: 'bell', capability: 'intel.manage' },
  { href: PATHS.intel, label: 'Price intel', icon: 'gauge', capability: 'pricing.view' },
  { href: `${HOME}/cms`, label: 'Content', icon: 'fileCheck', capability: 'cms.manage' },
  { href: PATHS.staff, label: 'Staff & roles', icon: 'account', capability: 'users.manage' },
  { href: PATHS.audit, label: 'Audit log', icon: 'shield', capability: 'users.manage' },
];

function navFor(user) {
  return NAV.filter((item) => roles.can(user.role, item.capability));
}

function baseLocals(user, { active, title, description }) {
  return {
    view: null,
    page: {
      title,
      metaTitle: `${title} · Console`,
      titleSuffix: false,
      description: description || 'Honest Cars operations console.',
      canonical: active,
      robots: 'noindex,nofollow',
      bodyClass: 'page-admin',
      layout: 'admin',
      jsonLd: [],
    },
    data: {
      admin: { nav: navFor(user), active, user, roleLabel: roles.ROLE_LABELS[user.role] || user.role },
      ok: null,
      error: null,
    },
  };
}

/** Read the one-line result a POST left behind in the querystring. */
function feedback(req) {
  return {
    ok: validate.text(req.query.ok, 160) || null,
    error: validate.text(req.query.err, 200) || null,
  };
}

/** POST → back to the module with a message. 303 so a refresh cannot repost. */
function done(res, path, message, { error = false, params = '' } = {}) {
  const key = error ? 'err' : 'ok';
  const sep = path.includes('?') ? '&' : '?';
  return res.redirect(303, `${path}${sep}${params ? `${params}&` : ''}${key}=${encodeURIComponent(message)}`);
}

/** The four checks behind a grade. All four are required for `certified`. */
function checklistFrom(body, grade) {
  const boxes = {
    vin_checked: Boolean(body.vin_checked),
    docs_sighted: Boolean(body.docs_sighted),
    obd2_scanned: Boolean(body.obd2_scanned),
    road_tested: Boolean(body.road_tested),
    checked_on: new Date().toISOString().slice(0, 10),
  };
  const ticked = ['vin_checked', 'docs_sighted', 'obd2_scanned', 'road_tested'];
  if (grade === 'certified' && !ticked.every((key) => boxes[key])) {
    return { error: 'Certified needs all four: VIN, documents, OBD2 and a road test.' };
  }
  const any = ticked.some((key) => boxes[key]);
  return { checklist: any ? boxes : null };
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

/** The console never loads anything from the static bundle. */
router.use((req, res, next) => {
  res.set('Cache-Control', CACHE.private);
  return next();
});

// ---------------------------------------------------------------------------
// Today — KPI home (§7.3)
// ---------------------------------------------------------------------------
router.get('/', auth.requireStaff('reports.view'), async (req, res, next) => {
  try {
    const [kpis, trend, funnel, revenue, moderation, summary, recentAudit] = await Promise.all([
      admin.kpis(),
      admin.listingsTrend({ days: 14 }),
      admin.leadFunnel({ days: 30 }),
      admin.revenueByPillar({ days: 30 }),
      admin.moderationList({ status: 'in_review', limit: 5 }),
      admin.dailySummary(),
      admin.auditLog({ limit: 6 }),
    ]);
    return await page(req, res, {
      view: 'admin/home',
      active: HOME,
      title: 'Today',
      description: 'Leads, bookings, money, moderation and SLA in one screen.',
      data: {
        kpis,
        trend,
        funnel,
        revenue,
        queue: moderation.rows,
        summary,
        whatsappSummary: `https://wa.me/?text=${encodeURIComponent(summary)}`,
        recentAudit,
        staleDays: admin.STALE_DAYS,
        refreshGraceDays: admin.REFRESH_GRACE_DAYS,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Listings moderation (§7.3)
// ---------------------------------------------------------------------------
router.get('/listings', auth.requireStaff('listings.moderate'), async (req, res, next) => {
  try {
    const status = validate.oneOf(req.query.status, [...admin.LISTING_STATUSES, 'all'], 'in_review');
    const q = validate.text(req.query.q, 60) || null;
    const [list, grades, dealers] = await Promise.all([
      admin.moderationList({ status: status === 'all' ? null : status, q, limit: 60 }),
      Promise.resolve(admin.GRADES),
      db.query('SELECT id, name FROM dealers ORDER BY name'),
    ]);
    return await page(req, res, {
      view: 'admin/listings',
      active: PATHS.listings,
      title: 'Listings',
      description: 'Moderation queue, verification grades and the 14-day freshness rule.',
      data: {
        rows: list.rows,
        counts: list.counts,
        status,
        q,
        grades,
        dealers,
        staleDays: admin.STALE_DAYS,
        refreshGraceDays: admin.REFRESH_GRACE_DAYS,
        sweep: null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/stale-sweep', auth.requireStaff('listings.moderate'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const dryRun = String(req.body.dry_run || '') === '1';
    const result = await admin.runStaleSweep({ actorId: req.user.id, dryRun });
    const message = dryRun
      ? `Dry run: ${result.requested.length} would be flagged, ${result.expired.length} would be unlisted.`
      : `Flagged ${result.requested.length} for refresh · unlisted ${result.expired.length}.`;
    return done(res, PATHS.listings, message);
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/publish', auth.requireStaff('listings.moderate'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const grade = validate.oneOf(req.body.grade, admin.GRADES, null);
    const { checklist, error: checklistError } = checklistFrom(req.body, grade);
    if (checklistError) return done(res, PATHS.listings, checklistError, { error: true });
    const result = await admin.publishListing(id, { grade, checklist, actorId: req.user.id });
    return result.ok
      ? done(res, PATHS.listings, 'Listing published — it is live on the storefront.')
      : done(res, PATHS.listings, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/grade', auth.requireStaff('listings.grade'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const grade = validate.oneOf(req.body.grade, admin.GRADES, null);
    const { checklist, error: checklistError } = checklistFrom(req.body, grade);
    if (checklistError) return done(res, PATHS.listings, checklistError, { error: true });
    const result = await admin.setGrade(id, { grade, checklist, actorId: req.user.id, note: validate.text(req.body.note, 200) });
    return result.ok
      ? done(res, PATHS.listings, `Grade set to ${String(grade).replace(/_/g, ' ')} — recorded in the audit log.`)
      : done(res, PATHS.listings, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/status', auth.requireStaff('listings.moderate'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const status = validate.oneOf(req.body.status, admin.LISTING_STATUSES, null);
    const result = await admin.setListingStatus(id, status, { actorId: req.user.id });
    return result.ok
      ? done(res, PATHS.listings, `Listing marked ${status}.`)
      : done(res, PATHS.listings, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/price', auth.requireStaff('listings.price'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const result = await admin.setPrice(id, req.body.price_naira, { actorId: req.user.id, note: validate.text(req.body.note, 200) });
    return result.ok
      ? done(res, PATHS.listings, 'Price updated — the override is in the audit log.')
      : done(res, PATHS.listings, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/listings/:id/refresh', auth.requireStaff('listings.moderate'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    await admin.markRefreshed(id, { actorId: req.user.id });
    return done(res, PATHS.listings, 'Marked fresh — the 14-day clock restarts.');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Leads — unified inbox (§7.3)
// ---------------------------------------------------------------------------
router.get('/leads', auth.requireStaff('leads.manage'), async (req, res, next) => {
  try {
    const status = validate.text(req.query.status, 20) || null;
    const type = validate.text(req.query.type, 20) || null;
    const kind = validate.oneOf(req.query.kind, ['lead', 'request'], null);
    const q = validate.text(req.query.q, 60) || null;
    const owner = validate.text(req.query.owner, 20) || null;
    const [inbox, staff] = await Promise.all([
      admin.leadsInbox({ status, type, kind, q, owner, limit: 60 }),
      admin.staffOptions(),
    ]);
    return await page(req, res, {
      view: 'admin/leads',
      active: PATHS.leads,
      title: 'Leads',
      description: 'Listing enquiries, concierge, service requests, hire and B2B in one inbox.',
      data: {
        rows: inbox.rows,
        counts: inbox.counts,
        staff,
        filters: { status, type, kind, q, owner },
        leadTypes: ['viewing', 'concierge', 'sell_swap', 'hire', 'service', 'parts', 'b2b', 'deal_alert'],
        statuses: admin.LEAD_STATUSES,
        templates: REPLY_TEMPLATES,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/** WhatsApp reply templates — ops sends them from their own WhatsApp. */
const REPLY_TEMPLATES = [
  {
    key: 'viewing',
    label: 'Book a viewing',
    body: 'Hello {name}, this is Honest Cars about {ref}. The car is available to view this week — what day suits you? We meet at the lot or a place of your choosing in Port Harcourt.',
  },
  {
    key: 'docs',
    label: 'Documents ready',
    body: 'Hello {name}, your documents for {ref} are ready for sighting. Bring a valid ID and we will walk you through each paper before any money moves.',
  },
  {
    key: 'options',
    label: 'Concierge options ready',
    body: 'Hello {name}, your options for {ref} are ready. I have attached three cars with prices, grades and honest notes — tell me which two you want to see and I will book the slots.',
  },
  {
    key: 'price',
    label: 'Price question',
    body: 'Hello {name}, thanks for asking about the price on {ref}. The asking price is what we published, and we will show you the market band it sits in — no hidden dealer fee on top.',
  },
  {
    key: 'lost',
    label: 'Close the loop (lost)',
    body: 'Hello {name}, I can see you have gone quiet on {ref}. No pressure at all — one line back to say whether you found something else or want me to keep looking would help me close my file.',
  },
];

router.post('/leads/:id/status', auth.requireStaff('leads.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const kind = req.body.kind === 'request' ? 'request' : 'lead';
    // Requests travel their own stages, leads theirs (§7.3).
    const stages = kind === 'request' ? admin.REQUEST_STAGES : admin.LEAD_STATUSES;
    const status = validate.oneOf(req.body.status, stages, null);
    const result = await admin.setLeadStatus(id, status, {
      actorId: req.user.id,
      kind,
      lostReason: validate.text(req.body.lost_reason, 160),
    });
    return result.ok
      ? done(res, kind === 'request' ? PATHS.concierge : PATHS.leads, `Marked ${status}.`)
      : done(res, kind === 'request' ? PATHS.concierge : PATHS.leads, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/leads/:id/assign', auth.requireStaff('leads.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const assignedTo = validate.integer(req.body.assigned_to, { min: 0, fallback: null });
    const kind = req.body.kind === 'request' ? 'request' : 'lead';
    const result = await admin.assignLead(id, { actorId: req.user.id, assignedTo, kind });
    return result.ok
      ? done(res, kind === 'request' ? PATHS.concierge : PATHS.leads, assignedTo ? 'Assigned.' : 'Unassigned.')
      : done(res, PATHS.leads, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/leads/auto-assign', auth.requireStaff('leads.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const result = await admin.autoAssign({ actorId: req.user.id });
    return result.ok
      ? done(res, PATHS.leads, `Round-robin assigned ${result.assigned} lead${result.assigned === 1 ? '' : 's'}.`)
      : done(res, PATHS.leads, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Concierge pipeline (§7.3)
// ---------------------------------------------------------------------------
router.get('/concierge', auth.requireStaff('concierge.manage'), async (req, res, next) => {
  try {
    const type = validate.oneOf(req.query.type, ['concierge', 'sell', 'swap', 'parts', 'documents', 'research', 'hire', 'consultation', 'tracking'], null);
    const [board, staff, focus] = await Promise.all([
      admin.pipelineBoard({ type }),
      admin.staffOptions(),
      req.query.open ? admin.requestById(validate.integer(req.query.open, { min: 1, fallback: 0 })) : Promise.resolve(null),
    ]);
    const candidates = focus ? await admin.candidatesFor(focus.id) : [];
    return await page(req, res, {
      view: 'admin/concierge',
      active: PATHS.concierge,
      title: 'Concierge pipeline',
      description: 'New → Searching → Options ready → Viewings → Closed, with the SLA timer per request.',
      data: {
        columns: board.columns,
        all: board.all,
        staff,
        focus,
        candidates,
        type,
        stages: admin.REQUEST_STAGES,
        stagesInfo: db.requests.STATUS_STAGES || [],
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/concierge/:id/stage', auth.requireStaff('concierge.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const status = validate.oneOf(req.body.status, admin.REQUEST_STAGES, null);
    const result = await admin.setRequestStage(id, status, {
      actorId: req.user.id,
      lostReason: validate.text(req.body.lost_reason, 160),
    });
    return result.ok
      ? done(res, PATHS.concierge, `Stage moved to ${String(status).replace(/_/g, ' ')}.`, { params: `open=${id}` })
      : done(res, PATHS.concierge, result.error, { error: true, params: `open=${id}` });
  } catch (error) {
    return next(error);
  }
});

router.post('/concierge/:id/candidates', auth.requireStaff('concierge.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const listingId = validate.integer(req.body.listing_id, { min: 1, fallback: 0 });
    const result = await admin.attachCandidate(id, {
      listingId,
      note: validate.text(req.body.note, 200),
      actorId: req.user.id,
    });
    return result.ok
      ? done(res, PATHS.concierge, 'Car attached to the request.', { params: `open=${id}` })
      : done(res, PATHS.concierge, result.error, { error: true, params: `open=${id}` });
  } catch (error) {
    return next(error);
  }
});

router.post('/concierge/:id/candidates/:listingId/remove', auth.requireStaff('concierge.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const listingId = validate.integer(req.params.listingId, { min: 1, fallback: 0 });
    await admin.removeCandidate(id, listingId, { actorId: req.user.id });
    return done(res, PATHS.concierge, 'Car removed from the request.', { params: `open=${id}` });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Bookings & dispatch (§7.3)
// ---------------------------------------------------------------------------
router.get('/bookings', auth.requireStaff('bookings.dispatch'), async (req, res, next) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : null;
    const status = validate.oneOf(req.query.status, admin.BOOKING_STATUSES, null);
    const [board, staff] = await Promise.all([
      admin.dispatchBoard({ date, status }),
      db.query("SELECT id, name FROM `users` WHERE role = 'inspector' AND status = 'active' ORDER BY name"),
    ]);
    return await page(req, res, {
      view: 'admin/bookings',
      active: PATHS.bookings,
      title: 'Dispatch',
      description: 'Inspections, consultations and installs — assign an inspector and move the job.',
      data: {
        rows: board.rows,
        counts: board.counts,
        inspectors: staff.map((row) => ({ id: row.id, name: row.name || 'Inspector' })),
        filters: { date, status },
        statuses: admin.BOOKING_STATUSES,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/bookings/:id/dispatch', auth.requireStaff('bookings.dispatch'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const inspectorId = validate.integer(req.body.inspector_id, { min: 0, fallback: null });
    const result = await admin.assignInspector(id, { inspectorId, actorId: req.user.id });
    return result.ok
      ? done(res, PATHS.bookings, inspectorId ? 'Inspector assigned.' : 'Inspector cleared.')
      : done(res, PATHS.bookings, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/bookings/:id/status', auth.requireStaff('bookings.dispatch'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const status = validate.oneOf(req.body.status, admin.BOOKING_STATUSES, null);
    const result = await admin.setBookingStatus(id, status, { actorId: req.user.id });
    return result.ok
      ? done(res, PATHS.bookings, `Booking ${status}.`)
      : done(res, PATHS.bookings, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Inspector mobile view (§7.3)
// ---------------------------------------------------------------------------
router.get('/jobs', auth.requireStaff('bookings.own_jobs'), async (req, res, next) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : null;
    const jobs = await admin.inspectorJobs(req.user.id, { date });
    return await page(req, res, {
      view: 'admin/jobs',
      active: PATHS.jobs,
      title: 'My jobs',
      description: 'Today’s inspections with the checklist that produces the client report.',
      data: {
        jobs,
        date,
        sections: INSPECTION_SECTIONS,
        verdicts: admin.VERDICTS,
      },
    });
  } catch (error) {
    return next(error);
  }
});

/** The checklist the PRD specifies for an inspection (§7.3 inspector view). */
const INSPECTION_SECTIONS = [
  { key: 'engine', label: 'Engine & fluids' },
  { key: 'transmission', label: 'Transmission' },
  { key: 'suspension', label: 'Suspension & steering' },
  { key: 'brakes', label: 'Brakes & tyres' },
  { key: 'electricals', label: 'Electricals & AC' },
  { key: 'body', label: 'Body, paint & interior' },
  { key: 'documents', label: 'Documents & VIN' },
];

router.post('/jobs/:id/report', auth.requireStaff('bookings.own_jobs'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const booking = await db.queryOne('SELECT id, inspector_id FROM bookings WHERE id = ? LIMIT 1', [id]);
    if (!booking) return done(res, PATHS.jobs, 'That job no longer exists.', { error: true });
    if (Number(booking.inspector_id) !== Number(req.user.id)) {
      return done(res, PATHS.jobs, 'That job is not assigned to you.', { error: true });
    }

    const sections = {};
    for (const section of INSPECTION_SECTIONS) {
      const value = validate.oneOf(req.body[`section_${section.key}`], ['ok', 'attention', 'fail'], null);
      if (value) sections[section.key] = value;
    }
    const checklist = {
      obd2_codes: validate.text(req.body.obd2_codes, 200) || null,
      sections,
      photos: validate.text(req.body.photos, 300) || null,
      checked_on: new Date().toISOString().slice(0, 10),
    };
    const result = await admin.saveInspectionReport(id, {
      checklist,
      verdict: validate.oneOf(req.body.verdict, admin.VERDICTS, null),
      notes: validate.text(req.body.report_notes, 4000),
      actorId: req.user.id,
    });
    return result.ok
      ? done(res, PATHS.jobs, 'Report saved. The client-facing PDF is generated in the dispatch module.')
      : done(res, PATHS.jobs, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Orders (§7.3 “Orders & Payments”) — what was bought and where it has got to
// ---------------------------------------------------------------------------
router.get('/orders', auth.requireStaff('payments.view'), async (req, res, next) => {
  try {
    const status = validate.oneOf(req.query.status, [...db.payments.ORDER_STATUSES, 'all'], 'all');
    const q = validate.text(req.query.q, 60) || null;
    const list = await db.payments.listOrders({ status: status === 'all' ? null : status, q, limit: 200 });
    return await page(req, res, {
      view: 'admin/orders',
      active: PATHS.orders,
      title: 'Orders',
      description: 'Shop orders, what is in them, and where each one has got to.',
      data: {
        rows: list.rows,
        counts: list.counts,
        statuses: db.payments.ORDER_STATUSES,
        status,
        q,
        canApprove: roles.can(req.user.role, 'payments.approve'),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/orders/:id/status', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const status = validate.oneOf(req.body.status, db.payments.ORDER_STATUSES, null);
    if (!status) return done(res, PATHS.orders, 'Unknown order status.', { error: true });
    const result = await db.payments.setOrderStatus(id, status, { actorId: req.user.id });
    return result.ok
      ? done(res, PATHS.orders, `Order moved to ${status.replace(/_/g, ' ')}.`)
      : done(res, PATHS.orders, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Payments, receipts and the dealer ledger (§7.3, §7.2)
// ---------------------------------------------------------------------------
router.get('/payments', auth.requireStaff('payments.view'), async (req, res, next) => {
  try {
    const status = validate.oneOf(req.query.status, [...db.payments.PAYMENT_STATUSES, 'all'], 'all');
    const purpose = validate.oneOf(req.query.purpose, [...db.payments.PURPOSES, 'all'], 'all');
    const provider = validate.oneOf(req.query.provider, [...db.payments.PROVIDERS, 'all'], 'all');
    const q = validate.text(req.query.q, 60) || null;
    const dealerId = validate.integer(req.query.dealer, { min: 1, fallback: 0 }) || null;
    const from = validate.text(req.query.from, 10) || null;
    const to = validate.text(req.query.to, 10) || null;

    const [list, ledger, statement, dealers, unpaidOrders, unpaidBookings, escrow, listings] = await Promise.all([
      db.payments.listPayments({
        status: status === 'all' ? null : status,
        purpose: purpose === 'all' ? null : purpose,
        provider: provider === 'all' ? null : provider,
        q,
        limit: 200,
      }),
      db.payments.ledgerSummary(),
      dealerId ? db.payments.ledgerFor(dealerId, { from, to }) : null,
      db.query('SELECT id, name, city FROM dealers ORDER BY name'),
      db.payments.listOrders({ status: 'pending_payment', limit: 50 }),
      db.query(
        `SELECT b.id, b.reference, b.name, b.amount_kobo, b.payment_status, b.slot_at
           FROM bookings b
          WHERE b.payment_status IN ('unpaid','pending') AND b.status NOT IN ('cancelled','completed')
          ORDER BY b.slot_at LIMIT 50`,
      ),
      db.payments.listMilestones({ limit: 1 }),
      db.query("SELECT id, stock_no, make, model, year FROM vehicle_listings ORDER BY stock_no LIMIT 300"),
    ]);

    return await page(req, res, {
      view: 'admin/payments',
      active: PATHS.payments,
      title: 'Money',
      description: 'Every payment in and out: statuses, receipts, refunds, and the dealer ledger.',
      data: {
        rows: list.rows,
        totals: list.totals,
        status,
        purpose,
        provider,
        q,
        statuses: db.payments.PAYMENT_STATUSES,
        purposes: db.payments.PURPOSES,
        providers: db.payments.PROVIDERS,
        availability: paymentService.availability(),
        providerLabels: paymentService.PROVIDER_LABELS,
        activeProvider: paymentService.activeProvider(),
        ledger,
        statement,
        dealerId,
        from,
        to,
        dealers,
        unpaidOrders: unpaidOrders.rows,
        unpaidBookings,
        escrowKobo: escrow.counts.heldKobo,
        listings,
        canApprove: roles.can(req.user.role, 'payments.approve'),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/payments/:id/confirm', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const note = validate.text(req.body.note, 160) || null;
    const result = await paymentService.confirmManually(id, { actorId: req.user.id, note });
    if (!result.ok) return done(res, PATHS.payments, result.error, { error: true });
    if (result.already) return done(res, PATHS.payments, 'That payment was already marked paid.');
    return done(res, PATHS.payments, `${result.payment.reference} marked paid and a receipt queued for the customer.`);
  } catch (error) {
    return next(error);
  }
});

router.post('/payments/:id/refund', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const amountKobo = money.nairaToKobo(req.body.amount);
    const reason = validate.text(req.body.reason, 200);
    if (!amountKobo) return done(res, PATHS.payments, 'Enter the refund amount in naira, e.g. ₦45,000.', { error: true });
    if (!reason) return done(res, PATHS.payments, 'A refund needs a reason — it goes on the audit log.', { error: true });
    const result = await paymentService.refund(id, { amountKobo, reason, actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.payments, result.error, { error: true });
    return done(res, PATHS.payments, `Refunded ${money.formatNaira(amountKobo)} against payment ${id}.`);
  } catch (error) {
    return next(error);
  }
});

/** Money that arrived outside a PSP: a transfer on the statement, cash at the lot. */
router.post('/payments/manual', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const amountKobo = money.nairaToKobo(req.body.amount);
    const purpose = validate.oneOf(req.body.purpose, db.payments.PURPOSES, null);
    const provider = validate.oneOf(req.body.provider, ['bank_transfer', 'cash', 'manual'], 'bank_transfer');
    if (!amountKobo) return done(res, PATHS.payments, 'Enter the amount in naira, e.g. ₦45,000.', { error: true });
    if (!purpose) return done(res, PATHS.payments, 'Choose what the money was for.', { error: true });

    const orderNo = validate.text(req.body.order_no, 40) || null;
    const bookingRef = validate.text(req.body.booking_reference, 40) || null;
    const order = orderNo ? await db.queryOne('SELECT id, order_no, name, phone, total_kobo FROM orders WHERE order_no = ? LIMIT 1', [orderNo]) : null;
    const booking = bookingRef ? await db.queryOne('SELECT id, reference, name, phone FROM bookings WHERE reference = ? LIMIT 1', [bookingRef]) : null;
    if (orderNo && !order) return done(res, PATHS.payments, `There is no order ${orderNo}.`, { error: true });
    if (bookingRef && !booking) return done(res, PATHS.payments, `There is no booking ${bookingRef}.`, { error: true });

    const result = await db.payments.recordManualPayment({
      purpose,
      amountKobo,
      provider,
      orderId: order ? order.id : null,
      bookingId: booking ? booking.id : null,
      customerName: validate.name(req.body.customer_name) || (order ? order.name : booking ? booking.name : null),
      customerPhone: validate.text(req.body.customer_phone, 20) || (order ? order.phone : booking ? booking.phone : null),
      note: validate.text(req.body.note, 160) || null,
      actorId: req.user.id,
    });
    if (!result.ok) return done(res, PATHS.payments, result.error, { error: true });

    // Whatever the money was for follows the money — but only once it is covered.
    if (booking) {
      await db.query("UPDATE bookings SET payment_status = 'paid' WHERE id = ?", [booking.id]);
    }
    if (order) {
      const paid = await db.queryOne(
        "SELECT COALESCE(SUM(amount_kobo - refund_kobo), 0) AS kobo FROM payments WHERE order_id = ? AND status IN ('paid','partially_refunded')",
        [order.id],
      );
      if (Number(paid.kobo || 0) >= Number(order.total_kobo || 0)) {
        await db.payments.setOrderStatus(order.id, 'paid', { actorId: req.user.id });
      }
    }
    return done(res, PATHS.payments, `Recorded ${money.formatNaira(amountKobo)} as ${result.reference}.`);
  } catch (error) {
    return next(error);
  }
});

/** Ask a customer for money: a pending payment plus a copyable bank instruction. */
router.post('/payments/request', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const amountKobo = money.nairaToKobo(req.body.amount);
    const purpose = validate.oneOf(req.body.purpose, db.payments.PURPOSES, 'booking');
    if (!amountKobo) return done(res, PATHS.payments, 'Enter the amount to request, e.g. ₦45,000.', { error: true });
    const bookingRef = validate.text(req.body.booking_reference, 40) || null;
    const orderNo = validate.text(req.body.order_no, 40) || null;
    const booking = bookingRef ? await db.queryOne('SELECT id, name, phone FROM bookings WHERE reference = ? LIMIT 1', [bookingRef]) : null;
    const order = orderNo ? await db.queryOne('SELECT id, name, phone FROM orders WHERE order_no = ? LIMIT 1', [orderNo]) : null;
    const name = validate.name(req.body.customer_name) || (booking ? booking.name : order ? order.name : null);
    const phone = validate.text(req.body.customer_phone, 20) || (booking ? booking.phone : order ? order.phone : null);
    if (!name || !phone) return done(res, PATHS.payments, 'A payment request needs a customer name and phone.', { error: true });

    const result = await paymentService.initiate({
      provider: validate.oneOf(req.body.provider, db.payments.PROVIDERS, null),
      purpose,
      amountKobo,
      bookingId: booking ? booking.id : null,
      orderId: order ? order.id : null,
      customerName: name,
      customerPhone: phone,
      actorId: req.user.id,
    });
    if (!result.ok) return done(res, PATHS.payments, result.error, { error: true });
    return done(res, PATHS.payments, `${result.reference} is ready for ${name} — the request message is on the message log.`);
  } catch (error) {
    return next(error);
  }
});

/** Append to the dealer ledger. Corrections are new rows, never edits. */
router.post('/ledger', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const dealerId = validate.integer(req.body.dealer_id, { min: 1, fallback: 0 });
    const entryType = validate.oneOf(req.body.entry_type, db.payments.LEDGER_ENTRY_TYPES, null);
    const magnitude = money.nairaToKobo(req.body.amount);
    if (!dealerId) return done(res, PATHS.payments, 'Choose the dealer this entry belongs to.', { error: true });
    if (!entryType) return done(res, PATHS.payments, 'Choose the entry type.', { error: true });
    if (!magnitude) return done(res, PATHS.payments, 'Enter the amount in naira, e.g. ₦250,000.', { error: true });
    const signed = String(req.body.direction || 'in') === 'out' ? -magnitude : magnitude;

    const result = await db.payments.addLedgerEntry({
      dealerId,
      entryType,
      amountKobo: signed,
      listingId: validate.integer(req.body.listing_id, { min: 1, fallback: 0 }) || null,
      reference: validate.text(req.body.reference, 40) || null,
      detail: validate.text(req.body.detail, 200) || null,
      actorId: req.user.id,
    });
    return result.ok
      ? done(res, `${PATHS.payments}?dealer=${dealerId}`, `Ledger entry added: ${money.formatNaira(magnitude)} ${signed < 0 ? 'paid out' : 'recorded'}.`)
      : done(res, PATHS.payments, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Milestone tracker (§7.3 escrow: funds → inspection → documents → released)
// ---------------------------------------------------------------------------
router.get('/milestones', auth.requireStaff('payments.view'), async (req, res, next) => {
  try {
    const stage = validate.oneOf(req.query.stage, [...db.payments.MILESTONE_STAGES, 'cancelled'], null);
    const [list, listings, bookings] = await Promise.all([
      db.payments.listMilestones({ stage, limit: 200 }),
      db.query("SELECT id, stock_no, make, model, year FROM vehicle_listings WHERE status IN ('live','reserved','sold') ORDER BY stock_no LIMIT 200"),
      db.query("SELECT id, reference, name, phone, slot_at FROM bookings WHERE status <> 'cancelled' ORDER BY slot_at DESC LIMIT 60"),
    ]);
    return await page(req, res, {
      view: 'admin/milestones',
      active: PATHS.milestones,
      title: 'Escrow',
      description: 'Protected purchases and parts escrow — one stage at a time, with a human on every release.',
      data: {
        rows: list.rows,
        counts: list.counts,
        stages: db.payments.MILESTONE_STAGES,
        kinds: db.payments.MILESTONE_KINDS,
        stage,
        listings,
        bookings,
        canApprove: roles.can(req.user.role, 'payments.approve'),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/milestones', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const amountKobo = money.nairaToKobo(req.body.amount);
    const kind = validate.oneOf(req.body.kind, db.payments.MILESTONE_KINDS, 'protected_purchase');
    if (!amountKobo) return done(res, PATHS.milestones, 'Enter the amount held, e.g. ₦500,000.', { error: true });
    const result = await db.payments.createMilestone({
      kind,
      subject: validate.text(req.body.subject, 200),
      listingId: validate.integer(req.body.listing_id, { min: 1, fallback: 0 }) || null,
      bookingId: validate.integer(req.body.booking_id, { min: 1, fallback: 0 }) || null,
      customerName: validate.name(req.body.customer_name),
      customerPhone: validate.text(req.body.customer_phone, 20),
      amountKobo,
      actorId: req.user.id,
    });
    return result.ok
      ? done(res, PATHS.milestones, `${result.reference} is tracking ${money.formatNaira(amountKobo)}.`)
      : done(res, PATHS.milestones, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/milestones/:id/stage', auth.requireStaff('payments.approve'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const to = validate.oneOf(req.body.to, [...db.payments.MILESTONE_STAGES, 'cancelled'], null);
    const note = validate.text(req.body.note, 200) || null;
    if (!to) return done(res, PATHS.milestones, 'Choose the stage to move to.', { error: true });
    const result = await db.payments.advanceMilestone(id, { to, note, actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.milestones, result.error, { error: true });
    await paymentService.notifyMilestone(result.milestone, { actorId: req.user.id }).catch(() => {});
    const verb = to === 'released' ? 'released to the seller' : `moved to ${to.replace(/_/g, ' ')}`;
    return done(res, PATHS.milestones, `${result.milestone.reference} ${verb}.`);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// The inspection report (FR-07) — staff print view and the client PDF
// ---------------------------------------------------------------------------
/** Shared gate: the assigned inspector, or anyone who may dispatch work. */
async function reportAccess(req, bookingId) {
  const booking = await db.queryOne('SELECT id, reference, inspector_id FROM bookings WHERE id = ? LIMIT 1', [bookingId]);
  if (!booking) return { ok: false, status: 404, error: 'That job no longer exists.' };
  const isOwner = Number(booking.inspector_id) === Number(req.user.id);
  if (!isOwner && !roles.can(req.user.role, 'bookings.dispatch')) {
    return { ok: false, status: 403, error: 'That job is not assigned to you.' };
  }
  const built = await report.build(bookingId);
  if (!built) return { ok: false, status: 404, error: 'That job no longer exists.' };
  return { ok: true, report: built };
}

router.get('/jobs/:id/report', auth.requireAnyStaff(['bookings.own_jobs', 'bookings.dispatch']), async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const access = await reportAccess(req, id);
    if (!access.ok) return done(res, PATHS.jobs, access.error, { error: true });

    return await sendPage(req, res, {
      routePath: req.path,
      view: 'report-inspection',
      cache: CACHE.private,
      page: {
        title: `Inspection report ${access.report.reference}`,
        metaTitle: `Inspection report ${access.report.reference}`,
        titleSuffix: false,
        description: 'The client-facing pre-purchase inspection report.',
        canonical: `/admin/jobs/${id}/report`,
        robots: 'noindex,nofollow',
        bodyClass: 'page-report',
        jsonLd: [],
      },
      data: { report: access.report, pdfUrl: `/admin/jobs/${id}/report.pdf`, backHref: PATHS.jobs, backLabel: 'Back to my jobs' },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/jobs/:id/report.pdf', auth.requireAnyStaff(['bookings.own_jobs', 'bookings.dispatch']), async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const access = await reportAccess(req, id);
    if (!access.ok) return res.status(access.status).json({ ok: false, error: access.error });
    if (!access.report.ready) {
      return res.status(409).json({ ok: false, error: 'The checklist has not been filed yet, so there is no report to print.' });
    }
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${report.fileName(access.report)}"`,
      'Cache-Control': 'private, no-store',
    });
    return report.pdf(access.report).pipe(res);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Staff, roles & audit (§7.3, §7.4)
// ---------------------------------------------------------------------------
router.get('/staff', auth.requireStaff('users.manage'), async (req, res, next) => {
  try {
    const [staff, customers, dealerAccounts, unclaimedLots] = await Promise.all([
      admin.staffList(),
      admin.customerCount(),
      dealers.dealerAccounts(),
      dealers.unclaimed(50),
    ]);
    return await page(req, res, {
      view: 'admin/staff',
      active: PATHS.staff,
      title: 'Staff & roles',
      description: 'Who is staff, what they may do, the dealer onboarding list, and the watchlist.',
      data: {
        staff,
        customers,
        dealerAccounts,
        unclaimedLots,
        roleLabels: roles.ROLE_LABELS,
        matrix: roles.MATRIX,
        capabilitiesFor: roles.capabilitiesFor,
        assignableRoles: roles.ROLES,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/staff/:id/role', auth.requireStaff('users.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const role = validate.oneOf(req.body.role, roles.ROLES, null);
    if (Number(id) === Number(req.user.id) && role !== 'admin') {
      return done(res, PATHS.staff, 'You cannot drop your own admin role — ask another admin.', { error: true });
    }
    const result = await admin.setRole(id, role, { actorId: req.user.id });
    return result.ok
      ? done(res, PATHS.staff, `Role set to ${roles.ROLE_LABELS[role] || role}.`)
      : done(res, PATHS.staff, result.error, { error: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * §7.2 onboarding: link a dealer-role account to the lot it runs. One account
 * owns one lot (`dealers.user_id` is unique), and the portal derives everything
 * from that link — so this is the switch that turns a login into a portal.
 */
router.post('/staff/dealer-link', auth.requireStaff('users.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const dealerId = validate.integer(req.body.dealer_id, { min: 1, fallback: 0 });
    const userId = validate.integer(req.body.user_id, { min: 1, fallback: 0 });
    const result = await dealers.linkUser(dealerId, userId);
    if (!result.ok) return done(res, PATHS.staff, result.error, { error: true });
    const lot = await dealers.byId(dealerId);
    const account = (await dealers.dealerAccounts()).find((row) => row.id === userId);
    await admin.recordAudit({
      actorId: req.user.id,
      action: 'dealer.account.linked',
      entity: 'dealer',
      entityId: dealerId,
      detail: { lot: lot.name, accountId: userId, account: account ? account.name : null, phone: account ? account.phone : null },
    });
    return done(res, PATHS.staff, `${account ? account.name : 'The account'} now runs ${lot.name} — the dealer portal is open to them.`);
  } catch (error) {
    return next(error);
  }
});

router.post('/staff/dealer-unlink', auth.requireStaff('users.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const dealerId = validate.integer(req.body.dealer_id, { min: 1, fallback: 0 });
    const lot = await dealers.byId(dealerId);
    if (!lot) return done(res, PATHS.staff, 'That lot does not exist.', { error: true });
    await dealers.unlinkUser(dealerId);
    await admin.recordAudit({
      actorId: req.user.id,
      action: 'dealer.account.unlinked',
      entity: 'dealer',
      entityId: dealerId,
      detail: { lot: lot.name, note: 'The portal closes for that login until a lot is linked again.' },
    });
    return done(res, PATHS.staff, `${lot.name} is no longer linked to a sign-in.`);
  } catch (error) {
    return next(error);
  }
});

router.post('/staff/:id/watchlist', auth.requireStaff('users.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    await admin.setWatchlist(id, String(req.body.watchlisted || '') === '1', { actorId: req.user.id });
    return done(res, PATHS.staff, 'Watchlist updated.');
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Deal alerts — FR-25. The two switches on /account ("price drops", "new
// matches") have a sending side, and this is where ops can see what it is
// watching, run it by hand, and read every message it produced.
// ---------------------------------------------------------------------------
router.get('/alerts', auth.requireStaff('intel.manage'), async (req, res, next) => {
  try {
    const [watch, recent] = await Promise.all([
      alertsService.watchList(),
      alertsService.recentAlerts({ limit: 40 }),
    ]);
    return await page(req, res, {
      view: 'admin/alerts',
      active: PATHS.alerts,
      title: 'Deal alerts',
      description: 'Saved cars watching a price, saved searches watching new stock, and every alert sent.',
      data: { watch, recent, maxPerRun: alertsService.MAX_ALERTS_PER_RUN },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/alerts/run', auth.requireStaff('intel.manage'), async (req, res, next) => {
  try {
    const dryRun = String(req.body.dry_run || '') === '1';
    const report = await alertsService.runWatch({ dryRun, userId: validate.integer(req.body.user_id, { min: 1 }) || null });
    const summary = [
      `${report.checked.cars} saved car${report.checked.cars === 1 ? '' : 's'}, ${report.checked.searches} saved search${report.checked.searches === 1 ? '' : 'es'}`,
      report.priceDrops.length ? `${report.priceDrops.length} price drop${report.priceDrops.length === 1 ? '' : 's'}` : null,
      report.newMatches.length ? `${report.newMatches.length} new match${report.newMatches.length === 1 ? '' : 'es'}` : null,
      report.skipped.length ? `${report.skipped.length} not delivered (recorded as skipped)` : null,
      dryRun ? 'dry run — nothing sent or written' : null,
    ].filter(Boolean).join(' · ');
    return done(res, PATHS.alerts, `Watch run: ${summary}.`);
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Inventory pricing intel — §7.3. The price-band table per make/model/year
// that feeds the price-position indicator on every VDP (§3.5), the weekly
// update form, and the audit history of who moved which band.
// §7.4: admin and ops manage it, marketing may read it, nobody else sees it.
// ---------------------------------------------------------------------------
router.get('/intel', auth.requireStaff('pricing.view'), async (req, res, next) => {
  try {
    const q = validate.text(req.query.q, 60) || null;
    const staleOnly = String(req.query.stale || '') === '1';
    const editId = validate.integer(req.query.edit, { min: 1, fallback: 0 });
    // The gap list links straight into the form, so ops never re-types a
    // make/model the database already knows.
    const prefill = {
      make: validate.text(req.query.make, 60) || '',
      model: validate.text(req.query.model, 80) || '',
      yearFrom: validate.integer(req.query.year_from, { min: 1950, max: 2100, fallback: '' }),
      yearTo: validate.integer(req.query.year_to, { min: 1950, max: 2100, fallback: '' }),
      condition: validate.oneOf(req.query.condition, db.pricing.CONDITIONS, 'any'),
      min: validate.text(req.query.min, 20) || '',
      max: validate.text(req.query.max, 20) || '',
      sample: validate.text(req.query.sample, 6) || '',
    };
    const [rows, stats, gaps, edit, history] = await Promise.all([
      db.pricing.bands({ q, staleOnly, limit: 300 }),
      db.pricing.coverage(),
      db.pricing.gaps({ limit: 40 }),
      editId ? db.pricing.bandById(editId) : Promise.resolve(null),
      admin.auditLog({ limit: 40, entity: 'price_band' }),
    ]);
    return await page(req, res, {
      view: 'admin/intel',
      active: PATHS.intel,
      title: 'Price intel',
      description: 'Market price bands per make, model and year — the table behind the price-position indicator.',
      data: {
        rows,
        stats,
        gaps,
        edit,
        history,
        q,
        staleOnly,
        prefill,
        conditions: db.pricing.CONDITIONS,
        conditionLabels: db.pricing.CONDITION_LABELS,
        canManage: roles.can(req.user.role, 'pricing.manage'),
      },
    });
  } catch (error) {
    return next(error);
  }
});

/** The weekly update form. Creates a band or moves the existing one. */
router.post('/intel/bands', auth.requireStaff('pricing.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const result = await db.pricing.upsertBand({
      make: validate.text(req.body.make, 60),
      model: validate.text(req.body.model, 80),
      yearFrom: validate.integer(req.body.year_from, { min: 1950, max: 2100 }),
      yearTo: validate.integer(req.body.year_to, { min: 1950, max: 2100 }),
      condition: validate.oneOf(req.body.condition, db.pricing.CONDITIONS, 'any'),
      minKobo: money.nairaToKobo(req.body.band_min),
      maxKobo: money.nairaToKobo(req.body.band_max),
      sampleSize: validate.integer(req.body.sample_size, { min: 0, max: 9999, fallback: 0 }),
      actorId: req.user.id,
    });
    if (!result.ok) return done(res, PATHS.intel, result.error, { error: true, params: `q=${encodeURIComponent(req.body.make || '')}` });
    const { band } = result;
    const label = `${band.make} ${band.model} ${band.yearFrom}–${band.yearTo} (${band.conditionLabel})`;
    return done(
      res,
      PATHS.intel,
      result.created
        ? `Band created for ${label}: ${money.formatNaira(band.minKobo)}–${money.formatNaira(band.maxKobo)}.`
        : `Band updated for ${label}: ${money.formatNaira(band.minKobo)}–${money.formatNaira(band.maxKobo)}.`,
    );
  } catch (error) {
    return next(error);
  }
});

/** "Still accurate" — re-stamps the week without touching a number. */
router.post('/intel/bands/:id/refresh', auth.requireStaff('pricing.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    const result = await db.pricing.refreshBand(id, { actorId: req.user.id });
    if (!result.ok) return done(res, PATHS.intel, result.error, { error: true });
    const { band } = result;
    return done(res, PATHS.intel, `${band.make} ${band.model} ${band.yearFrom}–${band.yearTo} checked against ${band.sampleSize} comparables today.`);
  } catch (error) {
    return next(error);
  }
});

router.get('/audit', auth.requireStaff('users.manage'), async (req, res, next) => {
  try {
    const entity = validate.text(req.query.entity, 40) || null;
    const rows = await admin.auditLog({ limit: 200, entity });
    return await page(req, res, {
      view: 'admin/audit',
      active: PATHS.audit,
      title: 'Audit log',
      description: 'Every sensitive action: publishes, grade changes, price overrides, dispatch and roles.',
      data: { rows, entity },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router };
