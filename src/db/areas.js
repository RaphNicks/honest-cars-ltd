'use strict';

/**
 * Service cities and areas — FR-32 (migration 024).
 *
 * Two jobs, and they are different:
 *
 *   • *Reading* is for the storefront: which cities we cover, which areas are
 *     inside each, and how much stock is in them. A city with no stock is not
 *     hidden — it is shown with "0" rather than implied away, because a buyer
 *     in Owerri should see that we are there and that the shelf is thin.
 *   • *Managing* is for ops: the PRD says "area list admin-managed", so areas
 *     can be added, renamed, retired and reordered without a deploy. Retiring
 *     is `is_active = 0` — the listings that mention an area keep mentioning it.
 *
 * Listing counts come from `v_live_listings`' own rule (live or reserved, not
 * expired), so the switcher can never claim stock the /cars page will not show.
 */

const { query, queryOne } = require('./pool');

const LIVE = "((l.status IN ('live','reserved') AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP())) OR (l.status = 'sold' AND l.sold_at IS NOT NULL AND l.sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)))";

function shapeCity(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    state: row.state,
    blurb: row.blurb || null,
    stockPrefix: row.stock_prefix || 'HC-PH',
    position: Number(row.position || 0),
    active: Boolean(row.is_active),
    cars: row.cars === undefined ? undefined : Number(row.cars || 0),
    live: row.live === undefined ? undefined : Number(row.live || 0),
    areas: row.areas === undefined ? undefined : Number(row.areas || 0),
  };
}

function shapeArea(row) {
  if (!row) return null;
  return {
    id: row.id,
    cityId: row.city_id,
    cityName: row.city_name || null,
    citySlug: row.city_slug || null,
    name: row.name,
    position: Number(row.position || 0),
    active: Boolean(row.is_active),
    cars: row.cars === undefined ? undefined : Number(row.cars || 0),
    stock: row.stock === undefined ? undefined : Number(row.stock || 0),
  };
}

/**
 * Every active city, in the order ops put them, with how much live stock is in
 * each. `defaultSlug` is the city the site was built around (Port Harcourt).
 */
async function cities({ includeInactive = false } = {}) {
  const rows = await query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM vehicle_listings l WHERE l.city = c.name AND ${LIVE}) AS cars,
            (SELECT COUNT(*) FROM vehicle_listings l WHERE l.city = c.name AND l.status = 'live') AS live,
            (SELECT COUNT(*) FROM service_areas a WHERE a.city_id = c.id AND a.is_active = 1) AS areas
       FROM service_cities c
      ${includeInactive ? '' : 'WHERE c.is_active = 1'}
      ORDER BY c.position ASC, c.name ASC`,
  );
  return rows.map(shapeCity);
}

async function cityBySlug(slug) {
  const row = await queryOne('SELECT * FROM service_cities WHERE slug = ? LIMIT 1', [String(slug || '').trim()]);
  return shapeCity(row);
}

async function cityByName(name) {
  const row = await queryOne('SELECT * FROM service_cities WHERE name = ? LIMIT 1', [String(name || '').trim()]);
  return shapeCity(row);
}

/**
 * A city as a URL or a form writes it: `owerri` (the /cars?city= token) or
 * `Port Harcourt` (what a curated facet rule stores). Returns null for
 * anything we do not serve, which is how a hand-typed ?city= dies quietly
 * instead of filtering the grid to nothing.
 */
async function cityByToken(token) {
  const value = String(token || '').trim();
  if (!value || value.length > 80) return null;
  return (await cityBySlug(value.toLowerCase())) || cityByName(value);
}

/** Areas, optionally just one city's — with the stock count for each. */
async function areas({ cityId = null, cityName = null, includeInactive = false } = {}) {
  const where = [];
  const params = [];
  if (cityId) {
    where.push('a.city_id = ?');
    params.push(Number(cityId));
  }
  if (cityName) {
    where.push('c.name = ?');
    params.push(String(cityName));
  }
  if (!includeInactive) where.push('a.is_active = 1');
  const rows = await query(
    `SELECT a.*, c.name AS city_name, c.slug AS city_slug,
            (SELECT COUNT(*) FROM vehicle_listings l WHERE l.area = a.name AND l.city = c.name AND ${LIVE}) AS cars,
            (SELECT COUNT(*) FROM vehicle_listings l WHERE l.area = a.name AND l.city = c.name) AS stock
       FROM service_areas a
       JOIN service_cities c ON c.id = a.city_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.position ASC, a.position ASC, a.name ASC`,
    params,
  );
  return rows.map(shapeArea);
}

/**
 * The filter rail's own shape: cities with their live counts, and areas grouped
 * under them. A city filter narrows the area list to that city, because a rail
 * listing Port Harcourt's fourteen neighbourhoods while the buyer is looking at
 * Aba is noise.
 */
async function facets() {
  const [cityRows, areaRows] = await Promise.all([cities(), areas()]);
  const byCity = new Map(cityRows.map((city) => [city.name, []]));
  for (const area of areaRows) {
    if (!byCity.has(area.cityName)) byCity.set(area.cityName, []);
    byCity.get(area.cityName).push(area);
  }
  return {
    cities: cityRows,
    areas: areaRows,
    areasByCity: Object.fromEntries([...byCity.entries()].map(([name, list]) => [name, list])),
  };
}

/** The option list a form needs — `{ value, label }`, cities then areas. */
async function options() {
  const [cityRows, areaRows] = await Promise.all([cities(), areas()]);
  return {
    cities: cityRows.map((city) => ({ value: city.name, label: `${city.name}, ${city.state}` })),
    areas: areaRows.map((area) => ({ value: area.name, label: `${area.name} — ${area.cityName}` })),
  };
}

/**
 * Every [city, area] pair the site offers, for the import validator and the
 * wizard: a listing may only be filed under an area we actually serve, in the
 * city it belongs to.
 */
async function pairs() {
  const rows = await query(
    `SELECT c.name AS city, a.name AS area FROM service_areas a
       JOIN service_cities c ON c.id = a.city_id
      WHERE a.is_active = 1 AND c.is_active = 1
      ORDER BY c.position, a.position`,
  );
  return rows.map((row) => ({ city: row.city, area: row.area }));
}

async function areaById(id) {
  return shapeArea(await queryOne(
    `SELECT a.*, c.name AS city_name, c.slug AS city_slug FROM service_areas a
       JOIN service_cities c ON c.id = a.city_id WHERE a.id = ? LIMIT 1`,
    [Number(id)],
  ));
}

/**
 * Areas cars are actually filed under that the governed list does not know
 * about — a dealer typed a neighbourhood we have never listed, or an import
 * arrived before ops added it. The console shows these with a one-click “add”
 * rather than hiding the drift.
 */
async function unmanagedAreas() {
  const rows = await query(
    `SELECT l.city, l.area, COUNT(*) AS cars,
            (SELECT COUNT(*) FROM vehicle_listings x
              WHERE x.city = l.city AND x.area = l.area
                AND x.status IN ('live','reserved')) AS live
       FROM vehicle_listings l
      WHERE NOT EXISTS (
              SELECT 1 FROM service_areas a
                JOIN service_cities c ON c.id = a.city_id
               WHERE c.name = l.city AND a.name = l.area)
      GROUP BY l.city, l.area
      ORDER BY cars DESC, l.area ASC`,
  );
  return rows.map((row) => ({
    city: row.city,
    area: row.area,
    cars: Number(row.cars || 0),
    live: Number(row.live || 0),
  }));
}

// ---------------------------------------------------------------------------
// Management (admin/settings)
// ---------------------------------------------------------------------------

async function addArea(cityId, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!clean) return { ok: false, error: 'An area needs a name.' };
  const city = await queryOne('SELECT * FROM service_cities WHERE id = ? LIMIT 1', [Number(cityId)]);
  if (!city) return { ok: false, error: 'Unknown city.' };

  const existing = await queryOne('SELECT * FROM service_areas WHERE city_id = ? AND name = ? LIMIT 1', [city.id, clean]);
  if (existing) {
    if (existing.is_active) return { ok: false, error: `${clean} is already listed under ${city.name}.` };
    // Re-adding a retired area is a correction, not a duplicate: bring it back.
    await query('UPDATE service_areas SET is_active = 1 WHERE id = ?', [existing.id]);
    return { ok: true, restored: true, area: await areaById(existing.id) };
  }

  const next = await queryOne(
    'SELECT COALESCE(MAX(position), 0) + 10 AS position FROM service_areas WHERE city_id = ?',
    [city.id],
  );
  const result = await query(
    'INSERT INTO service_areas (city_id, name, position) VALUES (?, ?, ?)',
    [city.id, clean, Number(next.position || 10)],
  );
  return { ok: true, area: await areaById(result.insertId) };
}

/** Rename, retire, restore or move an area. A rename is not retroactive: the
 *  listings that were filed under the old name keep it, and the desk is told. */
async function updateArea(id, { name = undefined, active = undefined, position = undefined } = {}) {
  const area = await areaById(id);
  if (!area) return { ok: false, error: 'That area does not exist.' };
  const sets = [];
  const params = [];
  if (name !== undefined) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!clean) return { ok: false, error: 'An area needs a name.' };
    sets.push('name = ?');
    params.push(clean);
  }
  if (active !== undefined) {
    sets.push('is_active = ?');
    params.push(active ? 1 : 0);
  }
  if (position !== undefined && Number.isFinite(Number(position))) {
    sets.push('position = ?');
    params.push(Number(position));
  }
  if (!sets.length) return { ok: true, area };

  try {
    await query(`UPDATE service_areas SET ${sets.join(', ')} WHERE id = ?`, [...params, area.id]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return { ok: false, error: `${name} is already listed under ${area.cityName}.` };
    throw error;
  }
  const updated = await areaById(area.id);
  // Say it out loud: a rename leaves existing listings on the old spelling.
  const moved = name !== undefined && name !== area.name
    ? await queryOne('SELECT COUNT(*) AS n FROM vehicle_listings WHERE area = ?', [area.name])
    : null;
  return { ok: true, area: updated, staleListings: moved ? Number(moved.n) : 0, previousName: name !== undefined ? area.name : null };
}

/**
 * Move an area one place up or down inside its own city — the order the
 * storefront filter rail reads. Positions are renumbered 10, 20, 30… so the
 * list stays readable however many times ops reorders it.
 */
async function moveArea(id, direction = 'up') {
  const area = await areaById(id);
  if (!area) return { ok: false, error: 'That area does not exist.' };
  const siblings = await query(
    'SELECT id, position FROM service_areas WHERE city_id = ? ORDER BY position ASC, name ASC',
    [area.cityId],
  );
  const index = siblings.findIndex((row) => Number(row.id) === Number(area.id));
  const target = siblings[index + (direction === 'up' ? -1 : 1)];
  if (index < 0 || !target) return { ok: true, moved: false, area };

  await query('UPDATE service_areas SET position = ? WHERE id = ?', [Number(target.position), area.id]);
  await query('UPDATE service_areas SET position = ? WHERE id = ?', [Number(area.position), target.id]);
  // Renumber so a hundred reorders do not accumulate a hundred positions.
  const ordered = await query(
    'SELECT id FROM service_areas WHERE city_id = ? ORDER BY position ASC, name ASC',
    [area.cityId],
  );
  let position = 10;
  for (const row of ordered) {
    await query('UPDATE service_areas SET position = ? WHERE id = ?', [position, row.id]);
    position += 10;
  }
  return { ok: true, moved: true, area: await areaById(area.id) };
}

// ---------------------------------------------------------------------------
// Markets — opening a city we do not operate in yet
// ---------------------------------------------------------------------------

/** A stock series: `HC-OW`. Eight characters is the column's width. */
const PREFIX = /^[A-Z0-9]{2,4}-[A-Z0-9]{2,4}$/;

/** `Port Harcourt` → `port-harcourt`: the `?city=` token, from a name if needed. */
function slugFrom(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function cityById(id) {
  return shapeCity(await queryOne('SELECT * FROM service_cities WHERE id = ? LIMIT 1', [Number(id)]));
}

/**
 * Open a market — the switch that promotes a city in the national catalogue
 * (`src/lib/nigeria-cities.js`) to a market we operate. It is the one thing a
 * `service_cities` row cannot do by itself from the console.
 *
 * A market is not a name on a list. It owns a stock series, it is what `?city=`
 * resolves to, and it is where areas live — and three refusals follow from that:
 *
 *   • two markets cannot share a stock series. The series is how a stock number
 *     identifies its market (`HC-OW-0142`), so a duplicate makes the number
 *     ambiguous at exactly the moment somebody is quoting it on the phone.
 *   • two markets cannot share a name. `listing-query.buildWhere` filters by the
 *     *name*, so duplicates would pool two cities' stock into one grid and
 *     neither city's count would be true.
 *   • a market that is already open is not opened twice.
 *
 * Re-opening a retired market is a correction rather than a duplicate, exactly
 * as `addArea` treats a retired area: the row comes back with the details just
 * entered.
 */
async function addCity({ slug, name, state, stockPrefix, position = undefined } = {}) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const cleanState = String(state || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const cleanSlug = slugFrom(slug || cleanName);
  const prefix = String(stockPrefix || '').trim().toUpperCase();

  if (!cleanName) return { ok: false, error: 'A market needs a city name.' };
  if (!cleanState) return { ok: false, error: 'A market needs a state.' };
  if (cleanSlug.length < 2) return { ok: false, error: 'A market needs a URL token — letters and dashes.' };
  if (!PREFIX.test(prefix)) {
    return { ok: false, error: 'A stock series reads like HC-OW: two to four capitals, a dash, then two to four more.' };
  }

  const series = await queryOne('SELECT name FROM service_cities WHERE stock_prefix = ? AND slug <> ? LIMIT 1', [prefix, cleanSlug]);
  if (series) return { ok: false, error: `${prefix} is ${series.name}'s stock series already.` };

  const named = await queryOne('SELECT name FROM service_cities WHERE name = ? AND slug <> ? LIMIT 1', [cleanName, cleanSlug]);
  if (named) {
    return { ok: false, error: `${named.name} is already a market — two markets cannot share a city name, because the name is what the grid filters by.` };
  }

  const existing = await queryOne('SELECT * FROM service_cities WHERE slug = ? LIMIT 1', [cleanSlug]);
  if (existing) {
    if (existing.is_active) return { ok: false, error: `${existing.name} is already a market.`, city: shapeCity(existing) };
    await query('UPDATE service_cities SET is_active = 1, name = ?, state = ?, stock_prefix = ? WHERE id = ?', [
      cleanName,
      cleanState,
      prefix,
      existing.id,
    ]);
    return { ok: true, restored: true, city: await cityById(existing.id) };
  }

  const next = position === undefined
    ? await queryOne('SELECT COALESCE(MAX(position), 0) + 10 AS position FROM service_cities')
    : { position };
  const result = await query(
    'INSERT INTO service_cities (slug, name, state, stock_prefix, position) VALUES (?, ?, ?, ?, ?)',
    [cleanSlug, cleanName, cleanState, prefix, Number(next.position || 10)],
  );
  return { ok: true, city: await cityById(result.insertId) };
}

/**
 * Retire or re-open a market, or change the details that are safe to change.
 *
 * **Not the name, and that is a decision rather than an omission.** Listings
 * carry the city's *name* — it is the column `buildWhere` filters by — so
 * renaming a market here would leave every car in it filed under a city that no
 * longer exists: a silent data loss dressed up as a convenience. A market
 * changes its name when its lots do, and until there is a screen that re-files
 * stock, offering the box would be the lie. (Same rule as PT-29 for areas, one
 * level up.)
 *
 * **Retiring refuses while stock is live.** A retired market leaves the picker,
 * so closing one with cars in it would either answer "we are not there yet" over
 * a grid of forty cars, or drop the filter and show the rest of the country as
 * if the buyer had not asked. Sell, move or expire them first; then it closes
 * cleanly.
 */
async function updateCity(id, { active = undefined, stockPrefix = undefined } = {}) {
  const city = await cityById(id);
  if (!city) return { ok: false, error: 'That market does not exist.' };

  if (active === false) {
    const row = await queryOne(
      `SELECT COUNT(*) AS n FROM vehicle_listings
        WHERE city = ? AND status IN ('live','reserved')
          AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())`,
      [city.name],
    );
    const live = Number(row?.n || 0);
    if (live) {
      return {
        ok: false,
        error: `${city.name} still has ${live} live car${live === 1 ? '' : 's'} — sell, move or expire them before closing the market.`,
      };
    }
  }

  const sets = [];
  const params = [];
  if (active !== undefined) {
    sets.push('is_active = ?');
    params.push(active ? 1 : 0);
  }
  if (stockPrefix !== undefined) {
    const prefix = String(stockPrefix).trim().toUpperCase();
    if (!PREFIX.test(prefix)) {
      return { ok: false, error: 'A stock series reads like HC-OW: two to four capitals, a dash, then two to four more.' };
    }
    const series = await queryOne('SELECT name FROM service_cities WHERE stock_prefix = ? AND id <> ? LIMIT 1', [prefix, city.id]);
    if (series) return { ok: false, error: `${prefix} is ${series.name}'s stock series already.` };
    sets.push('stock_prefix = ?');
    params.push(prefix);
  }
  if (!sets.length) return { ok: true, changed: false, city };

  await query(`UPDATE service_cities SET ${sets.join(', ')} WHERE id = ?`, [...params, city.id]);
  return { ok: true, changed: true, city: await cityById(city.id), previous: city };
}

module.exports = {
  LIVE,
  cities,
  cityById,
  cityBySlug,
  cityByName,
  cityByToken,
  areas,
  areaById,
  facets,
  options,
  pairs,
  unmanagedAreas,
  addArea,
  updateArea,
  moveArea,
  addCity,
  updateCity,
  slugFrom,
};
