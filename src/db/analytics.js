'use strict';

/**
 * Server-side mirror of the §15.1 event plan. Event names are stored verbatim
 * in snake_case — see docs/PRD-extracted.txt §15.1 and src/services/events.js
 * for the client-side contract.
 */

const { query, queryOne } = require('./pool');
// One definition of a date window (half-open, midnight-aligned), owned by reports.
const { windowBounds } = require('./reports');

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


// ---------------------------------------------------------------------------
// §15.2 — channel → lead → paid, and the cost of getting there
// ---------------------------------------------------------------------------

/**
 * Sessions and page activity per channel, from the events the browser sent.
 *
 * `utm.source` is what the client captured on landing (lib/campaign.js), so this
 * is first-touch: one visitor browsing ten pages is one session on the channel
 * that brought them, not ten.
 */
async function channels({ from, to } = {}) {
  const { start, end } = windowBounds({ from, to });
  return query(
    `SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.utm.source')), 'null'), '(direct / none)') AS channel,
            COUNT(DISTINCT session_id) AS sessions,
            SUM(event_name = 'listing_view') AS listingViews,
            SUM(event_name = 'whatsapp_click') AS whatsappClicks,
            SUM(event_name IN ('concierge_started', 'booking_started', 'begin_checkout')) AS funnelStarts,
            SUM(event_name IN ('concierge_retainer_paid', 'purchase', 'booking_completed', 'consultation_purchased')) AS funnelCompletions
       FROM analytics_events
      WHERE created_at >= ? AND created_at < ?
      GROUP BY channel
      ORDER BY sessions DESC, channel ASC`,
    [start, end],
  );
}

/**
 * Leads per channel, from `leads.utm` — the same bucket the reports read.
 */
async function leadsByChannel({ from, to } = {}) {
  const { start, end } = windowBounds({ from, to });
  return query(
    `SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(utm, '$.source')), 'null'), '(direct / none)') AS channel,
            COUNT(*) AS leads,
            SUM(status IN ('closed')) AS won,
            SUM(status IN ('lost')) AS lost
       FROM leads
      WHERE created_at >= ? AND created_at < ?
      GROUP BY channel
      ORDER BY leads DESC, channel ASC`,
    [start, end],
  );
}

/**
 * Money per channel, attributed by first touch.
 *
 * Payments, orders and bookings carry no campaign of their own — the visitor's
 * campaign lives on the lead their enquiry opened. So a naira is credited to the
 * channel that first brought *this phone number* to the site, which is the
 * honest join available: it is stated on the screen, not hidden, because a
 * customer who enquired from Instagram and paid by bank transfer a week later
 * really was an Instagram customer.
 *
 * A payer with no lead at all is its own row — "(unattributed)" — rather than
 * being folded into direct traffic it may not have come from.
 */
async function moneyByChannel({ from, to } = {}) {
  const { start, end } = windowBounds({ from, to });
  return query(
    `SELECT COALESCE(channel, '(unattributed)') AS channel,
            SUM(amount_kobo) AS paidKobo,
            COUNT(*) AS payments,
            SUM(purpose = 'retainer') AS retainers,
            SUM(purpose = 'booking') AS bookings,
            SUM(purpose = 'order') AS orders
       FROM (
         SELECT p.amount_kobo, p.purpose,
                (SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(l.utm, '$.source')), 'null'), NULL)
                   FROM leads l
                  WHERE l.phone = p.customer_phone AND l.utm IS NOT NULL
                  ORDER BY l.created_at ASC LIMIT 1) AS channel
           FROM payments p
          WHERE p.status = 'paid' AND p.paid_at >= ? AND p.paid_at < ?
       ) AS attributed
      GROUP BY channel
      ORDER BY paidKobo DESC`,
    [start, end],
  );
}

/** Spend recorded by hand, per channel, for the same window. */
async function spendByChannel({ from, to } = {}) {
  const { start, end } = windowBounds({ from, to });
  return query(
    `SELECT channel, SUM(amount_kobo) AS spendKobo, COUNT(*) AS entries
       FROM marketing_spend
      -- A period counts when it sits fully inside the window: half an invoice is
      -- not a number anyone can act on, and the screen says which periods the
      -- total covers so a partially-covered window is visible rather than
      -- silently prorated.
      WHERE period_start >= ? AND period_end < ?
      GROUP BY channel
      ORDER BY spendKobo DESC`,
    [start.slice(0, 10), end.slice(0, 10)],
  );
}

/** Record (or replace) a channel's spend for a period. One row per channel+period. */
async function recordSpend({ channel, periodStart, periodEnd, amountKobo, note = null, actorId = null }) {
  const existing = await queryOne(
    'SELECT id FROM marketing_spend WHERE channel = ? AND period_start = ? AND period_end = ? LIMIT 1',
    [channel, periodStart, periodEnd],
  );
  if (existing) {
    await query(
      'UPDATE marketing_spend SET amount_kobo = ?, note = ?, created_by = ? WHERE id = ?',
      [amountKobo, note, actorId, existing.id],
    );
    return { id: existing.id, updated: true };
  }
  const result = await query(
    'INSERT INTO marketing_spend (channel, period_start, period_end, amount_kobo, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [channel, periodStart, periodEnd, amountKobo, note, actorId],
  );
  return { id: result.insertId, updated: false };
}

/**
 * Which invoice periods the spend total actually covers.
 *
 * The dashboard says this out loud rather than prorating: "cost per acquisition"
 * computed against half a month's spend is a number nobody can act on.
 */
async function spendPeriods({ from, to } = {}) {
  const { start, end } = windowBounds({ from, to });
  return query(
    `SELECT DISTINCT period_start, period_end
       FROM marketing_spend
      WHERE period_start >= ? AND period_end < ?
      ORDER BY period_start ASC`,
    [start.slice(0, 10), end.slice(0, 10)],
  );
}

/** Money that is in flight: pending payments in the window, kept out of revenue. */
async function pendingMoney({ from, to } = {}) {
  const { start, end } = windowBounds({ from, to });
  const row = await queryOne(
    `SELECT COUNT(*) AS payments, COALESCE(SUM(amount_kobo), 0) AS kobo
       FROM payments
      WHERE status = 'pending' AND created_at >= ? AND created_at < ?
      HAVING COUNT(*) > 0`,
    [start, end],
  );
  return { payments: Number(row ? row.payments : 0), kobo: Number(row ? row.kobo : 0) };
}

/**
 * The whole marketing picture for one window: one row per channel, joining the
 * four sources above. Rows are merged here rather than in SQL because each
 * source is keyed differently (session, lead, phone, invoice) and a UNION would
 * have to pretend they share a grain.
 */
async function marketingSummary(options = {}) {
  const [traffic, leads, money, spend, periods, pending] = await Promise.all([
    channels(options),
    leadsByChannel(options),
    moneyByChannel(options),
    spendByChannel(options),
    spendPeriods(options),
    pendingMoney(options),
  ]);

  const byChannel = new Map();
  const row = (channel) => {
    if (!byChannel.has(channel)) {
      byChannel.set(channel, {
        channel,
        sessions: 0, listingViews: 0, whatsappClicks: 0, funnelStarts: 0, funnelCompletions: 0,
        leads: 0, won: 0, lost: 0,
        paidKobo: 0, payments: 0, retainers: 0, bookings: 0, orders: 0,
        spendKobo: 0, spendEntries: 0,
      });
    }
    return byChannel.get(channel);
  };

  for (const entry of traffic) Object.assign(row(entry.channel), {
    sessions: Number(entry.sessions || 0),
    listingViews: Number(entry.listingViews || 0),
    whatsappClicks: Number(entry.whatsappClicks || 0),
    funnelStarts: Number(entry.funnelStarts || 0),
    funnelCompletions: Number(entry.funnelCompletions || 0),
  });
  for (const entry of leads) Object.assign(row(entry.channel), {
    leads: Number(entry.leads || 0),
    won: Number(entry.won || 0),
    lost: Number(entry.lost || 0),
  });
  for (const entry of money) Object.assign(row(entry.channel), {
    paidKobo: Number(entry.paidKobo || 0),
    payments: Number(entry.payments || 0),
    retainers: Number(entry.retainers || 0),
    bookings: Number(entry.bookings || 0),
    orders: Number(entry.orders || 0),
  });
  for (const entry of spend) Object.assign(row(entry.channel), {
    spendKobo: Number(entry.spendKobo || 0),
    spendEntries: Number(entry.entries || 0),
  });

  const rows = [...byChannel.values()].map((entry) => {
    // CAC counts paid transactions, nothing else: a lead closed won without
    // money changing hands is a lead won, not an acquisition, and counting it
    // would let a channel look cheaper than it is. No conversions yet is a dash,
    // never a flattering ₦0.
    const acquisitions = entry.payments || 0;
    const cac = entry.spendKobo && acquisitions ? Math.round(entry.spendKobo / acquisitions) : null;
    const roas = entry.spendKobo && entry.paidKobo ? entry.paidKobo / entry.spendKobo : null;
    return { ...entry, acquisitions, cac, roas };
  });

  rows.sort((a, b) => (b.paidKobo - a.paidKobo) || (b.sessions - a.sessions) || a.channel.localeCompare(b.channel));

  const totals = rows.reduce((sum, entry) => ({
    sessions: sum.sessions + entry.sessions,
    leads: sum.leads + entry.leads,
    paidKobo: sum.paidKobo + entry.paidKobo,
    spendKobo: sum.spendKobo + entry.spendKobo,
    acquisitions: sum.acquisitions + entry.acquisitions,
  }), { sessions: 0, leads: 0, paidKobo: 0, spendKobo: 0, acquisitions: 0 });
  totals.cac = totals.spendKobo && totals.acquisitions ? Math.round(totals.spendKobo / totals.acquisitions) : null;
  totals.roas = totals.spendKobo && totals.paidKobo ? totals.paidKobo / totals.spendKobo : null;

  return { rows, totals, spendPeriods: periods, pending };
}

module.exports = {
  EVENT_NAMES, record, recentCounts,
  windowBounds, channels, leadsByChannel, moneyByChannel,
  spendByChannel, spendPeriods, pendingMoney, recordSpend, marketingSummary,
};
