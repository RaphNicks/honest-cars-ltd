'use strict';

/**
 * Renewals — FR-20, §7.3 “renewal queue + auto reminders (30/7/1 day)”.
 *
 * Two jobs, and the order matters:
 *
 *   1. `queue()` — what the desk works from today. It is *derived* (state comes
 *      from the renewal date, not from a column someone forgot to update), so a
 *      customer who stopped paying cannot sit in it looking active.
 *   2. `runReminders()` — the sweep. It walks everything renewing inside 30
 *      days, works out which window it is in (1 beats 7 beats 30), and sends
 *      the reminder for that window **once**. The dedupe lives in
 *      `subscription_reminders` under a unique key, exactly like the FR-25
 *      alert baselines: running it twice in a morning is a no-op, so “run it
 *      every day” is a safe instruction to give a cron job.
 *
 * There is no daemon. `npm run renewals` and the button on /admin/subscriptions
 * call the same function, and both are safe to run by hand, which is the point
 * of keeping the dedupe in the database rather than in memory.
 *
 * Delivery goes through services/notify.js, so it inherits the honest seam: a
 * channel with no provider records the message as `skipped` and keeps the text
 * for the ops desk to send from a WhatsApp deep link. The reminder row is
 * written either way — a message that could not be delivered by machine is
 * exactly the one a person has to send.
 */

const db = require('../db');
const notify = require('../services/notify');
const money = require('../lib/money');

/** A hard ceiling so one sweep can never send an unbounded number of messages. */
const MAX_PER_RUN = Number(process.env.RENEWALS_MAX_PER_RUN || 50);

const subscriptions = db.subscriptions;

/** The sentences a customer reads. Each states the date, because that is the question. */
function reminderBody({ windowDays, subscription, renewalLabel, amount }) {
  const what = subscription.kind === 'dealer_retainer'
    ? `${subscription.planName || 'Your HonestCars plan'} for ${subscription.unitLabel || subscription.dealerName || 'your lot'}`
    : `${subscription.planName || 'your tracker subscription'}${subscription.unitLabel ? ` on ${subscription.unitLabel}` : ''}`;
  const price = amount ? ` Renewal is ${money.formatNaira(amount)}.` : '';
  if (windowDays <= 1) {
    return `Your HonestCars subscription expires tomorrow — ${what} renews on ${renewalLabel}.${price} You can renew in your account: honestcarsltd.com/account. If anything has changed, reply here and we will sort it out.`;
  }
  if (windowDays <= 7) {
    return `A week to go: ${what} renews on ${renewalLabel}.${price} Renew any time in your account at honestcarsltd.com/account — renewing early does not lose you days.`;
  }
  return `Heads-up: ${what} renews on ${renewalLabel}.${price} Nothing to do now — we will remind you again closer to the date, and you can renew any time at honestcarsltd.com/account.`;
}

function formatDate(value) {
  if (!value) return 'the renewal date';
  return new Date(value).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The console's queue: everything renewing inside the window, plus whatever has
 * already slipped past it. `state` narrows to one derived state; `kind` splits
 * trackers from dealer retainers.
 */
async function queue({ withinDays = 30, kind = null, state = null, search = null, limit = 200 } = {}) {
  const rows = await subscriptions.queue({ withinDays, kind, state, search, limit });
  const summary = await subscriptions.summary();
  return { rows, summary };
}

/** Everything, including what is not due yet — the register behind the queue. */
async function register({ kind = null, state = null, search = null, limit = 200 } = {}) {
  return subscriptions.queue({ withinDays: null, kind, state, search, limit });
}

/**
 * Send the reminders that are due and not yet sent.
 *
 * `dryRun` reports exactly what would go out — including which messages the
 * desk would have to send by hand because no channel is configured — without
 * writing a reminder row or sending anything.
 */
async function runReminders({ dryRun = false, limit = MAX_PER_RUN } = {}) {
  const started = Date.now();
  const report = {
    dryRun: Boolean(dryRun),
    at: new Date().toISOString(),
    checked: 0,
    sent: 0,
    wouldSend: [],
    skipped: [],
    alreadySent: [],
    lapsed: 0,
    errors: [],
  };

  // Anything past its grace window becomes lapsed first, so the queue the desk
  // reads after the sweep cannot contain a subscription that "renewed" itself.
  if (!dryRun) report.lapsed = await subscriptions.sweepLapsed();

  const requested = limit === undefined || limit === null ? MAX_PER_RUN : Number(limit);
  const budget = { left: Math.max(0, Math.min(MAX_PER_RUN, Number.isFinite(requested) ? requested : MAX_PER_RUN)) };
  report.budget = budget.left;

  const due = await subscriptions.dueForReminders({ limit: 500 });
  report.checked = due.length;

  // One read of the dedupe table for the whole sweep, not one per row.
  const sent = await subscriptions.sentWindows();

  for (const subscription of due) {
    const windowDays = subscription.windowDays;
    if (!windowDays) continue;
    const already = sent.get(subscription.id);
    if (already && already.has(windowDays)) {
      report.alreadySent.push({ id: subscription.id, windowDays });
      continue;
    }

    const amount = subscription.amountKobo;
    const values = {
      windowDays,
      subscription,
      renewalLabel: formatDate(subscription.renewalAt),
      amount,
      name: subscription.customerName,
    };
    const body = reminderBody(values);
    const entry = {
      id: subscription.id,
      kind: subscription.kind,
      windowDays,
      phone: subscription.maskedPhone,
      renewalAt: subscription.renewalAt,
      body,
    };

    if (budget.left <= 0) {
      report.skipped.push({ ...entry, reason: 'run cap reached — run the sweep again to continue' });
      continue;
    }
    budget.left -= 1;

    if (dryRun) {
      report.wouldSend.push(entry);
      continue;
    }

    try {
      // The reminder row is written even when delivery is impossible: the
      // message exists, and it is the desk's job next.
      const notification = await notify.send({
        template: 'subscription_renewal',
        values,
        recipient: subscription.phone,
        entity: 'subscription',
        entityId: subscription.id,
      });
      const recorded = await subscriptions.recordReminder({
        subscriptionId: subscription.id,
        windowDays,
        notificationId: notification.id || null,
        channel: notification.channel || null,
        status: notification.ok ? 'sent' : 'skipped',
        detail: notification.ok ? null : (notification.error || 'channel not configured'),
      });
      if (recorded.duplicate) {
        report.alreadySent.push({ id: subscription.id, windowDays });
        continue;
      }
      if (notification.ok) {
        report.sent += 1;
      } else {
        report.skipped.push({ ...entry, reason: notification.error || 'channel not configured', notificationId: notification.id || null });
      }
    } catch (error) {
      report.errors.push({ id: subscription.id, windowDays, error: error.message });
    }
  }

  report.ms = Date.now() - started;
  return report;
}

module.exports = {
  MAX_PER_RUN,
  queue,
  register,
  runReminders,
  reminderBody,
  formatDate,
};
