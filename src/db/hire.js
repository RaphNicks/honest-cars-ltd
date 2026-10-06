'use strict';

/**
 * Hire management — FR-22, §7.3.
 *
 *   “Vehicle pool registry (partner-owned units, docs, tracker status),
 *    availability calendar, booking records, incident log.”
 *
 * Three reads do the work, and the interesting one is availability:
 *
 *   pool()        the physical cars. A unit is hired, not a class, so the pool
 *                 is per plate and `hire_classes` supplies the price.
 *   availability() a day-by-day view of the pool over a window: which unit is
 *                 free, which is out, and which is blocked because its papers
 *                 are missing or it is in the workshop. A car that is free but
 *                 uninsured is not available, and saying so here is the whole
 *                 point of keeping documents_state on the row.
 *   calendar()    the bookings laid over a month, for the screen a person looks
 *                 at when a client is on the phone.
 *
 * Booking dates are inclusive of both ends (`pickup_at` to `dropoff_at`), which
 * is what a client means by “the 10th to the 13th” — four days.
 *
 * Overlap is computed in SQL as `existing.pickup_at <= new.dropoff_at AND
 * existing.dropoff_at >= new.pickup_at`, the standard half-open-negated test for
 * inclusive ranges, so allocating a unit twice on the same days is impossible
 * rather than merely unlikely.
 */

const { query, queryOne, transaction } = require('./pool');
const phones = require('../lib/phone');

const BOOKING_STATUSES = ['requested', 'quoted', 'accepted', 'confirmed', 'on_hire', 'completed', 'cancelled'];
/** Statuses that occupy a vehicle. A cancelled or completed hire frees it. */
const ACTIVE_STATUSES = ['accepted', 'confirmed', 'on_hire'];
const INCIDENT_KINDS = ['damage', 'late_return', 'fine', 'breakdown', 'fuel', 'theft', 'other'];
const INCIDENT_SEVERITIES = ['minor', 'major', 'write_off'];

const STATUS_LABELS = {
  requested: 'Requested',
  quoted: 'Quoted',
  accepted: 'Accepted',
  confirmed: 'Confirmed',
  on_hire: 'On hire',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const VEHICLE_STATUS_LABELS = {
  available: 'Available',
  on_hire: 'On hire',
  service: 'In service',
  retired: 'Retired',
};

const DOCUMENT_LABELS = { current: 'Current', expiring: 'Expiring', missing: 'Missing' };
/** How close a paper expiry has to be before the desk should be chasing it. */
const DOCUMENT_WARNING_DAYS = 30;
const TRACKER_LABELS = { fitted: 'Fitted', on_order: 'On order', none: 'None' };

const INCIDENT_LABELS = {
  damage: 'Damage',
  late_return: 'Late return',
  fine: 'Fine',
  breakdown: 'Breakdown',
  fuel: 'Fuel',
  theft: 'Theft',
  other: 'Other',
};

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function daysBetween(from, to) {
  if (!from || !to) return 0;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.round((end.setHours(0, 0, 0, 0) - start.setHours(0, 0, 0, 0)) / 86_400_000) + 1;
}

function sqlDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/** Days between today and a date; negative means it has passed. */
function daysUntil(date) {
  if (!date) return null;
  const then = new Date(date);
  then.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((then - today) / 86_400_000);
}

function shapeVehicle(row) {
  if (!row) return null;
  const docsDays = daysUntil(row.documents_due);
  // The badge is derived from the expiry date, exactly like a subscription's
  // state: a row that says “current” whose papers ran out in June is the mistake
  // a spreadsheet makes, so the label reads the date and the column only decides
  // whether anything is on file at all.
  const docsLabel = row.documents_state === 'missing'
    ? 'Missing'
    : docsDays === null
      ? (DOCUMENT_LABELS[row.documents_state] || row.documents_state)
      : docsDays < 0
        ? 'Lapsed'
        : docsDays <= DOCUMENT_WARNING_DAYS ? 'Expiring' : 'Current';
  return {
    id: row.id,
    plate: row.plate,
    classSlug: row.class_slug,
    className: row.class_name || row.class_slug,
    make: row.make,
    model: row.model,
    year: row.year,
    colour: row.colour,
    seats: row.seats,
    title: [row.year, row.make, row.model].filter(Boolean).join(' ') || row.plate,
    owner: row.owner,
    ownerLabel: row.owner === 'partner' ? (row.partner_name || 'Partner-owned') : 'Honest Cars',
    partnerName: row.partner_name,
    driverAvailable: Boolean(row.driver_available),
    documentsState: row.documents_state,
    documentsLabel: docsLabel,
    documentsDue: row.documents_due,
    documentsDays: docsDays,
    // The check that stops a hire going out on an uninsured car. Derived from
    // the date, not from the enum, because a row that says “current” with an
    // expiry three months gone is exactly the mistake a spreadsheet makes.
    documentsValid: row.documents_state !== 'missing' && (docsDays === null || docsDays >= 0),
    trackerState: row.tracker_state,
    trackerLabel: TRACKER_LABELS[row.tracker_state] || row.tracker_state,
    status: row.status,
    statusLabel: VEHICLE_STATUS_LABELS[row.status] || row.status,
    location: row.location,
    notes: row.notes,
    image: row.image,
    bookings: Number(row.bookings || 0),
    hireDays: Number(row.hire_days || 0),
    openIncidents: Number(row.open_incidents || 0),
    nextBooking: row.next_pickup ? { reference: row.next_reference, pickupAt: row.next_pickup, dropoffAt: row.next_dropoff } : null,
  };
}

function shapeBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    requestId: row.request_id,
    trackingId: row.tracking_id || null,
    vehicleId: row.vehicle_id,
    plate: row.plate || null,
    vehicleTitle: [row.year, row.make, row.model].filter(Boolean).join(' ') || null,
    classSlug: row.class_slug,
    className: row.class_name || row.class_slug,
    clientName: row.client_name,
    phone: row.client_phone,
    maskedPhone: row.client_phone ? phones.mask(row.client_phone) : null,
    company: row.company,
    pickupAt: row.pickup_at,
    dropoffAt: row.dropoff_at,
    pickupPoint: row.pickup_point,
    dropoffPoint: row.dropoff_point,
    days: Number(row.days),
    withDriver: Boolean(row.with_driver),
    driverName: row.driver_name,
    airportPickup: Boolean(row.airport_pickup),
    dayRateKobo: Number(row.day_rate_kobo),
    driverKobo: Number(row.driver_kobo),
    extrasKobo: Number(row.extras_kobo),
    depositKobo: Number(row.deposit_kobo),
    totalKobo: Number(row.total_kobo),
    currency: row.currency,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    quoteSentAt: row.quote_sent_at,
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    notes: row.notes,
    fuelOut: row.fuel_out,
    fuelIn: row.fuel_in,
    odometerOut: row.odometer_out,
    odometerIn: row.odometer_in,
    createdAt: row.created_at,
    paymentId: row.payment_id || null,
    paymentStatus: row.payment_status || null,
    paymentReference: row.payment_reference || null,
    incidentCount: Number(row.incident_count || 0),
    openIncidents: Number(row.open_incidents || 0),
    // What the desk needs to know before the client calls: are we late to
    // handover, is the vehicle allocated, has the money landed.
    needsVehicle: row.vehicle_id === null && ['accepted', 'confirmed'].includes(row.status),
    daysUntilPickup: daysUntil(row.pickup_at),
    // How many units of this class are free on these dates — the number the
    // quote depends on.
    classFree: row.class_free === undefined ? null : Number(row.class_free),
  };
}

function shapeIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    bookingReference: row.booking_reference || null,
    vehicleId: row.vehicle_id,
    plate: row.plate || null,
    kind: row.kind,
    kindLabel: INCIDENT_LABELS[row.kind] || row.kind,
    severity: row.severity,
    detail: row.detail,
    costKobo: Number(row.cost_kobo),
    chargedKobo: Number(row.charged_kobo),
    gapKobo: Number(row.cost_kobo) - Number(row.charged_kobo),
    status: row.status,
    occurredAt: row.occurred_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    paymentId: row.payment_id,
    createdAt: row.created_at,
    reportedBy: row.reported_by,
    reportedByName: row.reported_by_name || null,
  };
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

const VEHICLE_SELECT = `SELECT v.*, c.name AS class_name,
         (SELECT COUNT(*) FROM hire_bookings b WHERE b.vehicle_id = v.id AND b.status <> 'cancelled') AS bookings,
         (SELECT COALESCE(SUM(b.days), 0) FROM hire_bookings b
           WHERE b.vehicle_id = v.id AND b.status IN ('completed','on_hire')) AS hire_days,
         (SELECT COUNT(*) FROM hire_incidents i WHERE i.vehicle_id = v.id AND i.status = 'open') AS open_incidents,
         (SELECT b.pickup_at FROM hire_bookings b
           WHERE b.vehicle_id = v.id AND b.status IN ('accepted','confirmed','on_hire')
             AND b.dropoff_at >= UTC_DATE()
           ORDER BY b.pickup_at ASC LIMIT 1) AS next_pickup,
         (SELECT b.dropoff_at FROM hire_bookings b
           WHERE b.vehicle_id = v.id AND b.status IN ('accepted','confirmed','on_hire')
             AND b.dropoff_at >= UTC_DATE()
           ORDER BY b.pickup_at ASC LIMIT 1) AS next_dropoff,
         (SELECT b.reference FROM hire_bookings b
           WHERE b.vehicle_id = v.id AND b.status IN ('accepted','confirmed','on_hire')
             AND b.dropoff_at >= UTC_DATE()
           ORDER BY b.pickup_at ASC LIMIT 1) AS next_reference
    FROM hire_vehicles v
    LEFT JOIN hire_classes c ON c.slug = v.class_slug`;

async function pool({ classSlug = null, status = null, includeRetired = false, search = null, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (!includeRetired) where.push("v.status <> 'retired'");
  if (classSlug) {
    where.push('v.class_slug = ?');
    params.push(classSlug);
  }
  if (status) {
    where.push('v.status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(v.plate LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR v.partner_name LIKE ? OR v.location LIKE ?)');
    const like = `%${String(search).slice(0, 60)}%`;
    params.push(like, like, like, like, like);
  }
  const rows = await query(
    `${VEHICLE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY v.status = 'retired', c.position, v.plate
      LIMIT ?`,
    [...params, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(shapeVehicle);
}

async function vehicleById(id) {
  const row = await queryOne(`${VEHICLE_SELECT} WHERE v.id = ? LIMIT 1`, [Number(id) || 0]);
  return shapeVehicle(row);
}

/**
 * Units of a class free on a date range.
 *
 * “Free” excludes a car that is in the workshop, retired, already booked on an
 * overlapping range, or whose papers are missing/expired. The last one is the
 * bit a spreadsheet gets wrong: the car is sitting there, so it looks
 * available, and it is not.
 */
async function availableVehicles({ classSlug, from, to, ignoreBookingId = null } = {}) {
  if (!from || !to) return [];
  // One pair of bounds: the overlap test negates a half-open range into the two
  // comparisons below, so `from` and `to` are each bound once.
  // Binds must follow placeholder order, and `${exclude}` sits before the date
  // comparisons in the subquery below — so it is pushed first.
  const params = [];
  let exclude = '';
  if (ignoreBookingId) {
    exclude = 'AND b.id <> ?';
    params.push(Number(ignoreBookingId));
  }
  params.push(sqlDate(from), sqlDate(to));
  const rows = await query(
    `${VEHICLE_SELECT}
      WHERE v.class_slug = ?
        AND v.status IN ('available','on_hire')
        AND v.documents_state <> 'missing'
        AND (v.documents_due IS NULL OR v.documents_due >= UTC_DATE())
        AND NOT EXISTS (
          SELECT 1 FROM hire_bookings b
           WHERE b.vehicle_id = v.id
             AND b.status NOT IN ('cancelled','completed')
             ${exclude}
             AND b.pickup_at <= ?
             AND b.dropoff_at >= ?
        )
      ORDER BY v.plate`,
    [classSlug, ...params],
  );
  return rows.map(shapeVehicle);
}

async function classOptions() {
  return query('SELECT slug, name, seats, daily_rate_kobo, weekly_rate_kobo, with_driver_kobo, airport_pickup, corporate FROM hire_classes ORDER BY position');
}

async function createVehicle({
  plate, classSlug, make = null, model = null, year = null, colour = null, seats = null,
  owner = 'honestcars', partnerName = null, driverAvailable = true,
  documentsState = 'missing', documentsDue = null, trackerState = 'none',
  status = 'available', location = null, notes = null, actorId = null,
} = {}) {
  const clean = String(plate || '').trim().toUpperCase().slice(0, 20);
  if (!clean) return { ok: false, error: 'A pool unit needs a plate — it is how the car is identified on the phone.' };
  const classes = await classOptions();
  if (!classes.some((c) => c.slug === classSlug)) return { ok: false, error: 'Choose the class the unit hires as.' };

  try {
    const result = await query(
      `INSERT INTO hire_vehicles
         (plate, class_slug, make, model, year, colour, seats, owner, partner_name, driver_available,
          documents_state, documents_due, tracker_state, status, location, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clean, classSlug, make, model, year, colour, seats, owner, partnerName, driverAvailable ? 1 : 0,
        documentsState, documentsDue ? sqlDate(documentsDue) : null, trackerState, status, location, notes,
      ],
    );
    await recordAudit({ actorId, action: 'hire.vehicle_added', entity: 'hire_vehicle', entityId: result.insertId, detail: { plate: clean, classSlug, owner } });
    return { ok: true, vehicle: await vehicleById(result.insertId) };
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') return { ok: false, error: `${clean} is already in the pool.` };
    throw error;
  }
}

async function updateVehicle(id, patch = {}, { actorId = null } = {}) {
  const current_ = await queryOne('SELECT * FROM hire_vehicles WHERE id = ? LIMIT 1', [Number(id) || 0]);
  if (!current_) return { ok: false, error: 'That unit is not in the pool.' };

  const sets = [];
  const params = [];
  const detail = {};
  const same = (value, current) => {
    if (value === null || value === undefined) return (current === null || current === undefined);
    if (current === null || current === undefined) return false;
    // A DATE column comes back as a Date at local midnight while the form sends
    // 'YYYY-MM-DD', so the two only match on their calendar day.
    if (current instanceof Date || value instanceof Date) {
      const a = new Date(value);
      const b = new Date(current);
      if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
      const day = (date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      return day(a) === day(b);
    }
    if (typeof current === 'number') return Number(value) === current;
    return String(value) === String(current);
  };
  /**
   * Only genuinely changed fields are written — so pressing “Save” on a form
   * nobody touched reports “nothing to change” instead of a false update, and
   * the audit log stays a record of decisions rather than of clicks.
   */
  const set = (column, value) => {
    const current = current_[column];
    if (same(value, current)) return false;
    sets.push(`${column} = ?`);
    params.push(value);
    detail[column] = value;
    return true;
  };

  if (patch.documentsState && ['current', 'expiring', 'missing'].includes(patch.documentsState)) {
    set('documents_state', patch.documentsState);
  }
  if (patch.documentsDue !== undefined) set('documents_due', patch.documentsDue ? sqlDate(patch.documentsDue) : null);
  if (patch.trackerState && ['fitted', 'on_order', 'none'].includes(patch.trackerState)) set('tracker_state', patch.trackerState);
  if (patch.status && ['available', 'on_hire', 'service', 'retired'].includes(patch.status)) set('status', patch.status);
  if (patch.location !== undefined) set('location', patch.location ? String(patch.location).slice(0, 80) : null);
  if (patch.notes !== undefined) set('notes', patch.notes ? String(patch.notes).slice(0, 300) : null);
  if (patch.driverAvailable !== undefined) set('driver_available', patch.driverAvailable ? 1 : 0);
  if (patch.classSlug) {
    const classes = await classOptions();
    if (!classes.some((c) => c.slug === patch.classSlug)) return { ok: false, error: 'That class does not exist.' };
    set('class_slug', patch.classSlug);
  }
  if (!sets.length) return { ok: true, unchanged: true, vehicle: await vehicleById(id) };

  params.push(Number(id));
  await query(`UPDATE hire_vehicles SET ${sets.join(', ')} WHERE id = ?`, params);
  await recordAudit({ actorId, action: 'hire.vehicle_updated', entity: 'hire_vehicle', entityId: Number(id), detail });
  return { ok: true, vehicle: await vehicleById(id) };
}

async function recordAudit({ actorId, action, entity, entityId, detail }) {
  if (!actorId) return;
  await query(
    'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    [actorId, action, entity, entityId, JSON.stringify(detail || {})],
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Availability & calendar
// ---------------------------------------------------------------------------

/**
 * A day-by-day view of the pool over a window.
 *
 * Each row is a unit and each day is one of: free, out (with the booking
 * reference), blocked (service/retired), or invalid (papers missing or expired).
 * The invalid state is separate from blocked on purpose — a car in the workshop
 * is a scheduling problem, a car with no insurance is a compliance one.
 */
async function availability({ from, to, classSlug = null, includeRetired = false } = {}) {
  const start = from ? new Date(from) : new Date();
  const end = to ? new Date(to) : new Date(Date.now() + 13 * 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { from: null, to: null, days: [], rows: [] };
  if (end < start) return { from: sqlDate(start), to: sqlDate(end), days: [], rows: [], error: 'The window ends before it starts.' };

  const vehicles = await pool({ classSlug, includeRetired, limit: 200 });
  const bookings = await query(
    `SELECT b.id, b.reference, b.vehicle_id, b.class_slug, b.status, b.pickup_at, b.dropoff_at, b.client_name, b.company
       FROM hire_bookings b
      WHERE b.status IN ('requested','quoted','accepted','confirmed','on_hire')
        AND b.vehicle_id IS NOT NULL
        AND b.pickup_at <= ?
        AND b.dropoff_at >= ?`,
    [sqlDate(end), sqlDate(start)],
  );

  const byVehicle = new Map();
  for (const booking of bookings) {
    if (!booking.vehicle_id) continue;
    const key = Number(booking.vehicle_id);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push(booking);
  }

  const days = [];
  for (let cursor = new Date(start.getTime()); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(sqlDate(cursor));
  }

  const rows = vehicles.map((vehicle) => {
    const cells = days.map((day) => {
      const booking = (byVehicle.get(vehicle.id) || []).find((b) => sqlDate(b.pickup_at) <= day && sqlDate(b.dropoff_at) >= day);
      if (booking) {
        // 'out' is a hire that is paid for or running; 'held' is a unit put on a
        // quote the client has not accepted yet. The desk can still move a hold.
        return {
          day,
          state: ['accepted', 'confirmed', 'on_hire'].includes(booking.status) ? 'out' : 'held',
          reference: booking.reference,
          bookingId: booking.id,
          client: booking.company || booking.client_name,
          starts: sqlDate(booking.pickup_at) === day,
          ends: sqlDate(booking.dropoff_at) === day,
        };
      }
      if (vehicle.status === 'retired') return { day, state: 'retired' };
      if (vehicle.status === 'service') return { day, state: 'service' };
      if (!vehicle.documentsValid) return { day, state: 'invalid', reason: vehicle.documentsLabel };
      return { day, state: 'free' };
    });
    return { vehicle, cells };
  });

  return {
    from: days[0] || null,
    to: days[days.length - 1] || null,
    days,
    rows,
    counts: {
      units: vehicles.length,
      freeToday: rows.filter((row) => row.cells[0] && row.cells[0].state === 'free').length,
      outToday: rows.filter((row) => row.cells[0] && row.cells[0].state === 'out').length,
      heldToday: rows.filter((row) => row.cells[0] && row.cells[0].state === 'held').length,
      blockedToday: rows.filter((row) => row.cells[0] && ['service', 'invalid', 'retired'].includes(row.cells[0].state)).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

const BOOKING_SELECT = `SELECT b.*, v.plate, v.make, v.model, v.year, c.name AS class_name, r.tracking_id,
         (SELECT pm.id FROM payments pm WHERE pm.hire_booking_id = b.id ORDER BY pm.id DESC LIMIT 1) AS payment_id,
         (SELECT pm.status FROM payments pm WHERE pm.hire_booking_id = b.id ORDER BY pm.id DESC LIMIT 1) AS payment_status,
         (SELECT pm.reference FROM payments pm WHERE pm.hire_booking_id = b.id ORDER BY pm.id DESC LIMIT 1) AS payment_reference,
         (SELECT COUNT(*) FROM hire_incidents i WHERE i.booking_id = b.id) AS incident_count,
         (SELECT COUNT(*) FROM hire_incidents i WHERE i.booking_id = b.id AND i.status = 'open') AS open_incidents
    FROM hire_bookings b
    LEFT JOIN hire_vehicles v ON v.id = b.vehicle_id
    LEFT JOIN hire_classes c ON c.slug = b.class_slug
    LEFT JOIN service_requests r ON r.id = b.request_id`;

async function bookingById(id) {
  const row = await queryOne(`${BOOKING_SELECT} WHERE b.id = ? LIMIT 1`, [Number(id) || 0]);
  return shapeBooking(row);
}

async function bookingByReference(reference) {
  const row = await queryOne(`${BOOKING_SELECT} WHERE b.reference = ? LIMIT 1`, [String(reference || '').toUpperCase().slice(0, 24)]);
  return shapeBooking(row);
}

async function bookings({ status = null, vehicleId = null, from = null, to = null, search = null, limit = 200, upcomingOnly = false } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('b.status = ?');
    params.push(status);
  }
  if (vehicleId) {
    where.push('b.vehicle_id = ?');
    params.push(Number(vehicleId));
  }
  if (upcomingOnly) where.push("b.status IN ('accepted','confirmed','on_hire') AND b.dropoff_at >= UTC_DATE()");
  if (from) {
    where.push('b.dropoff_at >= ?');
    params.push(sqlDate(from));
  }
  if (to) {
    where.push('b.pickup_at <= ?');
    params.push(sqlDate(to));
  }
  if (search) {
    where.push('(b.client_name LIKE ? OR b.client_phone LIKE ? OR b.company LIKE ? OR b.reference LIKE ? OR v.plate LIKE ?)');
    const like = `%${String(search).slice(0, 60)}%`;
    params.push(like, like, like, like, like);
  }
  const rows = await query(
    `${BOOKING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.pickup_at DESC, b.id DESC LIMIT ?`,
    [...params, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(shapeBooking);
}

/** What a client's own phone number can see (§7.1: hire bookings on /account). */
async function bookingsForPhone(phone, { limit = 20 } = {}) {
  const shapes = phones.variants(phone);
  if (!shapes.length) return [];
  const rows = await query(
    `${BOOKING_SELECT}
      WHERE b.client_phone IN (${shapes.map(() => '?').join(',')})
      ORDER BY b.pickup_at DESC LIMIT ?`,
    [...shapes, Math.min(50, Math.max(1, limit))],
  );
  return rows.map(shapeBooking);
}

/**
 * Allocate a unit. Refuses when the unit is not free — the same overlap test the
 * availability screen draws, enforced here because the screen can be stale by
 * the time the form is submitted.
 */
async function allocateVehicle(bookingId, vehicleId, { actorId = null } = {}) {
  const booking = await queryOne('SELECT * FROM hire_bookings WHERE id = ? LIMIT 1', [Number(bookingId) || 0]);
  if (!booking) return { ok: false, error: 'That hire does not exist.' };
  if (booking.status === 'cancelled') return { ok: false, error: 'That hire was cancelled.' };

  const vehicle = await queryOne('SELECT * FROM hire_vehicles WHERE id = ? LIMIT 1', [Number(vehicleId) || 0]);
  if (!vehicle) return { ok: false, error: 'That unit is not in the pool.' };
  if (vehicle.status === 'retired') return { ok: false, error: `${vehicle.plate} has been retired from the pool.` };
  if (vehicle.documents_state === 'missing') {
    return { ok: false, error: `${vehicle.plate} has no documents on file — no hire goes out on a car we cannot show papers for.` };
  }
  if (vehicle.documents_due && daysUntil(vehicle.documents_due) < 0) {
    return { ok: false, error: `${vehicle.plate}'s papers expired on ${sqlDate(vehicle.documents_due)} — renew them before it goes out.` };
  }
  // The price is the class price. Putting a sedan on an SUV quote would bill the
  // client for a car they are not getting, which is the whole reason the class
  // is on the booking at all.
  if (vehicle.class_slug !== booking.class_slug) {
    const asked = await queryOne('SELECT name FROM hire_classes WHERE slug = ? LIMIT 1', [booking.class_slug]);
    const actual = await queryOne('SELECT name FROM hire_classes WHERE slug = ? LIMIT 1', [vehicle.class_slug]);
    return {
      ok: false,
      error: `${vehicle.plate} is a ${actual ? actual.name : vehicle.class_slug}, but ${booking.reference} was quoted for a ${asked ? asked.name : booking.class_slug}. Allocate the class that was quoted, or requote.`,
    };
  }

  // Any live booking that already names this unit blocks the dates — including a
  // quoted one. A quote does not hold a car on its own (quoting never allocates),
  // but once a unit has been put on a quote it is that client's car until the
  // quote is cancelled or moved.
  const clash = await queryOne(
    `SELECT b.reference, b.pickup_at, b.dropoff_at, b.status FROM hire_bookings b
      WHERE b.vehicle_id = ?
        AND b.id <> ?
        AND b.status NOT IN ('cancelled','completed')
        AND b.pickup_at <= ?
        AND b.dropoff_at >= ?
      LIMIT 1`,
    [vehicle.id, booking.id, sqlDate(booking.dropoff_at), sqlDate(booking.pickup_at)],
  );
  if (clash) {
    return {
      ok: false,
      error: `${vehicle.plate} is on ${clash.reference} (${String(clash.status).replace('_', ' ')}) from ${sqlDate(clash.pickup_at)} to ${sqlDate(clash.dropoff_at)} — those dates overlap.`,
    };
  }

  await query('UPDATE hire_bookings SET vehicle_id = ? WHERE id = ?', [vehicle.id, booking.id]);
  if (!booking.vehicle_id && ['accepted', 'confirmed'].includes(booking.status)) {
    await query("UPDATE hire_vehicles SET status = 'on_hire' WHERE id = ? AND status = 'available'", [vehicle.id]);
  }
  await recordAudit({ actorId, action: 'hire.vehicle_allocated', entity: 'hire_booking', entityId: booking.id, detail: { plate: vehicle.plate, vehicleId: vehicle.id } });
  return { ok: true, booking: await bookingById(booking.id) };
}

/**
 * Move a hire through its lifecycle. Each transition has a rule, because the
 * mistakes here are all money: confirming without a vehicle, completing without
 * the car coming back, cancelling a hire that is already out.
 */
async function setStatus(id, next, { actorId = null, reason = null, fuelIn = null, odometerIn = null } = {}) {
  const booking = await queryOne('SELECT * FROM hire_bookings WHERE id = ? LIMIT 1', [Number(id) || 0]);
  if (!booking) return { ok: false, error: 'That hire does not exist.' };
  if (!BOOKING_STATUSES.includes(next)) return { ok: false, error: 'Unknown hire status.' };
  if (booking.status === next) return { ok: true, unchanged: true, booking: await bookingById(id) };
  if (booking.status === 'completed') return { ok: false, error: 'That hire is closed.' };
  if (booking.status === 'cancelled') return { ok: false, error: 'That hire was cancelled.' };

  if (next === 'confirmed' && !booking.vehicle_id) {
    return { ok: false, error: 'Allocate a unit before confirming the hire — the client is told which car to expect.' };
  }
  if (next === 'on_hire' && !booking.vehicle_id) {
    return { ok: false, error: 'A hire cannot start without a unit allocated.' };
  }
  // The car goes out when the hire is confirmed — that is to say, when the money
  // has landed and a unit is on it. A hire that has been accepted but not paid
  // would put a car on the road against an unpaid invoice, and the trail J6 asks
  // for runs quote → accept → pay → calendar, in that order.
  if (next === 'on_hire' && booking.status !== 'confirmed') {
    if (['requested', 'quoted'].includes(booking.status)) {
      return { ok: false, error: `${booking.reference} has not been accepted yet — send the quote and record the client's yes first.` };
    }
    const raised = await queryOne(
      "SELECT reference FROM payments WHERE hire_booking_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      [booking.id],
    );
    return {
      ok: false,
      error: raised
        ? `The hire is accepted but ${raised.reference} has not landed. Confirm the payment (money console) and the hire confirms itself, then release the car.`
        : 'The hire is accepted but no payment is recorded against it. Confirm the payment in the money console, or record a manual payment, before the car goes out.',
    };
  }
  // A car comes back only after it went out. Allowing “complete” from confirmed
  // or accepted would close a hire whose money never landed and whose car never
  // left the yard — the readings at the end of it are the proof it ran.
  if (next === 'completed' && booking.status !== 'on_hire') {
    return {
      ok: false,
      error: booking.vehicle_id
        ? 'Mark the hire as on hire when the car goes out, then complete it when it comes back.'
        : 'No unit was ever allocated to that hire, so there is nothing to complete. Cancel it instead.',
    };
  }
  if (next === 'cancelled' && booking.status === 'on_hire') {
    return { ok: false, error: 'The car is already out. Complete the hire when it comes back, then record what went wrong.' };
  }

  const sets = ['status = ?'];
  const params = [next];
  if (next === 'quoted' && !booking.quote_sent_at) sets.push('quote_sent_at = UTC_TIMESTAMP()');
  if (next === 'accepted') sets.push('accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP())');
  if (next === 'completed') {
    sets.push('completed_at = UTC_TIMESTAMP()');
    if (fuelIn !== null) {
      sets.push('fuel_in = ?');
      params.push(Math.min(100, Math.max(0, Number(fuelIn) || 0)));
    }
    if (odometerIn !== null) {
      sets.push('odometer_in = ?');
      params.push(Math.max(0, Number(odometerIn) || 0));
    }
  }
  if (next === 'cancelled') {
    sets.push('cancelled_at = UTC_TIMESTAMP()');
    if (reason) {
      sets.push('cancel_reason = ?');
      params.push(String(reason).slice(0, 200));
    }
  }
  params.push(Number(id));
  await query(`UPDATE hire_bookings SET ${sets.join(', ')} WHERE id = ?`, params);

  // The unit's own status follows the hire: out while it is out, free when it
  // comes back or the hire falls through.
  if (booking.vehicle_id) {
    if (next === 'on_hire') {
      await query("UPDATE hire_vehicles SET status = 'on_hire' WHERE id = ? AND status <> 'retired'", [booking.vehicle_id]);
    }
    if (next === 'completed' || next === 'cancelled') {
      await query(
        "UPDATE hire_vehicles SET status = IF(status = 'on_hire', 'available', status) WHERE id = ?",
        [booking.vehicle_id],
      );
    }
  }

  await recordAudit({ actorId, action: `hire.${next}`, entity: 'hire_booking', entityId: Number(id), detail: { from: booking.status, to: next, reason } });
  return { ok: true, booking: await bookingById(id) };
}

/** Confirm a hire because its money landed — called from payments.markPaid. */
async function confirmFromPayment(conn, payment) {
  if (!payment || !payment.hireBookingId) return null;
  const [[row]] = await conn.query('SELECT * FROM hire_bookings WHERE id = ? FOR UPDATE', [payment.hireBookingId]);
  if (!row) return null;
  // accepted → confirmed is the money step of J6; requested/quoted → confirmed
  // covers a hire paid straight off the quote, which is how most of them go.
  const next = ['requested', 'quoted', 'accepted'].includes(row.status) ? 'confirmed' : row.status;
  await conn.query(
    `UPDATE hire_bookings
        SET status = ?, accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP())
      WHERE id = ?`,
    [next, row.id],
  );
  // The car stays 'available' until the hire actually starts — being paid is not
  // the same as being on the road, and the calendar already blocks these dates.
  return { id: row.id, reference: row.reference, previousStatus: row.status, status: next, vehicleId: row.vehicle_id, amountKobo: payment.amountKobo };
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

const INCIDENT_SELECT = `SELECT i.*, b.reference AS booking_reference, v.plate, u.name AS reported_by_name
    FROM hire_incidents i
    LEFT JOIN hire_bookings b ON b.id = i.booking_id
    LEFT JOIN hire_vehicles v ON v.id = i.vehicle_id
    LEFT JOIN \`users\` u ON u.id = i.reported_by`;

async function incidents({ status = null, kind = null, vehicleId = null, bookingId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('i.status = ?');
    params.push(status);
  }
  if (kind) {
    where.push('i.kind = ?');
    params.push(kind);
  }
  if (vehicleId) {
    where.push('i.vehicle_id = ?');
    params.push(Number(vehicleId));
  }
  if (bookingId) {
    where.push('i.booking_id = ?');
    params.push(Number(bookingId));
  }
  const rows = await query(
    `${INCIDENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.status = 'resolved', i.created_at DESC LIMIT ?`,
    [...params, Math.min(300, Math.max(1, limit))],
  );
  return rows.map(shapeIncident);
}

/**
 * Log an incident against a hire or a unit.
 *
 * The vehicle is taken from the booking when there is one, so an incident can
 * never be filed against a car that was not the car. `cost` and `charged` are
 * separate because “what it cost us” and “what the client agreed to pay” are
 * different numbers, and the difference is what the desk argues about.
 */
async function logIncident({
  bookingId = null, vehicleId = null, kind = 'other', severity = 'minor', detail,
  costKobo = 0, chargedKobo = 0, occurredAt = null, actorId = null,
} = {}) {
  const text = String(detail || '').trim();
  if (!text) return { ok: false, error: 'An incident needs a description — it is the only record of what happened.' };
  if (!INCIDENT_KINDS.includes(kind)) return { ok: false, error: 'Unknown incident type.' };
  if (!INCIDENT_SEVERITIES.includes(severity)) return { ok: false, error: 'Unknown severity.' };

  let booking = null;
  if (bookingId) {
    booking = await queryOne('SELECT id, vehicle_id, reference FROM hire_bookings WHERE id = ? LIMIT 1', [Number(bookingId) || 0]);
    if (!booking) return { ok: false, error: 'That hire does not exist.' };
  }
  // A booking knows which car it was, so the vehicle is never typed in by hand
  // when the incident belongs to a hire.
  const resolvedVehicleId = booking ? booking.vehicle_id : (vehicleId ? Number(vehicleId) : null);

  const result = await query(
    `INSERT INTO hire_incidents
       (booking_id, vehicle_id, kind, severity, detail, cost_kobo, charged_kobo, occurred_at, reported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      booking ? booking.id : null,
      resolvedVehicleId,
      kind,
      severity,
      text.slice(0, 500),
      Math.max(0, Number(costKobo) || 0),
      Math.max(0, Number(chargedKobo) || 0),
      occurredAt ? new Date(occurredAt).toISOString().slice(0, 19).replace('T', ' ') : null,
      actorId,
    ],
  );

  // A write-off or a major fault pulls the unit off the road until somebody
  // looks at it. Anything less stays available.
  if (resolvedVehicleId && severity !== 'minor') {
    await query("UPDATE hire_vehicles SET status = 'service' WHERE id = ? AND status <> 'retired'", [resolvedVehicleId]);
  }
  await recordAudit({ actorId, action: 'hire.incident_logged', entity: 'hire_incident', entityId: result.insertId, detail: { kind, severity, bookingId: booking ? booking.id : null } });
  return { ok: true, id: result.insertId };
}

async function resolveIncident(id, { resolution = null, chargedKobo = null, writtenOff = false, actorId = null } = {}) {
  const current = await queryOne('SELECT * FROM hire_incidents WHERE id = ? LIMIT 1', [Number(id) || 0]);
  if (!current) return { ok: false, error: 'That incident does not exist.' };
  if (current.status !== 'open') return { ok: false, error: 'That incident has already been closed.' };

  const sets = ['status = ?', 'resolved_at = UTC_TIMESTAMP()'];
  const params = [writtenOff ? 'written_off' : 'resolved'];
  if (resolution) {
    sets.push('resolution = ?');
    params.push(String(resolution).slice(0, 400));
  }
  if (chargedKobo !== null && chargedKobo !== undefined) {
    sets.push('charged_kobo = ?');
    params.push(Math.max(0, Number(chargedKobo) || 0));
  }
  params.push(Number(id));
  await query(`UPDATE hire_incidents SET ${sets.join(', ')} WHERE id = ?`, params);

  // Once nothing is open against it, a car in the workshop can go back out.
  if (current.vehicle_id) {
    const stillOpen = await queryOne('SELECT COUNT(*) AS n FROM hire_incidents WHERE vehicle_id = ? AND status = ?', [current.vehicle_id, 'open']);
    if (!Number(stillOpen.n)) {
      await query("UPDATE hire_vehicles SET status = 'available' WHERE id = ? AND status = 'service'", [current.vehicle_id]);
    }
  }
  await recordAudit({ actorId, action: 'hire.incident_resolved', entity: 'hire_incident', entityId: Number(id), detail: { writtenOff, chargedKobo } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Summary — the console's strip
// ---------------------------------------------------------------------------

async function summary() {
  const [vehicles, byStatus, incidents, dueBack] = await Promise.all([
    pool({ limit: 500 }),
    query('SELECT status, COUNT(*) AS n FROM hire_bookings GROUP BY status'),
    query("SELECT COUNT(*) AS total, SUM(status = 'open') AS open_rows, COALESCE(SUM(cost_kobo), 0) AS cost FROM hire_incidents"),
    query(
      `SELECT COUNT(*) AS n FROM hire_bookings
        WHERE status IN ('accepted','confirmed','on_hire')
          AND dropoff_at BETWEEN UTC_DATE() AND DATE_ADD(UTC_DATE(), INTERVAL 2 DAY)`,
    ),
  ]);

  const counts = {};
  for (const row of byStatus) counts[row.status] = Number(row.n);

  const docsExpiring = vehicles.filter((v) => v.documentsDays !== null && v.documentsDays >= 0 && v.documentsDays <= 30);
  const docsLapsed = vehicles.filter((v) => v.documentsState !== 'missing' && v.documentsDays !== null && v.documentsDays < 0);
  const untracked = vehicles.filter((v) => v.trackerState !== 'fitted');

  return {
    counts,
    units: vehicles.length,
    available: vehicles.filter((v) => v.status === 'available' && v.documentsValid).length,
    onHire: vehicles.filter((v) => v.status === 'on_hire').length,
    inService: vehicles.filter((v) => v.status === 'service').length,
    partnerOwned: vehicles.filter((v) => v.owner === 'partner').length,
    docsExpiring: docsExpiring.length,
    docsLapsed: docsLapsed.length,
    untracked: untracked.length,
    dueBack: Number((dueBack[0] || {}).n || 0),
    incidents: {
      total: Number((incidents[0] || {}).total || 0),
      open: Number((incidents[0] || {}).open_rows || 0),
      costKobo: Number((incidents[0] || {}).cost || 0),
    },
    needsVehicle: (await query(
      `SELECT COUNT(*) AS n FROM hire_bookings WHERE vehicle_id IS NULL AND status IN ('accepted','confirmed')`,
    ))[0].n,
    // What the pool is worth to us this month, on paper: the day rate times the
    // days actually booked. A rough utilisation figure beats a made-up exact one.
    bookedDays: Number((await queryOne(
      `SELECT COALESCE(SUM(days), 0) AS n FROM hire_bookings
        WHERE status IN ('confirmed','on_hire','completed')
          AND pickup_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`,
    )).n || 0),
  };
}

module.exports = {
  BOOKING_STATUSES,
  ACTIVE_STATUSES,
  INCIDENT_KINDS,
  INCIDENT_SEVERITIES,
  STATUS_LABELS,
  VEHICLE_STATUS_LABELS,
  DOCUMENT_LABELS,
  TRACKER_LABELS,
  INCIDENT_LABELS,
  daysBetween,
  daysUntil,
  sqlDate,
  shapeVehicle,
  shapeBooking,
  shapeIncident,
  pool,
  vehicleById,
  availableVehicles,
  classOptions,
  createVehicle,
  updateVehicle,
  availability,
  bookingById,
  bookingByReference,
  bookings,
  bookingsForPhone,
  allocateVehicle,
  setStatus,
  confirmFromPayment,
  incidents,
  logIncident,
  resolveIncident,
  summary,
  transaction,
};
