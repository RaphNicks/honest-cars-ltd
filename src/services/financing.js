'use strict';

/**
 * Financing — FR-34. The customer-facing half: the arithmetic we are allowed to
 * do, the enquiry we capture, and the handoff to a partner.
 *
 * **We are not a lender, and this module is built so that it never reads like
 * one.** There is no rate in this file, no APR, no approval, no "you qualify".
 * What it does instead is arithmetic the customer can check themselves —
 *
 *   price − down payment = the gap that has to be financed
 *   gap ÷ months         = what the principal alone costs per month
 *
 * — and then says plainly that interest and fees are the lender's business, and
 * that their offer letter is the only thing that binds anyone. An affordability
 * sentence we cannot stand behind is worse than none: a person who plans around
 * a monthly figure we invented is a person we misled.
 *
 * The handoff is equally literal. `capture()` writes the enquiry and the inbox
 * lead; `route()` records *which partner it went to and when*, and sends the
 * handoff message through `notify` — where, with no email/WhatsApp provider
 * configured, it is recorded `skipped` with its text intact and handed to ops as
 * a WhatsApp deep link. No partner has been told anything until that happens,
 * and the console shows that state rather than assuming it.
 */

const config = require('../config');
const db = require('../db');
const notify = require('./notify');
const validate = require('./validate');
const phones = require('../lib/phone');
const money = require('../lib/money');

/** Terms we offer as choices. Nothing magic about them — typical Nigerian tenor. */
const TENORS = [12, 24, 36, 48, 60];

/** A brief that says "finance me" is not a blank cheque: ₦500m is not a car. */
const MAX_AMOUNT_KOBO = 500_000_000_00;
const MAX_DOWN_KOBO = 500_000_000_00;
const MAX_MONTHLY_KOBO = 100_000_000_00;

/** What a Nigerian bank or MFB will usually ask for. Wording, not a guarantee. */
const READINESS = [
  'A valid ID — NIN slip, driver’s licence, passport or voter’s card',
  'Six months of statements for the account your income lands in',
  'Proof of income — payslip, employment letter, or business registration and filings',
  'Your BVN, and the bank’s own minimum account age',
  'A guarantor or collateral, for some products and some lenders',
];

const STATUS_SENTENCE = {
  new: 'With our desk. Nobody has been assigned to it yet — a human reads every one of these.',
  shared: 'Sent to the partner. They have not come back to us yet, and we will not say they have.',
  contacted: 'The partner has been in touch with you.',
  approved: 'The partner approved it. Their written offer is what counts — we never quote their terms on their behalf.',
  declined: 'The partner declined it. That is their decision, not ours, and we can try another lender if you want.',
  withdrawn: 'Withdrawn.',
};

/**
 * The arithmetic. Pure, testable, and deliberately incapable of producing a
 * monthly payment that includes interest we do not know.
 *
 * @param {object} input
 * @param {number} input.amountKobo   the car's price, or the budget
 * @param {number} input.downKobo     what the customer can put down
 * @param {number} input.monthlyKobo  what they can pay a month
 * @param {number} input.tenorMonths  how long they want to take
 */
function plan({ amountKobo = 0, downKobo = 0, monthlyKobo = 0, tenorMonths = 36 } = {}) {
  const amount = Math.max(0, Math.round(Number(amountKobo) || 0));
  const down = Math.min(Math.max(0, Math.round(Number(downKobo) || 0)), amount);
  const monthly = Math.max(0, Math.round(Number(monthlyKobo) || 0));
  const tenor = TENORS.includes(Number(tenorMonths)) ? Number(tenorMonths) : 36;

  if (!amount) {
    return {
      ok: false,
      error: 'Tell us the car or the budget you have in mind — even a rough figure works.',
    };
  }

  const gap = amount - down;
  const downPercent = Math.round((down / amount) * 100);
  const principalPerMonth = Math.ceil(gap / tenor);
  const monthsAtMonthly = monthly > 0 ? Math.ceil(gap / monthly) : null;

  if (gap <= 0) {
    return {
      ok: true,
      amountKobo: amount,
      downKobo: down,
      monthlyKobo: monthly,
      tenorMonths: tenor,
      downPercent,
      gapKobo: 0,
      principalPerMonthKobo: 0,
      shortfallKobo: 0,
      monthlyCoversPrincipal: true,
      outright: true,
      headline: 'That covers the whole price, so you do not need financing for it.',
      detail:
        'If you still want options — a lower down payment, or cash left in the bank — tell us and the desk will route it anyway.',
    };
  }

  const shortfall = Math.max(0, principalPerMonth - monthly);
  const covers = monthly === 0 || monthly >= principalPerMonth;

  const headline = covers
    ? `${money.formatNaira(principalPerMonth)} a month over ${tenor} months covers the whole ${money.formatNaira(gap)} gap — before interest and fees.`
    : `At ${money.formatNaira(monthly)} a month over ${tenor} months you would pay ${money.formatNaira(
        monthly * tenor,
      )}, and the gap is ${money.formatNaira(gap)} — so this plan does not add up yet.`;

  const detail = covers
    ? `What that payment becomes once the lender adds interest is their figure, not ours — we do not quote rates we cannot honour. ${
        downPercent ? `Your ${money.formatNaira(down)} down payment is ${downPercent}% of the price.` : 'Nothing is put down yet.'
      }`
    : [
        `The principal alone needs ${money.formatNaira(principalPerMonth)} a month over ${tenor} months, before any interest or fees.`,
        `Three ways this becomes a plan that works: a bigger down payment, a longer tenor, or a monthly closer to ${money.formatNaira(
          principalPerMonth,
        )}.`,
        monthsAtMonthly
          ? `At ${money.formatNaira(monthly)} a month the principal alone would take about ${monthsAtMonthly} months.`
          : null,
        'Their offer is the one that counts, and we will not pretend to know their rate.',
      ]
        .filter(Boolean)
        .join(' ');

  return {
    ok: true,
    amountKobo: amount,
    downKobo: down,
    monthlyKobo: monthly,
    tenorMonths: tenor,
    downPercent,
    gapKobo: gap,
    principalPerMonthKobo: principalPerMonth,
    shortfallKobo: shortfall,
    monthsAtMonthly,
    monthlyCoversPrincipal: covers,
    outright: false,
    headline,
    detail,
    caveat: 'This is arithmetic, not an offer. No credit decision has been made, and no rate is implied.',
  };
}

/** The number we quote back at the customer, and the desk quotes at the lender. */
async function reference() {
  return db.financing.nextReference();
}

/**
 * Capture an enquiry.
 *
 * @param {object} body      raw request body (never trusted)
 * @param {object} [context] { sourcePath, utm, requestId }
 */
async function capture(body = {}, { sourcePath = '/financing', utm = null, requestId = null } = {}) {
  const name = validate.name(body.name);
  const phone = validate.phone(body.phone);
  if (!name) return { ok: false, status: 422, error: 'Please tell us your name.' };
  if (!phone) return { ok: false, status: 422, error: 'That phone number does not look right — please check it.' };

  // §11: an amount that decides what we tell someone never comes from the
  // browser if we can read it from the database instead.
  let listing = null;
  let amountKobo = null;
  if (body.listingSlug) {
    listing = await db.listings.findBySlug(validate.text(body.listingSlug, 200));
    if (listing) amountKobo = listing.priceKobo;
  }
  if (!amountKobo) {
    amountKobo = validate.kobo(body.amount);
    if (amountKobo === null || amountKobo <= 0) {
      return { ok: false, status: 422, error: 'Tell us the price or the budget you have in mind.' };
    }
  }
  if (amountKobo > MAX_AMOUNT_KOBO) {
    return { ok: false, status: 422, error: 'That figure is larger than we can help with — please check it.' };
  }

  const downKobo = Math.min(validate.kobo(body.down) ?? 0, MAX_DOWN_KOBO);
  const monthlyKobo = Math.min(validate.kobo(body.monthly) ?? 0, MAX_MONTHLY_KOBO);
  const tenorMonths = validate.oneOf(String(body.tenor || ''), TENORS.map(String), '36');

  const arithmetic = plan({
    amountKobo,
    downKobo,
    monthlyKobo,
    tenorMonths: Number(tenorMonths),
  });
  if (!arithmetic.ok) return { ok: false, status: 422, error: arithmetic.error };

  const employment = validate.oneOf(body.employment, db.financing.EMPLOYMENTS, null);
  const timeline = validate.oneOf(body.timeline, db.financing.TIMELINES, null);
  const email = validate.text(body.email, 160) || null;
  const canonicalPhone = phones.canonical(phone, { fallback: phone });
  const path = validate.text(sourcePath || '/financing', 200);

  // The ops inbox copy first: if anything below fails, the enquiry still exists
  // somewhere a human will see it.
  const inbox = await db.leads
    .createLead({
      type: 'financing',
      listingId: listing ? listing.id : null,
      name,
      phone: canonicalPhone,
      message: `Financing enquiry${listing ? ` — ${listing.title} (${listing.stockNo})` : ''}. Price ${
        arithmetic.amountKobo / 100
      } NGN, down ${arithmetic.downKobo / 100} NGN, monthly ${arithmetic.monthlyKobo / 100} NGN, ${
        arithmetic.tenorMonths
      } months.`,
      sourcePath: path,
      utm,
    })
    .catch(() => null);

  const created = await db.financing.createLead({
    name,
    phone: canonicalPhone,
    email,
    leadId: inbox ? inbox.id : null,
    listingId: listing ? listing.id : null,
    requestId,
    amountKobo: arithmetic.amountKobo,
    downKobo: arithmetic.downKobo,
    monthlyKobo: arithmetic.monthlyKobo,
    tenorMonths: arithmetic.tenorMonths,
    employment,
    timeline,
    plan: arithmetic,
    sourcePath: path,
    utm,
  });
  if (!created.ok) return { ok: false, status: 500, error: created.error };

  await db.analytics
    .record('services_enquiry_submitted', {
      payload: { type: 'financing', source: path },
      sourcePath: path,
    })
    .catch(() => {});

  // The customer hears from us immediately, and the message says what happens
  // next rather than thanking them for their enquiry.
  const message = await notify
    .send({
      template: 'financing_received',
      values: {
        name,
        reference: created.lead.reference,
        amount: money.formatNaira(arithmetic.amountKobo),
        car: listing ? listing.title : null,
      },
      recipient: canonicalPhone,
      entity: 'financing_lead',
      entityId: created.lead.id,
      mustDeliver: true,
    })
    .catch(() => null);

  const opsText = encodeURIComponent(
    `New financing enquiry ${created.lead.reference}\nName: ${name}\nPhone: ${canonicalPhone}\n${
      listing ? `Car: ${listing.title} (${listing.stockNo})\n` : ''
    }Price: ${money.formatNaira(arithmetic.amountKobo)}\nDown: ${money.formatNaira(arithmetic.downKobo)}\nMonthly: ${money.formatNaira(
      arithmetic.monthlyKobo,
    )} over ${arithmetic.tenorMonths} months`,
  );

  return {
    ok: true,
    lead: created.lead,
    plan: arithmetic,
    readiness: READINESS,
    notification: message ? { channel: message.channel, status: message.status } : null,
    whatsappUrl: `https://wa.me/${config.business.whatsapp}?text=${opsText}`,
  };
}

/**
 * Route an enquiry to a partner.
 *
 * `notify.send` is what makes this a handoff rather than a note to ourselves:
 * the message with the customer's requirements goes to the partner's channel,
 * and if that channel is not configured the record says `skipped` with the text
 * intact — which is the desk's cue to send it by hand.
 */
async function route(leadId, { partnerId, actorId = null } = {}) {
  const routed = await db.financing.route(leadId, { partnerId, actorId });
  if (!routed.ok) return routed;

  const { lead, partner } = routed;
  const message = await notify
    .send({
      template: 'financing_handoff',
      values: {
        partner: partner.name,
        reference: lead.reference,
        customer: lead.name,
        phone: lead.phone,
        car: lead.listingTitle || 'not decided yet',
        amount: money.formatNaira(lead.amountKobo),
        down: money.formatNaira(lead.downKobo),
        monthly: money.formatNaira(lead.monthlyKobo),
        tenor: `${lead.tenorMonths} months`,
        employment: (lead.employment || 'not stated').replace(/_/g, ' '),
        timeline: (lead.timeline || 'not stated').replace(/_/g, ' '),
        notes: lead.plan && lead.plan.headline ? lead.plan.headline : '',
      },
      recipient: partner.channel === 'email' || partner.channel === 'whatsapp' ? partner.contact : null,
      entity: 'financing_lead',
      entityId: lead.id,
      createdBy: actorId,
      mustDeliver: true,
    })
    .catch(() => null);

  return {
    ok: true,
    lead: await db.financing.findById(lead.id),
    partner,
    notification: message
      ? { channel: message.channel, status: message.status, body: message.body, error: message.error || null }
      : null,
    // The link ops uses when the channel is not wired up (`manual`, or a
    // provider we have no keys for). Empty contact = send it themselves.
    whatsappUrl: message && message.status !== 'sent' ? notify.whatsappLink(message.body, partner.contact) : null,
  };
}

/** Record what the partner came back with, and tell the customer. */
async function outcome(leadId, { status, note = null, actorId = null } = {}) {
  const allowed = ['contacted', 'approved', 'declined', 'withdrawn'];
  if (!allowed.includes(status)) {
    return { ok: false, error: 'Record contacted, approved, declined or withdrawn — routing is a separate step.' };
  }
  const before = await db.financing.findById(leadId);
  if (!before) return { ok: false, error: 'That enquiry does not exist.' };

  const saved = await db.financing.recordOutcome(leadId, { status, note, actorId });
  if (!saved.ok) return saved;

  const message = await notify
    .send({
      template: 'financing_update',
      values: {
        reference: saved.lead.reference,
        status: STATUS_SENTENCE[status],
        partner: saved.lead.partnerName || 'the partner',
        note: note || null,
      },
      recipient: saved.lead.phone,
      entity: 'financing_lead',
      entityId: saved.lead.id,
      createdBy: actorId,
      mustDeliver: true,
    })
    .catch(() => null);

  return { ok: true, lead: saved.lead, notification: message ? { channel: message.channel, status: message.status } : null };
}

/** What /account shows the signed-in customer about their own enquiries. */
function accountView(leads = []) {
  return leads.map((lead) => ({
    reference: lead.reference,
    car: lead.listingTitle || null,
    amount: money.formatNaira(lead.amountKobo),
    down: money.formatNaira(lead.downKobo),
    monthly: money.formatNaira(lead.monthlyKobo),
    tenor: `${lead.tenorMonths} months`,
    partner: lead.partnerName || null,
    status: lead.status,
    statusSentence: STATUS_SENTENCE[lead.status],
    lastUpdate: lead.updatedAt,
    url: `/financing?ref=${encodeURIComponent(lead.reference)}`,
  }));
}

/** Console summary — the queue plus the two facts that need acting on. */
async function desk() {
  const [counts, queue, partners] = await Promise.all([
    db.financing.counts(),
    db.financing.queue({ limit: 100 }),
    db.financing.partners({ withCounts: true }),
  ]);
  return {
    counts,
    queue,
    partners,
    activePartners: partners.filter((partner) => partner.active),
    // The honest headline for the screen: with no partner on the list, the
    // handoff is the desk's own WhatsApp, and the page says so.
    waiting: queue.filter((lead) => lead.status === 'new'),
    awaitingOutcome: queue.filter((lead) => lead.status === 'shared'),
  };
}

module.exports = {
  TENORS,
  READINESS,
  STATUS_SENTENCE,
  MAX_AMOUNT_KOBO,
  plan,
  reference,
  capture,
  route,
  outcome,
  accountView,
  desk,
};
