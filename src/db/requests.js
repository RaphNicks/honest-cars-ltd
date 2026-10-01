'use strict';

/**
 * Service requests + bookings — §6.5 concierge, §6.6 sell/swap, §6.7 service
 * pages, §7.1 “Requests” and “Bookings” cards on /account.
 *
 * One table (service_requests) carries every “tell us what you need” intake —
 * concierge, sell, swap, documents, research, parts, consultation, tracking —
 * with a human tracking id (HC-2481) the customer can watch at
 * /concierge/{tracking_id}. Bookings are the scheduled work: inspections,
 * installs and consultations.
 */

const { query, queryOne, transaction } = require('./pool');
const { parseJson } = require('./shape');

const REQUEST_TYPES = ['concierge', 'sell', 'swap', 'documents', 'research', 'parts', 'consultation', 'tracking', 'hire'];
const REQUEST_STATUSES = ['new', 'searching', 'options_ready', 'viewings', 'closed', 'lost'];
const BOOKING_TYPES = ['inspection', 'install', 'consultation'];

/** Human-facing status copy + the stage order the status page walks (§6.5). */
const STATUS_STAGES = [
  { key: 'new', label: 'Brief received', blurb: 'We have your brief and a human has read it.' },
  { key: 'searching', label: 'Searching', blurb: 'We are pulling matches from partner lots and verifying them.' },
  { key: 'options_ready', label: 'Options ready', blurb: 'Your verified options are ready — check WhatsApp.' },
  { key: 'viewings', label: 'Viewings', blurb: 'We are booking or running viewings with you.' },
  { key: 'closed', label: 'Closed', blurb: 'This request is complete. Tell us how it went.' },
];

/** Next tracking id: HC-2481, HC-2482… (§6.5 “success screen with tracking ID”). */
async function nextTrackingId() {
  const row = await queryOne("SELECT MAX(CAST(SUBSTRING(tracking_id, 4) AS UNSIGNED)) AS last FROM service_requests WHERE tracking_id LIKE 'HC-%'");
  return `HC-${Math.max(2481, Number(row && row.last ? row.last : 0) + 1)}`;
}

function shapeRequest(row) {
  if (!row) return null;
  const brief = parseJson(row.brief, {}) || {};
  const stageIndex = Math.max(0, STATUS_STAGES.findIndex((stage) => stage.key === row.status));
  return {
    id: row.id,
    trackingId: row.tracking_id,
    type: row.type,
    status: row.status,
    statusLabel: (STATUS_STAGES.find((s) => s.key === row.status) || {}).label || row.status,
    statusBlurb: (STATUS_STAGES.find((s) => s.key === row.status) || {}).blurb || '',
    stageIndex: stageIndex === -1 ? 0 : stageIndex,
    name: row.name,
    phone: row.phone,
    brief,
    slaDueAt: row.sla_due_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `/concierge/${row.tracking_id}`,
  };
}

/**
 * Create a request and return it with its tracking id.
 * slaHours: 48–72 for concierge (§6.5), 24 for sell/swap valuation (§6.6).
 */
async function createRequest({
  type,
  name,
  phone,
  brief = null,
  listingId = null,
  sourcePath = '/',
  slaHours = 72,
  notes = null,
  status = 'new',
}) {
  const safeType = REQUEST_TYPES.includes(type) ? type : 'concierge';
  const safeStatus = REQUEST_STATUSES.includes(status) ? status : 'new';

  return transaction(async (conn) => {
    const [maxRow] = await conn.query(
      "SELECT MAX(CAST(SUBSTRING(tracking_id, 4) AS UNSIGNED)) AS last FROM service_requests WHERE tracking_id LIKE 'HC-%'",
    );
    const next = Math.max(2481, Number(maxRow[0] && maxRow[0].last ? maxRow[0].last : 0) + 1);
    const trackingId = `HC-${next}`;

    const due = new Date(Date.now() + Math.max(1, slaHours) * 3_600_000);
    const [result] = await conn.query(
      `INSERT INTO service_requests (tracking_id, type, status, name, phone, brief, listing_id, sla_due_at, source_path, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trackingId,
        safeType,
        safeStatus,
        String(name || '').slice(0, 120),
        String(phone || '').slice(0, 40),
        brief ? JSON.stringify(brief).slice(0, 20_000) : null,
        listingId,
        due,
        String(sourcePath || '/').slice(0, 200),
        notes ? String(notes).slice(0, 500) : null,
      ],
    );

    // Read on the same connection: an uncommitted row is invisible to the pool.
    const [rows] = await conn.query('SELECT * FROM service_requests WHERE id = ?', [result.insertId]);
    return shapeRequest(rows[0]);
  });
}

async function findByTracking(trackingId) {
  const row = await queryOne('SELECT * FROM service_requests WHERE tracking_id = ? LIMIT 1', [
    String(trackingId || '').toUpperCase().slice(0, 16),
  ]);
  return shapeRequest(row);
}

async function updateStatus(trackingId, status, notes = null) {
  if (!REQUEST_STATUSES.includes(status)) throw new Error(`Unknown request status: ${status}`);
  await query('UPDATE service_requests SET status = ?, notes = COALESCE(?, notes) WHERE tracking_id = ?', [
    status,
    notes ? String(notes).slice(0, 500) : null,
    String(trackingId).toUpperCase(),
  ]);
  return findByTracking(trackingId);
}

/** /account “Requests” card — phone-number-first, no password yet (§7.1). */
async function listRequestsForPhone(phone) {
  const rows = await query(
    'SELECT * FROM service_requests WHERE phone = ? ORDER BY created_at DESC LIMIT 20',
    [String(phone || '').slice(0, 40)],
  );
  return rows.map(shapeRequest);
}

// ---------------------------------------------------------------------------
// Bookings (§6.7 inline booking forms, §7.3 dispatch queue)
// ---------------------------------------------------------------------------
function shapeBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    serviceSlug: row.service_slug,
    slotAt: row.slot_at,
    location: row.location,
    vehicle: parseJson(row.vehicle, {}) || {},
    addons: parseJson(row.addons, []) || [],
    name: row.name,
    phone: row.phone,
    amountKobo: row.amount_kobo === null ? null : Number(row.amount_kobo),
    paymentStatus: row.payment_status,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function createBooking({
  type,
  serviceSlug = null,
  slotAt = null,
  location = null,
  vehicle = null,
  addons = null,
  name,
  phone,
  amountKobo = null,
  requestId = null,
  status = 'requested',
}) {
  const safeType = BOOKING_TYPES.includes(type) ? type : 'consultation';
  const reference = await transaction(async (conn) => {
    const [maxRow] = await conn.query(
      "SELECT MAX(CAST(SUBSTRING(reference, 7) AS UNSIGNED)) AS last FROM bookings WHERE reference LIKE 'HC-BK-%'",
    );
    const next = Number(maxRow[0] && maxRow[0].last ? maxRow[0].last : 0) + 1;
    return `HC-BK-${String(next).padStart(4, '0')}`;
  });

  const result = await query(
    `INSERT INTO bookings (reference, type, service_slug, slot_at, location, vehicle, addons, name, phone, amount_kobo, request_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reference,
      safeType,
      serviceSlug,
      slotAt ? new Date(slotAt) : null,
      location ? String(location).slice(0, 200) : null,
      vehicle ? JSON.stringify(vehicle).slice(0, 4000) : null,
      addons ? JSON.stringify(addons).slice(0, 2000) : null,
      String(name || '').slice(0, 120),
      String(phone || '').slice(0, 40),
      amountKobo === null || amountKobo === undefined ? null : Number(amountKobo),
      requestId,
      status,
    ],
  );
  const row = await queryOne('SELECT * FROM bookings WHERE id = ?', [result.insertId]);
  return shapeBooking(row);
}

async function findByReference(reference) {
  const row = await queryOne('SELECT * FROM bookings WHERE reference = ? LIMIT 1', [
    String(reference || '').toUpperCase().slice(0, 24),
  ]);
  return shapeBooking(row);
}

async function listBookingsForPhone(phone) {
  const rows = await query('SELECT * FROM bookings WHERE phone = ? ORDER BY created_at DESC LIMIT 20', [
    String(phone || '').slice(0, 40),
  ]);
  return rows.map(shapeBooking);
}

module.exports = {
  REQUEST_TYPES,
  REQUEST_STATUSES,
  BOOKING_TYPES,
  STATUS_STAGES,
  nextTrackingId,
  createRequest,
  findByTracking,
  updateStatus,
  listRequestsForPhone,
  createBooking,
  findByReference,
  listBookingsForPhone,
};
