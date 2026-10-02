'use strict';

/**
 * PSP seam — §11 “Paystack or Flutterwave … card/bank/transfer payments”, FR-08.
 *
 * What is real here:
 *   • The state machine — a payment is created pending, confirmed once, and
 *     refunded only against money actually taken (src/db/payments.js).
 *   • Webhook handling — signature verification per provider, idempotent on
 *     `(provider, event_id)`, and a recorded verdict on every event.
 *   • The manual provider, which is how money actually arrives until the
 *     merchant account exists: bank transfer or cash, recorded by finance with
 *     the statement line in the note.
 *
 * What needs credentials (and is therefore a seam, not a pretence): the two
 * hosted-checkout providers. Set PAYSTACK_SECRET_KEY or FLUTTERWAVE_SECRET_KEY
 * and the adapter starts returning a real checkout URL; without them,
 * `initiate()` says so plainly instead of inventing a redirect.
 *
 * Card data never touches this process: the PSP hosts the fields and we keep
 * only its reference (§12.2).
 */

const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const notify = require('./notify');

const PROVIDERS = db.payments.PROVIDERS;

/** Names a human would use, so the console never shows a raw enum. */
const PROVIDER_LABELS = {
  manual: 'Manual entry',
  bank_transfer: 'Bank transfer',
  cash: 'Cash at the lot',
  paystack: 'Paystack',
  flutterwave: 'Flutterwave',
};

/** Which providers are actually usable right now. */
function availability() {
  return {
    manual: true,
    bank_transfer: true,
    cash: true,
    paystack: Boolean(config.payments.paystackSecret),
    flutterwave: Boolean(config.payments.flutterwaveSecret),
  };
}

function activeProvider() {
  const available = availability();
  for (const provider of [config.payments.defaultProvider, 'paystack', 'flutterwave', 'manual']) {
    if (provider && available[provider]) return provider;
  }
  return 'manual';
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------
const adapters = {
  /** Money recorded by a human who saw it arrive. */
  manual: {
    label: 'Manual (bank transfer / cash)',
    hosted: false,
    async initiate() {
      return { ok: true, checkoutUrl: null, note: 'Recorded manually by the finance desk.' };
    },
    verifySignature() {
      // Nothing to verify: these events are written by our own staff, and the
      // audit log — not a signature — is what makes them trustworthy.
      return { ok: true, verdict: 'self' };
    },
    parseEvent() {
      return null;
    },
  },

  /**
   * Paystack: `x-paystack-signature` is HMAC-SHA512 of the raw body with the
   * secret key (https://paystack.com/docs/payments/webhooks/).
   */
  paystack: {
    label: 'Paystack',
    hosted: true,
    async initiate({ payment }) {
      if (!config.payments.paystackSecret) {
        return { ok: false, error: 'Paystack is not configured — set PAYSTACK_SECRET_KEY.' };
      }
      const body = {
        email: config.business.email,
        amount: payment.amountKobo,
        currency: payment.currency || 'NGN',
        reference: payment.reference,
        callback_url: `${config.siteUrl}/order/${payment.orderNo || ''}`.replace(/\/$/, ''),
        metadata: { purpose: payment.purpose, paymentId: payment.id },
      };
      try {
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.payments.paystackSecret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await response.json().catch(() => null);
        if (!response.ok || !json || !json.status) {
          return { ok: false, error: (json && json.message) || `Paystack refused the request (${response.status}).` };
        }
        return { ok: true, checkoutUrl: json.data.authorization_url, providerRef: json.data.reference };
      } catch (error) {
        return { ok: false, error: `Could not reach Paystack: ${error.message}` };
      }
    },
    verifySignature({ headers, rawBody }) {
      const secret = config.payments.paystackSecret;
      if (!secret) return { ok: false, verdict: 'not-configured' };
      const signature = headers['x-paystack-signature'];
      if (!signature) return { ok: false, verdict: 'missing' };
      const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
      const match = expected.length === String(signature).length
        && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
      return { ok: match, verdict: match ? 'valid' : 'invalid' };
    },
    parseEvent(body) {
      if (!body || !body.event) return null;
      const data = body.data || {};
      return {
        eventId: String(body.id || `${body.event}:${data.reference || ''}:${data.id || ''}`),
        type: body.event,
        reference: data.reference || (data.metadata && data.metadata.reference) || null,
        amountKobo: data.amount ? Number(data.amount) : null,
        status: data.status || null,
        providerRef: data.id ? String(data.id) : null,
        raw: body,
      };
    },
  },

  /**
   * Flutterwave: the dashboard webhook sends `verif-hash`, compared with the
   * secret hash you set there (https://developer.flutterwave.com/docs/webhooks).
   */
  flutterwave: {
    label: 'Flutterwave',
    hosted: true,
    async initiate({ payment }) {
      if (!config.payments.flutterwaveSecret) {
        return { ok: false, error: 'Flutterwave is not configured — set FLUTTERWAVE_SECRET_KEY.' };
      }
      const body = {
        tx_ref: payment.reference,
        amount: (payment.amountKobo / 100).toFixed(2),
        currency: payment.currency || 'NGN',
        redirect_url: `${config.siteUrl}/order/${payment.orderNo || ''}`.replace(/\/$/, ''),
        customer: { email: config.business.email, name: payment.customerName || 'Guest' },
        customizations: { title: 'Honest Cars' },
      };
      try {
        const response = await fetch('https://api.flutterwave.com/v3/payments', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.payments.flutterwaveSecret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await response.json().catch(() => null);
        if (!response.ok || !json || json.status !== 'success') {
          return { ok: false, error: (json && json.message) || `Flutterwave refused the request (${response.status}).` };
        }
        return { ok: true, checkoutUrl: json.data.link, providerRef: payment.reference };
      } catch (error) {
        return { ok: false, error: `Could not reach Flutterwave: ${error.message}` };
      }
    },
    verifySignature({ headers }) {
      const secret = config.payments.flutterwaveSecretHash;
      if (!secret) return { ok: false, verdict: 'not-configured' };
      const signature = headers['verif-hash'];
      if (!signature) return { ok: false, verdict: 'missing' };
      const match = String(signature).length === secret.length
        && crypto.timingSafeEqual(Buffer.from(String(signature)), Buffer.from(secret));
      return { ok: match, verdict: match ? 'valid' : 'invalid' };
    },
    parseEvent(body) {
      if (!body || !body.event) return null;
      const data = body.data || {};
      return {
        eventId: String(body.id || data.id || `${body.event}:${data.tx_ref || ''}`),
        type: body.event,
        reference: data.tx_ref || null,
        amountKobo: data.amount ? Math.round(Number(data.amount) * 100) : null,
        status: data.status || null,
        providerRef: data.id ? String(data.id) : null,
        raw: body,
      };
    },
  },
};

/** A payment someone else took (bank transfer, cash) is not "hosted". */
adapters.bank_transfer = adapters.manual;
adapters.cash = adapters.manual;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a payment and, when a hosted provider is configured, a checkout URL.
 * Without one the payment stays `pending` and the confirmation page says how
 * to pay — the honest behaviour, and exactly what the bank-transfer flow needs.
 */
async function initiate({ purpose, amountKobo, orderId = null, bookingId = null, requestId = null, customerName = null, customerPhone = null, provider = null, actorId = null }) {
  const chosen = provider || activeProvider();
  const adapter = adapters[chosen];
  if (!adapter) return { ok: false, error: 'Unknown payment provider.' };

  const created = await db.payments.createPayment({
    provider: chosen, purpose, amountKobo, orderId, bookingId, requestId, customerName, customerPhone, createdBy: actorId,
  });
  if (!created.ok) return created;

  if (!adapter.hosted) {
    const payment = await db.payments.paymentById(created.id);
    await notify.send({
      template: 'payment_request',
      entity: 'payment',
      entityId: created.id,
      values: { amountKobo: amountKobo, reference: created.reference, purpose },
      recipient: customerPhone,
      fallbackChannel: 'console',
    });
    return { ok: true, id: created.id, reference: created.reference, provider: chosen, payment, checkoutUrl: null, hosted: false };
  }

  const payment = await db.payments.paymentById(created.id);
  const result = await adapter.initiate({ payment });
  if (!result.ok) {
    await db.payments.markFailed(created.id, { status: 'abandoned', reason: result.error, actorId });
    return { ok: false, error: result.error, id: created.id, reference: created.reference };
  }
  await db.query('UPDATE payments SET checkout_url = ?, provider_ref = COALESCE(?, provider_ref) WHERE id = ?', [result.checkoutUrl, result.providerRef || null, created.id]);
  return { ok: true, id: created.id, reference: created.reference, provider: chosen, checkoutUrl: result.checkoutUrl, hosted: true };
}

/**
 * Apply a provider webhook. Returns { ok, duplicate } — a PSP retry is a no-op.
 * `actorId` is null: a webhook is not a person, and the audit row says so.
 */
async function handleWebhook({ provider, headers = {}, rawBody, body = null }) {
  const adapter = adapters[provider];
  if (!adapter) return { ok: false, error: 'Unknown payment provider.', status: 404 };
  if (!adapter.hosted) return { ok: false, error: 'That provider does not send webhooks.', status: 400 };

  const signature = adapter.verifySignature({ headers, rawBody });
  const event = adapter.parseEvent(body);
  if (!event) return { ok: false, error: 'Unrecognised webhook payload.', status: 400 };

  // Find the payment first: an unsigned or unknown event must not create rows.
  const payment = event.reference ? await db.payments.paymentByReference(event.reference) : null;
  const verdict = signature.verdict;

  if (!payment) {
    return { ok: false, error: 'No payment matches that reference.', status: 404, verdict };
  }
  if (!signature.ok) {
    await db.payments.recordPaymentEvent({
      paymentId: payment.id, provider, eventId: event.eventId, type: event.type, signatureOk: false, payload: { verdict },
    });
    return { ok: false, error: 'Signature verification failed.', status: 401, verdict };
  }

  // Idempotency: the unique key on (provider, event_id) decides.
  const logged = await db.payments.recordPaymentEvent({
    paymentId: payment.id, provider, eventId: event.eventId, type: event.type, signatureOk: true, payload: event.raw,
  });
  if (logged.duplicate) return { ok: true, duplicate: true, verdict, payment };

  const paidTypes = ['charge.success', 'charge.successful', 'transfer.complete', 'successful'];
  const failedTypes = ['charge.failed', 'transfer.failed', 'failed', 'abandoned'];
  const refundTypes = ['refund.processed', 'refund.completed', 'refunded'];

  if (paidTypes.includes(event.type) || (event.status === 'success' && !refundTypes.includes(event.type))) {
    await db.payments.markPaid(payment.id, {
      provider, providerRef: event.providerRef, raw: event.raw, eventId: event.eventId, source: 'webhook',
    });
  } else if (refundTypes.includes(event.type)) {
    await db.payments.refund(payment.id, {
      amountKobo: event.amountKobo || null,
      reason: 'Provider refund webhook',
      actorId: null,
      viaProvider: true,
    });
  } else if (failedTypes.includes(event.type)) {
    await db.payments.markFailed(payment.id, { reason: event.type, provider, eventId: event.eventId });
  }

  return { ok: true, duplicate: false, verdict, payment: await db.payments.paymentById(payment.id) };
}

/**
 * Mark a payment paid from the console (finance saw the transfer land). This is
 * the manual path: it writes the same audit trail and the same customer
 * notification as a webhook, so the two are indistinguishable downstream.
 */
async function confirmManually(paymentId, { actorId, note = null }) {
  const result = await db.payments.markPaid(paymentId, { actorId, providerRef: note ? `manual:${String(note).slice(0, 40)}` : null });
  if (!result.ok) return result;
  const payment = result.payment;
  await notify.send({
    template: 'payment_receipt',
    entity: 'payment',
    entityId: payment.id,
    values: { amountKobo: payment.amountKobo, reference: payment.reference },
    recipient: null, // the console does not hold the clear number to message
    entityPhone: payment.maskedPhone,
    createdBy: actorId,
  });
  return { ...result, payment };
}

/** Refund wrapper: records the decision, and tells the customer what happens next. */
async function refund(paymentId, { amountKobo = null, reason, actorId }) {
  const result = await db.payments.refund(paymentId, { amountKobo, reason, actorId });
  if (!result.ok) return result;
  await notify.send({
    template: 'payment_refunded',
    entity: 'payment',
    entityId: paymentId,
    values: { amountKobo: result.amountKobo, reason },
    recipient: null,
    createdBy: actorId,
  });
  return result;
}

/**
 * Tell a customer their escrow moved. Deliberately not a release notice: the
 * wording says what changed and that nothing moves without them (§7.3).
 */
async function notifyMilestone(milestone, { actorId = null } = {}) {
  if (!milestone) return { ok: false, error: 'No milestone to announce.' };
  return notify.send({
    template: 'milestone_stage',
    entity: 'milestone',
    entityId: milestone.id,
    values: { reference: milestone.reference, stage: milestone.stage, amountKobo: milestone.amountKobo },
    recipient: null,
    createdBy: actorId,
  });
}

module.exports = {
  availability,
  activeProvider,
  initiate,
  handleWebhook,
  confirmManually,
  refund,
  notifyMilestone,
  adapters,
  PROVIDERS,
  PROVIDER_LABELS,
};
