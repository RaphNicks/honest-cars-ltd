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
const { sendPage, CACHE } = require('../lib/respond');

const router = express.Router();
const admin = db.admin;

const HOME = '/admin';
const PATHS = {
  listings: `${HOME}/listings`,
  leads: `${HOME}/leads`,
  concierge: `${HOME}/concierge`,
  bookings: `${HOME}/bookings`,
  jobs: `${HOME}/jobs`,
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
// Staff, roles & audit (§7.3, §7.4)
// ---------------------------------------------------------------------------
router.get('/staff', auth.requireStaff('users.manage'), async (req, res, next) => {
  try {
    const [staff, customers] = await Promise.all([admin.staffList(), admin.customerCount()]);
    return await page(req, res, {
      view: 'admin/staff',
      active: PATHS.staff,
      title: 'Staff & roles',
      description: 'Who is staff, what they may do, and the watchlist.',
      data: {
        staff,
        customers,
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

router.post('/staff/:id/watchlist', auth.requireStaff('users.manage'), auth.sameOriginOnly, async (req, res, next) => {
  try {
    const id = validate.integer(req.params.id, { min: 1, fallback: 0 });
    await admin.setWatchlist(id, String(req.body.watchlisted || '') === '1', { actorId: req.user.id });
    return done(res, PATHS.staff, 'Watchlist updated.');
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
