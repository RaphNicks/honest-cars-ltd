'use strict';

/**
 * Inventory pricing intel — §7.3, the market price-band table.
 *
 * One row per make/model/year-range/condition holding the band the site reads
 * when it labels a listing below / within / premium. That makes this table
 * load-bearing: the price-position indicator on every VDP (§3.5) is only as
 * honest as the band behind it, so the console shows the age of each row, who
 * last touched it, and which live stock has no band at all.
 *
 * Reads are open to `pricing.view`; every write goes through `recordAudit()`
 * with the before and after, because a band quietly moved is a price claim
 * quietly changed.
 */

const { query, queryOne, transaction } = require('./pool');

const CONDITIONS = ['any', 'tokunbo', 'nigerian_used', 'new'];
const CONDITION_LABELS = {
  any: 'Any condition',
  tokunbo: 'Tokunbo (imported used)',
  nigerian_used: 'Nigerian-used',
  new: 'New',
};

/** §7.3 asks for a weekly refresh, so a band older than this is stale. */
const STALE_DAYS = 7;

function shapeBand(row) {
  if (!row) return null;
  const min = Number(row.band_min_kobo);
  const max = Number(row.band_max_kobo);
  const refreshed = row.refreshed_at ? new Date(row.refreshed_at) : null;
  const ageDays = refreshed ? Math.floor((Date.now() - refreshed.getTime()) / 86_400_000) : null;
  return {
    id: row.id,
    make: row.make,
    model: row.model,
    yearFrom: Number(row.year_from),
    yearTo: Number(row.year_to),
    condition: row.condition,
    conditionLabel: CONDITION_LABELS[row.condition] || row.condition,
    minKobo: min,
    maxKobo: max,
    widthKobo: max - min,
    sampleSize: Number(row.sample_size || 0),
    refreshedAt: row.refreshed_at,
    ageDays,
    stale: ageDays === null || ageDays >= STALE_DAYS,
    listings: row.listings === undefined ? null : Number(row.listings),
    // How many live cars this band actually labels — the reason it matters.
    pricedListingId: row.sample_listing_id || null,
  };
}

/**
 * The table itself. `q` matches make or model; `staleOnly` narrows to rows due
 * for the weekly pass; `gap` switches to live stock with no band covering it.
 */
async function bands({ q = null, staleOnly = false, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(b.make LIKE ? OR b.model LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (staleOnly) {
    where.push('(b.refreshed_at IS NULL OR b.refreshed_at < DATE_SUB(CURDATE(), INTERVAL ? DAY))');
    params.push(STALE_DAYS);
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 200)));

  const rows = await query(
    `SELECT b.*,
            (SELECT COUNT(*) FROM vehicle_listings l
              WHERE l.make = b.make AND l.model = b.model
                AND l.year BETWEEN b.year_from AND b.year_to
                AND l.status IN ('live','reserved')) AS listings
       FROM price_bands b
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.make, b.model, b.year_from
      LIMIT ?`,
    params,
  );
  return rows.map(shapeBand);
}

async function bandById(id) {
  const row = await queryOne('SELECT * FROM price_bands WHERE id = ? LIMIT 1', [Number(id) || 0]);
  return shapeBand(row);
}

/**
 * Live stock the bands do not cover. These are the listings whose price
 * indicator reads "no data" — the ops to-do list that makes the table grow.
 */
async function gaps({ limit = 50 } = {}) {
  const rows = await query(
    `SELECT l.make, l.model, MIN(l.year) AS year_from, MAX(l.year) AS year_to,
            MIN(l.\`condition\`) AS \`condition\`, COUNT(*) AS listings,
            MIN(l.id) AS sample_listing_id
       FROM vehicle_listings l
      WHERE l.status IN ('live','reserved')
        AND NOT EXISTS (
          SELECT 1 FROM price_bands b
           WHERE b.make = l.make AND b.model = l.model
             AND l.year BETWEEN b.year_from AND b.year_to
             AND (b.\`condition\` = l.\`condition\` OR b.\`condition\` = 'any')
        )
      GROUP BY l.make, l.model
      ORDER BY listings DESC, l.make, l.model
      LIMIT ?`,
    [Math.min(200, Math.max(1, Number(limit) || 50))],
  );
  return rows.map((row) => ({
    make: row.make,
    model: row.model,
    yearFrom: Number(row.year_from),
    yearTo: Number(row.year_to),
    condition: row.condition,
    listings: Number(row.listings),
    sampleListingId: row.sample_listing_id,
  }));
}

/** Headline numbers for the console: coverage, staleness, and the gap. */
async function coverage() {
  const row = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM price_bands) AS bands,
       (SELECT COUNT(*) FROM price_bands
         WHERE refreshed_at IS NULL OR refreshed_at < DATE_SUB(CURDATE(), INTERVAL ? DAY)) AS stale,
       (SELECT COUNT(DISTINCT CONCAT(make, '|', model)) FROM vehicle_listings WHERE status IN ('live','reserved')) AS models,
       (SELECT COUNT(*) FROM vehicle_listings l
         WHERE l.status IN ('live','reserved')
           AND NOT EXISTS (
             SELECT 1 FROM price_bands b
              WHERE b.make = l.make AND b.model = l.model
                AND l.year BETWEEN b.year_from AND b.year_to
                AND (b.\`condition\` = l.\`condition\` OR b.\`condition\` = 'any')
           )) AS unpriced,
       (SELECT COUNT(*) FROM vehicle_listings WHERE status IN ('live','reserved')) AS live`,
    [STALE_DAYS],
  );
  return {
    bands: Number(row.bands || 0),
    stale: Number(row.stale || 0),
    models: Number(row.models || 0),
    unpriced: Number(row.unpriced || 0),
    live: Number(row.live || 0),
    staleDays: STALE_DAYS,
  };
}

/**
 * The weekly update form's write path: create the band, or move the existing
 * one for the same make/model/years/condition. Either way the row is stamped
 * as refreshed today and the change is audited with its before and after.
 */
async function upsertBand({ make, model, yearFrom, yearTo, condition = 'any', minKobo, maxKobo, sampleSize = 0, actorId = null }) {
  const cleanMake = String(make || '').trim().slice(0, 60);
  const cleanModel = String(model || '').trim().slice(0, 80);
  const safeCondition = CONDITIONS.includes(condition) ? condition : 'any';
  const from = Number(yearFrom);
  const to = Number(yearTo);
  const min = Number(minKobo);
  const max = Number(maxKobo);

  if (!cleanMake || !cleanModel) return { ok: false, error: 'A band needs a make and a model.' };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1950 || to > 2100 || from > to) {
    return { ok: false, error: 'Check the years: from 1950, and the range must run upwards.' };
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
    return { ok: false, error: 'Enter both ends of the band in naira, e.g. 11,500,000.' };
  }
  if (min > max) return { ok: false, error: 'The low end of a band cannot be above the high end.' };

  return transaction(async (conn) => {
    const [existingRows] = await conn.query(
      `SELECT * FROM price_bands
        WHERE make = ? AND model = ? AND year_from = ? AND year_to = ? AND \`condition\` = ?
        LIMIT 1`,
      [cleanMake, cleanModel, from, to, safeCondition],
    );
    const existing = existingRows[0] || null;

    if (existing) {
      await conn.query(
        `UPDATE price_bands
            SET band_min_kobo = ?, band_max_kobo = ?, sample_size = ?, refreshed_at = CURDATE()
          WHERE id = ?`,
        [min, max, Math.max(0, Number(sampleSize) || 0), existing.id],
      );
    } else {
      await conn.query(
        `INSERT INTO price_bands (make, model, year_from, year_to, \`condition\`, band_min_kobo, band_max_kobo, sample_size, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE())`,
        [cleanMake, cleanModel, from, to, safeCondition, min, max, Math.max(0, Number(sampleSize) || 0)],
      );
    }

    const [rows] = await conn.query(
      `SELECT * FROM price_bands
        WHERE make = ? AND model = ? AND year_from = ? AND year_to = ? AND \`condition\` = ?
        LIMIT 1`,
      [cleanMake, cleanModel, from, to, safeCondition],
    );
    const saved = rows[0];

    await conn.query('INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)', [
      actorId,
      existing ? 'price_band.updated' : 'price_band.created',
      'price_band',
      saved.id,
      JSON.stringify({
        make: cleanMake,
        model: cleanModel,
        years: `${from}-${to}`,
        condition: safeCondition,
        before: existing ? { minKobo: Number(existing.band_min_kobo), maxKobo: Number(existing.band_max_kobo), sampleSize: Number(existing.sample_size) } : null,
        after: { minKobo: min, maxKobo: max, sampleSize: Math.max(0, Number(sampleSize) || 0) },
      }),
    ]);

    return { ok: true, created: !existing, band: shapeBand(saved) };
  });
}

/**
 * "Still accurate" — the weekly ritual without editing a number. Re-stamping
 * the date is a real claim, so it is audited too.
 */
async function refreshBand(id, { actorId = null } = {}) {
  const existing = await bandById(id);
  if (!existing) return { ok: false, error: 'That band no longer exists.' };
  await query('UPDATE price_bands SET refreshed_at = CURDATE() WHERE id = ?', [existing.id]);
  await query('INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)', [
    actorId,
    'price_band.refreshed',
    'price_band',
    existing.id,
    JSON.stringify({
      make: existing.make,
      model: existing.model,
      years: `${existing.yearFrom}-${existing.yearTo}`,
      condition: existing.condition,
      checkedAgainst: existing.sampleSize,
    }),
  ]);
  return { ok: true, band: await bandById(existing.id) };
}

/**
 * The band for one car — FR-29's lookup.
 *
 * Same matching rule as the VDP indicator (`pickBand` in db/listings.js): exact
 * condition beats `any`, and the row with the most evidence behind it wins a
 * tie. If this ever disagrees with the badge on a listing, the widget and the
 * page would be telling two different stories about the same model.
 */
async function findBand({ make, model, year, condition = 'any' } = {}) {
  if (!make || !model || !year) return null;
  const rows = await query(
    `SELECT * FROM price_bands
      WHERE make = ? AND model = ?
        AND ? BETWEEN year_from AND year_to
        AND (\`condition\` = ? OR \`condition\` = 'any')`,
    [String(make), String(model), Number(year), String(condition)],
  );
  if (!rows.length) return null;
  const best = rows.sort((a, b) => {
    const exact = Number(b.condition === condition) - Number(a.condition === condition);
    if (exact) return exact;
    return Number(b.sample_size) - Number(a.sample_size);
  })[0];
  return shapeBand(best);
}

/**
 * What we *do* hold for a make/model, so "no band for that one" can be followed
 * by "here is the range we cover" instead of a dead end. Returns nulls when the
 * model is unknown to the table entirely.
 */
async function coverageFor({ make, model = null } = {}) {
  if (!make) return null;
  const row = await queryOne(
    `SELECT COUNT(*) AS bands,
            MIN(year_from) AS year_from, MAX(year_to) AS year_to,
            MIN(refreshed_at) AS oldest_refresh, MAX(refreshed_at) AS newest_refresh,
            SUM(sample_size) AS samples
       FROM price_bands
      WHERE make = ? ${model ? 'AND model = ?' : ''}`,
    model ? [String(make), String(model)] : [String(make)],
  );
  if (!row || !Number(row.bands)) return null;
  return {
    make,
    model,
    bands: Number(row.bands),
    yearFrom: Number(row.year_from),
    yearTo: Number(row.year_to),
    samples: Number(row.samples || 0),
    oldestRefresh: row.oldest_refresh,
    newestRefresh: row.newest_refresh,
  };
}

/** Other models of the same make we hold bands for — the suggestion list. */
async function modelsFor({ make, excludeModel = null, limit = 6 } = {}) {
  if (!make) return [];
  const params = [String(make)];
  let sql = 'SELECT model, MIN(year_from) AS year_from, MAX(year_to) AS year_to, SUM(sample_size) AS samples FROM price_bands WHERE make = ?';
  if (excludeModel) {
    sql += ' AND model <> ?';
    params.push(String(excludeModel));
  }
  sql += ' GROUP BY model ORDER BY samples DESC, model ASC LIMIT ?';
  params.push(Math.min(20, Math.max(1, Number(limit) || 6)));
  const rows = await query(sql, params);
  return rows.map((row) => ({
    model: row.model,
    yearFrom: Number(row.year_from),
    yearTo: Number(row.year_to),
    samples: Number(row.samples || 0),
  }));
}

module.exports = {
  CONDITIONS,
  CONDITION_LABELS,
  STALE_DAYS,
  shapeBand,
  bands,
  bandById,
  findBand,
  coverageFor,
  modelsFor,
  gaps,
  coverage,
  upsertBand,
  refreshBand,
};
