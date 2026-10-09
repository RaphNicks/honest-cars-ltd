'use strict';

/**
 * Hire quotes and bookings — FR-22, §7.3, acceptance scenario J6.
 *
 *   “Corporate hire request — /hire · RFQ → ops quote (template) → client
 *    accepts & pays → booking calendar → completion + invoice PDF.
 *    Quote/accept/pay trail digital end-to-end.”
 *
 * The quote is built from the class rate card, never from the request body: a
 * client can ask for fourteen days and an SUV, and the price comes from
 * `hire_classes`. Every line is stored on the booking rather than recomputed, so
 * repricing a class later cannot silently rewrite a hire that was already agreed
 * — the client pays what the quote they read said.
 *
 * `hire_classes.weekly_rate_kobo` applies from six days, which is what the
 * /hire page tells people, so the same rule is applied here.
 */

const db = require('../db');
const notify = require('../services/notify');
const money = require('../lib/money');
const validate = require('./validate');

/** The day the weekly rate takes over — stated on /hire, so it lives here too. */
const WEEKLY_FROM_DAYS = 6;

/** Deposit as a share of the hire, returned at handover. */
const DEPOSIT_RATE = 0.1;

/**
 * Price a hire. Returns the lines the client will read, in kobo.
 *
 * `days` is inclusive of both dates, because “the 10th to the 13th” is four days
 * to everybody except a spreadsheet.
 */
function quoteLines({ hireClass, days, withDriver = false, airportPickup = false, extrasKobo = 0 }) {
  if (!hireClass) return { ok: false, error: 'Choose the class the client asked for.' };
  if (!Number.isFinite(days) || days < 1) return { ok: false, error: 'A hire needs at least one day.' };

  const daily = Number(hireClass.daily_rate_kobo || 0);
  const weekly = Number(hireClass.weekly_rate_kobo || 0);
  const usesWeekly = days >= WEEKLY_FROM_DAYS && weekly > 0;
  // Weekly is priced per seven days, then the remainder at the day rate. With
  // fourteen days that is exactly two weeks; with ten it is a week plus three
  // days, which is what the desk would say out loud.
  const weeks = usesWeekly ? Math.floor(days / 7) : 0;
  const looseDays = usesWeekly ? days % 7 : days;
  const dayRateKobo = usesWeekly ? weekly : daily;
  const hireKobo = usesWeekly ? weeks * weekly + looseDays * daily : days * daily;
  const driverKobo = withDriver ? Number(hireClass.with_driver_kobo || 0) * days : 0;
  const extras = Math.max(0, Number(extrasKobo) || 0);
  const subtotal = hireKobo + driverKobo + extras;
  const depositKobo = Math.round(subtotal * DEPOSIT_RATE);

  return {
    ok: true,
    days,
    weeks,
    looseDays,
    usedWeeklyRate: usesWeekly,
    dayRateKobo,
    dayRateLabel: usesWeekly ? `${weeks} week${weeks === 1 ? '' : 's'}${looseDays ? ` + ${looseDays} day${looseDays === 1 ? '' : 's'}` : ''}` : `${days} day${days === 1 ? '' : 's'}`,
    hireKobo,
    driverKobo,
    extrasKobo: extras,
    depositKobo,
    totalKobo: subtotal + depositKobo,
    breakdown: [
      { label: `Hire — ${usesWeekly ? `${weeks} week${weeks === 1 ? '' : 's'}${looseDays ? ` + ${looseDays} day${looseDays === 1 ? '' : 's'}` : ''}` : `${days} day${days === 1 ? '' : 's'}`}`, amountKobo: hireKobo },
      driverKobo ? { label: `Driver — ${days} day${days === 1 ? '' : 's'}`, amountKobo: driverKobo } : null,
      extras ? { label: 'Extras', amountKobo: extras } : null,
      depositKobo ? { label: 'Refundable deposit (returned at handover)', amountKobo: depositKobo } : null,
    ].filter(Boolean),
  };
}

async function classBySlug(slug) {
  return db.queryOne('SELECT * FROM hire_classes WHERE slug = ? LIMIT 1', [String(slug || '').slice(0, 40)]);
}

/**
 * Turn a hire request into a quoted booking.
 *
 * Idempotent on the request: pressing “Quote” twice updates the quote rather
 * than creating a second booking for the same client, which is the mistake that
 * makes two references for one hire.
 */
async function quoteFromRequest(requestId, { note = null, extrasKobo = 0, actorId = null, days = null, classSlug = null, withDriver = null, airportPickup = null, pickupAt = null, dropoffAt = null, units = null } = {}) {
  const request = await db.queryOne('SELECT * FROM service_requests WHERE id = ? LIMIT 1', [Number(requestId) || 0]);
  if (!request) return { ok: false, error: 'That request does not exist.' };
  if (request.type !== 'hire') return { ok: false, error: 'That request is not a hire request.' };

  // The live /hire form posts vehicle_class / date_from / date_to / with_driver=yes;
  // older and seeded briefs use class / pickup / dropoff. Both are read, because
  // a request that came in last month still has to be quotable today.
  const brief = request.brief || {};
  const resolvedClass = classSlug || brief.vehicle_class || brief.class || null;
  const hireClass = await classBySlug(resolvedClass);
  if (!hireClass) return { ok: false, error: 'That request does not name a class we hire — pick one on the quote.' };

  // An RFQ often says “fourteen days from the 3rd” without fixed dates: ops sets
  // them on the quote, and that is the date the client is held to.
  const startAt = pickupAt || brief.date_from || brief.pickup || null;
  const endAt = dropoffAt || brief.date_to || brief.dropoff || null;
  if (!startAt || !endAt) return { ok: false, error: 'The request has no dates — add them on the quote before pricing it.' };
  if (db.hire.daysBetween(startAt, endAt) < 1) return { ok: false, error: 'The drop-off date is before the pick-up date.' };

  const resolvedDays = db.hire.daysBetween(startAt, endAt) || days || brief.days;
  const resolvedUnits = Math.max(1, Math.min(20, Number(units) || Number(brief.vehicles) || 1));
  // Checkbox forms post the string 'yes'; seeded briefs use a boolean.
  const yes = (value) => value === 'yes' || value === true || value === 1;
  const driver = withDriver === null ? yes(brief.with_driver) : Boolean(withDriver);
  const airport = airportPickup === null ? yes(brief.airport_pickup) || brief.pickup_point === 'airport' : Boolean(airportPickup);

  const priced = quoteLines({ hireClass, days: resolvedDays, withDriver: driver, airportPickup: airport, extrasKobo });
  if (!priced.ok) return priced;

  // A quote for four cars is only honest if four cars are free. Allocation is
  // the real guard (it refuses a clashing unit); this is the check at the moment
  // the number is put in front of the client.
  const free = await db.hire.availableVehicles({ classSlug: hireClass.slug, from: startAt, to: endAt });
  if (free.length < resolvedUnits) {
    return {
      ok: false,
      error: free.length
        ? `Only ${free.length} ${hireClass.name} unit${free.length === 1 ? '' : 's'} free for those dates — the client asked for ${resolvedUnits}. Change the dates, the class, or quote what we have.`
        : `No ${hireClass.name} is free for those dates. Change the dates or quote another class.`,
      freeUnits: free.map((unit) => unit.plate),
    };
  }

  const existing = await db.queryOne('SELECT * FROM hire_bookings WHERE request_id = ? LIMIT 1', [request.id]);
  const clientName = String(request.name || 'Client').slice(0, 120);
  const company = validate.text(brief.company, 120) || null;

  if (existing) {
    if (['on_hire', 'completed', 'cancelled'].includes(existing.status)) {
      return { ok: false, error: `That request is already a ${existing.status.replace('_', ' ')} hire (${existing.reference}) — quote it again from a new request.` };
    }
    await db.query(
      `UPDATE hire_bookings
          SET class_slug = ?, pickup_at = ?, dropoff_at = ?, days = ?, with_driver = ?, airport_pickup = ?,
              day_rate_kobo = ?, driver_kobo = ?, extras_kobo = ?, deposit_kobo = ?, total_kobo = ?,
              notes = ?, quote_sent_at = UTC_TIMESTAMP(), status = 'quoted'
        WHERE id = ?`,
      [
        hireClass.slug, db.hire.sqlDate(startAt), db.hire.sqlDate(endAt), priced.days, driver ? 1 : 0, airport ? 1 : 0,
        priced.dayRateKobo, priced.driverKobo, priced.extrasKobo, priced.depositKobo, priced.totalKobo,
        note ? String(note).slice(0, 400) : existing.notes, existing.id,
      ],
    );
    await audit(actorId, 'hire.requoted', existing.id, { requestId: request.id, totalKobo: priced.totalKobo });
    return { ok: true, booking: await db.hire.bookingById(existing.id), repriced: true };
  }

  // One hire per car: the vehicle is the thing that gets allocated, insured and
  // invoiced, so a four-car RFQ is four hire references under one request. The
  // console groups them; the client sees four lines with one total.
  const created = [];
  const made = await db.transaction(async (conn) => {
    const rows = [];
    for (let unit = 0; unit < resolvedUnits; unit += 1) {
      const reference = await nextReference(conn);
      const [result] = await conn.query(
        `INSERT INTO hire_bookings
           (reference, request_id, class_slug, client_name, client_phone, company, pickup_at, dropoff_at,
            pickup_point, days, with_driver, airport_pickup, day_rate_kobo, driver_kobo, extras_kobo,
            deposit_kobo, total_kobo, status, quote_sent_at, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', UTC_TIMESTAMP(), ?, ?)`,
        [
          reference, request.id, hireClass.slug, clientName, request.phone, company,
          db.hire.sqlDate(startAt), db.hire.sqlDate(endAt),
          airport ? 'Omagwa arrivals' : (brief.pickup_point || null),
          priced.days, driver ? 1 : 0, airport ? 1 : 0,
          priced.dayRateKobo, priced.driverKobo, priced.extrasKobo, priced.depositKobo, priced.totalKobo,
          note ? String(note).slice(0, 400) : null,
          actorId,
        ],
      );
      rows.push({ id: result.insertId, reference });
    }
    return rows;
  });
  created.push(...made);

  await audit(actorId, 'hire.quoted', created[0].id, {
    requestId: request.id,
    references: created.map((row) => row.reference),
    units: created.length,
    totalKobo: priced.totalKobo,
    groupTotalKobo: priced.totalKobo * created.length,
  });

  const bookings = await Promise.all(created.map((row) => db.hire.bookingById(row.id)));
  return {
    ok: true,
    booking: bookings[0],
    bookings,
    units: bookings.length,
    unitTotalKobo: priced.totalKobo,
    groupTotalKobo: priced.totalKobo * bookings.length,
    created: true,
  };
}

/**
 * The next HC-HIRE-nnnn, through the same series every other reference uses.
 * The locking read and the retry-on-duplicate live in src/db/ids.js — the point
 * of that module is that a reference is never computed twice.
 */
async function nextReference(conn) {
  const ids = require('../db/ids');
  // Inside the caller's transaction when there is one, so the reference and the
  // row it names commit together.
  return conn ? ids.nextId(conn, 'hire') : db.transaction((c) => ids.nextId(c, 'hire'));
}

async function audit(actorId, action, entityId, detail) {
  if (!actorId) return;
  await db.query(
    'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    [actorId, action, 'hire_booking', entityId, JSON.stringify(detail || {})],
  ).catch(() => {});
}

/**
 * Tell the client what they are being quoted.
 *
 * The message carries the reference and the amount, because the two questions a
 * client has are “what is it” and “how much” — and it goes through the same
 * honest notification seam as everything else: with no provider configured the
 * text is recorded and the desk sends it from a WhatsApp deep link.
 */
async function sendQuote(bookingId, { actorId = null } = {}) {
  const booking = await db.hire.bookingById(bookingId);
  if (!booking) return { ok: false, error: 'That hire does not exist.' };
  if (booking.status === 'cancelled') return { ok: false, error: 'That hire was cancelled.' };

  const result = await notify.send({
    template: 'hire_quote',
    entity: 'hire_booking',
    entityId: booking.id,
    recipient: booking.phone,
    values: {
      reference: booking.reference,
      client: booking.clientName,
      className: booking.className,
      days: booking.days,
      from: db.hire.sqlDate(booking.pickupAt),
      to: db.hire.sqlDate(booking.dropoffAt),
      total: money.formatNaira(booking.totalKobo),
      deposit: money.formatNaira(booking.depositKobo),
      withDriver: booking.withDriver,
      company: booking.company,
    },
    createdBy: actorId,
  });
  await audit(actorId, 'hire.quote_sent', booking.id, { channel: result.channel, ok: Boolean(result.ok) });
  return { ok: true, sent: Boolean(result.ok), channel: result.channel, body: result.body, booking };
}

/**
 * The client accepts. This is the moment the hire becomes real on our side, so
 * it raises the payment in the same step — the client is never left with an
 * accepted quote and no way to pay it.
 */
async function accept(bookingId, { actorId = null } = {}) {
  const booking = await db.hire.bookingById(bookingId);
  if (!booking) return { ok: false, error: 'That hire does not exist.' };
  if (booking.status === 'cancelled') return { ok: false, error: 'That hire was cancelled.' };
  if (['confirmed', 'on_hire'].includes(booking.status)) return { ok: true, already: true, booking };

  const moved = await db.hire.setStatus(bookingId, 'accepted', { actorId });
  if (!moved.ok) return moved;

  // A payment already raised and unpaid is reused rather than duplicated: two
  // pending references for one hire is two chances to pay twice.
  if (booking.paymentId && booking.paymentStatus === 'pending' && booking.paymentReference) {
    return { ok: true, booking: moved.booking, paymentReference: booking.paymentReference, reusedPayment: true };
  }

  const paymentService = require('./payments');
  const raised = await paymentService.initiate({
    purpose: 'hire',
    amountKobo: moved.booking.totalKobo,
    hireBookingId: moved.booking.id,
    customerName: moved.booking.clientName,
    customerPhone: moved.booking.phone,
  });
  if (!raised.ok) return { ok: false, error: raised.error || 'The hire payment could not be raised.', booking: moved.booking };

  return {
    ok: true,
    booking: moved.booking,
    paymentReference: raised.reference,
    checkoutUrl: raised.checkoutUrl || null,
    hosted: Boolean(raised.hosted),
  };
}

module.exports = {
  WEEKLY_FROM_DAYS,
  DEPOSIT_RATE,
  quoteLines,
  classBySlug,
  quoteFromRequest,
  sendQuote,
  accept,
};
