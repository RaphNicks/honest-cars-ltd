'use strict';

const { UTM_KEYS, sanitizeUtm } = require('../lib/campaign');

/**
 * §15.1 event plan — the single contract shared by the browser and the server.
 *
 * Event names are snake_case and stored VERBATIM. The client sends batches to
 * POST /api/events; the server validates against this same list and mirrors
 * them into analytics_events (§15.2 dashboards read from there).
 *
 * Nothing here is invented: every name below appears in PRD §15.1.
 */

const EVENTS = {
  discovery: ['search_used', 'filter_applied', 'sort_changed', 'saved_search_created'],
  listing: [
    'listing_impression',
    'listing_view',
    'gallery_engaged',
    'compare_added',
    'whatsapp_click',
    'viewing_requested',
  ],
  funnels: [
    'concierge_started',
    'concierge_step_completed',
    'concierge_abandoned',
    'concierge_retainer_paid',
    'booking_started',
    'booking_completed',
    'sell_swap_submitted',
    'hire_requested',
    'consultation_purchased',
  ],
  commerce: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'subscription_renewed'],
  dealerB2b: ['dealer_application_submitted', 'dealer_login_active', 'services_enquiry_submitted'],
  brand: ['article_read_75', 'blog_post_shared', 'deal_alert_signup', 'review_link_clicked'],
  /**
   * Auth & account telemetry — an extension BEYOND §15.1, which has no auth
   * category. Recorded server-side only (never accepted from the browser) so
   * ops can see login health without widening the client contract. No PII:
   * the payload carries a channel and an attempts count, never a phone number.
   */
  account: [
    'otp_requested',
    'otp_request_failed',
    'otp_verify_succeeded',
    'otp_verify_failed',
    'sign_out',
    'account_deleted',
    'saved_car_added',
    'saved_car_removed',
  ],
};

/** Flat list, exposed to the browser as window.HonestCars.events.names. */
const EVENT_NAMES = Object.values(EVENTS).flat();

/**
 * Events that must be recorded server-side only, never trusted from a client:
 * money moved, or a record created by the server itself (§11 "all amounts
 * confirmed via webhook, never client-side").
 */
const SERVER_ONLY = new Set([
  'purchase',
  'concierge_retainer_paid',
  'subscription_renewed',
  'booking_completed',
  ...['otp_requested', 'otp_request_failed', 'otp_verify_succeeded', 'otp_verify_failed', 'sign_out', 'account_deleted'],
]);

/** Client-side payload allowlist — keeps PII out of analytics (§12.2). */
const ALLOWED_PAYLOAD_KEYS = new Set([
  'query',
  'filters',
  'sort',
  'listing_id',
  'stock_no',
  'grade',
  'price_position',
  'source',
  'step',
  'type',
  'value',
  'currency',
  'items',
  'item_id',
  'item_name',
  'category',
  'compare_ids',
  'scroll_depth',
  'share_target',
  'result_count',
  'utm',
  'make',
  'model',
  // §13.2 — the low-bandwidth set. Without these four the browser sends them
  // and this allowlist silently drops them, which is how a working feature ends
  // up with no evidence in the dashboard.
  'save_data',
  'video_duration',
  'video_size',
  'blur_up',
]);

/** Strip anything not on the allowlist, and cap string sizes. */
function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) continue;
    if (key === 'utm') {
      const campaign = sanitizeUtm(value);
      if (campaign) out.utm = campaign;
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((v) => (typeof v === 'string' ? v.slice(0, 80) : v));
    else if (typeof value === 'object') out[key] = JSON.parse(JSON.stringify(value).slice(0, 1500));
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { EVENTS, EVENT_NAMES, SERVER_ONLY, ALLOWED_PAYLOAD_KEYS, UTM_KEYS, sanitizeUtm, sanitizePayload };
