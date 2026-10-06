'use strict';

/**
 * The bridge between shareable URLs and repository filters.
 *
 * §6.2: "URL reflects filters (shareable links)".
 * §14.1: "raw filter combinations stay noindex to avoid thin-page bloat" —
 *        isRawFilterCombo() is what enforces that, together with the curated
 *        facet registry.
 */

const PER_PAGE = 24;

/** URL name → repository filter name. */
const PARAM_MAP = {
  make: 'make',
  model: 'model',
  body: 'body_type',
  fuel: 'fuel_type',
  transmission: 'transmission',
  condition: 'condition',
  grade: 'grade',
  city: 'city',
  area: 'area',
  colour: 'colour',
  year_min: 'year_min',
  year_max: 'year_max',
  mileage_max: 'mileage_max',
  customs: 'customs_verified',
  q: 'q',
};

/** URL sort token → repository sort key. Hyphenated forms stay supported. */
const SORT_MAP = {
  recommended: 'recommended',
  price_asc: 'price_asc',
  price_desc: 'price_desc',
  newest: 'newest',
  mileage_asc: 'mileage_asc',
  'price-asc': 'price_asc',
  'price-desc': 'price_desc',
  'mileage-asc': 'mileage_asc',
};

const SORT_TO_TOKEN = Object.fromEntries(Object.entries(SORT_MAP).map(([token, key]) => [key, token]));

const FILTER_PARAMS = [...Object.keys(PARAM_MAP), 'min', 'max'];

/** A city token: `owerri`, `benin-city`, or the name as ops spells it. */
const CITY_TOKEN = /^[A-Za-z][A-Za-z0-9 .'\-]{1,59}$/;

/** Params that must be plain integers; anything else is dropped in parsing. */
const NUMERIC_PARAMS = new Set(['year_min', 'year_max', 'mileage_max']);

/**
 * Naira inputs land here as integers; the DB stores kobo (§10.2).
 * Strict on purpose: "abc", "-5" and "1e9" are rejected rather than coerced,
 * so a malformed query string can never quietly become a different filter.
 */
function nairaToKobo(value) {
  if (value === undefined || value === null) return undefined;
  const cleaned = String(value).trim().replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 100);
}

function first(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Parse an Express query object into { filters, view, sort, page }.
 * Unknown params are ignored rather than passed through (SQL injection in the
 * filter builder is impossible — buildWhere validates against enums).
 */
function parseListingQuery(query = {}) {
  const filters = {};
  const view = {};

  const min = nairaToKobo(first(query.min));
  const max = nairaToKobo(first(query.max));
  if (min) {
    filters.price_min_kobo = min;
    view.min = String(Math.round(min / 100));
  }
  if (max) {
    filters.price_max_kobo = max;
    view.max = String(Math.round(max / 100));
  }

  for (const [param, column] of Object.entries(PARAM_MAP)) {
    const raw = first(query[param]);
    if (raw === undefined || raw === null || raw === '') continue;
    const value = String(raw).trim().slice(0, 80);
    if (!value) continue;
    // Two gates: the parser drops malformed values, and buildWhere validates
    // enums again before anything reaches SQL.
    if (NUMERIC_PARAMS.has(param) && !/^\d{1,7}$/.test(value)) continue;
    // §6.2 city URLs are slugs; a facet rule may name the city directly. Either
    // way it has to look like a place, and the repository resolves it against
    // service_cities before it is ever used as a filter.
    if (param === 'city' && !CITY_TOKEN.test(value)) continue;
    filters[column] = param === 'customs' ? '1' : value;
    view[param] = value;
  }

  const sort = SORT_MAP[String(first(query.sort) || '').trim()] || 'recommended';
  const page = Math.max(1, Number.parseInt(first(query.page), 10) || 1);

  return { filters, view, sort, page };
}

/** Rebuild a querystring from the view object (+ sort/page), dropping defaults. */
function buildQueryString(view = {}, { sort = 'recommended', page = 1, includeSort = true } = {}) {
  const params = new URLSearchParams();
  const ordered = ['q', 'city', 'make', 'model', 'body', 'fuel', 'transmission', 'condition', 'grade', 'area', 'colour', 'min', 'max', 'year_min', 'year_max', 'mileage_max', 'customs'];
  for (const key of ordered) {
    const value = view[key];
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  if (includeSort && sort && sort !== 'recommended') params.set('sort', sort);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * True when the URL carries filters a crawler should not index as its own
 * page (§14.1). A curated facet's own filters are applied server-side, not via
 * the querystring, so facet pages stay clean and indexable.
 */
function isRawFilterCombo(view = {}) {
  return FILTER_PARAMS.some((key) => view[key] !== undefined && view[key] !== '');
}

/** Human labels for the active-filter pills. */
function activeFilterPills(view = {}, helpers) {
  const pills = [];
  const add = (key, label, value) => pills.push({ key, label, value, remove: { ...view, [key]: undefined } });

  if (view.q) add('q', 'Search', view.q);
  if (view.make) add('make', 'Make', view.make);
  if (view.model) add('model', 'Model', view.model);
  if (view.body) add('body', 'Body', helpers.BODY_TYPE_LABELS[view.body] || view.body);
  if (view.condition) add('condition', 'Condition', helpers.CONDITION_LABELS[view.condition] || view.condition);
  if (view.transmission) add('transmission', 'Transmission', helpers.TRANSMISSION_LABELS[view.transmission] || view.transmission);
  if (view.fuel) add('fuel', 'Fuel', helpers.FUEL_LABELS[view.fuel] || view.fuel);
  // `view.city` is the URL token (a slug); the label is filled in by the route
  // once the city has been resolved against service_cities.
  if (view.city) add('city', 'City', view.city);
  if (view.area) add('area', 'Area', view.area);
  if (view.grade) add('grade', 'Grade', 'Certified only');
  if (view.customs) add('customs', 'Documents', 'Customs verified');
  if (view.min) add('min', 'From', helpers.formatNaira(Number(view.min) * 100));
  if (view.max) add('max', 'Up to', helpers.formatNaira(Number(view.max) * 100));
  if (view.year_min) add('year_min', 'From year', view.year_min);
  if (view.year_max) add('year_max', 'To year', view.year_max);
  if (view.mileage_max) add('mileage_max', 'Max mileage', helpers.formatMileage(Number(view.mileage_max)));

  return pills.map((pill) => ({
    ...pill,
    href: `/cars${buildQueryString(pill.remove)}`,
  }));
}

module.exports = {
  PER_PAGE,
  PARAM_MAP,
  SORT_MAP,
  SORT_TO_TOKEN,
  FILTER_PARAMS,
  parseListingQuery,
  buildQueryString,
  isRawFilterCombo,
  activeFilterPills,
  nairaToKobo,
};
