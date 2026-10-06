'use strict';

/**
 * FR-22 — hire management: the pool, availability, the booking lifecycle,
 * incidents and the invoice.
 *
 * The promises worth testing are the ones that cost somebody money or a car:
 *
 *   • a unit is free only if it is not already out, not in the workshop, and its
 *     papers are valid — a car with no insurance is *there* and not available
 *   • allocation refuses a clashing unit and a unit of the wrong class, because
 *     the price the client agreed to is the class price
 *   • the lifecycle runs in one direction: quote → accept → pay → out → back,
 *     and every step out of order is refused with a sentence, not a 500
 *   • paying a hire confirms it inside the same transaction as the money
 *   • the invoice bills what was quoted (never the current rate card), adds
 *     incident charges, and releases the deposit at handover
 *
 * Fixtures are created against a throwaway phone number and torn down by exact
 * id, so the seeded demo data is never touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable } = require('./helpers');

let available = false;
const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
});

/** Phones no seeded account uses, so everything here is ours. */
const TENANT = '+2348099001144';
const COMPANY = 'Testcorp Logistics';

const db = require('../src/db');
const hire = require('../src/db/hire');
const hireService = require('../src/services/hire');
const invoice = require('../src/services/invoice');
const money = require('../src/lib/money');

/** ids created by this run, torn down newest-first in test.after. */
const created = { bookings: [], vehicles: [], requests: [], payments: [] };

function isoDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** A pool unit of a chosen class, with whatever papers state the test needs. */
async function makeVehicle({
  plate, classSlug = 'suv', owner = 'honestcars', documentsState = 'current',
  documentsDue = 300, trackerState = 'fitted', status = 'available', seats = 5, model = 'Testmobile',
} = {}) {
  const result = await hire.createVehicle({
    plate: plate || `TST-${Math.floor(Math.random() * 900 + 100)}-PH`,
    classSlug,
    make: 'Test',
    model,
    year: 2020,
    seats,
    owner,
    partnerName: owner === 'partner' ? 'Test Partner Ltd' : null,
    documentsState,
    documentsDue: documentsDue === null ? null : isoDate(documentsDue),
    trackerState,
    status,
    location: 'Test yard',
  });
  assert.equal(result.ok, true, result.error);
  created.vehicles.push(result.vehicle.id);
  return result.vehicle;
}

/** A hire request, as /hire would leave it. */
async function makeRequest({ classSlug = 'suv', days = 4, units = 1, from = 30, phone = TENANT } = {}) {
  const inserted = await db.query(
    `INSERT INTO service_requests (tracking_id, type, status, name, phone, brief, source_path, sla_due_at)
     VALUES (?, 'hire', 'new', 'Test Hirer', ?, ?, '/hire', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY))`,
    [
      `HC-T${Math.floor(Math.random() * 9000 + 1000)}`,
      phone,
      JSON.stringify({ vehicle_class: classSlug, date_from: isoDate(from), date_to: isoDate(from + days - 1), days, vehicles: units, with_driver: 'yes' }),
    ],
  );
  created.requests.push(inserted.insertId);
  return inserted.insertId;
}

async function makeBooking(overrides = {}) {
  // The phone has to travel with the request: a booking made “for” another number
  // while the request still carries the default one is a fixture that lies.
  const requestId = overrides.requestId === undefined
    ? await makeRequest({ units: 1, phone: overrides.phone || TENANT })
    : overrides.requestId;
  const result = await hireService.quoteFromRequest(requestId, {
    pickupAt: overrides.pickupAt || isoDate(30),
    dropoffAt: overrides.dropoffAt || isoDate(33),
    units: 1,
    withDriver: overrides.withDriver === undefined ? false : overrides.withDriver,
    actorId: null,
  });
  assert.equal(result.ok, true, result.error);
  const booking = result.booking;
  created.bookings.push(booking.id);
  return booking;
}

/**
 * One teardown, and it closes the pool *last*.
 *
 * Registering the pool close as a separate `test.after` looked tidier and was
 * wrong: hooks run in registration order, so the connections were gone before
 * the deletes ran, every one of them failed into a swallowed catch, and 35 test
 * units stayed in the pool for the next run to trip over.
 */
test.after(async () => {
  if (!available) return;
  // Children before parents: incidents and payments, then bookings, requests, cars.
  for (const id of created.bookings) await db.query('DELETE FROM hire_incidents WHERE booking_id = ?', [id]).catch(() => {});
  for (const id of created.bookings) await db.query('DELETE FROM payments WHERE hire_booking_id = ?', [id]).catch(() => {});
  for (const id of created.bookings) await db.query('DELETE FROM hire_bookings WHERE id = ?', [id]).catch(() => {});
  for (const id of created.requests) await db.query('DELETE FROM service_requests WHERE id = ?', [id]).catch(() => {});
  for (const id of created.vehicles) await db.query('DELETE FROM hire_vehicles WHERE id = ?', [id]).catch(() => {});
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

maybe('a unit carries its class rate, owner and paper state', async () => {
  const unit = await makeVehicle({ plate: 'TST-100-PH', classSlug: 'sedan', owner: 'partner', documentsDue: 12 });
  assert.equal(unit.classSlug, 'sedan');
  assert.equal(unit.className, 'Sedan');
  assert.equal(unit.owner, 'partner');
  assert.equal(unit.ownerLabel, 'Test Partner Ltd');
  assert.equal(unit.documentsLabel, 'Expiring');
  assert.equal(unit.documentsValid, true);
  assert.equal(unit.trackerLabel, 'Fitted');
});

maybe('a unit with no papers on file is not hireable, whatever its state says', async () => {
  const unit = await makeVehicle({ plate: 'TST-101-PH', documentsState: 'missing', documentsDue: null, status: 'available' });
  assert.equal(unit.documentsState, 'missing');
  assert.equal(unit.documentsValid, false);
});

maybe('a unit whose papers lapsed is not valid, even though the column says current', async () => {
  // The mistake a spreadsheet makes: the enum says “current”, the date is three
  // months gone. `documentsValid` reads the date.
  const unit = await makeVehicle({ plate: 'TST-102-PH', documentsState: 'current', documentsDue: -90 });
  assert.equal(unit.documentsState, 'current');
  assert.equal(unit.documentsValid, false);
  assert.equal(unit.documentsDays < 0, true);
});

maybe('a plate cannot be in the pool twice', async () => {
  await makeVehicle({ plate: 'TST-103-PH' });
  const again = await hire.createVehicle({ plate: 'tst-103-ph', classSlug: 'suv' });
  assert.equal(again.ok, false);
  assert.match(again.error, /already in the pool/i);
});

maybe('a unit cannot be added without a class we actually hire', async () => {
  const result = await hire.createVehicle({ plate: 'TST-104-PH', classSlug: 'spaceship' });
  assert.equal(result.ok, false);
  assert.match(result.error, /class/i);
});

maybe('the registry update path takes documents, tracker and workshop state', async () => {
  const unit = await makeVehicle({ plate: 'TST-105-PH' });
  const moved = await hire.updateVehicle(unit.id, { status: 'service', notes: 'Wheel bearing', documentsDue: isoDate(45) }, {});
  assert.equal(moved.ok, true);
  assert.equal(moved.vehicle.status, 'service');
  assert.equal(moved.vehicle.notes, 'Wheel bearing');
  // Nothing to change is not an error, and says so.
  const same = await hire.updateVehicle(unit.id, { status: 'service', notes: 'Wheel bearing', documentsDue: isoDate(45) }, {});
  assert.equal(same.unchanged, true);
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

maybe('availability is free / out / held / blocked / invalid, per unit per day', async () => {
  const rented = await makeVehicle({ plate: 'TST-110-PH' });
  const parked = await makeVehicle({ plate: 'TST-111-PH' });
  await makeVehicle({ plate: 'TST-112-PH', documentsState: 'missing', documentsDue: null });
  await makeVehicle({ plate: 'TST-113-PH', status: 'service' });

  const booking = await makeBooking({ pickupAt: isoDate(30), dropoffAt: isoDate(32) });
  await hire.allocateVehicle(booking.id, rented.id, {});
  await hire.setStatus(booking.id, 'accepted', {});
  await hire.setStatus(booking.id, 'confirmed', {});

  const view = await hire.availability({ from: isoDate(29), to: isoDate(34) });
  const rowFor = (plate) => view.rows.find((row) => row.vehicle.plate === plate);
  assert.equal(rowFor('TST-110-PH').cells[1].state, 'out', 'the hired unit is out on a booked day');
  assert.equal(rowFor('TST-110-PH').cells[0].state, 'free', 'and free before the hire starts');
  assert.equal(rowFor('TST-111-PH').cells[1].state, 'free');
  assert.equal(rowFor('TST-112-PH').cells[1].state, 'invalid');
  assert.equal(rowFor('TST-113-PH').cells[1].state, 'service');
  // A quoted hire that already holds a unit is a soft hold, not an out.
  const held = await makeBooking({ pickupAt: isoDate(31), dropoffAt: isoDate(33) });
  await hire.allocateVehicle(held.id, parked.id, {});
  const after = await hire.availability({ from: isoDate(29), to: isoDate(34) });
  assert.equal(after.rows.find((row) => row.vehicle.plate === 'TST-111-PH').cells[2].state, 'held');
});

maybe('the availability grid counts a unit once, on every day it is out', async () => {
  const unit = await makeVehicle({ plate: 'TST-115-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(40), dropoffAt: isoDate(43) });
  await hire.allocateVehicle(booking.id, unit.id, {});
  await hire.setStatus(booking.id, 'accepted', {});
  await hire.setStatus(booking.id, 'confirmed', {});
  const view = await hire.availability({ from: isoDate(39), to: isoDate(45) });
  const row = view.rows.find((r) => r.vehicle.plate === 'TST-115-PH');
  assert.equal(row.cells.filter((cell) => cell.state === 'out').length, 4, 'four days out, both ends included');
  assert.equal(row.cells[0].state, 'free');
  assert.equal(row.cells[5].state, 'free');
});

maybe('free units for a date range exclude the workshop, the retired and the paperless', async () => {
  await makeVehicle({ plate: 'TST-120-PH', classSlug: 'pickup' });
  await makeVehicle({ plate: 'TST-121-PH', classSlug: 'pickup', status: 'service' });
  await makeVehicle({ plate: 'TST-122-PH', classSlug: 'pickup', status: 'retired' });
  await makeVehicle({ plate: 'TST-123-PH', classSlug: 'pickup', documentsState: 'missing', documentsDue: null });
  const free = await hire.availableVehicles({ classSlug: 'pickup', from: isoDate(50), to: isoDate(53) });
  const plates = free.map((unit) => unit.plate);
  assert.equal(plates.includes('TST-120-PH'), true);
  assert.equal(plates.includes('TST-121-PH'), false);
  assert.equal(plates.includes('TST-122-PH'), false);
  assert.equal(plates.includes('TST-123-PH'), false);
});

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

maybe('a quote prices from the rate card: weekly rate from six days, deposit added', async () => {
  const hireClass = await hireService.classBySlug('suv');
  const short = hireService.quoteLines({ hireClass, days: 3 });
  assert.equal(short.hireKobo, Number(hireClass.daily_rate_kobo) * 3);
  assert.equal(short.usedWeeklyRate, false);
  assert.equal(short.depositKobo, Math.round(short.hireKobo * 0.1));

  const week = hireService.quoteLines({ hireClass, days: 7 });
  assert.equal(week.usedWeeklyRate, true);
  assert.equal(week.hireKobo, Number(hireClass.weekly_rate_kobo));

  // Ten days is a week plus three days, which is what the desk says out loud.
  const ten = hireService.quoteLines({ hireClass, days: 10 });
  assert.equal(ten.hireKobo, Number(hireClass.weekly_rate_kobo) + 3 * Number(hireClass.daily_rate_kobo));
  assert.equal(ten.dayRateLabel, '1 week + 3 days');
});

maybe('a driver is charged per day, leaving the weekly rate alone', async () => {
  const hireClass = await hireService.classBySlug('suv');
  const priced = hireService.quoteLines({ hireClass, days: 14, withDriver: true });
  assert.equal(priced.hireKobo, 2 * Number(hireClass.weekly_rate_kobo));
  assert.equal(priced.driverKobo, 14 * Number(hireClass.with_driver_kobo));
  assert.equal(priced.totalKobo, priced.hireKobo + priced.driverKobo + priced.depositKobo);
});

maybe('a request becomes a hire reference, priced and dated', async () => {
  const requestId = await makeRequest({ classSlug: 'sedan', days: 4 });
  const result = await hireService.quoteFromRequest(requestId, { actorId: null });
  assert.equal(result.ok, true, result.error);
  created.bookings.push(result.booking.id);
  assert.match(result.booking.reference, /^HC-HIRE-\d{4}$/);
  assert.equal(result.booking.status, 'quoted');
  assert.equal(result.booking.days, 4);
  assert.equal(result.booking.classSlug, 'sedan');
  assert.equal(Number(result.booking.totalKobo) > 0, true);
  assert.equal(result.booking.quoteSentAt !== null, true);
});

maybe('a four-car request quotes four references, one per car', async () => {
  const requestId = await makeRequest({ classSlug: 'bus', days: 3, units: 3 });
  await makeVehicle({ plate: 'TST-130-PH', classSlug: 'bus', seats: 14 });
  await makeVehicle({ plate: 'TST-131-PH', classSlug: 'bus', seats: 14 });
  await makeVehicle({ plate: 'TST-132-PH', classSlug: 'bus', seats: 14 });
  const result = await hireService.quoteFromRequest(requestId, { units: 3, actorId: null });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.units, 3);
  assert.equal(result.bookings.length, 3);
  for (const booking of result.bookings) created.bookings.push(booking.id);
  const references = new Set(result.bookings.map((booking) => booking.reference));
  assert.equal(references.size, 3, 'each car gets its own reference');
  assert.equal(result.groupTotalKobo, result.unitTotalKobo * 3);
});

maybe('a request we cannot cover is refused, with the number we can actually do', async () => {
  const requestId = await makeRequest({ classSlug: 'luxury', days: 2, units: 9 });
  const result = await hireService.quoteFromRequest(requestId, { units: 9, actorId: null });
  assert.equal(result.ok, false);
  assert.match(result.error, /free for those dates/i);
  assert.match(result.error, /asked for 9/i);
});

maybe('requoting the same request updates it instead of making a second hire', async () => {
  const booking = await makeBooking({ pickupAt: isoDate(60), dropoffAt: isoDate(62) });
  const result = await hireService.quoteFromRequest(booking.requestId, {
    pickupAt: isoDate(60), dropoffAt: isoDate(64), actorId: null,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.repriced, true);
  assert.equal(result.booking.id, booking.id, 'the same reference, repriced');
  assert.equal(result.booking.days, 5);
});

maybe('the quote message carries the reference, the dates and the amount', async () => {
  const booking = await makeBooking({});
  const sent = await hireService.sendQuote(booking.id, {});
  assert.equal(sent.ok, true, sent.error);
  assert.match(sent.body, new RegExp(booking.reference));
  assert.match(sent.body, /refundable deposit/i);
});

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

maybe('allocation refuses a unit of the wrong class', async () => {
  const booking = await makeBooking({});                      // quoted as SUV
  const sedan = await makeVehicle({ plate: 'TST-140-PH', classSlug: 'sedan' });
  const result = await hire.allocateVehicle(booking.id, sedan.id, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Sedan/);
  assert.match(result.error, /SUV/);
});

maybe('allocation refuses papers that are missing or expired', async () => {
  const booking = await makeBooking({});
  const paperless = await makeVehicle({ plate: 'TST-141-PH', documentsState: 'missing', documentsDue: null });
  const refused = await hire.allocateVehicle(booking.id, paperless.id, {});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /no documents on file/i);

  const lapsed = await makeVehicle({ plate: 'TST-142-PH', documentsState: 'current', documentsDue: -3 });
  const refused2 = await hire.allocateVehicle(booking.id, lapsed.id, {});
  assert.equal(refused2.ok, false);
  assert.match(refused2.error, /papers expired/i);
});

maybe('allocation refuses a unit that is already out on overlapping dates', async () => {
  const unit = await makeVehicle({ plate: 'TST-143-PH' });
  const first = await makeBooking({ pickupAt: isoDate(70), dropoffAt: isoDate(74) });
  const taken = await hire.allocateVehicle(first.id, unit.id, {});
  assert.equal(taken.ok, true, taken.error);

  const second = await makeBooking({ pickupAt: isoDate(72), dropoffAt: isoDate(76) });
  const clash = await hire.allocateVehicle(second.id, unit.id, {});
  assert.equal(clash.ok, false);
  assert.match(clash.error, /overlap/i);

  // The same unit, the day after it comes back, is fine.
  const later = await makeBooking({ pickupAt: isoDate(75), dropoffAt: isoDate(77) });
  const fine = await hire.allocateVehicle(later.id, unit.id, {});
  assert.equal(fine.ok, true, fine.error);
});

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

maybe('a hire cannot leave the yard unpaid, and cannot come back before it left', async () => {
  const unit = await makeVehicle({ plate: 'TST-150-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(80), dropoffAt: isoDate(82) });
  await hire.allocateVehicle(booking.id, unit.id, {});

  const early = await hire.setStatus(booking.id, 'on_hire', {});
  assert.equal(early.ok, false);
  assert.match(early.error, /not been accepted yet/i);

  await hire.setStatus(booking.id, 'accepted', {});
  const unpaid = await hire.setStatus(booking.id, 'on_hire', {});
  assert.equal(unpaid.ok, false);
  assert.match(unpaid.error, /has not landed|no payment is recorded/i);

  await hire.setStatus(booking.id, 'confirmed', {});
  const back = await hire.setStatus(booking.id, 'completed', {});
  assert.equal(back.ok, false);
  assert.match(back.error, /on hire when the car goes out/i);

  const out = await hire.setStatus(booking.id, 'on_hire', {});
  assert.equal(out.ok, true, out.error);
  const done = await hire.setStatus(booking.id, 'completed', { fuelIn: 61, odometerIn: 88_000 }, {});
  assert.equal(done.ok, true, done.error);
  assert.equal(done.booking.status, 'completed');
  assert.equal(done.booking.fuelIn, 61, 'the readings come back with the car');
  assert.equal(done.booking.odometerIn, 88_000);
  assert.equal((await hire.vehicleById(unit.id)).status, 'available', 'the unit is free again');
});

maybe('a hire that is out cannot be cancelled — it is completed when it comes back', async () => {
  const unit = await makeVehicle({ plate: 'TST-151-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(85), dropoffAt: isoDate(86) });
  await hire.allocateVehicle(booking.id, unit.id, {});
  await hire.setStatus(booking.id, 'accepted', {});
  await hire.setStatus(booking.id, 'confirmed', {});
  await hire.setStatus(booking.id, 'on_hire', {});
  const refused = await hire.setStatus(booking.id, 'cancelled', { reason: 'client changed their mind' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already out/i);
});

maybe('a closed hire is closed: no stepping backwards out of it', async () => {
  const unit = await makeVehicle({ plate: 'TST-152-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(88), dropoffAt: isoDate(89) });
  await hire.allocateVehicle(booking.id, unit.id, {});
  await hire.setStatus(booking.id, 'accepted', {});
  await hire.setStatus(booking.id, 'confirmed', {});
  await hire.setStatus(booking.id, 'on_hire', {});
  await hire.setStatus(booking.id, 'completed', {});
  const stale = await hire.setStatus(booking.id, 'on_hire', {});
  assert.equal(stale.ok, false);
  assert.match(stale.error, /closed/i);
  // And re-pressing the same status is a no-op rather than an error.
  const again = await hire.setStatus(booking.id, 'completed', {});
  assert.equal(again.unchanged, true);
});

maybe('paying a hire confirms it, in the same transaction as the money', async () => {
  const unit = await makeVehicle({ plate: 'TST-153-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(92), dropoffAt: isoDate(94) });
  await hire.allocateVehicle(booking.id, unit.id, {});

  const accepted = await hireService.accept(booking.id, {});
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.booking.status, 'accepted');
  assert.match(accepted.paymentReference, /^HC-PAY-\d{6}$/);

  const raised = await db.queryOne('SELECT * FROM payments WHERE hire_booking_id = ? ORDER BY id DESC LIMIT 1', [booking.id]);
  assert.equal(raised.status, 'pending');
  assert.equal(raised.purpose, 'hire', 'a hire payment says it is for a hire');

  // Accepting twice reuses the payment rather than raising a second one.
  const again = await hireService.accept(booking.id, {});
  assert.equal(again.ok, true);
  assert.equal(again.paymentReference, accepted.paymentReference);
  assert.equal(again.reusedPayment, true);

  const paid = await db.payments.markPaid(raised.id, { note: 'transfer matched' });
  assert.equal(paid.ok, true, paid.error);
  assert.equal(paid.hired && paid.hired.status, 'confirmed', 'the hire confirms itself when the money lands');
  const after = await hire.bookingById(booking.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.paymentStatus, 'paid');
  assert.equal((await hire.vehicleById(unit.id)).status, 'available', 'paid is not the same as on the road');
});

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

maybe('an incident above minor takes the unit off the road until it is closed', async () => {
  const unit = await makeVehicle({ plate: 'TST-160-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(100), dropoffAt: isoDate(101) });
  await hire.allocateVehicle(booking.id, unit.id, {});

  const logged = await hire.logIncident({
    bookingId: booking.id, kind: 'damage', severity: 'major',
    detail: 'Wing mirror torn off in traffic', costKobo: 6_500_000, chargedKobo: 5_000_000, actorId: null,
  });
  assert.equal(logged.ok, true, logged.error);
  assert.equal((await hire.vehicleById(unit.id)).status, 'service', 'a major fault parks the car');

  const open = await hire.incidents({ vehicleId: unit.id, status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].plate, 'TST-160-PH');
  assert.equal(open[0].kindLabel, 'Damage');
  assert.equal(open[0].gapKobo, 1_500_000, 'the difference between cost and charge is what the desk argues about');

  const closed = await hire.resolveIncident(open[0].id, { resolution: 'Panel shop, client paid', chargedKobo: 5_000_000 });
  assert.equal(closed.ok, true, closed.error);
  assert.equal((await hire.vehicleById(unit.id)).status, 'available', 'back on the road once nothing is open');
});

maybe('a minor incident does not park the car', async () => {
  const unit = await makeVehicle({ plate: 'TST-161-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(102), dropoffAt: isoDate(103) });
  await hire.allocateVehicle(booking.id, unit.id, {});
  await hire.logIncident({ bookingId: booking.id, kind: 'late_return', severity: 'minor', detail: 'Back three hours late', actorId: null });
  assert.equal((await hire.vehicleById(unit.id)).status, 'available');
});

maybe('an incident takes the vehicle from its booking, never from the form', async () => {
  const onHire = await makeVehicle({ plate: 'TST-162-PH' });
  const other = await makeVehicle({ plate: 'TST-163-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(104), dropoffAt: isoDate(105) });
  await hire.allocateVehicle(booking.id, onHire.id, {});
  // A vehicle id that contradicts the booking is ignored: the hire knows the car.
  await hire.logIncident({ bookingId: booking.id, vehicleId: other.id, kind: 'fine', severity: 'minor', detail: 'Speeding notice, Woji', costKobo: 400_000, actorId: null });
  const log = await hire.incidents({ bookingId: booking.id });
  assert.equal(log[0].plate, 'TST-162-PH');
});

maybe('an incident with no description is refused, and closing one twice too', async () => {
  const booking = await makeBooking({ pickupAt: isoDate(106), dropoffAt: isoDate(107) });
  const empty = await hire.logIncident({ bookingId: booking.id, kind: 'other', detail: '   ', actorId: null });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /description/i);

  const logged = await hire.logIncident({ bookingId: booking.id, kind: 'fuel', severity: 'minor', detail: 'Returned empty', actorId: null });
  assert.equal((await hire.resolveIncident(logged.id, { resolution: 'Charged for a full tank' })).ok, true);
  const twice = await hire.resolveIncident(logged.id, { resolution: 'again' });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /already been closed/i);
});

// ---------------------------------------------------------------------------
// The invoice
// ---------------------------------------------------------------------------

maybe('the invoice bills what was quoted, not today’s rate card', async () => {
  const booking = await makeBooking({ pickupAt: isoDate(110), dropoffAt: isoDate(113) });
  const before = await invoice.build(booking.id);
  assert.equal(before.ready, false, 'a quoted hire is not an invoice');

  await hire.allocateVehicle(booking.id, (await makeVehicle({ plate: 'TST-170-PH' })).id, {});
  await hire.setStatus(booking.id, 'accepted', {});
  await hire.setStatus(booking.id, 'confirmed', {});
  const doc = await invoice.build(booking.id);
  assert.equal(doc.ready, true);
  assert.equal(doc.totalKobo, booking.totalKobo, 'the quote total, to the kobo');
  assert.equal(doc.paidKobo, 0);
  assert.equal(doc.balanceKobo, booking.totalKobo);

  // Reprice the class — the agreed hire must not move.
  const hireClass = await hireService.classBySlug('suv');
  await db.query('UPDATE hire_classes SET daily_rate_kobo = daily_rate_kobo + 1000000 WHERE slug = ?', ['suv']);
  const after = await invoice.build(booking.id);
  await db.query('UPDATE hire_classes SET daily_rate_kobo = ? WHERE slug = ?', [hireClass.daily_rate_kobo, 'suv']);
  assert.equal(after.totalKobo, doc.totalKobo);
});

maybe('the invoice adds incident charges and releases the deposit at handover', async () => {
  const unit = await makeVehicle({ plate: 'TST-171-PH' });
  const booking = await makeBooking({ pickupAt: isoDate(115), dropoffAt: isoDate(117) });
  await hire.allocateVehicle(booking.id, unit.id, {});
  const accepted = await hireService.accept(booking.id, {});
  const payment = await db.queryOne('SELECT * FROM payments WHERE reference = ?', [accepted.paymentReference]);
  created.payments.push(payment.id);
  await db.payments.markPaid(payment.id, { note: 'test' });
  await hire.setStatus(booking.id, 'on_hire', {});
  await hire.logIncident({
    bookingId: booking.id, kind: 'damage', severity: 'minor',
    detail: 'Scuffed bumper', costKobo: 3_000_000, chargedKobo: 2_500_000, actorId: null,
  });
  await hire.setStatus(booking.id, 'completed', { fuelIn: 80, odometerIn: 50_000 }, {});

  const doc = await invoice.build(booking.id);
  assert.equal(doc.ready, true);
  assert.equal(doc.chargedKobo, 2_500_000);
  assert.equal(doc.totalKobo, booking.totalKobo + 2_500_000, 'the incident is on the bill');
  assert.equal(doc.paidKobo, booking.totalKobo);
  assert.equal(doc.balanceKobo, 2_500_000, 'what is still owed after the incident');
  assert.equal(doc.depositReturnKobo, booking.depositKobo, 'the deposit comes back at handover');
  assert.equal(doc.fuel.in, 80);
  assert.match(doc.terms, /deposit is refunded/i);
});

maybe('the invoice PDF is a real PDF', async () => {
  const booking = await makeBooking({ pickupAt: isoDate(120), dropoffAt: isoDate(121) });
  await hire.allocateVehicle(booking.id, (await makeVehicle({ plate: 'TST-172-PH' })).id, {});
  await hire.setStatus(booking.id, 'accepted', {});
  await hire.setStatus(booking.id, 'confirmed', {});
  const doc = await invoice.build(booking.id);
  const chunks = [];
  await new Promise((resolve, reject) => {
    invoice.pdf(doc).on('data', (chunk) => chunks.push(chunk)).on('end', resolve).on('error', reject);
  });
  const buffer = Buffer.concat(chunks);
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.equal(buffer.length > 4_000, true, `a document, not a stub (${buffer.length} bytes)`);
  assert.match(invoice.fileName(doc), /^honestcars-hire-hc-hire-\d+-invoice\.pdf$/);
});

// ---------------------------------------------------------------------------
// What the client and the desk see
// ---------------------------------------------------------------------------

maybe('a customer sees their own hires by phone, and nobody else’s', async () => {
  // A phone of its own: the other fixtures pile a year of hires onto TENANT, and
  // a customer page shows the twenty nearest by pick-up date, so sharing a number
  // here would hide this booking behind them rather than test anything.
  const OWN = '+2348099001199';
  const booking = await makeBooking({ phone: OWN });
  const mine = await hire.bookingsForPhone(OWN);
  assert.equal(mine.some((row) => row.reference === booking.reference), true);
  const theirs = await hire.bookingsForPhone('+2348099009999');
  assert.equal(theirs.some((row) => row.reference === booking.reference), false);
  // The same number written another way still finds it.
  const written = await hire.bookingsForPhone('08099001199');
  assert.equal(written.some((row) => row.reference === booking.reference), true);
});

maybe('the console summary counts the pool, the paperwork and what is open', async () => {
  await makeVehicle({ plate: 'TST-180-PH', documentsState: 'expiring', documentsDue: 10 });
  await makeVehicle({ plate: 'TST-181-PH', trackerState: 'on_order' });
  const summary = await hire.summary();
  assert.equal(typeof summary.units, 'number');
  assert.equal(summary.units > 0, true);
  assert.equal(summary.docsExpiring >= 1, true, 'papers due inside the month are counted');
  assert.equal(summary.untracked >= 1, true, 'trackers still on order are counted');
  assert.equal(typeof summary.counts.quoted, 'number');
  assert.equal(summary.incidents.open >= 1, true, 'the open incident above is counted');
});

maybe('money is never formatted twice, or in the wrong units', async () => {
  const hireClass = await hireService.classBySlug('sedan');
  const priced = hireService.quoteLines({ hireClass, days: 2 });
  assert.equal(money.formatNaira(priced.totalKobo), money.formatNaira(Number(hireClass.daily_rate_kobo) * 2 * 1.1));
  // The deposit is the only thing the client gets back, so it is always a tenth.
  assert.equal(priced.depositKobo, Math.round(Number(hireClass.daily_rate_kobo) * 2 * 0.1));
});
