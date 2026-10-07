'use strict';

/**
 * Runtime configuration. Everything comes from the environment so the same
 * build runs against the sandbox MySQL and a laptop instance untouched.
 * See .env.example.
 *
 * Some of these are also *defaults* for settings the console owns (§5.1):
 * business facts, page limits, the sold-car windows, the concierge SLA card,
 * referral and CAC figures, and the channel each message takes. The ones that
 * are marked below read through `overrides.value(...)`, which returns the saved
 * override when there is one and this environment-derived default when there is
 * not — so a fresh `.env` behaves exactly as it always did, and the desk can
 * change a number without a deploy. Which keys those are, and what each one
 * controls, is the registry in `src/lib/settings-schema.js`.
 */

require('dotenv').config();

// The console's /admin/settings screen (§5.1) stores overrides in the database,
// hydrated into this module at boot by `src/services/settings.js`. Reading a
// setting through `overrides.value()` gives the override when there is one and
// the registry's default — which is the environment, exactly as it was before
// that screen existed — when there is not. No cycle: this file and the registry
// never require each other at load time.
const overrides = require('./lib/overrides');

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // Public origin — used for canonical URLs, sitemap and OG tags.
  siteUrl: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'honestcars',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'honestcars',
    // Optional unix socket (some managed hosts prefer it). Wins over host/port.
    socketPath: process.env.DB_SOCKET || undefined,
    connectionLimit: int(process.env.DB_POOL_SIZE, 10),
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
  },

  // Business facts that appear in copy/schema (PRD §6.1, §14.3, Appendix D)
  business: {
    name: 'Honest Cars LTD',
    legalName: 'Honest Cars LTD',
    // Editable at /admin/settings — see the note on `overrides` at the top.
    get phone() {
      return overrides.value('business.phone');
    },
    get whatsapp() {
      return overrides.value('business.whatsapp');
    },
    get email() {
      return overrides.value('business.email');
    },
    city: 'Port Harcourt',
    region: 'Rivers State',
    country: 'NG',
    get addressNote() {
      return overrides.value('business.address_note');
    },
    get cacLine() {
      return overrides.value('business.cac_line');
    },
    latitude: Number.parseFloat(process.env.BUSINESS_LAT || '4.8156'),
    longitude: Number.parseFloat(process.env.BUSINESS_LNG || '7.0498'),
    // The account customers transfer to while no card processor is live (§18).
    get bankName() {
      return overrides.value('business.bank_name');
    },
    get bankAccount() {
      return overrides.value('business.bank_account');
    },
    get bankAccountName() {
      return overrides.value('business.bank_account_name');
    },
  },

  // Sold-archive rule (§6.2 + §14.1): visible 7 days → archive page → 301 at 90.
  soldArchive: {
    get visibleDays() {
      return overrides.value('sold.visible_days');
    },
    get redirectDays() {
      return overrides.value('sold.redirect_days');
    },
  },

  listings: {
    get perPage() {
      return overrides.value('listings.per_page');
    },
    get homeFeedLimit() {
      return overrides.value('listings.home_feed');
    },
    similarLimit: 3,
  },

  // Phone-first accounts (§7.1). OTP delivery is a seam: `console` writes the
  // code to the server log for development, `whatsapp` and `sms` are the real
  // providers (§11 — WhatsApp first, SMS as fallback). No provider is wired yet,
  // so the code is only ever returned to the browser outside production.
  auth: {
    provider: process.env.AUTH_OTP_PROVIDER || 'console',
    otpTtlMinutes: int(process.env.AUTH_OTP_TTL_MINUTES, 10),
    otpLength: int(process.env.AUTH_OTP_LENGTH, 6),
    maxVerifyAttempts: int(process.env.AUTH_MAX_VERIFY_ATTEMPTS, 5),
    maxRequestsPerHour: int(process.env.AUTH_MAX_REQUESTS_PER_HOUR, 5),
    sessionDays: int(process.env.AUTH_SESSION_DAYS, 30),
    // Peppers the OTP hash and the session token. Must be set in production.
    pepper: process.env.AUTH_PEPPER || '',
    // Development only: echo the code in the API response so the flow can be
    // driven without a phone. Forced off when NODE_ENV=production.
    get showCodeInResponse() {
      return !config.isProduction && bool(process.env.AUTH_SHOW_CODE, true);
    },
  },

  // Payments (§11, FR-08). The merchant accounts do not exist yet, so the
  // default provider is `manual`: finance records the transfer that arrived and
  // the console marks it paid. Drop in a secret key and the hosted adapter
  // starts returning a real checkout URL instead — no other change.
  payments: {
    get defaultProvider() {
      return process.env.PAYMENT_PROVIDER || 'manual';
    },
    paystackSecret: process.env.PAYSTACK_SECRET_KEY || '',
    flutterwaveSecret: process.env.FLUTTERWAVE_SECRET_KEY || '',
    // Flutterwave verifies webhooks with a shared hash, not an HMAC.
    flutterwaveSecretHash: process.env.FLUTTERWAVE_SECRET_HASH || '',
    get hostedAvailable() {
      return Boolean(config.payments.paystackSecret || config.payments.flutterwaveSecret);
    },
  },

  // Notifications (§11). WhatsApp first in production; `console` records and
  // prints in development. Channels are per template so a receipt can go to
  // WhatsApp while a report link goes by email.
  notifications: {
    get defaultChannel() {
      return process.env.NOTIFY_CHANNEL || 'console';
    },
    // Built from the registry in src/lib/settings-schema.js — one row per
    // template, so a message type cannot be added without a channel decision
    // (a test asserts the two lists match), and the desk can move a template
    // between WhatsApp, SMS and email without a deploy.
    get channels() {
      const out = {};
      for (const template of Object.keys(require('./lib/settings-schema').CHANNEL_TEMPLATES)) {
        out[template] = overrides.value(`notify.channel.${template}`);
      }
      return out;
    },
  },

  // FR-28 referrals. §7.1 asks for a reward *status*, and the PRD deliberately
  // names no amount — a reward is a campaign decision, so it is configuration
  // here and a human entry in the console. `rewardKobo` only pre-fills the form;
  // nothing is ever shown to a customer until the desk approves it.
  referral: {
    get rewardKobo() {
      return overrides.value('referral.reward');
    },
    get qualifyOrders() {
      return overrides.value('referral.qualify_orders');
    },
  },

  analytics: {
    ga4Id: process.env.GA4_ID || '',
    metaPixelId: process.env.META_PIXEL_ID || '',
    // Server-side mirror of the §15.1 event plan.
    serverSide: bool(process.env.ANALYTICS_SERVER_SIDE, true),
  },

  // §15.2 CAC guardrails. Spend is entered by hand, conversions come from the
  // data, and this is the line the marketing screen draws between "working" and
  // "call someone": a channel whose cost per paid transaction sits above it is
  // flagged, not hidden. Deliberately configuration, not a hard-coded number —
  // what is expensive in October is not what is expensive in March.
  marketing: {
    get cacGuardrailKobo() {
      return overrides.value('marketing.cac_guardrail');
    },
  },

  features: {
    // Static pages are written to disk by `npm run build:static`; the server
    // serves them when present and falls back to request-time rendering.
    serveStaticPages: bool(process.env.SERVE_STATIC_PAGES, true),
    staticDir: process.env.STATIC_DIR || 'dist',
    // Absolute — res.sendFile() requires it, and the build script and the
    // server must agree on the same directory regardless of cwd.
    get staticPath() {
      const path = require('node:path');
      return path.resolve(process.cwd(), this.staticDir);
    },
  },
};

config.isProduction = config.env === 'production';

module.exports = config;
