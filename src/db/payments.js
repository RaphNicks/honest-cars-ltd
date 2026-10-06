'use strict';

/**
 * Money and messages — §7.3 “Orders & Payments”, §10.1 “Payment polymorphic”,
 * §11 notifications.
 *
 * Everything the console and the customer pages read or write about money goes
 * through here, on the same pool as the rest of the site, so a receipt, a
 * refund and an order status can never disagree with each other.
 *
 * Rules this module enforces (they are not the UI’s to remember):
 *   • Card data is never stored or read — the PSP hosts the fields (§12.2).
 *   • A payment is only `paid` once, and only from `pending`/`failed`.
 *   • Refunds cannot exceed what was taken, and a refunded payment cannot be
 *     un-refunded.
 *   • Webhooks are idempotent on `(provider, event_id)`: a PSP retry is a
 *     no-op, not a second payment (§12.2 “idempotent order processing”).
 *   • Milestones move forward one stage at a time, and `released` needs a human
 *     with the payments.approve capability — recorded with their id.
 *   • Every write that changes money also writes `admin_audit`.
 */

const { query, queryOne, transaction } = require('./pool');
const { parseJson } = require('./shape');
const phones = require('../lib/phone');
const subscriptions = require('./subscriptions');
const hire = require('./hire');

const PROVIDERS = ['manual', 'paystack', 'flutterwave', 'bank_transfer', 'cash'];
const PURPOSES = ['order', 'booking', 'retainer', 'subscription', 'milestone', 'other', 'hire', 'addon'];
const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'abandoned', 'refunded', 'partially_refunded'];

/**
 * The retainer's status in the customer's words (§6.5). The status page shows
 * this, never the database enum — "pending" tells a buyer nothing about
 * whether their money is safe or what happens next.
 */
const RETAINER_STATES = {
  pending: {
    tone: 'reserved',
    label: 'Awaiting payment',
    blurb:
      'Your brief is live and the reference below is ready. Send the transfer and reply on WhatsApp with the receipt — ops confirms it by hand. It is credited against the success fee when you buy through us, and refunded in full if we find nothing that meets the brief.',
  },
  paid: {
    tone: 'certified',
    label: 'Received',
    blurb: 'Credited against the success fee when you buy through us, and refundable in full if we find nothing that meets your brief.',
  },
  failed: {
    tone: 'ghost',
    label: 'Payment failed',
    blurb: 'Nothing was taken. You can pay again with the same reference, or ask ops to re-check it.',
  },
  abandoned: {
    tone: 'ghost',
    label: 'Checkout abandoned',
    blurb: 'Nothing was taken. Pay with the same reference whenever you are ready — the search is not waiting on it.',
  },
  refunded: {
    tone: 'network_listed',
    label: 'Refunded in full',
    blurb: 'Returned to you because we could not find options that met the brief, or because you asked us to stop.',
  },
  partially_refunded: {
    tone: 'network_listed',
    label: 'Partly refunded',
    blurb: 'Part of the retainer has been returned — the refund line in your receipt says how much and why.',
  },
};
const MILESTONE_STAGES = ['funds_received', 'inspection_passed', 'documents_verified', 'released'];
const MILESTONE_KINDS = ['protected_purchase', 'parts_escrow'];
const ORDER_STATUSES = ['pending_payment', 'paid', 'processing', 'fulfilled', 'cancelled'];
const CHANNELS = ['whatsapp', 'sms', 'email', 'console'];

/** Next HC-PAY-000123 / HC-ML-0001 style reference. */
async function nextReference(prefix, table, column) {
  const row = await queryOne(
    `SELECT MAX(CAST(SUBSTRING(${column}, ${prefix.length + 1}) AS UNSIGNED)) AS last
       FROM ${table} WHERE ${column} LIKE ?`,
    [`${prefix}%`],
  );
  const next = Number(row && row.last ? row.last : 0) + 1;
  return `${prefix}${String(next).padStart(6, '0')}`;
}

function shapePayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    provider: row.provider,
    providerRef: row.provider_ref,
    purpose: row.purpose,
    orderId: row.order_id,
    bookingId: row.booking_id,
    requestId: row.request_id,
    subscriptionId: row.subscription_id || null,
    hireBookingId: row.hire_booking_id || null,
    dealerPurchaseId: row.dealer_purchase_id || null,
    customerName: row.customer_name || 'Guest',
    // The console prints the masked one; the services that deliver on a payment
    // (an add-on going live, FR-18) need the number that actually rings.
    customerPhone: row.customer_phone || null,
    maskedPhone: row.customer_phone ? phones.mask(row.customer_phone) : null,
    amountKobo: Number(row.amount_kobo),
    refundKobo: Number(row.refund_kobo || 0),
    refundableKobo: Math.max(0, Number(row.amount_kobo) - Number(row.refund_kobo || 0)),
    currency: row.currency,
    status: row.status,
    checkoutUrl: row.checkout_url,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    refundReason: row.refund_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderNo: row.order_no || null,
    bookingReference: row.booking_reference || null,
    requestTrackingId: row.tracking_id || null,
  };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
async function createPayment({
  provider = 'manual',
  purpose = 'other',
  amountKobo,
  orderId = null,
  bookingId = null,
  requestId = null,
  subscriptionId = null,   // a renewal (FR-20) — extends the subscription when it is paid
  hireBookingId = null,    // a hire (FR-22) — confirms the booking when it is paid
  dealerPurchaseId = null, // an add-on (FR-18) — delivered when it is paid
  customerName = null,
  customerPhone = null,
  createdBy = null,
  checkoutUrl = null,
  providerRef = null,
  actorId = null,
} = {}) {
  const amount = Number(amountKobo);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'A payment needs a positive amount.' };
  if (!PROVIDERS.includes(provider)) return { ok: false, error: 'Unknown payment provider.' };
  if (!PURPOSES.includes(purpose)) return { ok: false, error: 'Unknown payment purpose.' };

  const reference = await nextReference('HC-PAY-', 'payments', 'reference');
  const result = await query(
    `INSERT INTO payments
       (reference, provider, provider_ref, purpose, order_id, booking_id, request_id, subscription_id, hire_booking_id,
        dealer_purchase_id, customer_name, customer_phone, amount_kobo, status, checkout_url, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [reference, provider, providerRef, purpose, orderId, bookingId, requestId, subscriptionId, hireBookingId,
      dealerPurchaseId, customerName, customerPhone ? phones.canonical(customerPhone) : null, amount, checkoutUrl, createdBy],
  );
  await recordPaymentEvent({
    paymentId: result.insertId,
    provider,
    eventId: `created:${reference}`,
    type: 'payment.created',
    signatureOk: null,
    payload: { purpose, amountKobo: amount, provider },
  });
  return { ok: true, id: result.insertId, reference };
}

async function paymentById(id) {
  const row = await queryOne(
    `SELECT p.*, o.order_no, b.reference AS booking_reference, r.tracking_id
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN service_requests r ON r.id = p.request_id
      WHERE p.id = ? LIMIT 1`,
    [id],
  );
  return shapePayment(row);
}

/**
 * Payments raised against one service request — in practice the §6.5 retainer.
 * The status page states what has actually happened to the money, so it reads
 * the rows rather than assuming.
 */
async function paymentsForRequest(requestId) {
  const id = Number(requestId);
  if (!id) return [];
  const rows = await query('SELECT * FROM `payments` WHERE request_id = ? ORDER BY created_at DESC, id DESC', [id]);
  return rows.map(shapePayment);
}

async function paymentByReference(reference) {
  const row = await queryOne(
    `SELECT p.*, o.order_no, b.reference AS booking_reference, r.tracking_id
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN service_requests r ON r.id = p.request_id
      WHERE p.reference = ? LIMIT 1`,
    [reference],
  );
  return shapePayment(row);
}

/** The receipt a customer can open: the payment plus whatever it paid for. */
async function receipt(reference) {
  const payment = await paymentByReference(reference);
  if (!payment) return null;
  const items = payment.orderId
    ? await query('SELECT name, qty, unit_price_kobo FROM order_items WHERE order_id = ? ORDER BY id', [payment.orderId])
    : [];
  const events = await query(
    'SELECT type, signature_ok, created_at FROM payment_events WHERE payment_id = ? ORDER BY id',
    [payment.id],
  );
  return {
    payment,
    items: items.map((row) => ({ name: row.name, qty: row.qty, unitPriceKobo: Number(row.unit_price_kobo) })),
    events: events.map((row) => ({ type: row.type, signatureOk: row.signature_ok, at: row.created_at })),
  };
}

async function listPayments({ status = null, purpose = null, provider = null, q = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status && PAYMENT_STATUSES.includes(status)) {
    where.push('p.status = ?');
    params.push(status);
  }
  if (purpose && PURPOSES.includes(purpose)) {
    where.push('p.purpose = ?');
    params.push(purpose);
  }
  if (provider && PROVIDERS.includes(provider)) {
    where.push('p.provider = ?');
    params.push(provider);
  }
  if (q) {
    where.push('(p.reference LIKE ? OR o.order_no LIKE ? OR b.reference LIKE ? OR p.customer_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));

  const rows = await query(
    `SELECT p.*, o.order_no, b.reference AS booking_reference, r.tracking_id
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN service_requests r ON r.id = p.request_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`,
    params,
  );
  const totals = await queryOne(
    `SELECT
       COALESCE(SUM(status = 'paid' OR status = 'partially_refunded'), 0)  AS paid_count,
       COALESCE(SUM(CASE WHEN status IN ('paid','partially_refunded') THEN amount_kobo - refund_kobo ELSE 0 END), 0) AS net_kobo,
       COALESCE(SUM(refund_kobo), 0)                                       AS refunded_kobo,
       COALESCE(SUM(status = 'pending'), 0)                                AS pending_count,
       COALESCE(SUM(status = 'failed' OR status = 'abandoned'), 0)         AS failed_count
       FROM payments`,
  );
  return {
    rows: rows.map(shapePayment),
    totals: {
      paidCount: Number(totals.paid_count || 0),
      netKobo: Number(totals.net_kobo || 0),
      refundedKobo: Number(totals.refunded_kobo || 0),
      pendingCount: Number(totals.pending_count || 0),
      failedCount: Number(totals.failed_count || 0),
    },
  };
}

/** Append an event. Returns { duplicate: true } when the id was already seen. */
async function recordPaymentEvent({ paymentId, provider, eventId, type, signatureOk = null, payload = null }) {
  try {
    const result = await query(
      `INSERT INTO payment_events (payment_id, provider, event_id, type, signature_ok, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [paymentId, provider, String(eventId).slice(0, 120), String(type).slice(0, 60),
        signatureOk === null ? null : signatureOk ? 1 : 0, payload ? JSON.stringify(payload) : null],
    );
    return { ok: true, id: result.insertId, duplicate: false };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return { ok: true, duplicate: true };
    throw error;
  }
}

/**
 * Mark a payment paid and carry the state into whatever it paid for. Safe to
 * call twice (a PSP retry): the second call finds it already paid.
 */
async function markPaid(id, { providerRef = null, raw = null, actorId = null, eventId = null, provider = null, source = 'manual' } = {}) {
  const payment = await paymentById(id);
  if (!payment) return { ok: false, error: 'That payment does not exist.' };
  if (payment.status === 'refunded') return { ok: false, error: 'That payment has already been refunded.' };
  if (payment.status === 'paid' || payment.status === 'partially_refunded') return { ok: true, already: true, payment };

  let renewed = null;
  let hired = null;
  let purchased = null;
  await transaction(async (conn) => {
    await conn.query(
      "UPDATE payments SET status = 'paid', paid_at = UTC_TIMESTAMP(), provider_ref = COALESCE(?, provider_ref), raw = COALESCE(?, raw) WHERE id = ?",
      [providerRef, raw ? JSON.stringify(raw) : null, id],
    );
    if (payment.orderId) {
      await conn.query("UPDATE orders SET status = 'paid', payment_ref = COALESCE(?, payment_ref) WHERE id = ?", [providerRef, payment.orderId]);
    }
    if (payment.bookingId) {
      await conn.query("UPDATE bookings SET payment_status = 'paid' WHERE id = ?", [payment.bookingId]);
    }
    // FR-20: a renewal payment extends the subscription it was made against.
    // Doing it here — inside the transaction that marks the money paid — is what
    // makes the two inseparable: no path (webhook, console, manual record) can
    // take a renewal without granting the period, and none can grant it twice.
    renewed = await subscriptions.applyRenewal(conn, payment);
    // FR-22: paying a hire confirms it, in the same transaction as the money.
    hired = await hire.confirmFromPayment(conn, payment);
    // FR-18: paying for an add-on delivers it, by the same rule. The require is
    // late on purpose — services/addons reads this module back.
    purchased = await require('../services/addons').applyPurchase(conn, payment);
  });

  await recordPaymentEvent({
    paymentId: id,
    provider: provider || payment.provider,
    eventId: eventId || `paid:${payment.reference}`,
    type: 'payment.paid',
    signatureOk: source === 'webhook' ? true : null,
    payload: { providerRef, source, actorId },
  });
  if (actorId) {
    await recordAudit({ actorId, action: 'payment.paid', entity: 'payment', entityId: id, detail: { reference: payment.reference, amountKobo: payment.amountKobo, source } });
  }
  return { ok: true, payment: await paymentById(id), renewed, hired, purchased };
}

async function markFailed(id, { reason = null, status = 'failed', actorId = null, eventId = null, provider = null } = {}) {
  const payment = await paymentById(id);
  if (!payment) return { ok: false, error: 'That payment does not exist.' };
  if (payment.status === 'paid' || payment.status === 'refunded') {
    return { ok: false, error: 'A paid payment cannot be marked failed — flag a refund instead.' };
  }
  const next = status === 'abandoned' ? 'abandoned' : 'failed';
  await query("UPDATE payments SET status = ?, refund_reason = ? WHERE id = ?", [next, reason ? String(reason).slice(0, 200) : null, id]);
  if (payment.bookingId && next === 'failed') {
    await query("UPDATE bookings SET payment_status = 'unpaid' WHERE id = ?", [payment.bookingId]);
  }
  await recordPaymentEvent({
    paymentId: id,
    provider: provider || payment.provider,
    eventId: eventId || `${next}:${payment.reference}:${Date.now()}`,
    type: `payment.${next}`,
    signatureOk: null,
    payload: { reason },
  });
  if (actorId) {
    await recordAudit({ actorId, action: `payment.${next}`, entity: 'payment', entityId: id, detail: { reference: payment.reference, reason } });
  }
  return { ok: true, payment: await paymentById(id) };
}

/**
 * Flag/record a refund. We never move money ourselves: with a PSP configured
 * this calls the provider, and without one it records the decision so finance
 * can settle it — either way the customer-facing status is honest.
 */
async function refund(id, { amountKobo = null, reason, actorId, viaProvider = false } = {}) {
  const payment = await paymentById(id);
  if (!payment) return { ok: false, error: 'That payment does not exist.' };
  if (payment.status !== 'paid' && payment.status !== 'partially_refunded') {
    return { ok: false, error: 'Only a paid payment can be refunded.' };
  }
  const amount = amountKobo === null || amountKobo === undefined ? payment.refundableKobo : Number(amountKobo);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount to refund.' };
  if (amount > payment.refundableKobo) return { ok: false, error: 'That is more than is left on this payment.' };

  const total = payment.refundKobo + amount;
  const status = total >= payment.amountKobo ? 'refunded' : 'partially_refunded';
  await query(
    'UPDATE payments SET refund_kobo = ?, status = ?, refunded_at = UTC_TIMESTAMP(), refund_reason = ? WHERE id = ?',
    [total, status, String(reason || 'not recorded').slice(0, 200), id],
  );
  if (status === 'refunded' && payment.orderId) {
    await query("UPDATE orders SET status = 'cancelled' WHERE id = ? AND status <> 'fulfilled'", [payment.orderId]);
  }
  if (status === 'refunded' && payment.bookingId) {
    await query("UPDATE bookings SET payment_status = 'refunded' WHERE id = ?", [payment.bookingId]);
  }
  await recordPaymentEvent({
    paymentId: id,
    provider: payment.provider,
    eventId: `refund:${payment.reference}:${total}`,
    type: 'payment.refunded',
    signatureOk: null,
    payload: { amountKobo: amount, total, reason, viaProvider },
  });
  await recordAudit({
    actorId,
    action: 'payment.refund',
    entity: 'payment',
    entityId: id,
    detail: { reference: payment.reference, amountKobo: amount, total, reason, viaProvider },
  });
  return { ok: true, payment: await paymentById(id), amountKobo: amount };
}

// ---------------------------------------------------------------------------
// Orders (§7.3 order manager)
// ---------------------------------------------------------------------------
function shapeOrder(row) {
  return {
    id: row.id,
    orderNo: row.order_no,
    name: row.name,
    maskedPhone: phones.mask(row.phone),
    deliveryArea: row.delivery_area,
    deliveryFeeKobo: Number(row.delivery_fee_kobo),
    subtotalKobo: Number(row.subtotal_kobo),
    totalKobo: Number(row.total_kobo),
    status: row.status,
    paymentRef: row.payment_ref,
    notes: row.notes,
    createdAt: row.created_at,
    itemCount: Number(row.item_count || 0),
    items: row.items ? parseJson(row.items, []) : undefined,
    payment: row.payment_id
      ? { id: row.payment_id, reference: row.payment_reference, status: row.payment_status, provider: row.payment_provider, refundKobo: Number(row.payment_refund || 0) }
      : null,
  };
}

async function listOrders({ status = null, q = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status && ORDER_STATUSES.includes(status)) {
    where.push('o.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(o.order_no LIKE ? OR o.name LIKE ? OR o.payment_ref LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  const rows = await query(
    `SELECT o.*,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
            (SELECT p.id FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_id,
            (SELECT p.reference FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_reference,
            (SELECT p.status FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_status,
            (SELECT p.provider FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_provider,
            (SELECT p.refund_kobo FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS payment_refund
       FROM orders o
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    params,
  );
  const counts = await queryOne(
    `SELECT
       COALESCE(SUM(status = 'pending_payment'), 0) AS pending_payment,
       COALESCE(SUM(status = 'paid'), 0)            AS paid,
       COALESCE(SUM(status = 'processing'), 0)     AS processing,
       COALESCE(SUM(status = 'fulfilled'), 0)       AS fulfilled,
       COALESCE(SUM(status = 'cancelled'), 0)       AS cancelled,
       COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_kobo ELSE 0 END), 0) AS value_kobo
       FROM orders`,
  );
  return {
    rows: rows.map(shapeOrder),
    counts: {
      pending_payment: Number(counts.pending_payment || 0),
      paid: Number(counts.paid || 0),
      processing: Number(counts.processing || 0),
      fulfilled: Number(counts.fulfilled || 0),
      cancelled: Number(counts.cancelled || 0),
      valueKobo: Number(counts.value_kobo || 0),
    },
  };
}

async function orderByNo(orderNo) {
  const row = await queryOne(
    `SELECT o.*,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o WHERE o.order_no = ? LIMIT 1`,
    [orderNo],
  );
  if (!row) return null;
  const items = await query('SELECT name, qty, unit_price_kobo, install_requested FROM order_items WHERE order_id = ? ORDER BY id', [row.id]);
  const payments = await query('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', [row.id]);
  const order = shapeOrder(row);
  order.items = items.map((item) => ({
    name: item.name,
    qty: item.qty,
    unitPriceKobo: Number(item.unit_price_kobo),
    installRequested: Boolean(item.install_requested),
  }));
  order.payments = payments.map(shapePayment);
  return order;
}

async function setOrderStatus(id, status, { actorId } = {}) {
  if (!ORDER_STATUSES.includes(status)) return { ok: false, error: 'Unknown order status.' };
  const order = await queryOne('SELECT id, order_no, status FROM orders WHERE id = ? LIMIT 1', [id]);
  if (!order) return { ok: false, error: 'That order does not exist.' };

  // The database’s own state machine: once fulfilled, an order does not go back.
  if (order.status === 'fulfilled' && status !== 'fulfilled') {
    return { ok: false, error: 'A fulfilled order cannot be reopened — raise a refund instead.' };
  }
  await query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
  await recordAudit({
    actorId,
    action: 'order.status',
    entity: 'order',
    entityId: id,
    detail: { orderNo: order.order_no, from: order.status, to: status },
  });
  return { ok: true, status };
}

/**
 * Money that came in against a booking or a service request but has no PSP
 * row yet (bank transfer seen on the statement, cash at the lot). Creates the
 * payment record and marks it paid in one step, so there is exactly one way
 * money gets recorded.
 */
async function recordManualPayment({ purpose, amountKobo, orderId = null, bookingId = null, requestId = null, customerName = null, customerPhone = null, provider = 'bank_transfer', note = null, actorId }) {
  const created = await createPayment({
    provider,
    purpose,
    amountKobo,
    orderId,
    bookingId,
    requestId,
    customerName,
    customerPhone,
    createdBy: actorId,
  });
  if (!created.ok) return created;
  const paid = await markPaid(created.id, { actorId, source: 'manual', providerRef: note ? `manual:${String(note).slice(0, 40)}` : null });
  if (!paid.ok) return paid;
  await recordAudit({ actorId, action: 'payment.manual_record', entity: 'payment', entityId: created.id, detail: { purpose, amountKobo, provider, note } });
  return { ok: true, id: created.id, reference: created.reference };
}

// ---------------------------------------------------------------------------
// Milestones (§7.3 protected purchases & parts escrow)
// ---------------------------------------------------------------------------
function shapeMilestone(row) {
  return {
    id: row.id,
    reference: row.reference,
    kind: row.kind,
    subject: row.subject,
    listingId: row.listing_id,
    bookingId: row.booking_id,
    customerName: row.customer_name,
    maskedPhone: phones.mask(row.customer_phone),
    amountKobo: Number(row.amount_kobo),
    stage: row.stage,
    stageNote: row.stage_note,
    stageIndex: MILESTONE_STAGES.indexOf(row.stage),
    releasedBy: row.released_by,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    listingSlug: row.seo_slug || null,
    bookingReference: row.booking_reference || null,
  };
}

async function createMilestone({ kind = 'protected_purchase', subject, listingId = null, bookingId = null, customerName, customerPhone, amountKobo, actorId = null }) {
  if (!MILESTONE_KINDS.includes(kind)) return { ok: false, error: 'Unknown milestone kind.' };
  const amount = Number(amountKobo);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'A milestone needs a positive amount.' };
  if (!subject) return { ok: false, error: 'Say what the money is protecting.' };
  const reference = await nextReference('HC-ML-', 'payment_milestones', 'reference');
  const result = await query(
    `INSERT INTO payment_milestones
       (reference, kind, subject, listing_id, booking_id, customer_name, customer_phone, amount_kobo, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [reference, kind, String(subject).slice(0, 200), listingId, bookingId, String(customerName).slice(0, 120),
      phones.canonical(customerPhone), amount, actorId],
  );
  await recordAudit({ actorId, action: 'milestone.created', entity: 'milestone', entityId: result.insertId, detail: { reference, kind, amountKobo: amount } });
  return { ok: true, id: result.insertId, reference };
}

async function listMilestones({ stage = null, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (stage && MILESTONE_STAGES.includes(stage)) {
    where = 'WHERE m.stage = ?';
    params.push(stage);
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  const rows = await query(
    `SELECT m.*, l.seo_slug, b.reference AS booking_reference
       FROM payment_milestones m
       LEFT JOIN vehicle_listings l ON l.id = m.listing_id
       LEFT JOIN bookings b ON b.id = m.booking_id
      ${where}
      ORDER BY FIELD(m.stage,'funds_received','inspection_passed','documents_verified','released','cancelled'), m.created_at DESC
      LIMIT ?`,
    params,
  );
  const counts = await queryOne(
    `SELECT
       COALESCE(SUM(stage = 'funds_received'), 0)      AS funds_received,
       COALESCE(SUM(stage = 'inspection_passed'), 0)   AS inspection_passed,
       COALESCE(SUM(stage = 'documents_verified'), 0)  AS documents_verified,
       COALESCE(SUM(stage = 'released'), 0)            AS released,
       COALESCE(SUM(stage = 'cancelled'), 0)           AS cancelled,
       COALESCE(SUM(CASE WHEN stage NOT IN ('released','cancelled') THEN amount_kobo ELSE 0 END), 0) AS held_kobo
       FROM payment_milestones`,
  );
  return {
    rows: rows.map(shapeMilestone),
    counts: {
      funds_received: Number(counts.funds_received || 0),
      inspection_passed: Number(counts.inspection_passed || 0),
      documents_verified: Number(counts.documents_verified || 0),
      released: Number(counts.released || 0),
      cancelled: Number(counts.cancelled || 0),
      heldKobo: Number(counts.held_kobo || 0),
    },
  };
}

async function milestoneById(id) {
  const row = await queryOne(
    `SELECT m.*, l.seo_slug, b.reference AS booking_reference
       FROM payment_milestones m
       LEFT JOIN vehicle_listings l ON l.id = m.listing_id
       LEFT JOIN bookings b ON b.id = m.booking_id
      WHERE m.id = ? LIMIT 1`,
    [id],
  );
  return row ? shapeMilestone(row) : null;
}

/** Forward one stage (or cancel). Never backwards: escrow does not un-happen. */
async function advanceMilestone(id, { to, note = null, actorId }) {
  const milestone = await milestoneById(id);
  if (!milestone) return { ok: false, error: 'That milestone does not exist.' };
  if (milestone.stage === 'released') return { ok: false, error: 'This money has already been released.' };
  if (milestone.stage === 'cancelled') return { ok: false, error: 'This milestone was cancelled.' };

  if (to === 'cancelled') {
    await query("UPDATE payment_milestones SET stage = 'cancelled', stage_note = ? WHERE id = ?", [note ? String(note).slice(0, 200) : null, id]);
    await recordAudit({ actorId, action: 'milestone.cancelled', entity: 'milestone', entityId: id, detail: { reference: milestone.reference, note } });
    return { ok: true, milestone: await milestoneById(id) };
  }
  if (!MILESTONE_STAGES.includes(to)) return { ok: false, error: 'Unknown milestone stage.' };
  const target = MILESTONE_STAGES.indexOf(to);
  const current = MILESTONE_STAGES.indexOf(milestone.stage);
  if (target !== current + 1) {
    return { ok: false, error: `A milestone moves one stage at a time — this one is at “${milestone.stage.replace(/_/g, ' ')}”.` };
  }

  await query(
    `UPDATE payment_milestones
        SET stage = ?, stage_note = ?,
            released_by = CASE WHEN ? = 'released' THEN ? ELSE released_by END,
            released_at = CASE WHEN ? = 'released' THEN UTC_TIMESTAMP() ELSE released_at END
      WHERE id = ?`,
    [to, note ? String(note).slice(0, 200) : null, to, actorId, to, id],
  );
  await recordAudit({
    actorId,
    action: to === 'released' ? 'milestone.released' : 'milestone.stage',
    entity: 'milestone',
    entityId: id,
    detail: { reference: milestone.reference, from: milestone.stage, to, note },
  });
  return { ok: true, milestone: await milestoneById(id) };
}

/**
 * A customer's own money, matched by phone. Same rule as the dashboard: the
 * phone number is the identity, and the shapes are normalised so 0803…,
 * +234803… and 234803… all find the same rows.
 */
async function listForPhone(phone, { limit = 20 } = {}) {
  const shapes = phones.variants(phone);
  if (!shapes.length) return [];
  const rows = await query(
    `SELECT p.*, o.order_no, b.reference AS booking_reference, r.tracking_id
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN service_requests r ON r.id = p.request_id
      WHERE p.customer_phone IN (${shapes.map(() => '?').join(',')})
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`,
    [...shapes, Math.min(100, Math.max(1, Number(limit) || 20))],
  );
  return rows.map(shapePayment);
}

/** Escrow a customer is part of — they watch the same ladder the console does. */
async function milestonesForPhone(phone) {
  const shapes = phones.variants(phone);
  if (!shapes.length) return [];
  const rows = await query(
    `SELECT m.*, l.seo_slug, b.reference AS booking_reference
       FROM payment_milestones m
       LEFT JOIN vehicle_listings l ON l.id = m.listing_id
       LEFT JOIN bookings b ON b.id = m.booking_id
      WHERE m.customer_phone IN (${shapes.map(() => '?').join(',')})
      ORDER BY FIELD(m.stage,'funds_received','inspection_passed','documents_verified','released','cancelled'), m.created_at DESC
      LIMIT 20`,
    shapes,
  );
  return rows.map(shapeMilestone);
}

/** Ownership check for a receipt page: does this reference belong to that phone? */
async function receiptForPhone(reference, phone) {
  const shapes = phones.variants(phone);
  const payment = await paymentByReference(reference);
  if (!payment || !shapes.length) return null;
  const row = await queryOne('SELECT customer_phone FROM payments WHERE id = ? LIMIT 1', [payment.id]);
  const stored = row && row.customer_phone ? phones.canonical(row.customer_phone) : null;
  if (!stored || !shapes.includes(stored)) return null;
  return receipt(reference);
}

// ---------------------------------------------------------------------------
// Dealer ledger (§7.3 payout/commission; §7.2 statements)
// ---------------------------------------------------------------------------
const LEDGER_ENTRY_TYPES = ['sale_commission', 'payout', 'adjustment', 'clawback'];

const LEDGER_LABELS = {
  sale_commission: 'Commission on a sale',
  payout: 'Payout to the dealer',
  adjustment: 'Adjustment',
  clawback: 'Clawback',
};

function shapeLedgerEntry(row) {
  return {
    id: row.id,
    dealerId: row.dealer_id,
    dealerName: row.dealer_name || null,
    listingId: row.listing_id,
    listingStockNo: row.stock_no || null,
    commissionTermsRef: row.commission_terms_ref || null,
    paymentId: row.payment_id,
    paymentReference: row.payment_reference || null,
    entryType: row.entry_type,
    entryLabel: LEDGER_LABELS[row.entry_type] || row.entry_type,
    amountKobo: Number(row.amount_kobo),
    currency: row.currency,
    reference: row.reference,
    detail: row.detail,
    actorName: row.actor_name || null,
    createdAt: row.created_at,
  };
}

/**
 * One row per dealer: what has been earned, what has been paid out, and the
 * balance still standing. `SUM` over an empty ledger is NULL, hence COALESCE.
 */
async function ledgerSummary() {
  const rows = await query(
    `SELECT d.id, d.name, d.slug, d.city,
            COALESCE(SUM(l.amount_kobo), 0)                                        AS balance_kobo,
            COALESCE(SUM(CASE WHEN l.entry_type = 'sale_commission' THEN l.amount_kobo ELSE 0 END), 0) AS commission_kobo,
            COALESCE(SUM(CASE WHEN l.entry_type = 'payout' THEN -l.amount_kobo ELSE 0 END), 0)         AS paid_out_kobo,
            COALESCE(SUM(l.entry_type IN ('adjustment','clawback')), 0)             AS corrections_count,
            MAX(l.created_at)                                                       AS last_entry_at,
            (SELECT COUNT(*) FROM vehicle_listings v WHERE v.dealer_id = d.id AND v.status = 'live')   AS live_stock
       FROM dealers d
       LEFT JOIN dealer_ledger l ON l.dealer_id = d.id
      GROUP BY d.id
      ORDER BY balance_kobo DESC, d.name`,
  );
  return rows.map((row) => ({
    dealerId: row.id,
    name: row.name,
    slug: row.slug,
    city: row.city,
    balanceKobo: Number(row.balance_kobo || 0),
    commissionKobo: Number(row.commission_kobo || 0),
    paidOutKobo: Number(row.paid_out_kobo || 0),
    corrections: Number(row.corrections_count || 0),
    lastEntryAt: row.last_entry_at,
    liveStock: Number(row.live_stock || 0),
  }));
}

/** The entries behind one dealer's statement, newest first, plus the totals. */
async function ledgerFor(dealerId, { from = null, to = null, limit = 200 } = {}) {
  const dealer = await queryOne('SELECT id, name, slug, city FROM dealers WHERE id = ? LIMIT 1', [dealerId]);
  if (!dealer) return null;

  const where = ['l.dealer_id = ?'];
  const params = [dealerId];
  if (from) { where.push('l.created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('l.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(`${to} 00:00:00`); }
  params.push(Math.min(500, Math.max(1, Number(limit) || 200)));

  const rows = await query(
    `SELECT l.*, d.name AS dealer_name, v.stock_no, v.commission_terms_ref, p.reference AS payment_reference, u.name AS actor_name
       FROM dealer_ledger l
       JOIN dealers d ON d.id = l.dealer_id
       LEFT JOIN vehicle_listings v ON v.id = l.listing_id
       LEFT JOIN payments p ON p.id = l.payment_id
       LEFT JOIN \`users\` u ON u.id = l.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ?`,
    params,
  );

  // The balance carried in: everything before the window, so a statement shown
  // for September still explains why October starts where it does.
  const opening = from
    ? await queryOne('SELECT COALESCE(SUM(amount_kobo), 0) AS kobo FROM dealer_ledger WHERE dealer_id = ? AND created_at < ?', [dealerId, `${from} 00:00:00`])
    : { kobo: 0 };

  const entries = rows.map(shapeLedgerEntry);
  const movement = entries.reduce((total, entry) => total + entry.amountKobo, 0);

  return {
    dealer: { id: dealer.id, name: dealer.name, slug: dealer.slug, city: dealer.city },
    from,
    to,
    entries,
    openingKobo: Number(opening.kobo || 0),
    movementKobo: movement,
    closingKobo: Number(opening.kobo || 0) + movement,
    // A statement is a document, so it says when it was produced.
    producedAt: new Date().toISOString(),
  };
}

/**
 * Append a ledger entry. Nothing here is ever updated afterwards — a mistake is
 * corrected by writing the opposite entry, which is what the audit trail is for.
 */
async function addLedgerEntry({ dealerId, entryType, amountKobo, listingId = null, paymentId = null, reference = null, detail = null, actorId }) {
  if (!LEDGER_ENTRY_TYPES.includes(entryType)) return { ok: false, error: 'Unknown ledger entry type.' };
  const amount = Number(amountKobo);
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, error: 'A ledger entry needs a non-zero amount.' };
  if (entryType === 'sale_commission' && amount < 0) return { ok: false, error: 'A commission is entered as a positive amount.' };
  if (entryType === 'payout' && amount > 0) return { ok: false, error: 'A payout is entered as a negative amount (money leaving the ledger).' };

  const dealer = await queryOne('SELECT id, name FROM dealers WHERE id = ? LIMIT 1', [dealerId]);
  if (!dealer) return { ok: false, error: 'That dealer does not exist.' };

  const result = await query(
    `INSERT INTO dealer_ledger (dealer_id, listing_id, payment_id, entry_type, amount_kobo, reference, detail, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [dealerId, listingId, paymentId, entryType, Math.round(amount), reference ? String(reference).slice(0, 40) : null,
      detail ? String(detail).slice(0, 200) : null, actorId || null],
  );
  await recordAudit({
    actorId,
    action: `ledger.${entryType}`,
    entity: 'dealer_ledger',
    entityId: result.insertId,
    detail: { dealer: dealer.name, amountKobo: Math.round(amount), listingId, paymentId, reference, detail },
  });
  return { ok: true, id: result.insertId };
}

// ---------------------------------------------------------------------------
// Notifications (§11)
// ---------------------------------------------------------------------------
function shapeNotification(row) {
  return {
    id: row.id,
    channel: row.channel,
    template: row.template,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    status: row.status,
    providerRef: row.provider_ref,
    error: row.error,
    entity: row.entity,
    entityId: row.entity_id,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

async function createNotification({ channel = 'console', template, recipient, subject = null, body, entity = null, entityId = null, createdBy = null }) {
  if (!CHANNELS.includes(channel)) return { ok: false, error: 'Unknown notification channel.' };
  if (!recipient) return { ok: false, error: 'A notification needs a recipient.' };
  const result = await query(
    `INSERT INTO notifications (channel, template, recipient, subject, body, entity, entity_id, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    [channel, String(template).slice(0, 60), String(recipient).slice(0, 160), subject ? String(subject).slice(0, 160) : null,
      String(body).slice(0, 8000), entity, entityId, createdBy],
  );
  return { ok: true, id: result.insertId };
}

async function markNotification(id, { status, providerRef = null, error = null }) {
  await query(
    `UPDATE notifications
        SET status = ?, provider_ref = ?, error = ?,
            sent_at = CASE WHEN ? = 'sent' THEN UTC_TIMESTAMP() ELSE sent_at END
      WHERE id = ?`,
    [status, providerRef, error ? String(error).slice(0, 300) : null, status, id],
  );
  return { ok: true };
}

async function listNotifications({ status = null, entity = null, entityId = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('n.status = ?');
    params.push(status);
  }
  if (entity) {
    where.push('n.entity = ?');
    params.push(entity);
  }
  if (entityId) {
    where.push('n.entity_id = ?');
    params.push(entityId);
  }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
  const rows = await query(
    `SELECT n.* FROM notifications n ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY n.id DESC LIMIT ?`,
    params,
  );
  return rows.map(shapeNotification);
}

async function recordAudit({ actorId = null, action, entity, entityId = null, detail = null }) {
  await query(
    'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    [actorId, action, entity, entityId, detail ? JSON.stringify(detail) : null],
  );
}

module.exports = {
  PROVIDERS,
  PURPOSES,
  RETAINER_STATES,
  PAYMENT_STATUSES,
  PAYMENT_EVENT_TYPES: ['payment.created', 'payment.paid', 'payment.failed', 'payment.abandoned', 'payment.refunded'],
  MILESTONE_STAGES,
  MILESTONE_KINDS,
  ORDER_STATUSES,
  CHANNELS,
  createPayment,
  paymentById,
  paymentByReference,
  paymentsForRequest,
  receipt,
  listPayments,
  recordPaymentEvent,
  markPaid,
  markFailed,
  refund,
  listOrders,
  orderByNo,
  setOrderStatus,
  recordManualPayment,
  createMilestone,
  listMilestones,
  milestoneById,
  advanceMilestone,
  createNotification,
  markNotification,
  listNotifications,
  LEDGER_ENTRY_TYPES,
  LEDGER_LABELS,
  listForPhone,
  milestonesForPhone,
  receiptForPhone,
  ledgerSummary,
  ledgerFor,
  addLedgerEntry,
  shapePayment,
  shapeMilestone,
  shapeLedgerEntry,
};
