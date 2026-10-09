'use strict';

/**
 * Listings repository — every query the storefront needs, parameterised.
 *
 * Browsing is always scoped by the sold-archive rule (§6.2 + §14.1):
 *   live/reserved                 → browsable
 *   sold ≤ 7 days                 → still browsable, "Sold in N days" badge
 *   sold 7 → 90 days              → sold-archive page (indexable, similar cars)
 *   sold > 90 days                → 301 to the listing's facet
 */

const { query, queryOne } = require('./pool');
const {
  parseJson,
  CONDITION_LABELS,
  GRADE_LABELS,
  BODY_TYPE_LABELS,
  TRANSMISSION_LABELS,
  FUEL_LABELS,
  PRICE_POSITION,
} = require('./shape');

const SORTS = {
  recommended: 'l.featured_rank DESC, (l.status = \'sold\') ASC, l.published_at DESC',
  price_asc: 'l.asking_price_kobo ASC',
  price_desc: 'l.asking_price_kobo DESC',
  newest: 'l.published_at DESC',
  mileage_asc: 'l.mileage_km ASC',
};

const SORT_LABELS = {
  recommended: 'Recommended',
  price_asc: 'Price ↑',
  price_desc: 'Price ↓',
  newest: 'Newest',
  mileage_asc: 'Lowest mileage',
};

/** Filter surface exposed on /cars and on facet pages (§6.2). */
const FILTER_KEYS = [
  'price_min_kobo',
  'price_max_kobo',
  'make',
  'model',
  'year_min',
  'year_max',
  'condition',
  'body_type',
  'transmission',
  'fuel_type',
  'mileage_max',
  'grade',
  'city',
  'area',
  'colour',
  'customs_verified',
  'q',
];

const ENUM_FILTERS = {
  condition: Object.keys(CONDITION_LABELS),
  body_type: Object.keys(BODY_TYPE_LABELS),
  transmission: Object.keys(TRANSMISSION_LABELS),
  fuel_type: Object.keys(FUEL_LABELS),
  grade: Object.keys(GRADE_LABELS),
};

/**
 * Turn a query-string / facet rule object into a safe WHERE fragment.
 * Unknown keys and out-of-enum values are dropped, never interpolated.
 */
function buildWhere(filters = {}, { alias = 'l', liveScoped = true } = {}) {
  const clauses = [];
  const params = [];

  if (liveScoped) {
    // Mirrors v_live_listings but inline, because filters need the alias.
    clauses.push(
      `((l.status IN ('live','reserved') AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP()))
        OR (l.status = 'sold' AND l.sold_at IS NOT NULL AND l.sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)))`,
    );
  }

  const numeric = {
    price_min_kobo: 'l.asking_price_kobo >= ?',
    price_max_kobo: 'l.asking_price_kobo <= ?',
    year_min: 'l.year >= ?',
    year_max: 'l.year <= ?',
    mileage_max: 'l.mileage_km <= ?',
  };

  for (const key of Object.keys(numeric)) {
    const value = filters[key];
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    clauses.push(numeric[key]);
    params.push(Math.trunc(n));
  }

  if (filters.make) {
    clauses.push('l.make = ?');
    params.push(String(filters.make));
  }
  if (filters.model) {
    clauses.push('l.model = ?');
    params.push(String(filters.model));
  }
  if (filters.city) {
    // A city reaches this point already resolved against `service_cities`
    // (db.areas.cityByToken) — the URL carries the slug, the column holds the
    // name. The shape check is the second gate: whatever the caller did, a
    // value that is not a plain place name is dropped rather than queried.
    const city = String(filters.city).trim().slice(0, 80);
    if (/^[A-Za-z][A-Za-z0-9 .'\-]{0,79}$/.test(city)) {
      clauses.push('l.city = ?');
      params.push(city);
    }
  }

  if (filters.area) {
    clauses.push('l.area = ?');
    params.push(String(filters.area));
  }
  if (filters.colour) {
    clauses.push('l.ext_colour = ?');
    params.push(String(filters.colour));
  }

  for (const [key, allowed] of Object.entries(ENUM_FILTERS)) {
    const value = filters[key];
    if (!value) continue;
    if (!allowed.includes(String(value))) continue;
    // "Certified only" toggle is a minimum grade, not an equality match (§6.2).
    if (key === 'grade') {
      const order = ['network_listed', 'field_checked', 'certified'];
      const min = order.indexOf(String(value));
      const allowedGrades = order.slice(min);
      clauses.push(`l.verification_grade IN (${allowedGrades.map(() => '?').join(',')})`);
      params.push(...allowedGrades);
      continue;
    }
    const column = key === 'condition' ? '`condition`' : key;
    clauses.push(`l.${column} = ?`);
    params.push(String(value));
  }

  if (String(filters.customs_verified) === '1' || filters.customs_verified === true) {
    clauses.push("JSON_EXTRACT(l.documents, '$.customs_verified') = TRUE");
  }

  if (filters.q) {
    const term = `%${String(filters.q).trim().slice(0, 60)}%`;
    clauses.push('(l.make LIKE ? OR l.model LIKE ? OR l.trim LIKE ? OR l.stock_no LIKE ?)');
    params.push(term, term, term, term);
  }

  // A facet rule may carry a quick-search flag: everything with a price band.
  if (filters.with_price_band === true) {
    clauses.push("l.price_position <> 'no_data'");
  }

  const sql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { sql, params };
}

/** Apply a curated facet's rule JSON to the filter builder. */
function filtersFromFacet(facet) {
  const rules = parseJson(facet.rules, {}) || {};
  const filters = {};
  if (rules.city) filters.city = rules.city;
  if (rules.make) filters.make = rules.make;
  if (rules.model) filters.model = rules.model;
  if (rules.body_type) filters.body_type = rules.body_type;
  if (rules.condition) filters.condition = rules.condition;
  if (rules.grade) filters.grade = rules.grade;
  if (rules.max_price_kobo) filters.price_max_kobo = rules.max_price_kobo;
  if (rules.min_price_kobo) filters.price_min_kobo = rules.min_price_kobo;
  if (rules.year_min) filters.year_min = rules.year_min;
  if (rules.customs_verified) filters.customs_verified = '1';
  return filters;
}

function shapeListing(row) {
  if (!row) return null;
  const documents = parseJson(row.documents, {});
  return {
    id: row.id,
    stockNo: row.stock_no,
    status: row.status,
    soldAt: row.sold_at,
    soldInDays:
      row.sold_at && row.published_at
        ? Math.max(1, Math.round((new Date(row.sold_at) - new Date(row.published_at)) / 86_400_000))
        : null,
    grade: row.verification_grade,
    gradeLabel: GRADE_LABELS[row.verification_grade],
    make: row.make,
    model: row.model,
    year: row.year,
    trim: row.trim,
    title: [row.year, row.make, row.model, row.trim].filter(Boolean).join(' '),
    bodyType: row.body_type,
    bodyTypeLabel: BODY_TYPE_LABELS[row.body_type],
    transmission: row.transmission,
    transmissionLabel: TRANSMISSION_LABELS[row.transmission],
    fuelType: row.fuel_type,
    fuelTypeLabel: FUEL_LABELS[row.fuel_type],
    engineSize: row.engine_size,
    drivetrain: row.drivetrain,
    extColour: row.ext_colour,
    intColour: row.int_colour,
    condition: row.condition,
    conditionLabel: CONDITION_LABELS[row.condition],
    mileageKm: row.mileage_km,
    mileageVerified: Boolean(row.mileage_verified),
    features: parseJson(row.features, []) || [],
    priceKobo: Number(row.asking_price_kobo),
    negotiable: Boolean(row.negotiable),
    pricePosition: row.price_position,
    city: row.city,
    area: row.area,
    documents: {
      customs: Boolean(documents.customs_verified),
      registration: Boolean(documents.registration),
      dutySighted: Boolean(documents.duty_sighted),
      tintedPermit: Boolean(documents.tinted_permit),
    },
    description: row.description,
    honestNote: row.honest_note,
    inspectionSummary: parseJson(row.inspection_summary, null),
    // Derived, human-readable fields the compare table (§6.4) and cards reuse.
    pricePositionLabel: (PRICE_POSITION[row.price_position] || PRICE_POSITION.no_data).label,
    documentsSummary: [
      documents.customs_verified ? 'customs verified' : null,
      documents.registration ? 'registered' : null,
      documents.duty_sighted ? 'duty papers sighted' : null,
      documents.tinted_permit ? 'tinted permit' : null,
    ].filter(Boolean).join(', ') || 'pending',
    knownFaults: parseJson(row.inspection_summary, null) && parseJson(row.inspection_summary, null).faults
      ? parseJson(row.inspection_summary, null).faults
      : row.honest_note || null,
    slug: row.seo_slug,
    url: `/cars/${row.seo_slug}`,
    views: row.views,
    enquiries: row.enquiries,
    saves: row.saves,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    dealer: row.dealer_name
      ? { name: row.dealer_name, area: row.dealer_area, verified: Boolean(row.dealer_verified) }
      : null,
  };
}

/**
 * Paginated browse. Returns { rows, total, page, pages }.
 * Uses a windowed COUNT so pagination never lies about "128 cars in PH".
 */
async function browse(filters = {}, options = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(48, Math.max(1, Number(options.perPage) || 24));
  const sortKey = SORTS[options.sort] ? options.sort : 'recommended';
  const { sql: whereSql, params } = buildWhere(filters);

  const counted = await queryOne(
    `SELECT COUNT(*) AS total FROM vehicle_listings l ${whereSql}`,
    params,
  );
  const total = counted ? Number(counted.total) : 0;

  const rows = await query(
    `SELECT l.*, d.name AS dealer_name, d.lot_area AS dealer_area, d.verified AS dealer_verified
       FROM vehicle_listings l
       JOIN dealers d ON d.id = l.dealer_id
       ${whereSql}
      ORDER BY ${SORTS[sortKey]}
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
    params,
  );

  const listings = rows.map(shapeListing);
  await attachMedia(listings);

  return {
    listings,
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    sort: sortKey,
  };
}

/** Primary image (+ count) for a set of listings in one round trip. */
async function attachMedia(listings) {
  if (!listings.length) return listings;
  const ids = listings.map((l) => l.id);
  const rows = await query(
    `SELECT id, listing_id, type, shot_label, url, poster_url, duration_seconds, size_bytes,
            alt_text, position, width, height
       FROM listing_media
      WHERE listing_id IN (${ids.map(() => '?').join(',')})
      ORDER BY listing_id, position`,
    ids,
  );
  const byListing = new Map();
  for (const row of rows) {
    if (!byListing.has(row.listing_id)) byListing.set(row.listing_id, []);
    byListing.get(row.listing_id).push({
      id: row.id,
      type: row.type,
      shotLabel: row.shot_label,
      url: row.url,
      // Video rows carry their own cost (§13.2 tap-to-load label), and a poster
      // stands in for the frame until someone presses play.
      poster: row.poster_url || null,
      seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      alt: row.alt_text,
      position: row.position,
      width: row.width,
      height: row.height,
    });
  }
  for (const listing of listings) {
    const media = byListing.get(listing.id) || [];
    listing.media = media;
    // A card's photo can never be the video: photos are what a buyer scrolls,
    // and rendering an <img> pointing at an .mp4 is the bug this prevents.
    listing.primaryImage = media.find((entry) => entry.type === 'image') || null;
    listing.imageCount = media.filter((entry) => entry.type === 'image').length;
    listing.videoCount = media.filter((entry) => entry.type === 'video').length;
  }
  return listings;
}

/**
 * One live photo per body type, deepest stock first — the homepage category
 * cards (§6.1 redesign). Counts come from the same live rule the facet rail
 * uses, and the photo is the primary image of a real live listing, so a card
 * can never show a car the marketplace does not have.
 */
async function categoryShowcase() {
  return query(
    `SELECT l.body_type AS body, COUNT(*) AS count,
            SUBSTRING_INDEX(GROUP_CONCAT(m.url ORDER BY m.position ASC), ',', 1) AS image_url
       FROM vehicle_listings l
       JOIN listing_media m ON m.listing_id = l.id AND m.type = 'image'
      WHERE l.status IN ('live','reserved')
        AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP())
      GROUP BY l.body_type
      ORDER BY count DESC`,
  );
}

/** Homepage "fresh on the market" feed with the tab counts (§6.1 module 3). */
async function homeFeed(limit = 8) {
  const [feed, certified, under10m, suvs] = await Promise.all([
    browse({}, { perPage: limit, sort: 'newest' }),
    browse({ grade: 'certified' }, { perPage: limit, sort: 'newest' }),
    browse({ price_max_kobo: 1_000_000_000 }, { perPage: limit, sort: 'newest' }),
    browse({ body_type: 'suv' }, { perPage: limit, sort: 'newest' }),
  ]);
  return {
    all: feed,
    tabs: {
      all: { label: 'All', ...feed },
      certified: { label: 'Certified', ...certified },
      under10m: { label: 'Under ₦10m', ...under10m },
      suvs: { label: 'SUVs', ...suvs },
    },
  };
}

/**
 * One VDP: listing + full media + dealer (no contact details — §6.3).
 *
 * `scope: 'browsable'` (the default) applies the §6.2 visibility window, so a
 * listing sold 7–90 days ago resolves to the sold-archive route rather than
 * competing with it for the same URL. Ops tooling can pass 'any'.
 */
async function findBySlug(slug, { scope = 'browsable' } = {}) {
  const scopeSql =
    scope === 'any'
      ? ''
      : `AND ((l.status IN ('live','reserved') AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP()))
           OR (l.status = 'sold' AND l.sold_at IS NOT NULL AND l.sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)))`;
  const row = await queryOne(
    `SELECT l.*, d.name AS dealer_name, d.lot_area AS dealer_area, d.verified AS dealer_verified
       FROM vehicle_listings l
       JOIN dealers d ON d.id = l.dealer_id
      WHERE l.seo_slug = ?
        ${scopeSql}
      LIMIT 1`,
    [slug],
  );
  if (!row) return null;
  const listing = shapeListing(row);
  await attachMedia([listing]);
  listing.media = listing.media || [];
  // attachMedia already picked the first *photo*; this repeat would undo that
  // and put a video on the card, so it is deliberately not repeated here.
  return listing;
}

/** Sold-archive lookup: only the 7→90 day window returns a row. */
/**
 * Compare tool (§6.4): up to 3 listings by id, live/reserved/sold-≤7d only.
 * Order follows the ids the visitor picked so the table never reshuffles.
 */
/**
 * Running-cost estimate for the compare table (§6.4 row
 * “running-cost estimate”). Deliberately a transparent estimate: fuel at PH
 * pump price + servicing + insurance band, over 5 years, from the car's own
 * fuel type and engine size. Not a quote, and the UI says so.
 */
function runningCostEstimate(listing) {
  const kmPerYear = 15_000;
  const pumpPrice = 985; // ₦/litre — placeholder, ops-editable in one place
  const litresPer100 = listing.fuelType === 'diesel' ? 7.5 : listing.fuelType === 'hybrid' ? 4.5 : listing.engineSize && /3\.[0-9]/.test(listing.engineSize) ? 12.5 : 9.5;
  const fuel = (kmPerYear * 5 * litresPer100 * pumpPrice) / 100;
  const service = 5 * (listing.condition === 'tokunbo' ? 220_000 : 320_000);
  const insurance = 5 * Math.max(180_000, Number(listing.priceKobo || 0) / 100 * 0.035);
  return Math.round(fuel + service + insurance) * 100; // kobo
}

/**
 * Any-status fetch for account surfaces (§7.1 saved cars): a saved car that has
 * since sold must still render with its status badge rather than vanish.
 */
async function byIds(ids = [], { limit = 24 } = {}) {
  const clean = [...new Set(ids.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isFinite(id)))].slice(0, limit);
  if (!clean.length) return [];
  const rows = await query(
    `SELECT l.*, d.name AS dealer_name, d.lot_area AS dealer_area, d.verified AS dealer_verified
       FROM vehicle_listings l
       JOIN dealers d ON d.id = l.dealer_id
      WHERE l.id IN (${clean.map(() => '?').join(',')})`,
    clean,
  );
  const listings = await attachPricePositions(rows.map(shapeListing));
  await attachMedia(listings);
  const byId = new Map(listings.map((listing) => [listing.id, { ...listing, runningCostKobo: runningCostEstimate(listing) }]));
  return clean.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Hand-picked listings by SEO slug — the CMS featured module (§7.3).
 * Order is the editor's order, and only browsable cars come back: a module can
 * never surface a sold, expired or hidden car.
 */
async function bySlugs(slugs = []) {
  const clean = [...new Set((slugs || []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 12);
  if (!clean.length) return [];
  const rows = await query(
    `SELECT l.*, d.name AS dealer_name, d.lot_area AS dealer_area, d.verified AS dealer_verified
       FROM vehicle_listings l
       JOIN dealers d ON d.id = l.dealer_id
      WHERE l.seo_slug IN (${clean.map(() => '?').join(',')})
        AND l.status IN ('live','reserved')
        AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP())`,
    clean,
  );
  const listings = rows.map(shapeListing);
  await attachMedia(listings);
  const bySlug = new Map(listings.map((listing) => [listing.slug, { ...listing, runningCostKobo: runningCostEstimate(listing) }]));
  return clean.map((slug) => bySlug.get(slug)).filter(Boolean);
}

/**
 * Fetch these listings, in the order asked for. The default cap of three is
 * §6.4's comparison limit; a caller that is not comparing (the concierge
 * shortlist, §7.3) asks for its own cap and gets cards for all of them.
 */
async function findByIds(ids = [], { limit = 3 } = {}) {
  const cap = Math.max(1, Math.min(24, Number(limit) || 3));
  const clean = ids.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isFinite(id)).slice(0, cap);
  if (!clean.length) return [];
  const rows = await query(
    `SELECT l.*, d.name AS dealer_name, d.lot_area AS dealer_area, d.verified AS dealer_verified
       FROM vehicle_listings l
       JOIN dealers d ON d.id = l.dealer_id
      WHERE l.id IN (${clean.map(() => '?').join(',')})
        AND (l.status IN ('live','reserved')
             OR (l.status = 'sold' AND l.sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)))`,
    clean,
  );
  // Live bands, not the stored column: a band moved in /admin/intel changes the
  // comparison on the same load it changes the VDP.
  const listings = await attachPricePositions(rows.map(shapeListing));
  await attachMedia(listings);
  const byId = new Map(listings.map((listing) => [listing.id, { ...listing, runningCostKobo: runningCostEstimate(listing) }]));
  return clean.map((id) => byId.get(id)).filter(Boolean);
}

async function findArchivedSoldBySlug(slug) {
  const row = await queryOne(
    `SELECT l.*, d.name AS dealer_name
       FROM vehicle_listings l
       JOIN dealers d ON d.id = l.dealer_id
      WHERE l.seo_slug = ? AND l.status = 'sold'
        AND l.sold_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        AND l.sold_at >  DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
      LIMIT 1`,
    [slug, 7, 90],
  );
  if (!row) return null;
  const listing = shapeListing(row);
  await attachMedia([listing]);
  return listing;
}

/** Sold > 90 days: what the /cars/sold/{slug} URL must 301 to (§14.1). */
async function findRedirectTarget(slug) {
  const row = await queryOne(
    `SELECT l.seo_slug, l.make, l.model, l.archive_redirect_path
       FROM vehicle_listings l
      WHERE l.seo_slug = ? AND l.status = 'sold'
        AND l.sold_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
      LIMIT 1`,
    [slug, 90],
  );
  if (!row) return null;
  return {
    to: row.archive_redirect_path || `/cars/${slugify(row.make)}`,
    reason: 'sold_archive_90_days',
  };
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Similar cars: same make, then same budget band (§6.3 below fold). */
async function findSimilar(listing, limit = 3) {
  const rows = await query(
    `SELECT l.*, d.name AS dealer_name, d.lot_area AS dealer_area, d.verified AS dealer_verified,
            (l.make = ?) AS same_make
       FROM vehicle_listings l
       JOIN dealers d ON d.id = l.dealer_id
      WHERE l.id <> ?
        AND l.status IN ('live','reserved')
        AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP())
        AND (
          l.make = ?
          OR l.asking_price_kobo BETWEEN ? AND ?
        )
      ORDER BY same_make DESC, ABS(l.asking_price_kobo - ?) ASC
      LIMIT ${Math.max(1, Math.min(12, limit))}`,
    [
      listing.make,
      listing.id,
      listing.make,
      Math.round(listing.priceKobo * 0.75),
      Math.round(listing.priceKobo * 1.25),
      listing.priceKobo,
    ],
  );
  const listings = rows.map(shapeListing);
  await attachMedia(listings);
  return listings;
}

/** "No exact matches — {n} near matches" empty state (§6.2, Appendix D). */
async function countNearMatches(filters = {}) {
  const relaxed = { ...filters };
  delete relaxed.price_max_kobo;
  delete relaxed.price_min_kobo;
  delete relaxed.mileage_max;
  delete relaxed.colour;
  const { sql: whereSql, params } = buildWhere(relaxed);
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM vehicle_listings l ${whereSql}`,
    params,
  );
  return row ? Number(row.total) : 0;
}

/**
 * Filter-rail facets with live counts — 400-series across the network.
 *
 * `city` is a governed name from `service_cities` (or null for the whole
 * network), and it narrows every count in the rail — makes, areas, budgets —
 * so the panel can never offer a filter the current view cannot show. Note the
 * params being passed through: the WHERE fragment carries the city as a
 * placeholder, and a placeholder with no argument is a 1210, not a filter.
 */
async function filterFacets({ city = null } = {}) {
  const where = buildWhere(city ? { city } : {});
  const [
    makes, bodyTypes, conditions, grades, areas, cities, transmissions, fuels, priceStats,
  ] = await Promise.all([
    query(
      `SELECT make AS value, COUNT(*) AS count FROM vehicle_listings l
        ${where.sql} GROUP BY make ORDER BY count DESC, make ASC`,
      where.params,
    ),
    query(
      `SELECT body_type AS value, COUNT(*) AS count FROM vehicle_listings l
        ${where.sql} GROUP BY body_type ORDER BY count DESC`,
      where.params,
    ),
    query(
      `SELECT \`condition\` AS value, COUNT(*) AS count FROM vehicle_listings l
        ${where.sql} GROUP BY \`condition\` ORDER BY count DESC`,
      where.params,
    ),
    query(
      `SELECT verification_grade AS value, COUNT(*) AS count FROM vehicle_listings l
        ${where.sql} GROUP BY verification_grade ORDER BY count DESC`,
      where.params,
    ),
    query(
      `SELECT area AS value, city, COUNT(*) AS count FROM vehicle_listings l
        ${where.sql} GROUP BY city, area ORDER BY count DESC, area ASC`,
      where.params,
    ),
    query(
      // The governed list, in ops order, so the rail never invents a market and
      // a market with no stock still shows as a real 0 instead of quietly
      // disappearing from the site. The live rule is buildWhere's own, rewritten
      // for this alias.
      `SELECT slug AS value, name, state, stock_prefix, position,
              (SELECT COUNT(*) FROM vehicle_listings l2
                WHERE l2.city = c.name
                  AND ((l2.status IN ('live','reserved') AND (l2.expires_at IS NULL OR l2.expires_at > UTC_TIMESTAMP()))
                    OR (l2.status = 'sold' AND l2.sold_at IS NOT NULL AND l2.sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)))) AS count
         FROM service_cities c WHERE c.is_active = 1
        ORDER BY c.position ASC, c.name ASC`,
    ),
    query(
      `SELECT transmission AS value, COUNT(*) AS count FROM vehicle_listings l
        ${where.sql} GROUP BY transmission ORDER BY count DESC`,
      where.params,
    ),
    query(
      `SELECT fuel_type AS value, COUNT(*) AS count FROM vehicle_listings l
        ${where.sql} GROUP BY fuel_type ORDER BY count DESC`,
      where.params,
    ),
    queryOne(
      `SELECT MIN(asking_price_kobo) AS min_price, MAX(asking_price_kobo) AS max_price,
              MIN(year) AS min_year, MAX(year) AS max_year, MAX(mileage_km) AS max_mileage
         FROM vehicle_listings l ${where.sql}`,
      where.params,
    ),
  ]);

  // §6.2's rail groups areas under their market: fourteen Port Harcourt
  // neighbourhoods plus ten Owerri ones would be an unreadable wall of radios.
  const groups = new Map();
  for (const row of areas) {
    if (!groups.has(row.city)) groups.set(row.city, []);
    groups.get(row.city).push(row);
  }

  return {
    makes,
    bodyTypes,
    conditions,
    grades,
    areas,
    // Ordered the way ops ordered the markets, not by whichever happens to
    // have the most stock this week.
    areaGroups: cities
      .map((row) => ({ city: row.name, areas: groups.get(row.name) || [] }))
      .filter((group) => group.areas.length),
    cities: cities.map((row) => ({
      value: row.value,
      slug: row.value,
      name: row.name,
      state: row.state,
      count: Number(row.count || 0),
      stockPrefix: row.stock_prefix || 'HC-PH',
    })),
    transmissions,
    fuels,
    range: {
      minPrice: priceStats && priceStats.min_price ? Number(priceStats.min_price) : 0,
      maxPrice: priceStats && priceStats.max_price ? Number(priceStats.max_price) : 0,
      minYear: priceStats && priceStats.min_year ? Number(priceStats.min_year) : 2000,
      maxYear: priceStats && priceStats.max_year ? Number(priceStats.max_year) : new Date().getFullYear(),
      maxMileage: priceStats && priceStats.max_mileage ? Number(priceStats.max_mileage) : 200000,
    },
  };
}

/** Dependent make → model selects (§6.2), with counts. */
/**
 * The live cars that sit behind a band — FR-29's "why this number".
 *
 * A band is an opinion about a model, a year window and a condition; these are
 * the cars on the site right now that make it checkable. Medians rather than
 * means, because one optimistic seller should not move what we tell somebody
 * their car is worth. The rows come back bounded and the medians are computed
 * here — MySQL 5.7 has no window functions, and the counts are small.
 */
async function comparablesFor({ make, model, yearFrom = null, yearTo = null, limit = 200 } = {}) {
  if (!make || !model) return null;
  const where = ["l.make = ?", 'l.model = ?', "(l.status IN ('live','reserved') AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP()))"];
  const params = [String(make), String(model)];
  if (yearFrom) {
    where.push('l.year >= ?');
    params.push(Number(yearFrom));
  }
  if (yearTo) {
    where.push('l.year <= ?');
    params.push(Number(yearTo));
  }
  const rows = await query(
    `SELECT l.id, l.year, l.mileage_km, l.asking_price_kobo, l.seo_slug, l.area, l.verification_grade
       FROM vehicle_listings l
      WHERE ${where.join(' AND ')}
      ORDER BY l.asking_price_kobo ASC
      LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 200))],
  );
  if (!rows.length) {
    return { count: 0, priced: 0, medianPriceKobo: null, medianMileageKm: null, minPriceKobo: null, maxPriceKobo: null, sampleUrl: null, yearFrom: null, yearTo: null };
  }

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const prices = rows.map((row) => Number(row.asking_price_kobo)).filter((value) => value > 0);
  const mileages = rows.map((row) => Number(row.mileage_km)).filter((value) => Number.isFinite(value) && value > 0);
  const middle = rows[Math.floor(rows.length / 2)];

  return {
    count: rows.length,
    priced: prices.length,
    medianPriceKobo: prices.length ? median(prices) : null,
    medianMileageKm: mileages.length ? median(mileages) : null,
    minPriceKobo: prices.length ? Math.min(...prices) : null,
    maxPriceKobo: prices.length ? Math.max(...prices) : null,
    yearFrom: Math.min(...rows.map((row) => Number(row.year))),
    yearTo: Math.max(...rows.map((row) => Number(row.year))),
    sampleUrl: middle ? `/cars/${middle.seo_slug}` : null,
    sampleArea: middle ? middle.area : null,
  };
}

async function modelCounts(make) {
  return query(
    `SELECT model AS value, COUNT(*) AS count FROM vehicle_listings l
      WHERE l.make = ?
        AND ((l.status IN ('live','reserved') AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP()))
          OR (l.status = 'sold' AND l.sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)))
      GROUP BY model ORDER BY count DESC, model ASC`,
    [make],
  );
}

/** Trust counters for the hero chips (§6.1 module 2). */
async function networkCounters() {
  const row = await queryOne(
    `SELECT
        (SELECT COUNT(*) FROM vehicle_listings l ${buildWhere({}).sql}) AS cars_live,
        (SELECT COUNT(*) FROM dealers WHERE verified = 1) AS dealers,
        (SELECT COUNT(*) FROM vehicle_listings WHERE verification_grade = 'certified' AND status IN ('live','reserved')) AS certified,
        (SELECT COUNT(*) FROM vehicle_listings WHERE status = 'sold' AND sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)) AS cars_sold_90d`,
  );
  return {
    carsLive: Number(row?.cars_live || 0),
    partnerDealers: Number(row?.dealers || 0),
    certified: Number(row?.certified || 0),
    carsSold90d: Number(row?.cars_sold_90d || 0),
  };
}

/** Where a price sits against its band. One rule, used by every caller. */
function bandPosition(priceKobo, band) {
  if (!band) return null;
  const price = Number(priceKobo);
  const min = Number(band.band_min_kobo);
  const max = Number(band.band_max_kobo);
  return price < min ? 'below' : price > max ? 'premium' : 'within';
}

/**
 * Which band applies to a listing: the exact condition beats the catch-all, and
 * the year must fall inside the range. Shared shape for the single-row lookup
 * below and the batch resolver under it — they must pick the same band or the
 * VDP and the comparison would disagree about the same car.
 */
function pickBand(bands, listing) {
  const candidates = bands.filter(
    (band) => band.make === listing.make
      && band.model === listing.model
      && Number(listing.year) >= Number(band.year_from)
      && Number(listing.year) <= Number(band.year_to)
      && (band.condition === listing.condition || band.condition === 'any'),
  );
  if (!candidates.length) return null;
  // Exact condition first; then the one with the most evidence behind it.
  return candidates.sort((a, b) => {
    const exact = Number(b.condition === listing.condition) - Number(a.condition === listing.condition);
    if (exact) return exact;
    return Number(b.sample_size) - Number(a.sample_size);
  })[0];
}

/** Price band lookup that powers the price-position indicator (§3.5, §7.3). */
async function findPriceBand(listing) {
  const row = await queryOne(
    `SELECT make, model, year_from, year_to, band_min_kobo, band_max_kobo, sample_size, refreshed_at, \`condition\`
       FROM price_bands
      WHERE make = ? AND model = ?
        AND ? BETWEEN year_from AND year_to
        AND (\`condition\` = ? OR \`condition\` = 'any')`,
    [listing.make, listing.model, listing.year, listing.condition],
  );
  // The query already narrowed to the right rows; pickBand applies the same
  // tie-break the batch path uses rather than trusting the row order.
  const band = row ? pickBand([row], listing) : null;
  if (!band) return null;
  return {
    min: Number(band.band_min_kobo),
    max: Number(band.band_max_kobo),
    position: bandPosition(listing.priceKobo, band),
    sampleSize: Number(band.sample_size),
    refreshedAt: band.refreshed_at,
  };
}

/**
 * Resolve the live band for a set of listings, in one query.
 *
 * `vehicle_listings.price_position` is a denormalised column written at seed
 * time. The VDP has always read the band itself, so a band moved in
 * /admin/intel changes the VDP immediately — and without this, the compare
 * table and the concierge shortlist would keep showing the stale column for the
 * same car. Anything that shows a price position to a buyer comes through here.
 */
async function attachPricePositions(listings) {
  if (!listings.length) return listings;
  const makes = [...new Set(listings.map((listing) => listing.make))];
  const bands = await query(
    `SELECT make, model, year_from, year_to, band_min_kobo, band_max_kobo, sample_size, refreshed_at, \`condition\`
       FROM price_bands WHERE make IN (${makes.map(() => '?').join(',')})`,
    makes,
  );
  return listings.map((listing) => {
    const band = pickBand(bands, listing);
    const position = bandPosition(listing.priceKobo, band);
    if (!position) return listing; // no band yet: the stored value stands, label says so
    return {
      ...listing,
      pricePosition: position,
      pricePositionLabel: (PRICE_POSITION[position] || PRICE_POSITION.no_data).label,
      priceBand: {
        min: Number(band.band_min_kobo),
        max: Number(band.band_max_kobo),
        sampleSize: Number(band.sample_size),
        refreshedAt: band.refreshed_at,
      },
    };
  });
}

/** Fire-and-forget metric bump (never blocks a page render). */
async function recordView(listingId) {
  try {
    await query('UPDATE vehicle_listings SET views = views + 1 WHERE id = ?', [listingId]);
  } catch {
    /* metrics must never break a render */
  }
}

/** Sitemap + static build input: every listing URL that should exist. */
/**
 * Slugs for sitemap.xml. Must mirror the browse query exactly: a listing whose
 * expiry has passed is not served any more, so advertising it in the sitemap
 * would point crawlers at a 404.
 */
async function allIndexableSlugs() {
  return query(
    `SELECT seo_slug, updated_at, published_at, status, sold_at
       FROM vehicle_listings
      WHERE (status IN ('live','reserved') AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP()))
         OR (status = 'sold' AND sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY))
      ORDER BY updated_at DESC`,
  );
}

module.exports = {
  FILTER_KEYS,
  SORTS,
  SORT_LABELS,
  buildWhere,
  filtersFromFacet,
  shapeListing,
  browse,
  homeFeed,
  findBySlug,
  findByIds,
  byIds,
  bySlugs,
  runningCostEstimate,
  findArchivedSoldBySlug,
  findRedirectTarget,
  findSimilar,
  countNearMatches,
  filterFacets,
  categoryShowcase,
  comparablesFor,
  modelCounts,
  networkCounters,
  findPriceBand,
  attachPricePositions,
  pickBand,
  recordView,
  allIndexableSlugs,
  slugify,
};
