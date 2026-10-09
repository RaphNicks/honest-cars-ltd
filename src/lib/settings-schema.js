'use strict';

/**
 * The settings registry — every knob `/admin/settings` can change, and the
 * default each one falls back to.
 *
 * Three rules shape this file, and all three are about the screen not lying to
 * the person using it:
 *
 *   1. **If it is on the screen, the code reads it.** A setting nobody reads is
 *      a button that does nothing, and a console that offers one is worse than a
 *      console that offers none: an operator changes a number, believes
 *      something changed, and finds out months later that it never did. So the
 *      list is short and every key has a consumer — `test/settings.test.js`
 *      greps for them, so a new row cannot be added without one.
 *   2. **The default comes from the environment.** A deploy with an empty
 *      settings table behaves exactly as it did before this screen existed:
 *      `.env` is still the documentation for a self-hosted install, and the
 *      console is where the desk changes a number without a deploy. An override
 *      wins; resetting deletes the row and the default returns.
 *   3. **No secrets.** Provider keys — PSP, SMS, SMTP, GA4, Meta — are
 *      deliberately absent. They are deployment credentials, and a page where
 *      the desk can read them is a page where they leak. `.env` is the right
 *      home for those, and the screen says so.
 *
 * This file must not require anything from `src/` that leads back to `config.js`:
 * `config.js` reads these defaults, so a cycle here surfaces as an empty config
 * object and a stack trace from somewhere unrelated.
 */

/** Local copies of the two env helpers `config.js` uses — no shared import. */
const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Message templates, and which environment knob historically fed each one.
 * `test/settings.test.js` asserts every template in `services/notify.js` has a
 * row here, so adding a message with no channel is a failing test rather than a
 * template that quietly falls back to the general channel.
 */
const CHANNEL_TEMPLATES = {
  // Money in and money out — the desk wants these on the channel it watches.
  payment_request: 'NOTIFY_CHANNEL_PAYMENT',
  payment_receipt: 'NOTIFY_CHANNEL_PAYMENT',
  payment_refunded: 'NOTIFY_CHANNEL_PAYMENT',
  milestone_stage: 'NOTIFY_CHANNEL_PAYMENT',
  subscription_renewal: 'NOTIFY_CHANNEL_PAYMENT',
  referral_reward_paid: 'NOTIFY_CHANNEL_PAYMENT',
  // FR-34 — a financing referral leaves for a lender, which is not the same
  // route as a customer receipt and must not be silently substituted.
  financing_received: 'NOTIFY_CHANNEL_FINANCING',
  financing_handoff: 'NOTIFY_CHANNEL_FINANCING',
  financing_update: 'NOTIFY_CHANNEL_FINANCING',
  // Everything else follows the general channel.
  booking_dispatched: null,
  booking_completed: null,
  booking_reminder: null,
  request_options_ready: null,
  price_drop: null,
  new_match: null,
  hire_quote: null,
  hire_confirmed: null,
  hire_completed: null,
  addon_paid: null,
  referral_qualified: null,
  referral_reward_approved: null,
};

const CHANNELS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'console', label: 'Console (dev — records, does not deliver)' },
];

/** What a channel falls back to when nobody has chosen one for that template. */
function channelDefault(template) {
  const knob = CHANNEL_TEMPLATES[template];
  const value = (knob && process.env[knob]) || process.env.NOTIFY_CHANNEL || 'console';
  return CHANNELS.some((option) => option.value === value) ? value : 'console';
}

const TEMPLATE_LABELS = {
  payment_request: 'Payment instructions',
  payment_receipt: 'Payment receipt',
  payment_refunded: 'Refund processed',
  milestone_stage: 'Escrow stage moved',
  subscription_renewal: 'Subscription renewal',
  referral_reward_paid: 'Referral reward paid',
  referral_qualified: 'Referral qualified',
  referral_reward_approved: 'Referral reward approved',
  financing_received: 'Financing enquiry received',
  financing_handoff: 'Financing referral to a lender',
  financing_update: 'Financing outcome to the customer',
  booking_dispatched: 'Inspection booked',
  booking_completed: 'Inspection report ready',
  booking_reminder: 'Inspection reminder',
  request_options_ready: 'Concierge options ready',
  price_drop: 'Deal alert — price drop',
  new_match: 'Deal alert — new match',
  hire_quote: 'Hire quote',
  hire_confirmed: 'Hire confirmed',
  hire_completed: 'Hire closed',
  addon_paid: 'Dealer add-on live',
};

/**
 * The groups, in the order the screen shows them. Each field:
 *
 *   key       dotted, and stable — it is the row key in the settings table
 *   type      text | textarea | phone | email | digits | int | money | enum
 *   default   a function, so an env change is picked up without a restart
 *   unit      what a bare number means, for the label ("hours", "days", "₦")
 *   hint      why an operator would change it, in one sentence
 */
const GROUPS = [
  {
    key: 'business',
    title: 'Business facts',
    hint:
      'What our own pages print about us — the footer, the contact page, the about page, and the bank details a customer transfers to. Change these here and they are right everywhere without a deploy.',
    fields: [
      {
        key: 'business.phone',
        label: 'Phone number',
        type: 'phone',
        placeholder: '+2349135626182',
        hint: 'Shown in the footer and on /contact, and used for tel: links.',
        default: () => process.env.BUSINESS_PHONE || '+2349135626182',
      },
      {
        key: 'business.whatsapp',
        label: 'WhatsApp number',
        type: 'digits',
        placeholder: '2349135626182',
        hint: 'Digits only, with the country code — this is what every wa.me link uses.',
        default: () => process.env.BUSINESS_WHATSAPP || '2349135626182',
      },
      {
        key: 'business.email',
        label: 'Email address',
        type: 'email',
        placeholder: 'hello@honestcarsltd.com',
        hint: 'The address customers write to, and where ops mail comes from.',
        default: () => process.env.BUSINESS_EMAIL || 'hello@honestcarsltd.com',
      },
      {
        key: 'business.address_note',
        label: 'How we work, in one line',
        type: 'textarea',
        max: 200,
        hint: 'The footer line. Say where you are and what it means for a buyer.',
        default: () => 'We operate virtually in Port Harcourt — inspections come to you.',
      },
      {
        key: 'business.cac_line',
        label: 'Registration line',
        type: 'text',
        max: 200,
        hint: 'The CAC/RC line printed in the footer, on /contact and on /about.',
        default: () => 'Honest Cars LTD — RC 0000000 · Port Harcourt, Rivers State, Nigeria',
      },
      {
        key: 'business.bank_name',
        label: 'Bank',
        type: 'text',
        max: 80,
        hint: 'Where customers send a transfer while no card processor is live.',
        default: () => process.env.BUSINESS_BANK_NAME || 'GTBank',
      },
      {
        key: 'business.bank_account',
        label: 'Account number',
        type: 'digits',
        min: 6,
        max: 20,
        hint: 'Printed on every payment-instruction screen. Check it twice — a wrong digit is money in the wrong account.',
        default: () => process.env.BUSINESS_BANK_ACCOUNT || '0123456789',
      },
      {
        key: 'business.bank_account_name',
        label: 'Account name',
        type: 'text',
        max: 80,
        hint: 'As it appears in the bank app, so the customer can match it before sending.',
        default: () => process.env.BUSINESS_BANK_ACCOUNT_NAME || 'Honest Cars Ltd',
      },
    ],
  },

  {
    key: 'thresholds',
    title: 'Limits and windows',
    hint:
      'How much of the catalogue a page shows, and how long a sold car stays visible before it is archived. These are the numbers the §14 archive rule and the crawl budget depend on.',
    fields: [
      {
        key: 'listings.per_page',
        label: 'Cars per page',
        type: 'int',
        min: 12,
        max: 48,
        unit: 'cars',
        hint: 'The /cars grid. Too high and the page becomes a scroll nobody finishes.',
        default: () => int(process.env.LISTINGS_PER_PAGE, 24),
      },
      {
        key: 'listings.home_feed',
        label: 'Cars on the home feed',
        type: 'int',
        min: 4,
        max: 12,
        unit: 'cars',
        hint: 'The freshly-listed row on the home page.',
        default: () => int(process.env.HOME_FEED_LIMIT, 8),
      },
      {
        key: 'sold.visible_days',
        label: 'Sold cars stay visible',
        type: 'int',
        min: 1,
        max: 30,
        unit: 'days',
        hint: '§14: a sold car stays up briefly — a buyer who bookmarked it should see that it went, not a 404.',
        default: () => int(process.env.SOLD_VISIBLE_DAYS, 7),
      },
      {
        key: 'sold.redirect_days',
        label: 'Then redirect to the archive',
        type: 'int',
        min: 30,
        max: 365,
        unit: 'days',
        hint: 'After this, the old URL 301s to the archive page. Must be longer than the window above.',
        default: () => int(process.env.SOLD_REDIRECT_DAYS, 90),
      },
      {
        key: 'marketing.cac_guardrail',
        label: 'CAC guardrail',
        type: 'money',
        hint: 'The line the marketing screen draws between "working" and "call someone". A channel above it is flagged, never hidden.',
        default: () => int(process.env.MARKETING_CAC_GUARDRAIL_KOBO, 3_500_000),
      },
    ],
  },

  {
    key: 'fees',
    title: 'Fees and retainers',
    hint:
      'What we charge for a concierge search and what a referral is worth. Everything here is shown to the customer before they commit, so a change is visible the moment it saves.',
    fields: [
      {
        key: 'referral.reward',
        label: 'Referral reward',
        type: 'money',
        hint: 'Pre-fills the reward form — nothing is ever shown to a referrer until the desk approves a figure.',
        default: () => int(process.env.REFERRAL_REWARD_KOBO, 200_000),
      },
      {
        key: 'referral.qualify_orders',
        label: 'Orders that qualify a referral',
        type: 'int',
        min: 1,
        max: 10,
        unit: 'paid orders',
        hint: 'How many paid orders a referred account needs before the reward is even queued.',
        default: () => int(process.env.REFERRAL_QUALIFY_ORDERS, 1),
      },
      {
        key: 'concierge.sla_standard_hours',
        label: 'Standard — hours',
        type: 'int',
        min: 24,
        max: 168,
        unit: 'hours',
        hint: 'The promise on the SLA card. The desk is measured against it, so it has to be achievable.',
        default: () => 72,
      },
      {
        key: 'concierge.sla_standard_retainer',
        label: 'Standard — retainer',
        type: 'money',
        hint: 'What a standard search costs up front, credited against the success fee.',
        default: () => 5_000_000,
      },
      {
        key: 'concierge.sla_priority_hours',
        label: 'Priority — hours',
        type: 'int',
        min: 24,
        max: 168,
        unit: 'hours',
        hint: 'Front of the queue.',
        default: () => 48,
      },
      {
        key: 'concierge.sla_priority_retainer',
        label: 'Priority — retainer',
        type: 'money',
        hint: 'The priority retainer.',
        default: () => 6_500_000,
      },
      {
        key: 'concierge.sla_urgent_hours',
        label: 'Same-week urgent — hours',
        type: 'int',
        min: 24,
        max: 168,
        unit: 'hours',
        hint: 'For buyers with a deposit deadline.',
        default: () => 48,
      },
      {
        key: 'concierge.sla_urgent_retainer',
        label: 'Same-week urgent — retainer',
        type: 'money',
        hint: 'The urgent retainer, including daily WhatsApp updates.',
        default: () => 7_500_000,
      },
    ],
  },

  {
    key: 'channels',
    title: 'Message channels',
    hint:
      'Where each message goes. A channel with no provider configured records the message as skipped with its text intact and hands it to ops to send by hand — it never reports a delivery that did not happen.',
    fields: Object.keys(CHANNEL_TEMPLATES).map((template) => ({
      key: `notify.channel.${template}`,
      label: TEMPLATE_LABELS[template] || template.replace(/_/g, ' '),
      type: 'enum',
      options: CHANNELS,
      unset: 'Default',
      hint: `${template}`,
      default: () => channelDefault(template),
    })),
  },
];

const FIELDS = GROUPS.flatMap((group) => group.fields.map((field) => ({ ...field, group: group.key })));
const BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

/** Everything this registry will accept as a row key. */
function keys() {
  return FIELDS.map((field) => field.key);
}

function field(key) {
  return BY_KEY.get(key) || null;
}

/** The default for a field, resolved now (it may read the environment). */
function defaultValue(fieldOrKey) {
  const def = typeof fieldOrKey === 'string' ? field(fieldOrKey) : fieldOrKey;
  if (!def) return null;
  const value = typeof def.default === 'function' ? def.default() : def.default;
  return value === undefined ? null : value;
}

// ---------------------------------------------------------------------------
// Parsing
//
// The console is the only caller, but it is a caller with a keyboard and a
// paste buffer: every value passes through here before it reaches the table, and
// the same function re-parses what comes back out, so a row edited in SQL cannot
// reach a page as a number that is not one.
// ---------------------------------------------------------------------------

function parseText(raw, { max = 500, multiline = false } = {}) {
  let value = String(raw ?? '').trim();
  value = multiline ? value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : value.replace(/\s+/g, ' ');
  if (!value) return { ok: false, error: 'This one cannot be empty — use “Reset to default” instead.' };
  if (value.length > max) return { ok: false, error: `Keep it under ${max} characters (that was ${value.length}).` };
  return { ok: true, value };
}

/**
 * Validate and canonicalise one submitted value.
 *
 * @returns {{ok: boolean, error?: string, value?: string|number}}
 *          `value` is the canonical *stored* form.
 */
function parse(def, raw) {
  const input = raw === undefined || raw === null ? '' : String(raw).trim();

  switch (def.type) {
    case 'textarea':
    case 'text':
      return parseText(input, { max: def.max || 500, multiline: def.type === 'textarea' });

    case 'phone': {
      const cleaned = input.replace(/[()\s-]/g, '');
      if (!/^\+?\d{7,15}$/.test(cleaned)) {
        return { ok: false, error: 'A phone number is digits, optional leading + (e.g. +2348031234567).' };
      }
      return { ok: true, value: cleaned };
    }

    case 'digits': {
      const cleaned = input.replace(/[\s-]/g, '');
      if (!/^\d+$/.test(cleaned)) return { ok: false, error: 'Digits only here.' };
      if (cleaned.length < (def.min || 4) || cleaned.length > (def.max || 24)) {
        return { ok: false, error: `That should be ${def.min || 4}–${def.max || 24} digits.` };
      }
      return { ok: true, value: cleaned };
    }

    case 'email': {
      const cleaned = input.toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(cleaned)) return { ok: false, error: 'That does not look like an email address.' };
      return { ok: true, value: cleaned };
    }

    case 'int': {
      if (!/^\d+$/.test(input.replace(/[,\s]/g, ''))) return { ok: false, error: 'A whole number, please.' };
      const value = Number.parseInt(input.replace(/[,\s]/g, ''), 10);
      if (value < def.min || value > def.max) {
        return { ok: false, error: `Keep it between ${def.min} and ${def.max}${def.unit ? ` ${def.unit}` : ''}.` };
      }
      return { ok: true, value: String(value) };
    }

    case 'money': {
      // Naira in, kobo out — the storage unit every other money column uses.
      const cleaned = input.replace(/[₦,\s]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, error: 'An amount in naira, like 25000 or 25,000.50.' };
      const kobo = Math.round(Number(cleaned) * 100);
      if (kobo <= 0) return { ok: false, error: 'An amount above zero, please.' };
      if (def.max && kobo > def.max) return { ok: false, error: 'That is larger than this field allows.' };
      return { ok: true, value: String(kobo) };
    }

    case 'enum': {
      const allowed = (def.options || []).map((option) => option.value);
      if (!allowed.includes(input)) return { ok: false, error: 'Pick one of the listed options.' };
      return { ok: true, value: input };
    }

    default:
      return { ok: false, error: `Unknown setting type "${def.type}".` };
  }
}

/**
 * Turn a stored string back into the value the code wants: a number for `int`
 * and `money` (kobo), a boolean-free string for everything else.
 */
function coerce(def, stored) {
  if (stored === null || stored === undefined || stored === '') return defaultValue(def);
  if (def.type === 'int' || def.type === 'money') {
    const n = Number(stored);
    return Number.isFinite(n) ? n : defaultValue(def);
  }
  return String(stored);
}

/** How a value reads on the screen — naira for money, not kobo. */
function display(def, raw) {
  if (raw === null || raw === undefined || raw === '') {
    const fallback = defaultValue(def);
    return def.type === 'money' ? naira(fallback) : String(fallback ?? '');
  }
  if (def.type === 'money') return naira(Number(raw));
  return String(raw);
}

function naira(kobo) {
  const amount = Number(kobo || 0) / 100;
  return amount.toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

module.exports = {
  GROUPS,
  FIELDS,
  CHANNELS,
  CHANNEL_TEMPLATES,
  TEMPLATE_LABELS,
  keys,
  field,
  defaultValue,
  parse,
  coerce,
  display,
  channelDefault,
  naira,
};
