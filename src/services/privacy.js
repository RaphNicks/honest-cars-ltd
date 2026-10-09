'use strict';

/**
 * Privacy — §18.3. The duty side of NDPA, on top of db/privacy.js.
 *
 * Two jobs live here.
 *
 * **Consent.** `NOTICES` is the register of every consent box the site shows,
 * with the wording *exactly as the customer sees it* and the file it appears
 * in. A record keeps the wording, so the console can answer "what were they
 * told?" and not only "did they tick it?". `test/privacy.test.js` greps the
 * views for each notice, which means the register cannot drift away from the
 * page — if the sentence changes and the register does not, the suite fails.
 *
 * **Requests.** §12.2's self-service rights already worked: `/account/export`
 * downloads everything and `/api/account/delete` closes the account and
 * anonymises its records. What was missing was a *record* that someone asked.
 * `fileSelfService()` writes one the moment either happens, deduplicated to one
 * row per person per day, so a refresh is not a second request and the log
 * still says what a human would have written down. `logRequest()` files the
 * ones that arrive by WhatsApp or over the counter, and the desk works them
 * with a 30-day clock that starts when the *person* asked, not when the row
 * was typed.
 */

const config = require('../config');
const db = require('../db');
const validate = require('./validate');
const phones = require('../lib/phone');

/**
 * Every consent box on the site, verbatim. `view` is where the wording lives —
 * the test reads that file and requires the sentence to be in it.
 */
const NOTICES = [
  // --- "we may contact you about this" (service contact, not marketing) ------
  {
    key: 'service_form',
    purpose: 'service_contact',
    source: 'service_form',
    view: ['views/partials/service-form.ejs'],
    text: 'HonestCars can contact me on WhatsApp about this request. No marketing spam — that is a separate, optional list.',
  },
  {
    key: 'contact',
    purpose: 'service_contact',
    source: 'contact',
    view: ['views/pages/contact.ejs'],
    text: 'HonestCars can contact me on WhatsApp about this message. No marketing spam.',
  },
  {
    key: 'concierge_brief',
    purpose: 'service_contact',
    source: 'concierge',
    view: ['views/pages/find-my-car.ejs'],
    text: 'HonestCars can contact me on WhatsApp about this brief. No marketing spam.',
  },
  {
    key: 'sell_valuation',
    purpose: 'service_contact',
    source: 'sell_swap',
    view: ['views/pages/sell-swap.ejs'],
    text: 'HonestCars can contact me on WhatsApp about this valuation. No marketing spam.',
  },
  {
    key: 'swap',
    purpose: 'service_contact',
    source: 'sell_swap',
    view: ['views/pages/sell-swap.ejs'],
    text: 'HonestCars can contact me on WhatsApp about this swap. No marketing spam.',
  },
  {
    key: 'hire',
    purpose: 'service_contact',
    source: 'hire',
    view: ['views/pages/hire.ejs'],
    text: 'HonestCars can contact me on WhatsApp about this quote. No marketing spam.',
  },
  {
    key: 'partner',
    purpose: 'service_contact',
    source: 'partner',
    view: ['views/pages/partner.ejs'],
    text: 'HonestCars can contact me on WhatsApp about this application.',
  },
  {
    key: 'checkout',
    purpose: 'service_contact',
    source: 'checkout',
    view: ['views/pages/checkout.ejs'],
    text: 'HonestCars can contact me on WhatsApp to confirm this order and payment.',
  },
  {
    key: 'login',
    purpose: 'service_contact',
    source: 'login',
    view: ['views/pages/login.ejs'],
    text: 'I agree to HonestCars contacting me on this number about my requests and orders.',
  },

  // --- the permissions that are more than contact ---------------------------
  {
    key: 'financing',
    purpose: 'lender_share',
    source: 'financing',
    view: ['views/pages/financing.ejs'],
    text: 'I am happy for Honest Cars to share these details with a lender so they can contact me about this enquiry. Nothing is shared until you send it.',
  },
  {
    key: 'concierge_financing',
    purpose: 'lender_share',
    source: 'concierge',
    view: ['views/pages/find-my-car.ejs'],
    // Not a checkbox: the radio card that says "Yes — I would like options"
    // carries this sentence, so choosing it *is* the permission — provided the
    // sentence is on the page, which the test checks.
    text: 'We put your requirement in front of a lender and record where it goes. You pay us nothing for it, and we never quote a rate we cannot honour.',
  },
  {
    key: 'marketing',
    purpose: 'marketing',
    source: 'account',
    view: ['views/pages/account.ejs'],
    text: 'Send me deal alerts and new-stock notes on this number or email.',
  },
  {
    key: 'deal_alerts',
    purpose: 'deal_alerts',
    source: 'saved_car',
    view: ['views/pages/account.ejs'],
    // The sentence above the saved-search alert switches: the thing a person is
    // agreeing to when they save a car or leave a search watching.
    text: 'Price drops and new matches go out on the channel we message you on.',
  },
];

/** Notices a checkbox is *not* behind (a radio card), so the box test skips them. */
const NOT_CHECKBOX = ['concierge_financing'];

const NOTICE_BY_KEY = new Map(NOTICES.map((notice) => [notice.key, notice]));

function notice(key) {
  const found = NOTICE_BY_KEY.get(key);
  if (!found) throw new Error(`Unknown consent notice: ${key}`);
  return found.text;
}

/**
 * Which notice a service intake was looking at. The forms all post to the same
 * endpoint and each carries its own sentence, so the choice is made from the
 * *kind* of request rather than guessed from a path — with `/contact` naming
 * itself, because the contact page is the one form that is not a service flow.
 */
function noticeKeyForIntake(kind, sourcePath = '') {
  if (String(sourcePath).startsWith('/contact')) return 'contact';
  switch (kind) {
    case 'concierge':
      return 'concierge_brief';
    case 'sell':
      return 'sell_valuation';
    case 'swap':
      return 'swap';
    case 'hire':
      return 'hire';
    case 'dealer':
    case 'b2b':
      return 'partner';
    default:
      return 'service_form';
  }
}

/**
 * Record a consent event. Best-effort by design: a person opting in must not
 * have their form fail because the audit row could not be written, but the
 * failure is loud in the server log rather than silent, because a gap in this
 * table is a gap in the evidence.
 */
async function recordConsent(key, { userId = null, phone = null, name = null, granted = true, source = null, path = null, actor = 'self', recordedBy = null } = {}, conn = null) {
  const entry = NOTICE_BY_KEY.get(key) || { purpose: 'enquiry_contact', source: key, text: notice(key) };
  try {
    await db.privacy.recordConsent(
      {
        userId,
        phone: phone ? phones.canonical(phone, { fallback: phone }) : null,
        name,
        purpose: entry.purpose,
        granted,
        source: source || entry.source,
        path,
        notice: entry.text,
        actor,
        recordedBy,
      },
      conn,
    );
    return { ok: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[privacy] consent record failed (${entry.purpose}, ${key}): ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/** File a request the site itself has just satisfied (an export, a deletion). */
async function fileSelfService({ type, user = null, channel = 'self_service', subject, resolution, sourcePath = null, when = null }) {
  const requestedAt = when ? new Date(when) : new Date();
  const midnight = new Date(Date.now() - 86_400_000);
  const phone = user && user.phone ? phones.canonical(user.phone, { fallback: user.phone }) : null;

  // One row per person per day per type. A customer who downloads their file
  // three times on Tuesday made one request on Tuesday; a customer who comes
  // back next month has made a second one, and that is a real row.
  if (user && user.id) {
    const existing = await db.queryOne(
      `SELECT id FROM data_requests
        WHERE user_id = ? AND request_type = ? AND channel = 'self_service' AND requested_at >= ?
        ORDER BY id DESC LIMIT 1`,
      [user.id, type, midnight],
    );
    if (existing) {
      await db.query(
        'UPDATE data_requests SET requested_at = ?, due_at = ?, resolution = ? WHERE id = ?',
        [requestedAt, new Date(requestedAt.getTime() + db.privacy.DUE_DAYS * 86_400_000), resolution || null, existing.id],
      );
      return { ok: true, request: await db.privacy.findRequest(existing.id), reused: true };
    }
  }

  return db.privacy.createRequest({
    type,
    status: 'completed',
    channel,
    userId: user ? user.id : null,
    name: user ? user.name : null,
    phone,
    email: user ? user.email : null,
    subject,
    resolution,
    requestedAt,
    completedAt: requestedAt,
    sourcePath,
  });
}

/**
 * Log a request that arrived by WhatsApp, on the phone, or over the counter.
 * Everything is validated here rather than in the route, so the console form,
 * any future API and a test all get the same refusals.
 */
async function logRequest(input = {}, actor = {}) {
  const type = validate.oneOf(input.type, db.privacy.TYPES, null);
  if (!type) return { ok: false, error: 'Pick what they asked for.' };

  const channel = validate.oneOf(input.channel, db.privacy.CHANNELS.filter((c) => c !== 'self_service'), 'whatsapp');
  const name = validate.name(input.name);
  const rawPhone = validate.text(input.phone, 40);
  const phone = rawPhone ? validate.phone(rawPhone) : null;
  const email = validate.text(input.email, 160).toLowerCase() || null;
  if (!name && !phone) {
    return { ok: false, error: 'A request needs a name or a phone number — otherwise there is nobody to action it for.' };
  }
  if (rawPhone && !phone) return { ok: false, error: 'That phone number does not look right — use the digits, or +234…' };

  const requestedAt = parseDay(input.requestedAt);
  if (requestedAt === null) return { ok: false, error: 'That date does not look right — use YYYY-MM-DD.' };
  if (requestedAt.getTime() > Date.now() + 86_400_000) return { ok: false, error: 'A request cannot be dated in the future.' };

  // `subject` is what they asked for, in the words used — free text, because a
  // person who writes in does not choose from our list of five.
  const subject = validate.text(input.subject, 240) || null;
  const result = await db.privacy.createRequest({
    type,
    channel,
    name,
    phone: phone ? phones.canonical(phone, { fallback: phone }) : null,
    email,
    subject,
    requestedAt,
    status: 'received',
    sourcePath: validate.text(actor.path, 200) || '/admin/privacy',
  });
  if (!result.ok) return result;
  return { ok: true, request: result.request, type };
}

/** `YYYY-MM-DD` → Date at local midnight; undefined → now; anything else → null. */
function parseDay(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

/** Move a request, with the human sentence the closure needs. */
async function moveRequest(id, { status, resolution }, actor = {}) {
  const result = await db.privacy.updateRequest(id, {
    status,
    resolution: validate.text(resolution, 240) || null,
    handledBy: actor.id || null,
  });
  if (!result.ok) return result;
  return { ok: true, request: result.request, moved: result.moved };
}

/**
 * What the person's consent history looks like, in words. The current state of
 * each purpose is read from where it actually lives — the account flag, the
 * saved cars and searches — never re-derived from the log.
 */
async function consentStateFor(phone) {
  if (!phone) return { events: [], summary: [] };
  const events = await db.privacy.consentForPhone(phone);
  const rows = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM saved_cars s JOIN \`users\` u ON u.id = s.user_id WHERE u.phone = ?)      AS saved_cars,
       (SELECT COUNT(*) FROM saved_searches s JOIN \`users\` u ON u.id = s.user_id
         WHERE u.phone = ? AND s.alerts_enabled = 1)                                                   AS alert_searches`,
    [phone, phone],
  );
  const row = rows[0] || {};
  const latest = new Map();
  for (const event of events) if (!latest.has(event.purpose)) latest.set(event.purpose, event);
  const summary = [...latest.values()].map((event) => ({
    purpose: event.purpose,
    purposeLabel: event.purposeLabel,
    granted: event.granted,
    at: event.createdBy,
    sentence: event.granted
      ? `Said yes to ${event.purposeLabel.toLowerCase()} — “${event.notice}”`
      : `Said no to ${event.purposeLabel.toLowerCase()} — recorded ${new Date(event.createdBy).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}`,
  }));
  return {
    events,
    summary,
    liveState: {
      savedCars: Number(row.saved_cars) || 0,
      alertSearches: Number(row.alert_searches) || 0,
    },
  };
}

/**
 * The console's screen. Counts, the queue, and the two consent facts that
 * matter: how many people are on each list *now*, and what changed lately.
 */
async function desk({ status = 'open', type = null } = {}) {
  const [counts, openList, tally, recent, state] = await Promise.all([
    db.privacy.counts(),
    db.privacy.requests({ status: 'open', limit: 500 }),
    db.privacy.consentTally({ days: 30 }),
    db.privacy.consentEvents({ limit: 12 }),
    db.privacy.consentState(),
  ]);
  // The filter is applied to the open list we already have rather than asking
  // the database the same question twice — the queue and the overdue count can
  // then never disagree about which requests are open.
  const queue = status === 'open' && !type ? openList : await db.privacy.requests({ status, type, limit: 200 });
  return {
    counts,
    queue,
    tally,
    recent,
    state,
    openList,
    overdue: openList.filter((request) => request.overdue),
  };
}

/**
 * The compliance file: one line per request, for the lawyer or the regulator.
 * Deliberately not a "report" of our own making — same columns as the screen.
 */
async function csv() {
  const rows = await db.privacy.requests({ status: null, limit: 500 });
  return rows.map((row) => [
    row.reference,
    db.privacy.TYPE_LABELS[row.type] || row.type,
    row.status,
    row.channel,
    row.name || '',
    row.phone || '',
    row.email || '',
    row.subject || '',
    row.resolution || '',
    isoDate(row.requestedAt),
    isoDate(row.dueAt),
    row.completedAt ? isoDate(row.completedAt) : '',
    row.handledByName || '',
  ]);
}

function isoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

const CSV_HEADER = [
  'reference',
  'what_they_asked',
  'status',
  'channel',
  'name',
  'phone',
  'email',
  'detail',
  'what_was_done',
  'requested_on',
  'due_by',
  'closed_on',
  'handled_by',
];

/**
 * The sentence the account page shows after an export or a deletion. Kept here
 * so the console record and the customer's confirmation cannot describe the
 * same act differently.
 */
const SELF_SERVICE = {
  access: {
    subject: 'Downloaded their data from /account/export',
    resolution: 'Export generated and downloaded immediately (NDPA right of access). No human action needed.',
  },
  erasure: {
    subject: 'Closed their account from /account',
    resolution:
      'Account closed; requests, bookings, orders and leads anonymised in place. Transaction history kept without the person attached (§12.2).',
  },
};

/** Business contact for a person who would rather write than use the console. */
function privacyContact() {
  return config.business.email || null;
}

module.exports = {
  NOTICES,
  NOT_CHECKBOX,
  noticeKeyForIntake,
  notice,
  SELF_SERVICE,
  recordConsent,
  fileSelfService,
  logRequest,
  parseDay,
  moveRequest,
  consentStateFor,
  desk,
  csv,
  CSV_HEADER,
  privacyContact,
};
