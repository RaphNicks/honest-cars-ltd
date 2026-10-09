'use strict';

/**
 * Subscriptions — FR-20 / §7.3.
 *
 *   “Tracking subscriptions (unit, client, plan, renewal date, status);
 *    renewal queue + auto reminders (30/7/1 day); dealer retainer/subs
 *    management.”
 *
 * One table serves both kinds, because the *lifecycle* is the same and the desk
 * should chase one queue, not two:
 *
 *   tracker          a device in a customer's car. Created by the shop at
 *                    checkout (§6.8), then activated by hand as it is fitted.
 *   dealer_retainer  a lot on a monthly plan. Created by the desk.
 *
 * State is the device_state enum the shop already used, and every value means
 * something a person can act on:
 *
 *   ordered       paid for, not yet fitted
 *   installed     device is in the car (checklist step 1)
 *   activated     platform live + renewal date set (steps 2 and 3)
 *   renewal_due   inside a reminder window — the queue the desk works
 *   lapsed        the renewal date passed without payment
 *   cancelled     stopped, and the reason is in `notes`… i.e. nowhere (see below)
 *
 * `lapsed` is *derived*, never set by hand: a subscription whose renewal date
 * is past the grace window is lapsed whether or not a sweep has run, so the
 * console cannot show a stale “active” for a customer who stopped paying.
 */

const { query, queryOne, transaction } = require('./pool');
const phones = require('../lib/phone');

/** Days after the renewal date before a subscription is treated as lapsed. */
const GRACE_DAYS = 7;

/** The reminder windows §7.3 names — 30, 7 and 1 day before renewal. */
const REMINDER_WINDOWS = [30, 7, 1];

const KINDS = ['tracker', 'dealer_retainer'];
const KIND_LABELS = {
  tracker: 'Tracker',
  dealer_retainer: 'Dealer retainer',
};

const STATE_LABELS = {
  ordered: 'Ordered',
  installed: 'Installed',
  activated: 'Active',
  renewal_due: 'Renewal due',
  lapsed: 'Lapsed',
  cancelled: 'Cancelled',
};

/** The order the activation checklist runs in (§6.8: installed → activated). */
const CHECKLIST = [
  { key: 'installed', label: 'Device installed', column: 'installed_at' },
  { key: 'activated', label: 'Platform activated', column: 'activated_at' },
  { key: 'renewal_set', label: 'Renewal date set', column: 'renewal_at' },
];

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function daysUntil(date) {
  if (!date) return null;
  const ms = new Date(date).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

/**
 * Which reminder window a subscription is inside, if any.
 *
 * The windows are bands, not instants: “30 days” means *inside 30 days and not
 * yet inside 7*, “7” means inside 7 and not yet inside 1, and “1” is the last
 * band — everything at or past one day out. So the scan is ascending and takes
 * the first window the subscription has reached, which is also what makes the
 * per-window dedupe a one-liner: a daily sweep sends 30, then 7, then 1, and a
 * subscriber who was added late starts at whichever band they are actually in.
 *
 * Overdue days sit in the 1-day band on purpose — the last reminder has already
 * gone out by then, and the wording (not the window) is what says “this is now
 * late”.
 */
function windowFor(days) {
  if (days === null || days === undefined) return null;
  // REMINDER_WINDOWS is written widest-first because that is the order a person
  // says them; the scan needs them tightest-first.
  return [...REMINDER_WINDOWS].sort((a, b) => a - b).find((w) => days <= w) || null;
}

/**
 * `lapsed` when the grace window is gone, `renewal_due` inside a window, and
 * otherwise whatever the checklist has recorded. Derived here rather than in
 * SQL so the console, the queue and the reminders all agree by construction.
 */
function effectiveState(row) {
  if (row.device_state === 'cancelled') return 'cancelled';
  const days = daysUntil(row.renewal_at);
  if (days !== null && days < -GRACE_DAYS) return 'lapsed';
  if (days !== null && days <= REMINDER_WINDOWS[0] && row.device_state !== 'ordered') return 'renewal_due';
  return row.device_state;
}

function shape(row) {
  if (!row) return null;
  const days = daysUntil(row.renewal_at);
  const state = effectiveState(row);
  return {
    id: row.id,
    kind: row.kind || 'tracker',
    kindLabel: KIND_LABELS[row.kind] || 'Tracker',
    orderId: row.order_id,
    orderNo: row.order_no || null,
    dealerId: row.dealer_id,
    dealerName: row.dealer_name || null,
    productId: row.product_id,
    productName: row.product_name || row.plan_name || null,
    planName: row.plan_name || row.product_name || null,
    customerName: row.customer_name,
    phone: row.customer_phone,
    maskedPhone: row.customer_phone ? phones.mask(row.customer_phone) : null,
    unitLabel: row.unit_label,
    amountKobo: row.amount_kobo === null || row.amount_kobo === undefined
      ? (row.product_price_kobo === null || row.product_price_kobo === undefined ? null : Number(row.product_price_kobo))
      : Number(row.amount_kobo),
    periodMonths: Number(row.period_months || 12),
    deviceState: row.device_state,
    state,
    stateLabel: STATE_LABELS[state] || state,
    daysRemaining: days,
    overdue: days !== null && days < 0,
    windowDays: windowFor(days),
    installedAt: row.installed_at,
    activatedAt: row.activated_at,
    renewalAt: row.renewal_at,
    createdAt: row.created_at,
    lastReminderAt: row.last_reminder_at || null,
    remindersSent: Number(row.reminders_sent || 0),
    paymentId: row.payment_id || null,
    paymentStatus: row.payment_status || null,
    paymentReference: row.payment_reference || null,
    checklist: {
      installed: Boolean(row.installed_at),
      activated: Boolean(row.activated_at),
      renewal_set: Boolean(row.renewal_at),
    },
  };
}

const SELECT = `SELECT s.*,
                       o.order_no,
                       d.name AS dealer_name,
                       p.name AS product_name,
                       p.price_kobo AS product_price_kobo,
                       (SELECT COUNT(*) FROM subscription_reminders r WHERE r.subscription_id = s.id) AS reminders_sent,
                       (SELECT MAX(r.sent_at) FROM subscription_reminders r WHERE r.subscription_id = s.id) AS last_reminder_at,
                       (SELECT pm.id FROM payments pm
                         WHERE pm.subscription_id = s.id AND pm.purpose = 'subscription'
                         ORDER BY pm.id DESC LIMIT 1) AS payment_id,
                       (SELECT pm.status FROM payments pm
                         WHERE pm.subscription_id = s.id AND pm.purpose = 'subscription'
                         ORDER BY pm.id DESC LIMIT 1) AS payment_status,
                       (SELECT pm.reference FROM payments pm
                         WHERE pm.subscription_id = s.id AND pm.purpose = 'subscription'
                         ORDER BY pm.id DESC LIMIT 1) AS payment_reference
                  FROM subscriptions s
                  LEFT JOIN orders o ON o.id = s.order_id
                  LEFT JOIN dealers d ON d.id = s.dealer_id
                  LEFT JOIN products p ON p.id = s.product_id`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function byId(id) {
  const row = await queryOne(`${SELECT} WHERE s.id = ? LIMIT 1`, [Number(id) || 0]);
  return shape(row);
}

/** Every subscription belonging to a phone number (§7.1 “My tracked vehicles”). */
async function forPhone(phone, { limit = 20 } = {}) {
  const shapes = phones.variants(phone);
  if (!shapes.length) return [];
  const rows = await query(
    `${SELECT}
      WHERE s.customer_phone IN (${shapes.map(() => '?').join(',')})
      ORDER BY s.renewal_at IS NULL, s.renewal_at ASC, s.id DESC LIMIT ?`,
    [...shapes, Math.min(50, Math.max(1, limit))],
  );
  return rows.map(shape);
}

/**
 * The renewal queue the desk works from, tightened to the widest window by
 * default. `state` filters the derived state, so “overdue” is a queue, not a
 * report.
 */
async function queue({ withinDays = 30, kind = null, state = null, search = null, limit = 200 } = {}) {
  const where = ["s.device_state <> 'cancelled'"];
  const params = [];
  if (kind && KINDS.includes(kind)) {
    where.push('s.kind = ?');
    params.push(kind);
  }
  if (search) {
    where.push('(s.customer_name LIKE ? OR s.customer_phone LIKE ? OR s.unit_label LIKE ? OR s.plan_name LIKE ?)');
    const like = `%${String(search).slice(0, 60)}%`;
    params.push(like, like, like, like);
  }

  const rows = await query(
    `${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY s.renewal_at IS NULL, s.renewal_at ASC, s.id ASC
      LIMIT ?`,
    [...params, Math.min(500, Math.max(1, limit))],
  );
  const shaped = rows.map(shape).filter((row) => {
    if (state && row.state !== state) return false;
    // "within the window" includes anything already overdue.
    if (withinDays !== null && withinDays !== undefined) {
      if (row.daysRemaining === null) return false;
      if (row.daysRemaining > Number(withinDays)) return false;
    }
    return true;
  });
  return shaped;
}

/** Counts per state across everything live — the console's summary strip. */
async function summary() {
  // Every live row, including the ones with no renewal date yet: a subscription
  // that has been paid for and not fitted is still a subscription, and leaving it
  // out of the state counts made the console's own summary disagree with its
  // register. Only the money figures below need a date.
  const rows = await query(`${SELECT} WHERE s.device_state <> 'cancelled' AND s.kind IS NOT NULL`);
  const counts = { activated: 0, renewal_due: 0, lapsed: 0, ordered: 0, installed: 0, cancelled: 0 };
  let dueSoon = 0;
  let lapsed = 0;
  let revenueKobo = 0;
  for (const row of rows) {
    const state = effectiveState(row);
    counts[state] = (counts[state] || 0) + 1;
    const days = daysUntil(row.renewal_at);
    // “Due in 30 days” means money we can expect: a lapsed subscription is not
    // due, it is lost, and counting it here would flatter the queue. A row that
    // has not been fitted yet is not due either — there is nothing protecting a
    // car to renew.
    if (state === 'lapsed') {
      lapsed += 1;
      continue;
    }
    if (days === null) continue;
    if (state === 'ordered') continue;
    if (days <= 30) {
      dueSoon += 1;
      revenueKobo += Number(row.amount_kobo ?? row.product_price_kobo ?? 0);
    }
  }
  const byKind = await query(
    `SELECT kind, COUNT(*) AS n FROM subscriptions WHERE device_state <> 'cancelled' GROUP BY kind`,
  );
  return {
    counts,
    dueSoon,
    lapsed,
    revenueKobo,
    trackerCount: Number((byKind.find((r) => r.kind === 'tracker') || {}).n || 0),
    retainerCount: Number((byKind.find((r) => r.kind === 'dealer_retainer') || {}).n || 0),
  };
}

/** The window a subscription is inside (exported for the reminder sweep). */
function reminderWindow(days) {
  return windowFor(days);
}

/** Rows with their renewal inside `windows`, for the sweep — tracker and retainer alike. */
async function dueForReminders({ windows = REMINDER_WINDOWS, limit = 200 } = {}) {
  const widest = Math.max(...windows);
  const rows = await query(
    `${SELECT}
      WHERE s.device_state IN ('installed','activated','renewal_due')
        AND s.renewal_at IS NOT NULL
        AND s.renewal_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY)
      ORDER BY s.renewal_at ASC
      LIMIT ?`,
    [widest, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(shape);
}

async function remindersFor(subscriptionId) {
  return query(
    `SELECT r.window_days, r.sent_at, r.status, r.channel, r.detail
       FROM subscription_reminders r WHERE r.subscription_id = ? ORDER BY r.window_days DESC`,
    [Number(subscriptionId) || 0],
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record a reminder attempt. The unique key on (subscription_id, window_days)
 * is what makes the sweep idempotent: a second run the same day inserts
 * nothing, and the caller is told so rather than messaging twice.
 */
async function recordReminder({ subscriptionId, windowDays, notificationId = null, channel = null, status = 'sent', detail = null }) {
  try {
    const result = await query(
      `INSERT INTO subscription_reminders (subscription_id, window_days, sent_at, notification_id, channel, status, detail)
       VALUES (?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?)`,
      [Number(subscriptionId), Number(windowDays), notificationId, channel, String(status).slice(0, 24), detail ? String(detail).slice(0, 200) : null],
    );
    return { ok: true, id: result.insertId };
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') return { ok: false, duplicate: true };
    throw error;
  }
}

/**
 * The activation checklist (§6.8). Each step is stamped once — re-ticking a box
 * must never move a date, because the date is what the renewal queue runs on.
 *
 * `renewalAt` is accepted as a date string; when it is set, the state moves to
 * `activated` only if the device is already installed (the checklist has an
 * order, and skipping a step is how a subscription ends up “active” with no
 * device in the car).
 */
async function setChecklist(id, { installed = null, activated = null, renewalAt = null, unitLabel = null, planName = null, amountKobo = null, periodMonths = null, actorId = null, note = null } = {}) {
  const current = await queryOne('SELECT * FROM subscriptions WHERE id = ? LIMIT 1', [Number(id) || 0]);
  if (!current) return { ok: false, error: 'That subscription does not exist.' };

  const sets = [];
  const params = [];
  const detail = {};

  if (installed && !current.installed_at) {
    sets.push('installed_at = UTC_TIMESTAMP()');
    detail.installed = true;
  }
  if (activated && !current.activated_at) {
    if (!current.installed_at && !installed) {
      return { ok: false, error: 'Fit the device first — the checklist runs installed → activated → renewal date.' };
    }
    sets.push('activated_at = UTC_TIMESTAMP()');
    detail.activated = true;
  }
  if (renewalAt) {
    const when = new Date(renewalAt);
    if (Number.isNaN(when.getTime())) return { ok: false, error: 'That renewal date is not a date.' };
    sets.push('renewal_at = ?');
    params.push(when.toISOString().slice(0, 19).replace('T', ' '));
    detail.renewalAt = when.toISOString().slice(0, 10);
  }
  if (unitLabel !== null && unitLabel !== undefined) {
    sets.push('unit_label = ?');
    params.push(String(unitLabel).slice(0, 80) || null);
    detail.unitLabel = String(unitLabel).slice(0, 80);
  }
  if (planName !== null && planName !== undefined) {
    sets.push('plan_name = ?');
    params.push(String(planName).slice(0, 80) || null);
    detail.planName = String(planName).slice(0, 80);
  }
  if (amountKobo !== null && amountKobo !== undefined) {
    sets.push('amount_kobo = ?');
    params.push(Math.max(0, Number(amountKobo) || 0));
    detail.amountKobo = Number(amountKobo) || 0;
  }
  if (periodMonths !== null && periodMonths !== undefined) {
    sets.push('period_months = ?');
    params.push(Math.min(60, Math.max(1, Number(periodMonths) || 12)));
    detail.periodMonths = Number(periodMonths) || 12;
  }
  // Nothing to change is not a failure. The console disables an already-stamped
  // step, but a stale page or a double press still posts it, and answering that
  // with an error flash teaches the desk to distrust a control that worked.
  if (!sets.length) return { ok: true, unchanged: true, subscription: await byId(id) };

  // State follows the checklist: installed once both dates exist, activated
  // when both stamps and a renewal date are present.
  const willInstall = current.installed_at || installed;
  const willActivate = current.activated_at || activated;
  const willRenew = current.renewal_at || renewalAt;
  const nextState = willInstall && willActivate && willRenew ? 'activated' : willInstall ? 'installed' : current.device_state;
  if (nextState !== current.device_state && nextState !== 'activated') {
    sets.push('device_state = ?');
    params.push(nextState);
  } else if (nextState === 'activated' && current.device_state !== 'activated') {
    sets.push("device_state = 'activated'");
  }

  params.push(Number(id));
  await query(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`, params);

  if (actorId) {
    await query(
      `INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail)
       VALUES (?, 'subscription.checklist', 'subscription', ?, ?)`,
      [actorId, Number(id), JSON.stringify({ ...detail, note: note ? String(note).slice(0, 120) : null })],
    );
  }
  return { ok: true, subscription: await byId(id), detail };
}

/** Stop a subscription without deleting the record of it (§7.3 status). */
async function cancel(id, { actorId = null, reason = null } = {}) {
  const result = await query(
    "UPDATE subscriptions SET device_state = 'cancelled' WHERE id = ? AND device_state <> 'cancelled'",
    [Number(id) || 0],
  );
  if (!result.affectedRows) return { ok: false, error: 'That subscription is already cancelled, or does not exist.' };
  if (actorId) {
    await query(
      `INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail)
       VALUES (?, 'subscription.cancelled', 'subscription', ?, ?)`,
      [actorId, Number(id), JSON.stringify({ reason: reason ? String(reason).slice(0, 160) : null })],
    );
  }
  return { ok: true, subscription: await byId(id) };
}

/** Put a lot on a retainer plan (§7.3 “dealer retainer/subs management”). */
async function createRetainer({ dealerId, planName, amountKobo, periodMonths = 1, renewalAt = null, startsAt = null, actorId = null }) {
  const dealer = await queryOne('SELECT * FROM dealers WHERE id = ? LIMIT 1', [Number(dealerId) || 0]);
  if (!dealer) return { ok: false, error: 'That dealer does not exist.' };
  if (!planName) return { ok: false, error: 'Give the plan a name — it is what the dealer sees on the renewal.' };
  const amount = Math.max(0, Number(amountKobo) || 0);
  if (!amount) return { ok: false, error: 'A retainer needs an amount.' };

  const start = startsAt ? new Date(startsAt) : new Date();
  if (Number.isNaN(start.getTime())) return { ok: false, error: 'That start date is not a date.' };
  const renew = renewalAt ? new Date(renewalAt) : addMonths(start, Math.min(60, Math.max(1, Number(periodMonths) || 1)));
  if (Number.isNaN(renew.getTime())) return { ok: false, error: 'That renewal date is not a date.' };

  const account = dealer.user_id
    ? await queryOne('SELECT phone, name FROM `users` WHERE id = ? LIMIT 1', [dealer.user_id])
    : null;

  const result = await query(
    `INSERT INTO subscriptions
       (kind, dealer_id, customer_name, customer_phone, unit_label, plan_name, amount_kobo,
        device_state, installed_at, activated_at, renewal_at, period_months)
     VALUES ('dealer_retainer', ?, ?, ?, ?, ?, ?, 'activated', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)`,
    [
      dealer.id,
      account ? account.name : dealer.name,
      account ? account.phone : null,
      dealer.name,
      String(planName).slice(0, 80),
      amount,
      sqlDate(renew),
      Math.min(60, Math.max(1, Number(periodMonths) || 1)),
    ],
  );
  if (actorId) {
    await query(
      `INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail)
       VALUES (?, 'subscription.retainer_created', 'subscription', ?, ?)`,
      [actorId, result.insertId, JSON.stringify({ dealerId: dealer.id, planName, amountKobo: amount, periodMonths: Number(periodMonths) || 1 })],
    );
  }
  return { ok: true, subscription: await byId(result.insertId) };
}

/**
 * Attach a renewal payment to a subscription and quote it.
 *
 * The amount is the subscription's own: a tracker renews at the recorded price,
 * a retainer at its monthly rate. Nothing here invents a figure — a row with no
 * amount and no product price cannot be renewed online, and says why.
 */
async function renewalQuote(id) {
  const row = await queryOne(`${SELECT} WHERE s.id = ? LIMIT 1`, [Number(id) || 0]);
  if (!row) return { ok: false, error: 'That subscription does not exist.' };
  const subscription = shape(row);
  if (subscription.deviceState === 'cancelled') return { ok: false, error: 'That subscription has been cancelled.' };
  const amountKobo = subscription.amountKobo;
  if (!amountKobo) return { ok: false, error: 'This subscription has no renewal price recorded — ask the desk to set one.' };
  return { ok: true, subscription, amountKobo };
}

/**
 * Extend a subscription by the payment's worth. Called inside the transaction
 * that marks a payment paid (src/db/payments.js), so the entitlement can never
 * lag the money.
 *
 * Renewing early does not cost the customer days: the year is added to the
 * existing renewal date when that is still in the future, and to today when the
 * subscription has already lapsed. Both are what a person would expect and
 * neither needs explaining on the phone.
 */
async function applyRenewal(conn, payment) {
  if (!payment || !payment.subscriptionId) return null;
  const [[row]] = await conn.query('SELECT * FROM subscriptions WHERE id = ? FOR UPDATE', [payment.subscriptionId]);
  if (!row) return null;

  const months = Math.min(60, Math.max(1, Number(row.period_months) || 12));
  await conn.query(
    `UPDATE subscriptions
        SET device_state = 'activated',
            activated_at = COALESCE(activated_at, UTC_TIMESTAMP()),
            installed_at = COALESCE(installed_at, UTC_TIMESTAMP()),
            renewal_at   = DATE_ADD(GREATEST(COALESCE(renewal_at, UTC_TIMESTAMP()), UTC_TIMESTAMP()), INTERVAL ? MONTH)
      WHERE id = ?`,
    [months, row.id],
  );
  const [[after]] = await conn.query('SELECT renewal_at FROM subscriptions WHERE id = ?', [row.id]);
  return {
    id: row.id,
    kind: row.kind || 'tracker',
    periodMonths: months,
    previousRenewalAt: row.renewal_at,
    renewalAt: after ? after.renewal_at : null,
    paymentId: payment.id,
    amountKobo: payment.amountKobo,
  };
}

/**
 * The reminders the sweep has already used for each 30/7/1 window, keyed by
 * subscription. The sweep reads this so a message is sent once per window.
 */
async function sentWindows() {
  const rows = await query('SELECT subscription_id, window_days FROM subscription_reminders');
  const map = new Map();
  for (const row of rows) {
    const key = Number(row.subscription_id);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(Number(row.window_days));
  }
  return map;
}

/** Lapse anything that is past its grace window, so the queue cannot go stale. */
async function sweepLapsed() {
  const result = await query(
    `UPDATE subscriptions
        SET device_state = 'lapsed'
      WHERE device_state IN ('activated','renewal_due','installed')
        AND renewal_at IS NOT NULL
        AND renewal_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)`,
    [GRACE_DAYS],
  );
  return result.affectedRows || 0;
}

function addMonths(date, months) {
  const copy = new Date(date.getTime());
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function sqlDate(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  GRACE_DAYS,
  REMINDER_WINDOWS,
  KINDS,
  KIND_LABELS,
  STATE_LABELS,
  CHECKLIST,
  daysUntil,
  reminderWindow,
  byId,
  forPhone,
  queue,
  summary,
  dueForReminders,
  remindersFor,
  sentWindows,
  recordReminder,
  setChecklist,
  cancel,
  createRetainer,
  renewalQuote,
  applyRenewal,
  sweepLapsed,
  transaction,
  shape,
};
