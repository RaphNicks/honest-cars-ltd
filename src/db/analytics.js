'use strict';

/**
 * Server-side mirror of the §15.1 event plan. Event names are stored verbatim
 * in snake_case — see docs/PRD-extracted.txt §15.1 and src/services/events.js
 * for the client-side contract.
 */

const { query } = require('./pool');

/**
 * The full §15.1 plan. Used to reject typos and to keep the client contract
 * and the database honest with each other.
 */
const EVENT_NAMES = new Set([
  // Discovery
  'search_used', 'filter_applied', 'sort_changed', 'saved_search_created',
  // Listing
  'listing_impression', 'listing_view', 'gallery_engaged', 'compare_added',
  'whatsapp_click', 'viewing_requested',
  // Funnels
  'concierge_started', 'concierge_step_completed', 'concierge_abandoned', 'concierge_retainer_paid',
  'booking_started', 'booking_completed',
  'sell_swap_submitted', 'hire_requested', 'consultation_purchased',
  // Commerce
  'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'subscription_renewed',
  // Dealer / B2B
  'dealer_application_submitted', 'dealer_login_active', 'services_enquiry_submitted',
  // Brand
  'article_read_75', 'blog_post_shared', 'deal_alert_signup', 'review_link_clicked',
  // Auth & account — server-side extension beyond §15.1 (see services/events.js)
  'otp_requested', 'otp_request_failed', 'otp_verify_succeeded', 'otp_verify_failed',
  'sign_out', 'account_deleted', 'saved_car_added', 'saved_car_removed',
]);

async function record(eventName, { payload = null, sourcePath = null, sessionId = null } = {}) {
  if (!EVENT_NAMES.has(eventName)) {
    const error = new Error(`Unknown event name: ${eventName}`);
    error.statusCode = 400;
    throw error;
  }
  await query(
    `INSERT INTO analytics_events (event_name, payload, source_path, session_id)
     VALUES (?, ?, ?, ?)`,
    [
      eventName,
      payload ? JSON.stringify(payload).slice(0, 4000) : null,
      sourcePath ? String(sourcePath).slice(0, 200) : null,
      sessionId ? String(sessionId).slice(0, 64) : null,
    ],
  );
}

async function recentCounts(limit = 20) {
  return query(
    `SELECT event_name, COUNT(*) AS count, MAX(created_at) AS last_seen
       FROM analytics_events GROUP BY event_name ORDER BY count DESC LIMIT ?`,
    [String(limit)],
  );
}

module.exports = { EVENT_NAMES, record, recentCounts };
