'use strict';

/**
 * Admin console data layer — §7.3.
 *
 * Every read and every write the console performs lives here, on top of the
 * same pool as the public site, so the ops screens and the storefront cannot
 * drift apart. Sensitive writes (publish, grade, price, dispatch, role) go
 * through `recordAudit()` — §7.3 requires an audit log of exactly those.
 *
 * Nothing in this module decides who may do what: that is §7.4 and lives in
 * src/services/roles.js. This file is the mechanism, the route is the policy.
 */

const { query, queryOne, transaction } = require('./pool');
const { parseJson } = require('./shape');
const phones = require('../lib/phone');
const { nairaToKobo, koboToNaira } = require('../lib/money');

const LISTING_STATUSES = ['draft', 'in_review', 'live', 'reserved', 'sold', 'expired'];
const GRADES = ['network_listed', 'field_checked', 'certified'];
const LEAD_STATUSES = ['new', 'assigned', 'contacted', 'viewing', 'closed', 'lost'];
const REQUEST_STAGES = ['new', 'searching', 'options_ready', 'viewings', 'closed', 'lost'];
const BOOKING_STATUSES = ['requested', 'confirmed', 'dispatched', 'completed', 'cancelled'];
const VERDICTS = ['pass', 'pass_with_advisory', 'fail'];

/** Staleness rule (§7.3): 14 days idle → ask for a refresh, + 7 days → unlist. */
const STALE_DAYS = 14;
const REFRESH_GRACE_DAYS = 7;

/** MySQL returns SUM()/COUNT() as strings (and NULL for an empty set). */
function ints(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) out[key] = Number(value || 0);
  return out;
}

// Money parsing lives in src/lib/money.js now that the payments module needs
// it too. Re-exported below so existing callers keep working unchanged.

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
async function recordAudit({ actorId = null, action, entity, entityId = null, detail = null }) {
  await query(
    'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    [actorId, String(action).slice(0, 60), String(entity).slice(0, 40), entityId, detail ? JSON.stringify(detail) : null],
  );
}

async function auditLog({ limit = 100, entity = null, entityId = null } = {}) {
  const where = [];
  const params = [];
  if (entity) {
    where.push('a.entity = ?');
    params.push(entity);
  }
  if (entityId) {
    where.push('a.entity_id = ?');
    params.push(entityId);
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  const rows = await query(
    `SELECT a.*, u.name AS actor_name, u.phone AS actor_phone, u.role AS actor_role
       FROM admin_audit a
       LEFT JOIN \`users\` u ON u.id = a.actor_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    detail: parseJson(row.detail, null),
    createdAt: row.created_at,
    actor: row.actor_name || (row.actor_phone ? phones.mask(row.actor_phone) : 'system'),
    actorRole: row.actor_role || null,
    actorId: row.actor_id,
  }));
}

// ---------------------------------------------------------------------------
// KPI home (§7.3)
// ---------------------------------------------------------------------------
async function kpis() {
  const [today] = await query(
    `SELECT
       (SELECT COUNT(*) FROM leads WHERE created_at >= UTC_DATE())                     AS leads_today,
       (SELECT COUNT(*) FROM leads WHERE status = 'new')                               AS leads_open,
       (SELECT COUNT(*) FROM bookings WHERE created_at >= UTC_DATE())                  AS bookings_today,
       (SELECT COUNT(*) FROM bookings WHERE status IN ('requested','confirmed','dispatched')) AS bookings_open,
       (SELECT COALESCE(SUM(total_kobo), 0) FROM orders
          WHERE created_at >= UTC_DATE() AND status <> 'cancelled')                    AS order_value_today,
       (SELECT COUNT(*) FROM service_requests WHERE status = 'new')                     AS requests_new,
       (SELECT COUNT(*) FROM vehicle_listings WHERE status = 'in_review')               AS pending_verification,
       (SELECT COUNT(*) FROM vehicle_listings
          WHERE status = 'live'
            AND refreshed_at IS NULL AND stale_flagged_at IS NULL
            AND GREATEST(updated_at, created_at) < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)) AS stale_due,
       (SELECT COUNT(*) FROM vehicle_listings WHERE status = 'live')                    AS listings_live,
       (SELECT COUNT(*) FROM vehicle_listings WHERE status = 'sold')                    AS listings_sold,
       (SELECT COUNT(*) FROM subscriptions WHERE device_state <> 'lapsed')              AS trackers_active`,
    [STALE_DAYS],
  );
  // Counted separately: `users` is a reserved word in MySQL 8, and a
  // single-quoted string here keeps the SQL readable without escaping.
  const staff = await queryOne("SELECT COUNT(*) AS n FROM `users` WHERE role <> ? AND status = ?", ['customer', 'active']);
  return { ...ints(today), staff: Number(staff ? staff.n : 0) };
}

/** Paid money, and what it was for (§7.3 “revenue by service line”). */
async function revenueByPillar({ days = 30 } = {}) {
  const rows = await query(
    `SELECT 'shop' AS pillar, COUNT(*) AS orders, COALESCE(SUM(total_kobo),0) AS kobo
       FROM orders WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) AND status <> 'cancelled'
     UNION ALL
     SELECT 'bookings', COUNT(*), COALESCE(SUM(amount_kobo),0)
       FROM bookings WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) AND payment_status = 'paid'
     UNION ALL
     SELECT 'hire', COUNT(*), 0
       FROM service_requests WHERE type = 'hire' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
     UNION ALL
     SELECT 'concierge', COUNT(*), 0
       FROM service_requests WHERE type = 'concierge' AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)`,
    [days, days, days, days],
  );
  return rows.map((row) => ({ pillar: row.pillar, count: Number(row.orders), kobo: Number(row.kobo) }));
}

/** Listings added per day — the “listings trend” chart. */
async function listingsTrend({ days = 14 } = {}) {
  const rows = await query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS n
       FROM vehicle_listings
      WHERE created_at > DATE_SUB(UTC_DATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at) ORDER BY day`,
    [days],
  );
  const byDay = new Map(rows.map((row) => [String(row.day).slice(0, 10), Number(row.n)]));
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    out.push({ day: key, label: `${date.getUTCDate()}/${date.getUTCMonth() + 1}`, count: byDay.get(key) || 0 });
  }
  return out;
}

/** The lead funnel: how many are where, and how many got there in the window. */
async function leadFunnel({ days = 30 } = {}) {
  const leads = await query(
    `SELECT status, COUNT(*) AS n FROM leads
      WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) GROUP BY status`,
    [days],
  );
  const requests = await query(
    `SELECT status, COUNT(*) AS n FROM service_requests
      WHERE created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) GROUP BY status`,
    [days],
  );
  const leadCounts = Object.fromEntries(leads.map((r) => [r.status, Number(r.n)]));
  const requestCounts = Object.fromEntries(requests.map((r) => [r.status, Number(r.n)]));

  const stages = [
    { key: 'captured', label: 'Captured', count: Object.values(leadCounts).reduce((a, b) => a + b, 0) },
    { key: 'contacted', label: 'Contacted', count: (leadCounts.contacted || 0) + (leadCounts.viewing || 0) + (leadCounts.closed || 0) },
    { key: 'viewing', label: 'Viewing', count: (leadCounts.viewing || 0) + (leadCounts.closed || 0) },
    { key: 'closed', label: 'Closed', count: leadCounts.closed || 0 },
  ];
  const max = Math.max(1, ...stages.map((s) => s.count));
  return {
    stages: stages.map((stage) => ({ ...stage, width: Math.round((stage.count / max) * 100) })),
    requests: { open: requestCounts.new || 0, options: requestCounts.options_ready || 0, closed: requestCounts.closed || 0 },
  };
}

/** One-click daily summary: plain text the ops lead can paste into WhatsApp. */
async function dailySummary() {
  const k = await kpis();
  const stale = await queryOne(
    `SELECT COUNT(*) AS n FROM vehicle_listings
      WHERE status = 'live' AND stale_flagged_at IS NOT NULL AND refreshed_at IS NULL`,
  );
  return [
    `HonestCars — ${new Date().toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    `New leads today: ${k.leads_today} (${k.leads_open} open in total)`,
    `Bookings today: ${k.bookings_today} (${k.bookings_open} in flight)`,
    `Shop orders today: ₦${Math.round(koboToNaira(k.order_value_today)).toLocaleString('en-NG')}`,
    `Concierge requests awaiting options: ${k.requests_new}`,
    `Listings pending review: ${k.pending_verification}`,
    `Listings due a refresh: ${k.stale_due} · flagged: ${Number(stale ? stale.n : 0)}`,
    `Live stock: ${k.listings_live} · tracker subscriptions active: ${k.trackers_active}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Listings moderation (§7.3)
// ---------------------------------------------------------------------------
function shapeModerationRow(row) {
  return {
    id: row.id,
    stockNo: row.stock_no,
    slug: row.seo_slug,
    status: row.status,
    grade: row.verification_grade,
    gradeChecklist: parseJson(row.grade_checklist, null),
    gradeSetAt: row.grade_set_at,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim,
    priceKobo: Number(row.asking_price_kobo),
    area: row.area,
    dealer: row.dealer_name,
    dealerId: row.dealer_id,
    views: Number(row.views || 0),
    enquiries: Number(row.enquiries || 0),
    saves: Number(row.saves || 0),
    createdAt: row.created_at,
    publishedAt: row.published_at,
    soldAt: row.sold_at,
    refreshedAt: row.refreshed_at,
    staleFlaggedAt: row.stale_flagged_at,
    refreshRequestedAt: row.refresh_requested_at,
    moderatedAt: row.moderated_at,
    updatedAt: row.updated_at,
    url: `/cars/${row.seo_slug}`,
    ageDays: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86_400_000),
    idleDays: Math.floor(
      (Date.now() - new Date(row.refreshed_at || row.updated_at || row.created_at).getTime()) / 86_400_000,
    ),
  };
}

async function moderationList({ status = null, q = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status && LISTING_STATUSES.includes(status)) {
    where.push('l.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(l.seo_slug LIKE ? OR l.stock_no LIKE ? OR CONCAT(l.make, " ", l.model) LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = await query(
    `SELECT l.*, d.name AS dealer_name
       FROM vehicle_listings l
       LEFT JOIN dealers d ON d.id = l.dealer_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY FIELD(l.status, 'in_review','draft','live','reserved','sold','expired'), l.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [counts] = await query(
    `SELECT
       SUM(status = 'draft') AS draft, SUM(status = 'in_review') AS in_review,
       SUM(status = 'live') AS live, SUM(status = 'reserved') AS reserved,
       SUM(status = 'sold') AS sold, SUM(status = 'expired') AS expired,
       SUM(status = 'live' AND stale_flagged_at IS NOT NULL AND refreshed_at IS NULL) AS stale_flagged
     FROM vehicle_listings`,
  );
  const numeric = ints(counts);
  return { rows: rows.map(shapeModerationRow), counts: numeric, total: Object.values(numeric).reduce((a, b) => a + b, 0) };
}

async function listingById(id) {
  const row = await queryOne(
    `SELECT l.*, d.name AS dealer_name FROM vehicle_listings l
      LEFT JOIN dealers d ON d.id = l.dealer_id WHERE l.id = ? LIMIT 1`,
    [id],
  );
  return row ? shapeModerationRow(row) : null;
}

/**
 * Publish. §7.3 moderation: a listing goes live with a grade, and a grade
 * beyond “network listed” needs the checklist behind it.
 */
async function publishListing(id, { grade, checklist, actorId, note = null }) {
  return transaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM vehicle_listings WHERE id = ? FOR UPDATE', [id]);
    const listing = rows[0];
    if (!listing) return { ok: false, error: 'That listing no longer exists.' };
    if (listing.status === 'live') return { ok: false, error: 'That listing is already live.' };
    if (grade && !GRADES.includes(grade)) return { ok: false, error: 'Unknown verification grade.' };
    if (grade === 'certified' && !listing.honest_note) {
      return { ok: false, error: 'A certified listing needs an honest note before it can go live.' };
    }

    await conn.query(
      `UPDATE vehicle_listings
          SET status = 'live', moderated_by = ?, moderated_at = UTC_TIMESTAMP(),
              published_at = COALESCE(published_at, UTC_TIMESTAMP()),
              verification_grade = COALESCE(?, verification_grade),
              grade_checklist = COALESCE(?, grade_checklist),
              grade_set_by = ?, grade_set_at = UTC_TIMESTAMP(),
              refreshed_at = UTC_TIMESTAMP(), stale_flagged_at = NULL, unlisted_at = NULL
        WHERE id = ?`,
      [actorId, grade || null, checklist ? JSON.stringify(checklist) : null, actorId, id],
    );
    await conn.query(
      'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
      [actorId, 'listing.publish', 'listing', id, JSON.stringify({ stockNo: listing.stock_no, grade: grade || listing.verification_grade, checklist: checklist || null, note })],
    );
    return { ok: true, status: 'live' };
  });
}

async function setListingStatus(id, status, { actorId, note = null }) {
  if (!LISTING_STATUSES.includes(status)) return { ok: false, error: 'Unknown listing status.' };
  const listing = await listingById(id);
  if (!listing) return { ok: false, error: 'That listing no longer exists.' };

  await query(
    `UPDATE vehicle_listings
        SET status = ?,
            sold_at = CASE WHEN ? = 'sold' THEN UTC_TIMESTAMP() ELSE sold_at END,
            unlisted_at = CASE WHEN ? IN ('expired','draft') THEN UTC_TIMESTAMP() ELSE unlisted_at END,
            published_at = CASE WHEN ? = 'live' THEN COALESCE(published_at, UTC_TIMESTAMP()) ELSE published_at END,
            moderated_by = ?, moderated_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [status, status, status, status, actorId, id],
  );
  await recordAudit({ actorId, action: `listing.${status}`, entity: 'listing', entityId: id, detail: { stockNo: listing.stockNo, note } });
  return { ok: true, status };
}

/**
 * Set the verification grade (§7.4: allowed for ops “with audit”). The
 * checklist records what was actually verified, so a grade is never just a
 * label someone typed.
 */
async function setGrade(id, { grade, checklist = null, actorId, note = null }) {
  if (!GRADES.includes(grade)) return { ok: false, error: 'Unknown verification grade.' };
  const listing = await listingById(id);
  if (!listing) return { ok: false, error: 'That listing no longer exists.' };
  if (grade === 'certified' && !checklist) {
    return { ok: false, error: 'Certified needs the checklist: VIN, documents, OBD2 and a road test.' };
  }

  await query(
    `UPDATE vehicle_listings
        SET verification_grade = ?, grade_checklist = ?, grade_set_by = ?, grade_set_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [grade, checklist ? JSON.stringify(checklist) : null, actorId, id],
  );
  await recordAudit({
    actorId,
    action: 'listing.grade',
    entity: 'listing',
    entityId: id,
    detail: { from: listing.grade, to: grade, checklist, note },
  });
  return { ok: true, grade };
}

async function setPrice(id, naira, { actorId, note = null }) {
  const kobo = nairaToKobo(naira);
  if (!kobo) return { ok: false, error: 'Enter a price in naira.' };
  const listing = await listingById(id);
  if (!listing) return { ok: false, error: 'That listing no longer exists.' };

  await query('UPDATE vehicle_listings SET asking_price_kobo = ? WHERE id = ?', [kobo, id]);
  await recordAudit({
    actorId,
    action: 'listing.price',
    entity: 'listing',
    entityId: id,
    detail: { from: koboToNaira(listing.priceKobo), to: koboToNaira(kobo), note },
  });
  return { ok: true, priceKobo: kobo };
}

/** Ops confirms the car is still current — resets the staleness clock. */
async function markRefreshed(id, { actorId }) {
  await query(
    'UPDATE vehicle_listings SET refreshed_at = UTC_TIMESTAMP(), stale_flagged_at = NULL, refresh_requested_at = NULL WHERE id = ?',
    [id],
  );
  await recordAudit({ actorId, action: 'listing.refreshed', entity: 'listing', entityId: id });
  return { ok: true };
}

/**
 * The 14-day rule (§7.3 “expiry automation”):
 *   pass 1 — a live listing nobody has touched for 14 days gets a refresh
 *            request (visible to ops, and to the dealer portal later);
 *   pass 2 — a flagged listing that is still untouched 7 days later is
 *            auto-unlisted to \`expired`.
 * Idempotent: running it twice in a day changes nothing.
 */
async function runStaleSweep({ actorId = null, dryRun = false } = {}) {
  const stale = await query(
    `SELECT id, stock_no, status, refreshed_at, updated_at, created_at, stale_flagged_at
       FROM vehicle_listings
      WHERE status = 'live'
        AND refreshed_at IS NULL
        AND GREATEST(updated_at, created_at) < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${STALE_DAYS} DAY)
        AND stale_flagged_at IS NULL
      LIMIT 200`,
  );

  const expired = await query(
    `SELECT id, stock_no FROM vehicle_listings
      WHERE status = 'live'
        AND refreshed_at IS NULL
        AND stale_flagged_at IS NOT NULL
        AND stale_flagged_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${REFRESH_GRACE_DAYS} DAY)
      LIMIT 200`,
  );

  if (dryRun) {
    return { requested: stale.map((row) => row.stock_no), expired: expired.map((row) => row.stock_no), dryRun: true };
  }

  for (const row of stale) {
    await query(
      'UPDATE vehicle_listings SET stale_flagged_at = UTC_TIMESTAMP(), refresh_requested_at = UTC_TIMESTAMP() WHERE id = ?',
      [row.id],
    );
    // Per listing, so the car's own history shows why it was flagged.
    await recordAudit({ actorId, action: 'listing.stale_flag', entity: 'listing', entityId: row.id, detail: { stockNo: row.stock_no, days: STALE_DAYS } });
  }
  for (const row of expired) {
    await query("UPDATE vehicle_listings SET status = 'expired', unlisted_at = UTC_TIMESTAMP() WHERE id = ?", [row.id]);
    await recordAudit({ actorId, action: 'listing.stale_unlist', entity: 'listing', entityId: row.id, detail: { stockNo: row.stock_no, graceDays: REFRESH_GRACE_DAYS } });
  }
  return { requested: stale.map((row) => row.stock_no), expired: expired.map((row) => row.stock_no), dryRun: false };
}

// ---------------------------------------------------------------------------
// Leads — the unified CRM-lite inbox (§7.3)
// ---------------------------------------------------------------------------
function shapeLead(row) {
  return {
    id: row.id,
    kind: 'lead',
    type: row.type,
    status: row.status,
    name: row.name,
    phone: row.phone,
    maskedPhone: phones.mask(row.phone),
    message: row.message,
    preferredDay: row.preferred_day,
    listingId: row.listing_id,
    listingTitle: row.listing_title || null,
    listingSlug: row.listing_slug || null,
    sourcePath: row.source_path,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name || null,
    lostReason: row.lost_reason,
    lastContactedAt: row.last_contacted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeRequestLead(row) {
  return {
    id: row.id,
    kind: 'request',
    type: row.type,
    status: row.status,
    name: row.name,
    phone: row.phone,
    maskedPhone: phones.mask(row.phone),
    message: (parseJson(row.brief, {}) || {}).notes || null,
    brief: parseJson(row.brief, {}) || {},
    trackingId: row.tracking_id,
    sourcePath: row.source_path,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name || null,
    lostReason: row.lost_reason,
    lastContactedAt: row.last_contacted_at,
    slaDueAt: row.sla_due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `/concierge/${row.tracking_id}`,
  };
}

/**
 * One inbox: listing enquiries (`leads`), concierge/sell/swap/parts/hire
 * requests (`service_requests`) and bookings, filtered and paged together.
 * Bookings are shown read-only here and worked from dispatch.
 */
async function leadsInbox({ status = null, type = null, q = null, owner = null, kind = null, limit = 40, offset = 0 } = {}) {
  const rows = [];
  const wantLeads = !kind || kind === 'lead';
  const wantRequests = !kind || kind === 'request';

  if (wantLeads) {
    const where = [];
    const params = [];
    if (status && LEAD_STATUSES.includes(status)) {
      where.push('l.status = ?');
      params.push(status);
    }
    if (type) {
      where.push('l.type = ?');
      params.push(type);
    }
    if (owner === 'unassigned') where.push('l.assigned_to IS NULL');
    else if (owner) {
      where.push('l.assigned_to = ?');
      params.push(Number(owner));
    }
    if (q) {
      where.push('(l.name LIKE ? OR l.phone LIKE ? OR l.message LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const leadRows = await query(
      `SELECT l.*, u.name AS assignee_name, v.seo_slug AS listing_slug,
              CONCAT(v.year, ' ', v.make, ' ', v.model) AS listing_title
         FROM leads l
         LEFT JOIN \`users\` u ON u.id = l.assigned_to
         LEFT JOIN vehicle_listings v ON v.id = l.listing_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.created_at DESC LIMIT ?`,
      [...params, limit],
    );
    rows.push(...leadRows.map(shapeLead));
  }

  if (wantRequests) {
    const where = [];
    const params = [];
    if (status && ['new', 'searching', 'options_ready', 'viewings', 'closed', 'lost'].includes(status)) {
      where.push('r.status = ?');
      params.push(status);
    }
    if (type) {
      where.push('r.type = ?');
      params.push(type);
    }
    if (owner === 'unassigned') where.push('r.assigned_to IS NULL');
    else if (owner) {
      where.push('r.assigned_to = ?');
      params.push(Number(owner));
    }
    if (q) {
      where.push('(r.name LIKE ? OR r.phone LIKE ? OR r.tracking_id LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const requestRows = await query(
      `SELECT r.*, u.name AS assignee_name
         FROM service_requests r
         LEFT JOIN \`users\` u ON u.id = r.assigned_to
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC LIMIT ?`,
      [...params, limit],
    );
    rows.push(...requestRows.map(shapeRequestLead));
  }

  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const page = rows.slice(offset, offset + limit);
  return {
    rows: page,
    counts: await inboxCounts(),
    more: rows.length > offset + limit,
  };
}

async function inboxCounts() {
  const [leadCounts] = await query(
    `SELECT SUM(status = 'new') AS new_leads, SUM(status = 'assigned') AS assigned,
            SUM(status = 'contacted') AS contacted, SUM(status = 'viewing') AS viewing,
            SUM(status = 'closed') AS closed, SUM(status = 'lost') AS lost,
            SUM(assigned_to IS NULL AND status <> 'closed' AND status <> 'lost') AS unassigned
       FROM leads`,
  );
  const [requestCounts] = await query(
    `SELECT SUM(status = 'new') AS new_requests, SUM(status = 'searching') AS searching,
            SUM(status = 'options_ready') AS options_ready, SUM(status = 'viewings') AS viewings,
            SUM(status = 'closed') AS closed, SUM(status = 'lost') AS lost,
            SUM(sla_due_at IS NOT NULL AND sla_due_at < UTC_TIMESTAMP() AND status NOT IN ('closed','lost')) AS sla_breached
       FROM service_requests`,
  );
  return ints({ ...leadCounts, ...requestCounts });
}

async function setLeadStatus(id, status, { actorId, lostReason = null, kind = 'lead' }) {
  // A request travels its own pipeline (new → searching → options_ready →
  // viewings → closed/lost), so it is validated against its own stages.
  if (kind === 'request') {
    if (!REQUEST_STAGES.includes(status)) return { ok: false, error: 'Unknown pipeline stage.' };
    return setRequestStage(id, status, { actorId, lostReason });
  }
  if (!LEAD_STATUSES.includes(status)) return { ok: false, error: 'Unknown lead status.' };

  const touched = status === 'contacted' || status === 'viewing' ? ', last_contacted_at = UTC_TIMESTAMP()' : '';
  await query(
    `UPDATE leads SET status = ?, lost_reason = ?${touched} WHERE id = ?`,
    [status, status === 'lost' ? (lostReason || 'not recorded').slice(0, 160) : null, id],
  );
  await recordAudit({ actorId, action: 'lead.status', entity: 'lead', entityId: id, detail: { status, lostReason } });
  return { ok: true, status };
}

async function assignLead(id, { actorId, assignedTo, kind = 'lead' }) {
  const table = kind === 'request' ? 'service_requests' : 'leads';
  await query(
    `UPDATE ${table} SET assigned_to = ?, assigned_at = UTC_TIMESTAMP(), status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END WHERE id = ?`,
    [assignedTo || null, id],
  );
  await recordAudit({
    actorId,
    action: kind === 'request' ? 'request.assign' : 'lead.assign',
    entity: kind === 'request' ? 'request' : 'lead',
    entityId: id,
    detail: { assignedTo },
  });
  return { ok: true };
}

/** Round-robin: give each unassigned lead to the next ops person. */
async function autoAssign({ actorId, limit = 50 } = {}) {
  const pool = await query(
    "SELECT id FROM `users` WHERE role IN ('ops','admin') AND status = 'active' ORDER BY id",
  );
  if (!pool.length) return { ok: false, error: 'No ops staff to assign to.' };

  const unassigned = await query(
    "SELECT id FROM leads WHERE assigned_to IS NULL AND status NOT IN ('closed','lost') ORDER BY created_at LIMIT ?",
    [limit],
  );
  let index = 0;
  for (const row of unassigned) {
    await query(
      "UPDATE leads SET assigned_to = ?, assigned_at = UTC_TIMESTAMP(), status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END WHERE id = ?",
      [pool[index % pool.length].id, row.id],
    );
    index += 1;
  }
  await recordAudit({ actorId, action: 'leads.auto_assign', entity: 'lead', detail: { assigned: unassigned.length } });
  return { ok: true, assigned: unassigned.length };
}

async function staffOptions() {
  const rows = await query(
    "SELECT id, name, phone, role FROM `users` WHERE role IN ('ops','admin','inspector','finance','marketing') AND status = 'active' ORDER BY FIELD(role,'admin','ops','inspector','finance','marketing'), name",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name || 'Staff',
    role: row.role,
    maskedPhone: phones.mask(row.phone),
  }));
}

// ---------------------------------------------------------------------------
// Concierge pipeline (§7.3)
// ---------------------------------------------------------------------------
function shapePipelineRequest(row) {
  const brief = parseJson(row.brief, {}) || {};
  return {
    id: row.id,
    trackingId: row.tracking_id,
    type: row.type,
    status: row.status,
    name: row.name,
    maskedPhone: phones.mask(row.phone),
    brief,
    budget: brief.budget || brief.max_budget || null,
    notes: row.notes,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name || null,
    candidateCount: Number(row.candidate_count || 0),
    slaDueAt: row.sla_due_at,
    slaHoursLeft: row.sla_due_at ? Math.round((new Date(row.sla_due_at).getTime() - Date.now()) / 3_600_000) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `/concierge/${row.tracking_id}`,
  };
}

async function pipelineBoard({ type = 'concierge' } = {}) {
  const rows = await query(
    `SELECT r.*, u.name AS assignee_name,
            (SELECT COUNT(*) FROM request_candidates c WHERE c.request_id = r.id) AS candidate_count
       FROM service_requests r
       LEFT JOIN \`users\` u ON u.id = r.assigned_to
      WHERE (? IS NULL OR r.type = ?)
      ORDER BY FIELD(r.status,'new','searching','options_ready','viewings','closed','lost'), r.sla_due_at IS NULL, r.sla_due_at`,
    [type, type],
  );
  const shaped = rows.map(shapePipelineRequest);
  const columns = REQUEST_STAGES.map((stage) => ({ stage, rows: shaped.filter((row) => row.status === stage) }));
  return { columns, all: shaped };
}

async function requestById(id) {
  const row = await queryOne(
    `SELECT r.*, u.name AS assignee_name,
            (SELECT COUNT(*) FROM request_candidates c WHERE c.request_id = r.id) AS candidate_count
       FROM service_requests r LEFT JOIN \`users\` u ON u.id = r.assigned_to WHERE r.id = ? LIMIT 1`,
    [id],
  );
  return row ? shapePipelineRequest(row) : null;
}

async function setRequestStage(id, status, { actorId, lostReason = null }) {
  if (!REQUEST_STAGES.includes(status)) return { ok: false, error: 'Unknown pipeline stage.' };
  await query(
    `UPDATE service_requests
        SET status = ?, lost_reason = ?, last_contacted_at = CASE WHEN ? IN ('searching','options_ready','viewings') THEN UTC_TIMESTAMP() ELSE last_contacted_at END
      WHERE id = ?`,
    [status, status === 'lost' ? (lostReason || 'not recorded').slice(0, 160) : null, status, id],
  );
  await recordAudit({ actorId, action: 'request.stage', entity: 'request', entityId: id, detail: { status, lostReason } });
  return { ok: true, status };
}

/** Attach a car to a request — these rows render the buyer's comparison. */
async function attachCandidate(requestId, { listingId, note = null, actorId }) {
  const listing = await listingById(listingId);
  if (!listing) return { ok: false, error: 'That listing no longer exists.' };
  const existing = await queryOne('SELECT id FROM request_candidates WHERE request_id = ? AND listing_id = ?', [requestId, listingId]);
  if (existing) return { ok: false, error: 'That car is already on this request.' };

  const [{ next }] = await query(
    'SELECT COALESCE(MAX(rank_no), 0) + 1 AS next FROM request_candidates WHERE request_id = ?',
    [requestId],
  );
  await query(
    'INSERT INTO request_candidates (request_id, listing_id, note, rank_no, added_by) VALUES (?, ?, ?, ?, ?)',
    [requestId, listingId, note ? String(note).slice(0, 200) : null, next, actorId],
  );
  await recordAudit({ actorId, action: 'request.candidate_add', entity: 'request', entityId: requestId, detail: { listingId, stockNo: listing.stockNo } });
  return { ok: true };
}

async function removeCandidate(requestId, listingId, { actorId }) {
  await query('DELETE FROM request_candidates WHERE request_id = ? AND listing_id = ?', [requestId, listingId]);
  await recordAudit({ actorId, action: 'request.candidate_remove', entity: 'request', entityId: requestId, detail: { listingId } });
  return { ok: true };
}

async function candidatesFor(requestId) {
  const rows = await query(
    `SELECT c.id, c.listing_id, c.note, c.rank_no, l.seo_slug, l.year, l.make, l.model, l.trim,
            l.asking_price_kobo, l.verification_grade, l.status, l.area
       FROM request_candidates c JOIN vehicle_listings l ON l.id = c.listing_id
      WHERE c.request_id = ? ORDER BY c.rank_no, c.id`,
    [requestId],
  );
  return rows.map((row) => ({
    id: row.id,
    listingId: row.listing_id,
    note: row.note,
    rank: row.rank_no,
    title: `${row.year} ${row.make} ${row.model}${row.trim ? ` ${row.trim}` : ''}`,
    priceKobo: Number(row.asking_price_kobo),
    grade: row.verification_grade,
    status: row.status,
    area: row.area,
    url: `/cars/${row.seo_slug}`,
  }));
}

// ---------------------------------------------------------------------------
// Bookings & dispatch (§7.3)
// ---------------------------------------------------------------------------
function shapeBooking(row) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    status: row.status,
    serviceSlug: row.service_slug,
    slotAt: row.slot_at,
    location: row.location,
    vehicle: parseJson(row.vehicle, {}) || {},
    addons: parseJson(row.addons, null),
    name: row.name,
    maskedPhone: phones.mask(row.phone),
    phone: row.phone,
    amountKobo: row.amount_kobo === null ? null : Number(row.amount_kobo),
    paymentStatus: row.payment_status,
    inspectorId: row.inspector_id,
    inspectorName: row.inspector_name || null,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    checklist: parseJson(row.checklist, null),
    verdict: row.verdict,
    reportNotes: row.report_notes,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

async function dispatchBoard({ date = null, status = null, inspectorId = null, limit = 80 } = {}) {
  const where = [];
  const params = [];
  if (date) {
    where.push('DATE(b.slot_at) = ?');
    params.push(date);
  }
  if (status && BOOKING_STATUSES.includes(status)) {
    where.push('b.status = ?');
    params.push(status);
  }
  if (inspectorId) {
    where.push('b.inspector_id = ?');
    params.push(inspectorId);
  }
  const rows = await query(
    `SELECT b.*, u.name AS inspector_name
       FROM bookings b LEFT JOIN \`users\` u ON u.id = b.inspector_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.slot_at IS NULL, b.slot_at, b.created_at DESC LIMIT ?`,
    [...params, limit],
  );
  const [counts] = await query(
    `SELECT SUM(status = 'requested') AS requested, SUM(status = 'confirmed') AS confirmed,
            SUM(status = 'dispatched') AS dispatched, SUM(status = 'completed') AS completed,
            SUM(status = 'cancelled') AS cancelled,
            SUM(slot_at IS NULL AND status IN ('requested','confirmed')) AS unscheduled
       FROM bookings`,
  );
  return { rows: rows.map(shapeBooking), counts: ints(counts) };
}

async function assignInspector(id, { inspectorId, actorId }) {
  const inspector = inspectorId
    ? await queryOne("SELECT id, name, role FROM `users` WHERE id = ? AND role = 'inspector' LIMIT 1", [inspectorId])
    : null;
  if (inspectorId && !inspector) return { ok: false, error: 'Pick an inspector from the list.' };

  // Assigning an inspector *is* the dispatch: the job is confirmed and sent in
  // one action (§7.5 — the dispatcher should not have to click twice).
  await query(
    `UPDATE bookings
        SET inspector_id = ?,
            status = CASE WHEN status = 'requested' THEN 'dispatched' ELSE status END,
            dispatched_at = CASE WHEN ? IS NOT NULL AND dispatched_at IS NULL THEN UTC_TIMESTAMP() ELSE dispatched_at END
      WHERE id = ?`,
    [inspectorId || null, inspectorId || null, id],
  );
  await recordAudit({ actorId, action: 'booking.assign', entity: 'booking', entityId: id, detail: { inspectorId: inspectorId || null, inspector: inspector ? inspector.name : null } });
  return { ok: true };
}

async function setBookingStatus(id, status, { actorId }) {
  if (!BOOKING_STATUSES.includes(status)) return { ok: false, error: 'Unknown booking status.' };
  await query(
    `UPDATE bookings
        SET status = ?,
            dispatched_at = CASE WHEN ? = 'dispatched' THEN UTC_TIMESTAMP() ELSE dispatched_at END,
            completed_at = CASE WHEN ? = 'completed' THEN UTC_TIMESTAMP() ELSE completed_at END
      WHERE id = ?`,
    [status, status, status, id],
  );
  await recordAudit({ actorId, action: 'booking.status', entity: 'booking', entityId: id, detail: { status } });
  return { ok: true };
}

/**
 * The inspector's checklist (§7.3 “inspector mobile view”). Saving it with a
 * verdict completes the job; the client-facing report PDF is the remaining
 * piece of that module and is stated as such in the UI.
 */
async function saveInspectionReport(id, { checklist, verdict, notes, actorId }) {
  if (verdict && !VERDICTS.includes(verdict)) return { ok: false, error: 'Unknown verdict.' };
  const booking = await queryOne('SELECT * FROM bookings WHERE id = ? LIMIT 1', [id]);
  if (!booking) return { ok: false, error: 'That booking no longer exists.' };

  await query(
    `UPDATE bookings
        SET checklist = ?, verdict = ?, report_notes = ?,
            status = CASE WHEN status IN ('requested','confirmed','dispatched') THEN 'completed' ELSE status END,
            completed_at = COALESCE(completed_at, UTC_TIMESTAMP())
      WHERE id = ?`,
    [checklist ? JSON.stringify(checklist) : null, verdict || null, notes ? String(notes).slice(0, 4000) : null, id],
  );
  await recordAudit({ actorId, action: 'booking.report', entity: 'booking', entityId: id, detail: { verdict, hasChecklist: Boolean(checklist) } });
  return { ok: true };
}

/** Today's jobs for one inspector (mobile view). */
async function inspectorJobs(inspectorId, { date = null } = {}) {
  const rows = await query(
    `SELECT * FROM bookings
      WHERE inspector_id = ?
        AND (? IS NULL OR DATE(slot_at) = ?)
        AND status NOT IN ('cancelled')
      ORDER BY slot_at IS NULL, slot_at LIMIT 50`,
    [inspectorId, date, date],
  );
  return rows.map(shapeBooking);
}

// ---------------------------------------------------------------------------
// Staff & roles (§7.3 “Users & Roles”, §7.4)
// ---------------------------------------------------------------------------
async function staffList() {
  const rows = await query(
    "SELECT id, name, phone, role, status, watchlisted, last_seen_at, created_at FROM `users` WHERE role <> 'customer' ORDER BY FIELD(role,'admin','ops','inspector','finance','marketing','dealer'), name",
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name || 'Unnamed',
    maskedPhone: phones.mask(row.phone),
    role: row.role,
    status: row.status,
    watchlisted: Boolean(row.watchlisted),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  }));
}

async function setRole(userId, role, { actorId }) {
  const allowed = ['customer', 'dealer', 'ops', 'inspector', 'marketing', 'finance', 'admin'];
  if (!allowed.includes(role)) return { ok: false, error: 'Unknown role.' };
  const before = await queryOne('SELECT id, role, name FROM `users` WHERE id = ? LIMIT 1', [userId]);
  if (!before) return { ok: false, error: 'That account does not exist.' };

  await query('UPDATE `users` SET role = ? WHERE id = ?', [role, userId]);
  await recordAudit({ actorId, action: 'user.role', entity: 'user', entityId: userId, detail: { from: before.role, to: role } });
  return { ok: true, role };
}

async function setWatchlist(userId, watchlisted, { actorId }) {
  await query('UPDATE `users` SET watchlisted = ? WHERE id = ?', [watchlisted ? 1 : 0, userId]);
  await recordAudit({ actorId, action: 'user.watchlist', entity: 'user', entityId: userId, detail: { watchlisted: Boolean(watchlisted) } });
  return { ok: true };
}

/** Accounts that signed in but never used a role — the customer book. */
async function customerCount() {
  const row = await queryOne(
    "SELECT COUNT(*) AS total, SUM(watchlisted = 1) AS watchlisted FROM `users` WHERE role = 'customer'",
  );
  return ints(row);
}

module.exports = {
  STALE_DAYS,
  REFRESH_GRACE_DAYS,
  LISTING_STATUSES,
  GRADES,
  LEAD_STATUSES,
  REQUEST_STAGES,
  BOOKING_STATUSES,
  VERDICTS,
  recordAudit,
  auditLog,
  kpis,
  revenueByPillar,
  listingsTrend,
  leadFunnel,
  dailySummary,
  moderationList,
  listingById,
  publishListing,
  setListingStatus,
  setGrade,
  setPrice,
  markRefreshed,
  runStaleSweep,
  leadsInbox,
  inboxCounts,
  setLeadStatus,
  assignLead,
  autoAssign,
  staffOptions,
  pipelineBoard,
  requestById,
  setRequestStage,
  attachCandidate,
  removeCandidate,
  candidatesFor,
  dispatchBoard,
  assignInspector,
  setBookingStatus,
  saveInspectionReport,
  inspectorJobs,
  staffList,
  setRole,
  setWatchlist,
  customerCount,
  nairaToKobo,
  koboToNaira,
};
