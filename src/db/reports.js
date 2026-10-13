'use strict';

/**
 * §7.3 Reports — the four exports the PRD names: pillar, inspector, dealer, UTM.
 *
 * Every one of them is a read: no report writes a row, and none of them touches
 * the money seam. They are grouped here (rather than spread across the modules
 * that own each table) because they share one shape — a date window in, a
 * header plus rows out — which is what makes the CSV and the PDF honest about
 * the same numbers.
 *
 * Money is returned in kobo and formatted by the renderer, never here.
 *
 * Windows are half-open: `from` is inclusive from 00:00, `to` is exclusive, so
 * two adjacent windows never count the same record twice.
 */

const db = require('./pool');

/**
 * A date range as SQL bounds, defaulting to the last 30 days.
 *
 * Every bound lands on a midnight, including the default one: a window that
 * starts at "29 days ago, 14:37" would quietly drop the first morning's records,
 * and a reader comparing two windows would not be able to see why.
 */
function windowBounds({ from, to }) {
  const day = (value) => new Date(`${value}T00:00:00Z`);
  const today = new Date();
  const endDay = to ? day(to) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = from ? day(from) : new Date(endDay.getTime() - 29 * 86_400_000);
  // `to` names a day a person would want included, so it runs to the next midnight.
  const exclusiveEnd = new Date(endDay.getTime() + 86_400_000);
  const iso = (value) => value.toISOString().slice(0, 19).replace('T', ' ');
  return { start: iso(start), end: iso(exclusiveEnd) };
}

const PILLAR_LABELS = {
  concierge: 'Concierge (find my car)',
  sell: 'Sell my car',
  swap: 'Swap',
  documents: 'Document check',
  research: 'Research',
  parts: 'Parts enquiry',
  consultation: 'Consultation',
  tracking: 'Tracker / security',
  hire: 'Vehicle hire',
  inspection: 'Pre-purchase inspection',
  install: 'Tracker installation',
  viewing: 'Viewing request',
  service: 'Service enquiry',
  b2b: 'Dealer / B2B',
  deal_alert: 'Deal alert signup',
  shop: 'Shop order',
};

/**
 * Pillar: where the work came from. `service_requests` and `bookings` are
 * separate tables with separate type enums, so they are unioned here and
 * summed by pillar — which is the only way a reader gets one row per pillar
 * instead of two rows named "consultation".
 *
 * `closed` means the record reached its end state; `paidKobo` is what actually
 * changed hands, which is why it reads 0 for a pillar nobody has paid for yet.
 */
async function pillars({ from, to }) {
  const { start, end } = windowBounds({ from, to });
  return db.query(
    `SELECT pillar, SUM(total) AS total, SUM(closed) AS closed, SUM(paidKobo) AS paidKobo FROM (
       SELECT type AS pillar, COUNT(*) AS total,
              SUM(status IN ('closed')) AS closed, 0 AS paidKobo
         FROM service_requests
        WHERE created_at >= ? AND created_at < ?
        GROUP BY type
       UNION ALL
       SELECT type AS pillar, COUNT(*) AS total,
              SUM(status IN ('completed')) AS closed,
              COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN amount_kobo ELSE 0 END), 0) AS paidKobo
         FROM bookings
        WHERE created_at >= ? AND created_at < ?
        GROUP BY type
       UNION ALL
       SELECT 'shop' AS pillar, COUNT(*) AS total,
              SUM(status IN ('fulfilled')) AS closed, 0 AS paidKobo
         FROM orders
        WHERE created_at >= ? AND created_at < ?
        HAVING COUNT(*) > 0
        UNION ALL
       SELECT type AS pillar, COUNT(*) AS total,
              SUM(status IN ('closed')) AS closed, 0 AS paidKobo
         FROM leads
        WHERE created_at >= ? AND created_at < ?
        GROUP BY type
     ) AS unioned
     GROUP BY pillar
     ORDER BY total DESC, pillar ASC`,
    [start, end, start, end, start, end, start, end],
  );
}

/**
 * Inspector: who did the work, and how it came out. Unassigned bookings are
 * returned as their own row — a report that quietly hides work nobody owns is
 * the one report ops actually needs to see.
 */
async function inspectors({ from, to }) {
  const { start, end } = windowBounds({ from, to });
  return db.query(
    `SELECT u.id, u.name,
            COUNT(b.id) AS assigned,
            SUM(b.status = 'completed') AS completed,
            SUM(b.verdict = 'pass' OR b.verdict = 'pass_with_advisory') AS passed,
            SUM(b.verdict = 'fail') AS failed,
            SUM(b.checklist IS NOT NULL) AS reports,
            ROUND(AVG(CASE WHEN b.completed_at IS NOT NULL AND b.dispatched_at IS NOT NULL
                     THEN TIMESTAMPDIFF(HOUR, b.dispatched_at, b.completed_at) END), 1) AS avgHours
       FROM bookings b
       LEFT JOIN \`users\` u ON u.id = b.inspector_id
      WHERE b.created_at >= ? AND b.created_at < ?
      GROUP BY u.id, u.name
      ORDER BY assigned DESC, u.name ASC`,
    [start, end],
  );
}

/**
 * Dealer: what a lot lists, what it earns, what it is still owed. The ledger is
 * signed (a clawback is negative), so the total is the honest net position
 * rather than a sum of positives.
 */
async function dealers({ from, to }) {
  const { start, end } = windowBounds({ from, to });
  const rows = await db.query(
    `SELECT d.id, d.name, d.lot_area, d.commission_pct,
            COUNT(DISTINCT l.id) AS listings,
            COUNT(DISTINCT CASE WHEN l.status = 'live' THEN l.id END) AS live,
            COUNT(DISTINCT CASE WHEN l.status = 'sold' THEN l.id END) AS sold,
            COUNT(DISTINCT ld.id) AS leads
       FROM dealers d
       LEFT JOIN vehicle_listings l ON l.dealer_id = d.id
       LEFT JOIN leads ld ON ld.listing_id = l.id AND ld.created_at >= ? AND ld.created_at < ?
      GROUP BY d.id, d.name, d.lot_area, d.commission_pct
      ORDER BY listings DESC, d.name ASC`,
    [start, end],
  );
  // The money is read in its own pass: the join above multiplies listings by
  // leads, and a ledger summed through it would be counted many times over.
  const money = await db.query(
    `SELECT dealer_id,
            COALESCE(SUM(CASE WHEN amount_kobo > 0 THEN amount_kobo ELSE 0 END), 0) AS earnedKobo,
            COALESCE(SUM(CASE WHEN amount_kobo < 0 THEN -amount_kobo ELSE 0 END), 0) AS paidKobo,
            COALESCE(SUM(amount_kobo), 0) AS netKobo
       FROM dealer_ledger
      WHERE created_at >= ? AND created_at < ?
      GROUP BY dealer_id`,
    [start, end],
  );
  const byDealer = new Map(money.map((row) => [Number(row.dealer_id), row]));
  return rows.map((row) => ({
    earnedKobo: 0, paidKobo: 0, netKobo: 0, ...row, ...(byDealer.get(Number(row.id)) || {}),
  }));
}

/**
 * UTM: which link brought the person here. `leads.utm` is a JSON blob written
 * by the public forms, so the source is read out of it; a lead that arrived
 * without one is a real bucket ("direct / none") and is named rather than
 * dropped.
 */
async function sources({ from, to }) {
  const { start, end } = windowBounds({ from, to });
  return db.query(
    `SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(utm, '$.source')), 'null'), '(direct / none)') AS source,
            COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(utm, '$.medium')), 'null'), '—') AS medium,
            COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(utm, '$.campaign')), 'null'), '—') AS campaign,
            COUNT(*) AS leads,
            SUM(status IN ('closed')) AS closed,
            SUM(status IN ('lost')) AS lost
       FROM leads
      WHERE created_at >= ? AND created_at < ?
      GROUP BY source, medium, campaign
      ORDER BY leads DESC, source ASC`,
    [start, end],
  );
}

/** The four exports, keyed by the slug the console puts in the URL. */
const REPORTS = {
  pillar: {
    label: 'Pillar',
    description: 'Every request, booking, order and lead, grouped by the work it belongs to.',
    columns: [
      { key: 'pillar', label: 'Pillar', format: 'pillar' },
      { key: 'total', label: 'Records', numeric: true },
      { key: 'closed', label: 'Closed', numeric: true },
      { key: 'paidKobo', label: 'Paid', format: 'money' },
    ],
    rows: pillars,
  },
  inspector: {
    label: 'Inspector',
    description: 'Workload and outcomes per inspector, with unassigned jobs named.',
    columns: [
      { key: 'name', label: 'Inspector', format: 'name' },
      { key: 'assigned', label: 'Assigned', numeric: true },
      { key: 'completed', label: 'Completed', numeric: true },
      { key: 'reports', label: 'Reports filed', numeric: true },
      { key: 'passed', label: 'Passed', numeric: true },
      { key: 'failed', label: 'Failed', numeric: true },
      { key: 'avgHours', label: 'Avg hours', numeric: true },
    ],
    rows: inspectors,
  },
  dealer: {
    label: 'Dealer',
    description: 'What each lot lists, what the ledger says it has earned, and what is still owed.',
    columns: [
      { key: 'name', label: 'Dealer' },
      { key: 'lot_area', label: 'Lot' },
      { key: 'listings', label: 'Listings', numeric: true },
      { key: 'live', label: 'Live', numeric: true },
      { key: 'sold', label: 'Sold', numeric: true },
      { key: 'leads', label: 'Leads', numeric: true },
      { key: 'earnedKobo', label: 'Commission', format: 'money' },
      { key: 'paidKobo', label: 'Paid out', format: 'money' },
      { key: 'netKobo', label: 'Net owed', format: 'money' },
    ],
    rows: dealers,
  },
  utm: {
    label: 'UTM',
    description: 'Which link brought the person in, and what became of them.',
    columns: [
      { key: 'source', label: 'Source' },
      { key: 'medium', label: 'Medium' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'leads', label: 'Leads', numeric: true },
      { key: 'closed', label: 'Closed', numeric: true },
      { key: 'lost', label: 'Lost', numeric: true },
    ],
    rows: sources,
  },
};

/** Human label for a pillar slug, falling back to the slug itself. */
function pillarLabel(key) {
  return PILLAR_LABELS[key] || key;
}

module.exports = { REPORTS, PILLAR_LABELS, pillarLabel, pillars, inspectors, dealers, sources, windowBounds };
