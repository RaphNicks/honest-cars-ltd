'use strict';

/**
 * Dealer partner portal data — §7.2. Every query here is scoped by dealer id,
 * and the dealer id always comes from the signed-in account's own lot row
 * (`forUser`), never from the URL. That is the whole authorisation story: a
 * dealer can only ever read or write rows whose `dealer_id` is theirs.
 *
 * The screens this feeds:
 *   Dashboard     live listings, leads this week, views, pending actions, commission
 *   My Listings   table + card views, states, quick actions (mark sold, edit price, add photo)
 *   Add Listing   the mobile-first wizard — draft, then submit for review
 *   Leads         enquiries on this lot's cars, with the status pipeline
 *   Performance   views / enquiries / response time / freshness scorecard
 */

const { query, queryOne } = require('./pool');
const { parseJson } = require('./shape');

const LIVE = "('live','reserved')";

/** Statuses a dealer may move a listing between, and who does the moving. */
const DEALER_STATUS_RULES = {
  draft: { in_review: 'in_review', label: 'Submit for review' },
  in_review: { draft: 'draft', label: 'Withdraw to draft' },
  live: { sold: 'sold', reserved: 'reserved', draft: 'draft' },
  reserved: { live: 'live', sold: 'sold' },
  sold: null,
  expired: { draft: 'draft' },
};

// ---------------------------------------------------------------------------
// The lot behind a signed-in account
// ---------------------------------------------------------------------------
async function forUser(userId) {
  const row = await queryOne(
    `SELECT d.*, (SELECT COUNT(*) FROM vehicle_listings l WHERE l.dealer_id = d.id) AS listings_total
       FROM dealers d
      WHERE d.user_id = ? LIMIT 1`,
    [userId],
  );
  if (!row) return null;
  return shapeDealer(row);
}

async function byId(id) {
  const row = await queryOne('SELECT * FROM dealers WHERE id = ? LIMIT 1', [id]);
  return row ? shapeDealer(row) : null;
}

function shapeDealer(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    lotArea: row.lot_area,
    city: row.city,
    tier: row.tier,
    verified: Boolean(row.verified),
    userId: row.user_id,
    agreementSigned: row.agreement_signed,
    agreementRef: row.agreement_ref || null,
    agreementUrl: row.agreement_url || null,
    commissionPct: row.commission_pct === null ? null : Number(row.commission_pct),
    listingsTotal: row.listings_total === undefined ? undefined : Number(row.listings_total),
    // §7.2 “tier badge”
    tierLabel: { pilot: 'Pilot partner', standard: 'Standard partner', premium: 'Premium partner' }[row.tier] || row.tier,
  };
}

// ---------------------------------------------------------------------------
// Dashboard (§7.2 — one screen)
// ---------------------------------------------------------------------------
async function dashboard(dealerId) {
  const counts = await queryOne(
    `SELECT
       SUM(l.status = 'live')                                              AS live,
       SUM(l.status = 'reserved')                                          AS reserved,
       SUM(l.status = 'sold')                                              AS sold,
       SUM(l.status = 'draft')                                             AS draft,
       SUM(l.status = 'in_review')                                          AS in_review,
       SUM(l.status = 'expired')                                            AS expired,
       COALESCE(SUM(l.views), 0)                                            AS views,
       COALESCE(SUM(l.enquiries), 0)                                        AS enquiries,
       COALESCE(SUM(l.saves), 0)                                            AS saves,
       SUM(l.status IN ${LIVE} AND l.expires_at IS NOT NULL AND l.expires_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY)) AS expiring_soon,
       SUM(l.refreshed_at IS NULL AND l.updated_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY) AND l.status IN ${LIVE}) AS unconfirmed,
       SUM(l.inspection_report_id IS NULL AND l.status = 'live')           AS awaiting_report
     FROM vehicle_listings l
     WHERE l.dealer_id = ?`,
    [dealerId],
  );

  const leads = await queryOne(
    `SELECT
       SUM(le.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)) AS week,
       SUM(le.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)) AS month,
       SUM(le.status = 'new')                                          AS unread
     FROM leads le
     JOIN vehicle_listings l ON l.id = le.listing_id
     WHERE l.dealer_id = ?`,
    [dealerId],
  );

  const commission = await queryOne(
    `SELECT COALESCE(SUM(amount_kobo), 0) AS balance_kobo,
            COALESCE(SUM(CASE WHEN amount_kobo > 0 THEN amount_kobo ELSE 0 END), 0) AS owed_kobo,
            COALESCE(SUM(CASE WHEN amount_kobo < 0 THEN -amount_kobo ELSE 0 END), 0) AS paid_kobo
       FROM dealer_ledger WHERE dealer_id = ?`,
    [dealerId],
  );

  const topListings = await query(
    `SELECT l.id, l.stock_no, l.seo_slug, l.make, l.model, l.year, l.trim, l.status,
            l.asking_price_kobo, l.views, l.enquiries, l.saves,
            l.refreshed_at, l.updated_at, l.expires_at,
            (SELECT COUNT(*) FROM listing_media m WHERE m.listing_id = l.id) AS photos
       FROM vehicle_listings l
      WHERE l.dealer_id = ?
      ORDER BY l.views DESC, l.id DESC
      LIMIT 6`,
    [dealerId],
  );

  return {
    counts: Object.fromEntries(
      Object.entries(counts || {}).map(([key, value]) => [key, Number(value || 0)]),
    ),
    leads: Object.fromEntries(
      Object.entries(leads || {}).map(([key, value]) => [key, Number(value || 0)]),
    ),
    commission: Object.fromEntries(
      Object.entries(commission || {}).map(([key, value]) => [key, Number(value || 0)]),
    ),
    topListings: topListings.map(shapeDealerListing),
  };
}

function shapeDealerListing(row) {
  return {
    id: row.id,
    stockNo: row.stock_no,
    slug: row.seo_slug,
    title: [row.year, row.make, row.model, row.trim].filter(Boolean).join(' '),
    make: row.make,
    model: row.model,
    year: row.year,
    status: row.status,
    priceKobo: Number(row.asking_price_kobo),
    views: Number(row.views || 0),
    enquiries: Number(row.enquiries || 0),
    saves: Number(row.saves || 0),
    photos: Number(row.photos || 0),
    refreshedAt: row.refreshed_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    url: `/cars/${row.seo_slug}`,
    stale: !row.refreshed_at && row.updated_at
      ? (Date.now() - new Date(row.updated_at).getTime()) > 14 * 86_400_000
      : false,
  };
}

/** §7.2 “My Listings — table + card views; states; quick actions”. */
async function listings(dealerId, { status = null, limit = 200 } = {}) {
  const rows = await query(
    `SELECT l.*,
            (SELECT COUNT(*) FROM listing_media m WHERE m.listing_id = l.id) AS photos,
            (SELECT COUNT(*) FROM leads le WHERE le.listing_id = l.id) AS leads_total,
            (SELECT url FROM listing_media m WHERE m.listing_id = l.id ORDER BY position LIMIT 1) AS primary_image
       FROM vehicle_listings l
      WHERE l.dealer_id = ?
      ${status ? 'AND l.status = ?' : ''}
      ORDER BY FIELD(l.status, 'in_review', 'live', 'reserved', 'draft', 'expired', 'sold'), l.updated_at DESC
      LIMIT ?`,
    status ? [dealerId, status, Math.min(500, limit)] : [dealerId, Math.min(500, limit)],
  );
  return rows.map((row) => ({
    ...shapeDealerListing(row),
    leadsTotal: Number(row.leads_total || 0),
    primaryImage: row.primary_image || null,
    grade: row.verification_grade,
    mileageKm: Number(row.mileage_km || 0),
    bodyType: row.body_type,
    condition: row.condition,
    documents: parseJson(row.documents, {}) || {},
    source: row.source || null,
  }));
}

/** One listing, scoped to its owner. */
async function listingForDealer(dealerId, listingId) {
  const row = await queryOne(
    `SELECT l.*,
            (SELECT COUNT(*) FROM listing_media m WHERE m.listing_id = l.id) AS photos
       FROM vehicle_listings l
      WHERE l.id = ? AND l.dealer_id = ? LIMIT 1`,
    [listingId, dealerId],
  );
  if (!row) return null;
  return {
    ...shapeDealerListing(row),
    mileageKm: Number(row.mileage_km || 0),
    bodyType: row.body_type,
    transmission: row.transmission,
    fuelType: row.fuel_type,
    extColour: row.ext_colour || '',
    area: row.area,
    description: row.description || '',
    honestNote: row.honest_note || '',
    negotiable: Boolean(row.negotiable),
    documents: parseJson(row.documents, {}) || {},
    grade: row.verification_grade,
    moderateNote: row.moderate_note || null,
    media: await query(
      'SELECT id, url, alt_text, position, shot_label FROM listing_media WHERE listing_id = ? ORDER BY position',
      [listingId],
    ),
  };
}

// ---------------------------------------------------------------------------
// Writes — all scoped, all audited by the caller
// ---------------------------------------------------------------------------
async function createListing(dealerId, input) {
  const stockNo = await nextStockNo();
  const slug = await uniqueSlug(`${input.year}-${input.make}-${input.model}`, stockNo);
  const result = await query(
    `INSERT INTO vehicle_listings
       (stock_no, dealer_id, status, make, model, year, trim, body_type, transmission, fuel_type,
        engine_size, drivetrain, ext_colour, \`condition\`, mileage_km, features,
        asking_price_kobo, negotiable, city, area, documents, description, seo_slug)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [stockNo, dealerId, input.make, input.model, input.year, input.trim || null, input.bodyType,
      input.transmission, input.fuelType, input.engineSize || null, input.drivetrain || null,
      input.extColour || null, input.condition, input.mileageKm, JSON.stringify(input.features || []),
      input.priceKobo, input.negotiable ? 1 : 0, 'Port Harcourt', input.area,
      JSON.stringify(input.documents || {}), input.description || null, slug],
  );
  return { id: result.insertId, stockNo, slug };
}

async function updateListing(dealerId, listingId, input) {
  const before = await listingForDealer(dealerId, listingId);
  if (!before) return { ok: false, error: 'That listing is not one of yours.' };
  if (before.status === 'sold') return { ok: false, error: 'A sold car is history — ask ops if it needs reopening.' };

  await query(
    `UPDATE vehicle_listings
        SET asking_price_kobo = ?, negotiable = ?, mileage_km = ?, description = ?,
            honest_note = ?, area = ?, ext_colour = ?, documents = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND dealer_id = ?`,
    [input.priceKobo, input.negotiable ? 1 : 0, input.mileageKm, input.description || null,
      input.honestNote || null, input.area, input.extColour || null,
      JSON.stringify(input.documents || {}), listingId, dealerId],
  );

  // A price change is what the FR-25 watch exists for: record it against every
  // saver so the alert sweep can tell them.
  const priceChanged = Number(before.priceKobo) !== Number(input.priceKobo);
  return { ok: true, priceChanged, previousPriceKobo: before.priceKobo, title: before.title };
}

/**
 * Lifecycle moves a dealer may make. A listing only goes live through the §7.3
 * moderation queue: the dealer submits, ops publishes. `sold` and `reserved`
 * are the dealer's own to set, because only they know.
 */
async function setListingStatus(dealerId, listingId, to) {
  const listing = await listingForDealer(dealerId, listingId);
  if (!listing) return { ok: false, error: 'That listing is not one of yours.' };
  const allowed = DEALER_STATUS_RULES[listing.status];
  if (!allowed || !allowed[to]) {
    return { ok: false, error: `A ${listing.status.replace('_', ' ')} listing cannot be moved to ${to.replace('_', ' ')}.` };
  }
  if (to === 'in_review') {
    // §7.2: the wizard requires photos and a documents checklist before review.
    if (Number(listing.photos) < 3) {
      return { ok: false, error: 'Add at least three photos before sending a car for review — buyers decide from the pictures.' };
    }
    const docs = listing.documents || {};
    if (!docs.customs_verified && !docs.registration && !docs.duty_sighted && !docs.tinted_permit) {
      return { ok: false, error: 'Tick the documents you have sighted before submitting for review.' };
    }
  }

  // Marking sold stamps the date; pulling a car off the site clears the
  // published stamp so the moderation queue can publish it afresh.
  await query(
    `UPDATE vehicle_listings
        SET status = ?,
            sold_at = ${to === 'sold' ? 'UTC_TIMESTAMP()' : 'NULL'},
            published_at = ${to === 'draft' ? 'NULL' : 'published_at'}
      WHERE id = ? AND dealer_id = ?`,
    [to, listingId, dealerId],
  );
  return { ok: true, from: listing.status, to, stockNo: listing.stockNo, title: listing.title };
}

/** §7.2 “quick actions (mark sold, edit price, add photos)”. */
async function addPhoto(dealerId, listingId, { url, alt = null, shot = null }) {
  const listing = await listingForDealer(dealerId, listingId);
  if (!listing) return { ok: false, error: 'That listing is not one of yours.' };
  const clean = String(url || '').trim().slice(0, 400);
  if (!/^(https?:\/\/|\/img\/)/i.test(clean)) {
    return { ok: false, error: 'A photo needs a URL on this site (/img/…) or an https link.' };
  }
  const position = (listing.media || []).length;
  await query(
    'INSERT INTO listing_media (listing_id, type, shot_label, url, alt_text, position, width, height) VALUES (?, ?, ?, ?, ?, ?, 1200, 900)',
    [listingId, 'image', shot || null, clean, alt || listing.title, position],
  );
  return { ok: true, position: position + 1 };
}

async function removePhoto(dealerId, listingId, mediaId) {
  const listing = await listingForDealer(dealerId, listingId);
  if (!listing) return { ok: false, error: 'That listing is not one of yours.' };
  await query('DELETE FROM listing_media WHERE id = ? AND listing_id = ?', [mediaId, listingId]);
  return { ok: true };
}

/** §7.2 “must update lead status (contacted/viewing/sold/lost)”. */
const DEALER_LEAD_STATUSES = ['new', 'contacted', 'viewing', 'closed', 'lost'];

async function leads(dealerId, { status = null, limit = 100 } = {}) {
  const rows = await query(
    `SELECT le.id, le.type, le.name, le.phone, le.message, le.status, le.created_at,
            le.assigned_at, le.last_contacted_at, le.lost_reason,
            l.id AS listing_id, l.stock_no, l.seo_slug, l.make, l.model, l.year, l.trim
       FROM leads le
       JOIN vehicle_listings l ON l.id = le.listing_id
      WHERE l.dealer_id = ?
      ${status ? 'AND le.status = ?' : ''}
      ORDER BY le.created_at DESC
      LIMIT ?`,
    status ? [dealerId, status, Math.min(300, limit)] : [dealerId, Math.min(300, limit)],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    name: row.name,
    phone: row.phone,
    // §7.2: masked or full per policy — the dealer has to be able to call back,
    // so the number is shown to the lot the enquiry was about, and to nobody else.
    phoneMasked: maskPhone(row.phone),
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    lastContactedAt: row.last_contacted_at,
    lostReason: row.lost_reason,
    contacted: Boolean(row.last_contacted_at),
    listing: row.listing_id
      ? {
        id: row.listing_id,
        stockNo: row.stock_no,
        slug: row.seo_slug,
        title: [row.year, row.make, row.model, row.trim].filter(Boolean).join(' '),
        url: `/cars/${row.seo_slug}`,
      }
      : null,
  }));
}

async function setLeadStatus(dealerId, leadId, status, lostReason = null) {
  if (!DEALER_LEAD_STATUSES.includes(status)) return { ok: false, error: 'Unknown lead status.' };
  const lead = await queryOne(
    `SELECT le.id, le.status FROM leads le
       JOIN vehicle_listings l ON l.id = le.listing_id
      WHERE le.id = ? AND l.dealer_id = ? LIMIT 1`,
    [leadId, dealerId],
  );
  if (!lead) return { ok: false, error: 'That enquiry is not about one of your cars.' };

  await query(
    `UPDATE leads
        SET status = ?, lost_reason = ?, last_contacted_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [status, status === 'lost' ? (lostReason ? String(lostReason).slice(0, 200) : 'Not a fit') : null, leadId],
  );
  return { ok: true, from: lead.status, to: status };
}

// ---------------------------------------------------------------------------
// Performance (§7.2 — views, enquiries, response time, freshness)
// ---------------------------------------------------------------------------
async function performance(dealerId) {
  const totals = await queryOne(
    `SELECT COALESCE(SUM(l.views), 0) AS views,
            COALESCE(SUM(l.enquiries), 0) AS enquiries,
            COALESCE(SUM(l.saves), 0) AS saves,
            COUNT(*) AS listings
       FROM vehicle_listings l WHERE l.dealer_id = ?`,
    [dealerId],
  );

  const sevenDay = await queryOne(
    `SELECT COALESCE(SUM(views), 0) AS views
       FROM listing_daily_views v JOIN vehicle_listings l ON l.id = v.listing_id
      WHERE l.dealer_id = ? AND v.viewed_on >= DATE_SUB(UTC_DATE(), INTERVAL 7 DAY)`,
    [dealerId],
  ).catch(() => ({ views: 0 }));

  const response = await queryOne(
    `SELECT AVG(TIMESTAMPDIFF(HOUR, le.created_at, le.last_contacted_at)) AS hours,
            COUNT(*) AS answered
       FROM leads le
       JOIN vehicle_listings l ON l.id = le.listing_id
      WHERE l.dealer_id = ? AND le.last_contacted_at IS NOT NULL`,
    [dealerId],
  );

  const freshness = await query(
    `SELECT l.*,
            (SELECT COUNT(*) FROM listing_media m WHERE m.listing_id = l.id) AS photos
       FROM vehicle_listings l
      WHERE l.dealer_id = ? AND l.status IN ${LIVE}
      ORDER BY COALESCE(l.refreshed_at, l.updated_at) ASC
      LIMIT 20`,
    [dealerId],
  );

  const views = Number((totals || {}).views || 0);
  const enquiries = Number((totals || {}).enquiries || 0);
  const answered = Number((response || {}).answered || 0);
  const avgHours = (response || {}).hours === null || (response || {}).hours === undefined
    ? null
    : Number(response.hours);

  return {
    totals: {
      views,
      enquiries,
      saves: Number((totals || {}).saves || 0),
      listings: Number((totals || {}).listings || 0),
      views7d: Number((sevenDay || {}).views || 0),
    },
    // Two numbers the dealer can act on, not a scoreboard.
    enquiryRate: views ? enquiries / views : 0,
    response: {
      answered,
      unanswered: Math.max(0, enquiries - answered),
      avgHours,
      // Appendix B tone: a plain verdict, not a letter grade.
      verdict: avgHours === null ? 'No enquiries answered yet'
        : avgHours <= 4 ? 'Fast — inside 4 hours'
          : avgHours <= 24 ? 'Fine — inside a day'
            : 'Slow — buyers go elsewhere',
    },
    freshness: freshness.map((row) => ({
      ...shapeDealerListing(row),
      daysSinceUpdate: row.refreshed_at || row.updated_at
        ? Math.floor((Date.now() - new Date(row.refreshed_at || row.updated_at).getTime()) / 86_400_000)
        : null,
    })),
  };
}

/** §7.2 “Orders & Billing — commission statements per closed deal”. */
async function statements(dealerId, { limit = 50 } = {}) {
  const rows = await query(
    `SELECT e.id, e.entry_type, e.amount_kobo, e.detail, e.reference, e.created_at,
            p.reference AS payment_reference, p.purpose,
            l.stock_no, l.seo_slug, l.make, l.model, l.year
       FROM dealer_ledger e
       LEFT JOIN payments p ON p.id = e.payment_id
       LEFT JOIN vehicle_listings l ON l.id = e.listing_id
      WHERE e.dealer_id = ?
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?`,
    [dealerId, Math.min(200, limit)],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.entry_type,
    amountKobo: Number(row.amount_kobo),
    detail: row.detail || null,
    reference: row.reference || null,
    createdAt: row.created_at,
    paymentReference: row.payment_reference || null,
    purpose: row.purpose || null,
    listing: row.stock_no
      ? { stockNo: row.stock_no, title: [row.year, row.make, row.model].filter(Boolean).join(' '), slug: row.seo_slug }
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
async function nextStockNo() {
  const row = await queryOne("SELECT stock_no FROM vehicle_listings WHERE stock_no LIKE 'HC-PH-%' ORDER BY id DESC LIMIT 1");
  const last = row ? Number(String(row.stock_no).replace('HC-PH-', '')) : 0;
  return `HC-PH-${String(last + 1).padStart(4, '0')}`;
}

/** [+2348032220001] → [+234•••0001]: enough to recognise a caller, not to leak. */
function maskPhone(value) {
  const phone = String(value || '').trim();
  if (phone.length < 9) return phone;
  return `${phone.slice(0, 4)}•••${phone.slice(-4)}`;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function uniqueSlug(base, stockNo) {
  const root = `${slugify(base)}-${String(stockNo).toLowerCase()}`;
  const clash = await queryOne('SELECT id FROM vehicle_listings WHERE seo_slug = ? LIMIT 1', [root]);
  return clash ? `${root}-${Date.now().toString(36)}` : root;
}

/** Marks a listing as confirmed-current (§7.2 freshness). */
async function confirmFresh(dealerId, listingId) {
  const listing = await listingForDealer(dealerId, listingId);
  if (!listing) return { ok: false, error: 'That listing is not one of yours.' };
  await query('UPDATE vehicle_listings SET refreshed_at = UTC_TIMESTAMP() WHERE id = ? AND dealer_id = ?', [listingId, dealerId]);
  return { ok: true, stockNo: listing.stockNo };
}

/**
 * Dealer-role accounts and the lot each one owns, for the §7.3 onboarding panel
 * on /admin/staff. A `null` lotId is an account waiting to be linked.
 */
async function dealerAccounts() {
  const rows = await query(
    `SELECT u.id, u.name, u.phone, u.status, d.id AS dealer_id, d.name AS lot_name, d.tier
       FROM \`users\` u
       LEFT JOIN dealers d ON d.user_id = u.id
      WHERE u.role = 'dealer'
      ORDER BY (d.id IS NULL) DESC, u.name`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    status: row.status,
    lotId: row.dealer_id || null,
    lotName: row.lot_name || null,
    tier: row.tier || null,
  }));
}

/** Unclaimed lots, for ops to link an account to when onboarding (§7.2). */
async function unclaimed(limit = 50) {
  const rows = await query(
    `SELECT id, name, slug, lot_area, tier, verified FROM dealers
      WHERE user_id IS NULL ORDER BY name LIMIT ?`,
    [Math.min(200, limit)],
  );
  return rows.map(shapeDealer);
}

async function linkUser(dealerId, userId) {
  const dealer = await queryOne('SELECT id, user_id FROM dealers WHERE id = ? LIMIT 1', [dealerId]);
  if (!dealer) return { ok: false, error: 'That lot does not exist.' };
  if (dealer.user_id && String(dealer.user_id) !== String(userId)) {
    return { ok: false, error: 'That lot already belongs to another account — unlink it first.' };
  }
  const taken = await queryOne('SELECT id, name FROM dealers WHERE user_id = ? AND id <> ? LIMIT 1', [userId, dealerId]);
  if (taken) return { ok: false, error: `That account already owns ${taken.name}.` };
  await query('UPDATE dealers SET user_id = ? WHERE id = ?', [userId, dealerId]);
  return { ok: true };
}

async function unlinkUser(dealerId) {
  await query('UPDATE dealers SET user_id = NULL WHERE id = ?', [dealerId]);
  return { ok: true };
}

module.exports = {
  LIVE,
  DEALER_STATUS_RULES,
  DEALER_LEAD_STATUSES,
  shapeDealer,
  shapeDealerListing,
  forUser,
  byId,
  dashboard,
  listings,
  listingForDealer,
  createListing,
  updateListing,
  setListingStatus,
  addPhoto,
  removePhoto,
  confirmFresh,
  leads,
  setLeadStatus,
  performance,
  statements,
  unclaimed,
  dealerAccounts,
  maskPhone,
  linkUser,
  unlinkUser,
  nextStockNo,
  slugify,
};
