'use strict';

/**
 * Financing leads and the partners they are routed to — FR-34 (migration 026).
 *
 * The module exists because of one sentence in §6.5 ("financing needed? Y/N
 * (routes to partner note)") and one open question in Appendix D ("any bank/MFB
 * partner … or defer"). The answer this code gives is: build the route, and let
 * the partner be *data* rather than a hard-coded assumption. `finance_partners`
 * is empty on a fresh install, which is the truth — and the console says so
 * instead of showing a partner that does not exist.
 *
 * Three rules live here rather than in a view:
 *
 *   • A lead is `new` with `partner_id = NULL` until a human routes it. Nothing
 *     auto-assigns, because "shared with a partner" is a claim about something
 *     that happened outside this system.
 *   • The customer's figures (amount, down payment, monthly, tenor) are stored
 *     exactly as given. We are not the lender; we do not compute a rate.
 *   • Every status change carries the person who made it (`acted_by`), so the
 *     question "who told this customer they were approved?" has an answer.
 */

const { query, queryOne } = require('./pool');

const STATUSES = ['new', 'shared', 'contacted', 'approved', 'declined', 'withdrawn'];
/** The statuses that mean the desk is finished with it. */
const CLOSED = ['approved', 'declined', 'withdrawn'];
const PARTNER_KINDS = ['bank', 'mfb', 'fintech', 'cooperative', 'other'];
const CHANNELS = ['whatsapp', 'email', 'phone', 'manual'];
const EMPLOYMENTS = ['salaried', 'self_employed', 'business_owner', 'civil_servant', 'retired', 'other'];
const TIMELINES = ['asap', 'two_weeks', 'month', 'researching'];

function shapePartner(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: row.kind === 'mfb' ? 'MFB' : row.kind.charAt(0).toUpperCase() + row.kind.slice(1),
    channel: row.channel,
    contact: row.contact || null,
    note: row.note || null,
    active: Boolean(row.active),
    leads: row.leads === undefined ? undefined : Number(row.leads),
    createdAt: row.created_at,
  };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function shapeLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    phone: row.phone,
    phoneMasked: row.phone_masked || null,
    email: row.email || null,
    leadId: row.lead_id || null,
    leadStatus: row.lead_status || null,
    assignedTo: row.assigned_to || null,
    assignedName: row.assigned_name || null,
    listingId: row.listing_id || null,
    listingSlug: row.listing_slug || null,
    listingTitle: row.listing_title || null,
    requestId: row.request_id || null,
    trackingId: row.tracking_id || null,
    amountKobo: Number(row.amount_kobo || 0),
    downKobo: Number(row.down_kobo || 0),
    monthlyKobo: Number(row.monthly_kobo || 0),
    tenorMonths: Number(row.tenor_months || 0),
    employment: row.employment || null,
    timeline: row.timeline || null,
    plan: parseJson(row.plan),
    partnerId: row.partner_id || null,
    partnerName: row.partner_name || null,
    partnerChannel: row.partner_channel || null,
    partnerContact: row.partner_contact || null,
    status: row.status,
    sharedAt: row.shared_at || null,
    outcomeNote: row.outcome_note || null,
    sourcePath: row.source_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** `HC-FIN-000123` — the reference the customer quotes back at us. */
async function nextReference() {
  const row = await queryOne(
    "SELECT MAX(CAST(SUBSTRING(reference, 8) AS UNSIGNED)) AS last FROM financing_leads WHERE reference LIKE 'HC-FIN-%'",
  );
  const next = Number((row && row.last) || 0) + 1;
  return `HC-FIN-${String(next).padStart(6, '0')}`;
}

/**
 * Create the lead. The reference is retried on the unique key, so two people
 * submitting in the same second cannot collide or lose an enquiry.
 */
async function createLead(input) {
  const payload = {
    reference: input.reference || (await nextReference()),
    name: input.name,
    phone: input.phone,
    email: input.email || null,
    lead_id: input.leadId || null,
    listing_id: input.listingId || null,
    request_id: input.requestId || null,
    amount_kobo: Number(input.amountKobo || 0),
    down_kobo: Number(input.downKobo || 0),
    monthly_kobo: Number(input.monthlyKobo || 0),
    tenor_months: Number(input.tenorMonths || 0),
    employment: input.employment || null,
    timeline: input.timeline || null,
    plan: input.plan ? JSON.stringify(input.plan) : null,
    source_path: input.sourcePath || '/financing',
    utm: input.utm ? JSON.stringify(input.utm) : null,
  };

  // Prepared statements cannot expand `SET ?`, and string-building an INSERT is
  // how SQL injection gets in — so the column list is explicit and every value
  // is a parameter.
  const COLUMNS = [
    'reference', 'name', 'phone', 'email', 'lead_id', 'listing_id', 'request_id',
    'amount_kobo', 'down_kobo', 'monthly_kobo', 'tenor_months', 'employment',
    'timeline', 'plan', 'source_path', 'utm',
  ];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await query(
        `INSERT INTO financing_leads (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
        COLUMNS.map((column) => payload[column]),
      );
      const lead = await findById(result.insertId);
      return { ok: true, lead };
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY' && attempt < 2) {
        payload.reference = await nextReference();
        continue;
      }
      throw error;
    }
  }
  return { ok: false, error: 'Could not allocate a financing reference.' };
}

// ---------------------------------------------------------------------------
// Partners
// ---------------------------------------------------------------------------

async function partners({ activeOnly = false, withCounts = false } = {}) {
  const rows = await query(
    `SELECT p.*${withCounts ? `, (SELECT COUNT(*) FROM financing_leads f WHERE f.partner_id = p.id) AS leads` : ''}
       FROM finance_partners p
      ${activeOnly ? 'WHERE p.active = 1' : ''}
      ORDER BY p.active DESC, p.name ASC`,
  );
  return rows.map(shapePartner);
}

async function findPartner(id) {
  return shapePartner(await queryOne('SELECT * FROM finance_partners WHERE id = ? LIMIT 1', [id]));
}

async function createPartner({ name, kind, channel, contact, note, createdBy = null }) {
  const existing = await queryOne('SELECT id FROM finance_partners WHERE name = ? LIMIT 1', [name]);
  if (existing) return { ok: false, error: 'A partner with that name is already on the list.' };
  const result = await query(
    'INSERT INTO finance_partners (name, kind, channel, contact, note, created_by) VALUES (?,?,?,?,?,?)',
    [name, kind, channel, contact || null, note || null, createdBy],
  );
  return { ok: true, partner: await findPartner(result.insertId) };
}

async function setPartnerActive(id, active) {
  await query('UPDATE finance_partners SET active = ? WHERE id = ?', [active ? 1 : 0, id]);
  return findPartner(id);
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

const SELECT_LEAD = `
  SELECT f.*, l.seo_slug AS listing_slug,
         TRIM(CONCAT_WS(' ', l.year, l.make, l.model, l.trim)) AS listing_title,
         r.tracking_id, ld.status AS lead_status, ld.assigned_to,
         u.name AS assigned_name,
         p.name AS partner_name, p.channel AS partner_channel, p.contact AS partner_contact
    FROM financing_leads f
    LEFT JOIN vehicle_listings l ON l.id = f.listing_id
    LEFT JOIN service_requests r ON r.id = f.request_id
    LEFT JOIN leads ld ON ld.id = f.lead_id
    LEFT JOIN users u ON u.id = ld.assigned_to
    LEFT JOIN finance_partners p ON p.id = f.partner_id`;

async function findById(id) {
  return shapeLead(await queryOne(`${SELECT_LEAD} WHERE f.id = ? LIMIT 1`, [id]));
}

async function findByReference(reference) {
  return shapeLead(await queryOne(`${SELECT_LEAD} WHERE f.reference = ? LIMIT 1`, [String(reference || '').toUpperCase()]));
}

/** The customer's own enquiries, matched on the number they gave us (§7.1). */
async function listForPhone(phone, { limit = 5 } = {}) {
  const rows = await query(`${SELECT_LEAD} WHERE f.phone = ? ORDER BY f.created_at DESC LIMIT ?`, [phone, limit]);
  return rows.map(shapeLead);
}

/** The console queue. Unassigned first — that is the work. */
async function queue({ status = null, partnerId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status && STATUSES.includes(status)) {
    where.push('f.status = ?');
    params.push(status);
  }
  if (partnerId) {
    where.push('f.partner_id = ?');
    params.push(partnerId);
  }
  params.push(limit);
  const rows = await query(
    `${SELECT_LEAD}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY FIELD(f.status, 'new', 'shared', 'contacted', 'approved', 'declined', 'withdrawn'), f.created_at DESC
      LIMIT ?`,
    params,
  );
  return rows.map(shapeLead);
}

async function counts() {
  const rows = await query(
    "SELECT status, COUNT(*) AS n FROM financing_leads GROUP BY status",
  );
  const out = { new: 0, shared: 0, contacted: 0, approved: 0, declined: 0, withdrawn: 0, total: 0, open: 0, closed: 0 };
  for (const row of rows) {
    out[row.status] = Number(row.n);
    out.total += Number(row.n);
    if (CLOSED.includes(row.status)) out.closed += Number(row.n);
    else out.open += Number(row.n);
  }
  return out;
}

/** Route it: record which partner it went to and when. */
async function route(id, { partnerId, actorId = null }) {
  const partner = await findPartner(partnerId);
  if (!partner) return { ok: false, error: 'That partner is not on the list.' };
  if (!partner.active) return { ok: false, error: `${partner.name} is switched off — reactivate it first, or pick another.` };
  await query(
    "UPDATE financing_leads SET partner_id = ?, status = 'shared', shared_at = NOW(), acted_by = ? WHERE id = ?",
    [partner.id, actorId, id],
  );
  return { ok: true, lead: await findById(id), partner };
}

async function recordOutcome(id, { status, note = null, actorId = null }) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  await query('UPDATE financing_leads SET status = ?, outcome_note = ?, acted_by = ? WHERE id = ?', [
    status,
    note || null,
    actorId,
    id,
  ]);
  return { ok: true, lead: await findById(id) };
}

module.exports = {
  STATUSES,
  CLOSED,
  PARTNER_KINDS,
  CHANNELS,
  EMPLOYMENTS,
  TIMELINES,
  nextReference,
  createLead,
  findById,
  findByReference,
  listForPhone,
  queue,
  counts,
  route,
  recordOutcome,
  partners,
  findPartner,
  createPartner,
  setPartnerActive,
  shapeLead,
  shapePartner,
};
