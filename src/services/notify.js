'use strict';

/**
 * Notifications — §11 “WhatsApp Business … deep links with prefilled refs”,
 * §7.3 renewal/receipt messages.
 *
 * Delivery is a seam, exactly like OTP: `console` prints and records in
 * development, and a real channel is a provider function away. What is *not*
 * a seam is the log: every message is written to `notifications` with its
 * template, recipient and outcome, so ops can always answer “what did we tell
 * this customer, and when?”.
 *
 * Nothing here sends automatically to a third party. With the console channel
 * (the default) the message is recorded and printed, and the ops desk has a
 * WhatsApp deep link with the text pre-filled — which is how the business
 * actually talks to customers today.
 */

const config = require('../config');
const db = require('../db');

/**
 * Templates. `{name}`, `{amount}`, `{reference}`, `{when}`… are substituted.
 * Wording is deliberately plain: it is read on a phone, in traffic.
 */
const TEMPLATES = {
  // The reference is what the customer quotes back at us, so it belongs in the
  // sentence — but a missing one must never print as "null" at someone. Each of
  // these drops the clause rather than the value.
  payment_request: ({ amount, reference }) =>
    `To pay ${amount}${reference ? ` for ${reference}` : ''}: transfer to the Honest Cars account and send us the receipt, or ask for a card link. We will confirm the moment it lands.`,
  payment_receipt: ({ amount, reference }) =>
    `Payment received — thank you. ${amount}${reference ? ` against ${reference}` : ''}. Your receipt is in your account at honestcarsltd.com/account. Nothing else is owed on this.`,
  payment_refunded: ({ amount, reference, reason }) =>
    `Refund processed: ${amount}${reference ? ` on ${reference}` : ''}${reason ? ` (${reason})` : ''}. It lands back on the same account you paid from, and can take up to 5 working days.`,
  booking_dispatched: ({ reference, when, inspector }) =>
    `Your inspection ${reference} is booked for ${when}. ${inspector ? `${inspector} is your inspector. ` : ''}He will call before arriving.`,
  booking_completed: ({ reference }) =>
    `Your inspection report for ${reference} is ready — the findings, the photos and the verdict are all in your account at honestcarsltd.com/account.`,
  request_options_ready: ({ trackingId, count }) =>
    `Your options for ${trackingId} are ready: ${count} verified car${count === 1 ? '' : 's'} with prices, grades and our notes on each one. Open honestcarsltd.com/concierge/${trackingId} to see them.`,
  milestone_stage: ({ reference, stage, amount }) =>
    `${reference}: ${amount} moved to “${stage.replace(/_/g, ' ')}”. You can see the full stage list any time — nothing is released without your confirmation.`,
  booking_reminder: ({ reference, when }) =>
    `Reminder: inspection ${reference} is booked for ${when}. If that no longer works, reply here and we will move it.`,
  // FR-25 — the alert composer builds the whole sentence (it has the old and new
  // price, or the matched cars), and these templates carry it verbatim.
  price_drop: ({ body }) => body,
  new_match: ({ body }) => body,
};

function render(template, values = {}) {
  const factory = TEMPLATES[template];
  const body = factory
    ? factory({
      ...values,
      amount: values.amount || (values.amountKobo ? formatNaira(values.amountKobo) : ''),
    })
    : `Honest Cars update: ${JSON.stringify(values)}`;
  return String(body).replace(/\s+/g, ' ').trim();
}

function formatNaira(kobo) {
  const naira = Number(kobo || 0) / 100;
  return `₦${naira.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

/** Which channel a template should take. */
function channelFor(template, recipient) {
  const preferred = config.notifications.channels[template] || config.notifications.defaultChannel;
  if (preferred === 'email' && !recipient) return 'console';
  return preferred;
}

/**
 * Providers. `console` is real: it prints and records. The others need
 * credentials, and say so rather than silently dropping a customer message.
 */
const providers = {
  async console({ body, subject }) {
    console.log(`[notify] ${subject ? `${subject} — ` : ''}${body}`);
    return { ok: true, providerRef: 'console' };
  },
  async whatsapp() {
    return { ok: false, error: 'WhatsApp Cloud API is not configured (NOTIFY_WHATSAPP_TOKEN).' };
  },
  async sms() {
    return { ok: false, error: 'SMS provider is not configured (NOTIFY_SMS_KEY).' };
  },
  async email() {
    return { ok: false, error: 'Email provider is not configured (NOTIFY_EMAIL_KEY).' };
  },
};

/**
 * Record and attempt a notification.
 *
 * @param {object} options
 * @param {string} options.template   key from TEMPLATES
 * @param {object} [options.values]   substitution values
 * @param {string} [options.recipient] phone or email; omit to record only
 * @param {string} [options.entity] @param {number} [options.entityId]
 * @param {number} [options.createdBy] staff id when a human triggered it
 */
async function send({ template, values = {}, recipient = null, entity = null, entityId = null, createdBy = null, subject = null }) {
  const channel = channelFor(template, recipient);
  const body = render(template, values);
  const to = recipient || 'ops:unaddressed';

  const created = await db.payments.createNotification({
    channel, template, recipient: to, subject, body, entity, entityId, createdBy,
  });
  if (!created.ok) return created;

  const provider = providers[channel] || providers.console;
  const result = await provider({ body, subject, recipient: to, values });

  if (result.ok) {
    await db.payments.markNotification(created.id, { status: 'sent', providerRef: result.providerRef || null });
    return { ok: true, id: created.id, channel, status: 'sent', body };
  }

  // Not configured yet is not a failure of the message — record it honestly so
  // ops can send it by hand instead of assuming the customer was told.
  await db.payments.markNotification(created.id, {
    status: channel === 'console' ? 'failed' : 'skipped',
    error: result.error,
  });
  return { ok: false, id: created.id, channel, status: 'skipped', body, error: result.error };
}

/** The WhatsApp deep link ops uses to send the same text themselves (§11). */
function whatsappLink(body, phone = null) {
  const base = phone ? `https://wa.me/${String(phone).replace(/\D/g, '')}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(body)}`;
}

module.exports = { TEMPLATES, render, send, whatsappLink, formatNaira, providers };
