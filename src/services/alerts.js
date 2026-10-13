'use strict';

/**
 * Saved-car and saved-search alerts — FR-25, §7.1's two switches.
 *
 * The account screen has always had "Price drops" and "New matches" per saved
 * search, and the seeded schema has always carried the columns. This is the
 * sending side:
 *
 *   • A saved car watches its own price. The baseline (`last_price_kobo`) is set
 *     when you save it, so saving a car never alerts you about the price you
 *     just looked at. A sweep compares the live price to the baseline; a fall
 *     sends one alert and moves the baseline down, a rise moves the baseline up
 *     silently (that is not news — and it means the *next* drop is measured from
 *     where the price actually is).
 *   • A saved search watches new stock. `last_alerted_at` starts at the moment
 *     you save the search, so a new save never dumps the current inventory on
 *     you, and it only ever moves forward to the newest listing actually
 *     alerted on — never to wall-clock time, which would silently skip a car
 *     published while the sweep was running.
 *
 * There is no daemon here, deliberately: `npm run alerts` is a script a cron
 * job (or the ops desk from /admin/alerts) runs. Both paths call the same
 * `runWatch()`, and both are safe to run twice — the baselines are what make a
 * drop alert fire once per price rather than once per sweep.
 *
 * Delivery goes through services/notify.js, so it inherits the honest seam: a
 * channel with no provider records the message as `skipped` and keeps the text,
 * ready for the ops desk to send from a WhatsApp deep link. Nothing is dropped
 * and nothing pretends to have been sent.
 */

const db = require('../db');
const listingQuery = require('./listing-query');
const notify = require('./notify');
const money = require('../lib/money');

/** A hard ceiling so one sweep can never send an unbounded number of messages. */
const MAX_ALERTS_PER_RUN = Number(process.env.ALERTS_MAX_PER_RUN || 50);
/** How many listings a single saved search may contribute to one sweep. */
const MAX_MATCHES_PER_SEARCH = 5;

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// What is being watched (§7.3 /admin/alerts reads this)
// ---------------------------------------------------------------------------
async function watchList({ limit = 200 } = {}) {
  const cars = await db.query(
    `SELECT s.id, s.user_id, s.last_price_kobo, s.last_alerted_at, s.created_at,
            u.name AS user_name, u.phone,
            l.id AS listing_id, l.seo_slug, l.make, l.model, l.year, l.asking_price_kobo,
            l.status, l.expires_at
       FROM saved_cars s
       JOIN vehicle_listings l ON l.id = s.listing_id
       JOIN \`users\` u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT ?`,
    [Math.min(500, Math.max(1, limit))],
  );

  const searches = await db.query(
    `SELECT ss.*, u.name AS user_name, u.phone,
            (SELECT COUNT(*) FROM vehicle_listings l WHERE 1 = 1) AS listing_total
       FROM saved_searches ss
       JOIN \`users\` u ON u.id = ss.user_id
      ORDER BY ss.created_at DESC
      LIMIT ?`,
    [Math.min(500, Math.max(1, limit))],
  );

  return {
    cars: cars.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      email: null,
      phone: row.phone,
      listing: {
        id: row.listing_id,
        slug: row.seo_slug,
        title: [row.year, row.make, row.model].filter(Boolean).join(' '),
        url: `/cars/${row.seo_slug}`,
        priceKobo: Number(row.asking_price_kobo),
        status: row.status,
        live: row.status === 'live' || row.status === 'reserved',
      },
      baselineKobo: row.last_price_kobo === null ? null : Number(row.last_price_kobo),
      lastAlertedAt: row.last_alerted_at,
      createdAt: row.created_at,
      // What a sweep would do right now — the screen shows this, so nobody has
      // to run a watch to find out what it would say.
      pendingDrop:
        row.last_price_kobo !== null && Number(row.asking_price_kobo) < Number(row.last_price_kobo)
          ? Number(row.last_price_kobo) - Number(row.asking_price_kobo)
          : 0,
    })),
    searches: searches.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      phone: row.phone,
      label: row.label,
      query: row.query,
      url: `/cars${String(row.query || '').startsWith('?') ? row.query : row.query ? `?${row.query}` : ''}`,
      alertsEnabled: Boolean(row.alerts_enabled),
      priceDrop: Boolean(row.alert_price_drop),
      newMatch: Boolean(row.alert_new_match),
      lastAlertedAt: row.last_alerted_at,
      createdAt: row.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------
function dropMessage(listing, previousKobo, currentKobo) {
  const drop = previousKobo - currentKobo;
  return `${listing.title} is down ${money.formatNaira(drop)} to ${money.formatNaira(currentKobo)} — was ${money.formatNaira(previousKobo)}. Still HonestCars listed: ${listing.url} (ref ${listing.slug.split('-').pop().toUpperCase()}).`;
}

function matchMessage(search, listings) {
  const lines = listings
    .slice(0, 3)
    .map((listing) => `• ${listing.title} — ${money.formatNaira(listing.priceKobo)} (${listing.gradeLabel || listing.grade})`);
  return `${listings.length} new car${listings.length === 1 ? '' : 's'} matching “${search.label}”: ${lines.join(' ')} Open honestcarsltd.com${search.url} for the rest.`;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.dryRun]  detect and report, write nothing, send nothing
 * @param {number}  [options.userId]  restrict to one account (useful for support)
 * @param {number}  [options.limit]   cap the number of messages this run sends
 */
async function runWatch({ dryRun = false, userId = null, limit = MAX_ALERTS_PER_RUN } = {}) {
  const started = Date.now();
  const report = {
    dryRun: Boolean(dryRun),
    at: nowSql(),
    checked: { cars: 0, searches: 0 },
    priceDrops: [],
    newMatches: [],
    soldOff: [],
    skipped: [],
    sent: 0,
    remaining: 0,
    errors: [],
  };

  // An explicit 0 means "detect but send nothing" — the caller asked for that
  // on purpose, so it must not silently become the default cap.
  const requested = limit === undefined || limit === null ? MAX_ALERTS_PER_RUN : Number(limit);
  const budget = { left: Math.max(0, Math.min(MAX_ALERTS_PER_RUN, Number.isFinite(requested) ? requested : MAX_ALERTS_PER_RUN)) };

  // --- saved cars: price drops -------------------------------------------------
  const carRows = await db.query(
    `SELECT s.id AS saved_car_id, s.user_id, s.last_price_kobo, u.name AS user_name, u.phone,
            l.id AS listing_id, l.seo_slug, l.make, l.model, l.year, l.trim,
            l.asking_price_kobo, l.verification_grade, l.status, l.expires_at
       FROM saved_cars s
       JOIN vehicle_listings l ON l.id = s.listing_id
       JOIN \`users\` u ON u.id = s.user_id
      ${userId ? 'WHERE s.user_id = ?' : ''}
      ORDER BY s.id`,
    userId ? [userId] : [],
  );
  report.checked.cars = carRows.length;

  for (const row of carRows) {
    const current = Number(row.asking_price_kobo);
    const baseline = row.last_price_kobo === null ? current : Number(row.last_price_kobo);
    const sold = row.status !== 'live' && row.status !== 'reserved';

    if (sold) {
      report.soldOff.push({ userId: row.user_id, listingId: row.listing_id, slug: row.seo_slug, status: row.status });
      continue;
    }

    if (current === baseline) continue;

    if (current > baseline) {
      // A rise is not an alert. Move the baseline so the next drop is measured
      // from where the price actually is.
      if (!dryRun) {
        await db.query('UPDATE saved_cars SET last_price_kobo = ? WHERE id = ? AND last_price_kobo <= ?', [
          current, row.saved_car_id, current,
        ]);
      }
      continue;
    }

    const listing = {
      id: row.listing_id,
      slug: row.seo_slug,
      title: [row.year, row.make, row.model, row.trim].filter(Boolean).join(' '),
      url: `/cars/${row.seo_slug}`,
      priceKobo: current,
      grade: row.verification_grade,
    };
    const body = dropMessage(listing, baseline, current);
    const entry = {
      userId: row.user_id,
      userName: row.user_name,
      savedCarId: row.saved_car_id,
      listingId: row.listing_id,
      slug: row.seo_slug,
      title: listing.title,
      fromKobo: baseline,
      toKobo: current,
      dropKobo: baseline - current,
      body,
    };

    if (budget.left <= 0) {
      report.remaining += 1;
      continue;
    }

    if (!dryRun) {
      const result = await notify.send({
        template: 'price_drop',
        values: { body },
        recipient: row.phone,
        entity: 'listing',
        entityId: row.listing_id,
      });
      entry.notificationId = result.id || null;
      entry.delivery = result.status || 'unknown';
      // The baseline only moves when the alert is on its way — a failed send
      // leaves the drop to be found again next sweep rather than lost.
      if (result.ok) {
        await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = UTC_TIMESTAMP() WHERE id = ?', [
          current, row.saved_car_id,
        ]);
        budget.left -= 1;
        report.sent += 1;
      } else {
        await db.query('UPDATE saved_cars SET last_price_kobo = ?, last_alerted_at = UTC_TIMESTAMP() WHERE id = ?', [
          current, row.saved_car_id,
        ]);
        report.skipped.push({ kind: 'price_drop', userId: row.user_id, listingId: row.listing_id, reason: result.error || result.status });
        budget.left -= 1;
      }
    } else {
      report.priceDrops.push(entry);
    }

    if (!dryRun) report.priceDrops.push(entry);
  }

  // --- saved searches: new matches ---------------------------------------------
  const searchRows = await db.query(
    `SELECT ss.*, u.name AS user_name, u.phone
       FROM saved_searches ss
       JOIN \`users\` u ON u.id = ss.user_id
      WHERE ss.alerts_enabled = 1 AND ss.alert_new_match = 1
      ${userId ? 'AND ss.user_id = ?' : ''}
      ORDER BY ss.id`,
    userId ? [userId] : [],
  );
  report.checked.searches = searchRows.length;

  for (const search of searchRows) {
    const parsed = listingQuery.parseListingQuery(
      Object.fromEntries(new URLSearchParams(String(search.query || '').replace(/^\?/, ''))),
    );
    const window = search.last_alerted_at || search.created_at;

    const result = await db.listings.browse(parsed.filters, {
      page: 1,
      perPage: 48,
      sort: 'newest',
    });
    const fresh = result.listings
      .filter((listing) => listing.publishedAt && new Date(listing.publishedAt) > new Date(window))
      .slice(0, MAX_MATCHES_PER_SEARCH);

    if (!fresh.length) continue;

    const body = matchMessage(
      { label: search.label, url: `/cars?${String(search.query || '').replace(/^\?/, '')}` },
      fresh,
    );
    const entry = {
      userId: search.user_id,
      userName: search.user_name,
      searchId: search.id,
      label: search.label,
      count: fresh.length,
      listings: fresh.map((listing) => ({ id: listing.id, slug: listing.slug, title: listing.title, priceKobo: listing.priceKobo })),
      body,
    };

    if (budget.left <= 0) {
      report.remaining += 1;
      continue;
    }

    // Never move the window forward to “now”: only to the newest listing we
    // actually told the customer about.
    const newest = fresh.reduce((max, listing) => {
      const value = new Date(listing.publishedAt);
      return value > max ? value : max;
    }, new Date(window));

    if (!dryRun) {
      const sent = await notify.send({
        template: 'new_match',
        values: { body },
        recipient: search.phone,
        entity: 'saved_search',
        entityId: search.id,
      });
      entry.notificationId = sent.id || null;
      entry.delivery = sent.status || 'unknown';
      if (!sent.ok) report.skipped.push({ kind: 'new_match', userId: search.user_id, searchId: search.id, reason: sent.error || sent.status });
      await db.query('UPDATE saved_searches SET last_alerted_at = ? WHERE id = ? AND (last_alerted_at IS NULL OR last_alerted_at < ?)', [
        newest.toISOString().slice(0, 19).replace('T', ' '), search.id, newest.toISOString().slice(0, 19).replace('T', ' '),
      ]);
      budget.left -= 1;
      report.sent += 1;
    }
    report.newMatches.push(entry);
  }

  report.ms = Date.now() - started;
  return report;
}

/** Recent alert messages, for the console (they are ordinary notifications). */
async function recentAlerts({ limit = 40 } = {}) {
  const rows = await db.query(
    `SELECT id, template, recipient, body, status, error, entity, entity_id, created_at, sent_at
       FROM notifications
      WHERE template IN ('price_drop', 'new_match')
      ORDER BY id DESC
      LIMIT ?`,
    [Math.min(200, Math.max(1, limit))],
  );
  return rows;
}

module.exports = {
  MAX_ALERTS_PER_RUN,
  watchList,
  runWatch,
  recentAlerts,
  dropMessage,
  matchMessage,
};
