'use strict';

/**
 * Runtime configuration. Everything comes from the environment so the same
 * build runs against the sandbox MySQL and a laptop instance untouched.
 * See .env.example.
 */

require('dotenv').config();

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
    phone: process.env.BUSINESS_PHONE || '+2348000000000',
    whatsapp: process.env.BUSINESS_WHATSAPP || '2348000000000',
    email: process.env.BUSINESS_EMAIL || 'hello@honestcarsltd.com',
    city: 'Port Harcourt',
    region: 'Rivers State',
    country: 'NG',
    addressNote: 'We operate virtually in Port Harcourt — inspections come to you.',
    cacLine: 'Honest Cars LTD — RC 0000000 · Port Harcourt, Rivers State, Nigeria',
    latitude: Number.parseFloat(process.env.BUSINESS_LAT || '4.8156'),
    longitude: Number.parseFloat(process.env.BUSINESS_LNG || '7.0498'),
    // The account customers transfer to while no card processor is live (§18).
    bankName: process.env.BUSINESS_BANK_NAME || 'GTBank',
    bankAccount: process.env.BUSINESS_BANK_ACCOUNT || '0123456789',
    bankAccountName: process.env.BUSINESS_BANK_ACCOUNT_NAME || 'Honest Cars Ltd',
  },

  // Sold-archive rule (§6.2 + §14.1): visible 7 days → archive page → 301 at 90.
  soldArchive: {
    visibleDays: int(process.env.SOLD_VISIBLE_DAYS, 7),
    redirectDays: int(process.env.SOLD_REDIRECT_DAYS, 90),
  },

  listings: {
    perPage: int(process.env.LISTINGS_PER_PAGE, 24),
    homeFeedLimit: int(process.env.HOME_FEED_LIMIT, 8),
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
    channels: {
      payment_request: process.env.NOTIFY_CHANNEL_PAYMENT || process.env.NOTIFY_CHANNEL || 'console',
      payment_receipt: process.env.NOTIFY_CHANNEL_PAYMENT || process.env.NOTIFY_CHANNEL || 'console',
      payment_refunded: process.env.NOTIFY_CHANNEL_PAYMENT || process.env.NOTIFY_CHANNEL || 'console',
      booking_dispatched: process.env.NOTIFY_CHANNEL || 'console',
      booking_completed: process.env.NOTIFY_CHANNEL || 'console',
      request_options_ready: process.env.NOTIFY_CHANNEL || 'console',
      milestone_stage: process.env.NOTIFY_CHANNEL_PAYMENT || process.env.NOTIFY_CHANNEL || 'console',
      booking_reminder: process.env.NOTIFY_CHANNEL || 'console',
    },
  },

  analytics: {
    ga4Id: process.env.GA4_ID || '',
    metaPixelId: process.env.META_PIXEL_ID || '',
    // Server-side mirror of the §15.1 event plan.
    serverSide: bool(process.env.ANALYTICS_SERVER_SIDE, true),
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
