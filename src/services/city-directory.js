'use strict';

/**
 * The city picker's list — every city in the catalogue, in the order a buyer
 * wants to read it: how much stock is there.
 *
 * Two sources, one list:
 *
 *   • `service_cities` — the markets we operate. Authoritative when a city is
 *     in it, because ops own the name, the state and the stock prefix, and a
 *     rename at /admin/settings must show up here.
 *   • `src/lib/nigeria-cities.js` — the national catalogue, so a buyer in
 *     Ibadan can find Ibadan even though we have no lot there.
 *
 * A city the database knows but the catalogue does not is still listed: ops
 * adding a market must never make it disappear from the picker.
 *
 * Ordering is the point of this file. Default sort is **live stock, descending**
 * — Port Harcourt first because that is where the cars are, the rest of the
 * country behind it, and ties broken by name so the list is stable rather than
 * whatever order MySQL happened to return. Ops' `position` still orders the
 * filter rail (see `db.areas.cities`); this is the picker's own order, and it
 * is the order the search filters down within.
 */

const db = require('../db');
const { CITIES, stateLabel, findCity } = require('../lib/nigeria-cities');

/**
 * Live stock per city name, for every city — not just the markets. One query
 * rather than a count per city: the picker shows forty-eight of them.
 */
async function stockByCity() {
  const rows = await db.query(
    `SELECT l.city AS name, COUNT(*) AS cars
       FROM vehicle_listings l
      WHERE l.status IN ('live','reserved') AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP())
      GROUP BY l.city`,
  );
  return new Map(rows.map((row) => [String(row.name), Number(row.cars || 0)]));
}

/** The list, sorted by depth of stock. */
async function directory() {
  const [markets, stock] = await Promise.all([db.areas.cities(), stockByCity()]);
  const bySlug = new Map(markets.map((market) => [market.slug, market]));

  const rows = CITIES.map((city) => {
    const market = bySlug.get(city.slug);
    if (market) bySlug.delete(city.slug);
    return {
      slug: city.slug,
      name: market ? market.name : city.name,
      state: market ? market.state : city.state,
      prefix: market ? market.stockPrefix : city.prefix,
      // A market is a city we operate in; the catalogue is everywhere else.
      served: Boolean(market),
      live: stock.get(market ? market.name : city.name) || 0,
      areas: market ? market.areas : 0,
      position: market ? market.position : 1000,
    };
  });

  // Anything the database knows that the catalogue does not (ops added a
  // market; a migration renamed one) still belongs in the list.
  for (const market of bySlug.values()) {
    rows.push({
      slug: market.slug,
      name: market.name,
      state: market.state,
      prefix: market.stockPrefix,
      served: true,
      live: stock.get(market.name) || 0,
      areas: market.areas,
      position: market.position,
    });
  }

  rows.sort((a, b) => {
    if (b.live !== a.live) return b.live - a.live;
    if (a.position !== b.position) return a.position - b.position;
    return a.name.localeCompare(b.name);
  });

  return rows.map((row) => ({ ...row, stateLabel: stateLabel(row) }));
}

/**
 * Resolve a `?city=` token to a city — a market first, then the catalogue. A
 * catalogue city resolves too: `/cars?city=lagos` must filter to Lagos and say
 * plainly that the shelf is empty, rather than ignoring the request and showing
 * the whole network as if the buyer had not asked.
 */
async function resolve(token) {
  const market = await db.areas.cityByToken(token);
  if (market) {
    // The count matters to the caller: a market whose stock has all sold is
    // "we are not there yet" in copy as well as in the grid, and it must read
    // that way from the same number the picker shows.
    const stock = await stockByCity();
    return { ...market, served: true, live: stock.get(market.name) || 0, stateLabel: stateLabel(market) };
  }
  const catalogued = findCity(token);
  return catalogued ? { ...catalogued, served: false, live: 0, stateLabel: stateLabel(catalogued) } : null;
}

module.exports = { directory, resolve, stockByCity, stateLabel };
