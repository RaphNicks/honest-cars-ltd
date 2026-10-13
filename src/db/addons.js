'use strict';

/**
 * Dealer add-on purchases — FR-18, §7.2 “Orders & Billing”.
 *
 *   “Commission statements per closed deal; pay for add-on services (media
 *    shoot, featured placement, intelligence subscription) via PSP”
 *
 * The commission half lives in `payments.js` (the append-only ledger) and
 * `services/statement.js` (the document). This module owns the catalogue and
 * the purchases:
 *
 *   dealer_addons     what the portal sells, and what each one *does*
 *   dealer_purchases  one row per purchase, with the life it has
 *
 * A purchase is `pending` until the money lands, then `active` until `ends_at`
 * (or forever, for a one-off with no duration). The benefit itself is applied
 * by services/addons.applyPurchase inside the transaction that marks the
 * payment paid — the same seam hire and renewals use, for the same reason.
 */

const { query, queryOne } = require('./pool');
const ids = require('./ids');

const EFFECT_LABELS = {
  media_shoot: 'A photo and video shoot for one car',
  featured_placement: 'Featured placement for one car',
  intelligence: 'Market intelligence subscription',
};

const STATUS_LABELS = {
  pending: 'Awaiting payment',
  active: 'Active',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

function shapeAddon(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description || null,
    priceKobo: Number(row.price_kobo),
    interval: row.interval,
    intervalLabel: row.interval === 'monthly' ? 'per month' : 'one-off',
    effect: row.effect,
    effectLabel: EFFECT_LABELS[row.effect] || row.effect,
    durationDays: row.duration_days === null || row.duration_days === undefined ? null : Number(row.duration_days),
    needsListing: Boolean(row.needs_listing),
    isActive: Boolean(row.is_active),
    position: Number(row.position || 0),
    url: `/dealer/addons/${row.slug}`,
  };
}

function shapePurchase(row) {
  if (!row) return null;
  const expired = row.status === 'active' && row.ends_at && new Date(row.ends_at).getTime() < Date.now();
  return {
    id: row.id,
    reference: row.reference,
    dealerId: row.dealer_id,
    dealerName: row.dealer_name || null,
    dealerSlug: row.dealer_slug || null,
    addonId: row.addon_id,
    addonSlug: row.addon_slug || null,
    addonName: row.addon_name || null,
    effect: row.effect || null,
    listingId: row.listing_id || null,
    listing: row.stock_no
      ? {
        stockNo: row.stock_no,
        title: [row.year, row.make, row.model].filter(Boolean).join(' '),
        slug: row.seo_slug,
        url: `/cars/${row.seo_slug}`,
      }
      : null,
    amountKobo: Number(row.amount_kobo),
    // The derived state is the honest one: a purchase whose window has closed
    // is expired whether or not a sweep has run yet.
    status: expired ? 'expired' : row.status,
    storedStatus: row.status,
    statusLabel: STATUS_LABELS[expired ? 'expired' : row.status] || row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    detail: row.detail || null,
    paymentId: row.payment_id || null,
    paymentReference: row.payment_reference || null,
    paymentStatus: row.payment_status || null,
    createdAt: row.created_at,
    url: `/dealer/addons/purchase/${row.reference}`,
  };
}

/** The catalogue the portal renders, in the order ops put it in. */
async function catalogue({ includeInactive = false } = {}) {
  const rows = await query(
    `SELECT * FROM dealer_addons
      ${includeInactive ? '' : 'WHERE is_active = 1'}
      ORDER BY position ASC, price_kobo ASC, id ASC`,
  );
  return rows.map(shapeAddon);
}

async function bySlug(slug) {
  return shapeAddon(await queryOne('SELECT * FROM dealer_addons WHERE slug = ? LIMIT 1', [slug]));
}

async function byId(id) {
  return shapeAddon(await queryOne('SELECT * FROM dealer_addons WHERE id = ? LIMIT 1', [id]));
}

const PURCHASE_SELECT = `SELECT p.*, a.slug AS addon_slug, a.name AS addon_name, a.effect,
                                l.stock_no, l.seo_slug, l.make, l.model, l.year,
                                d.name AS dealer_name, d.slug AS dealer_slug,
                                pay.reference AS payment_reference, pay.status AS payment_status
                           FROM dealer_purchases p
                           JOIN dealer_addons a ON a.id = p.addon_id
                           JOIN dealers d ON d.id = p.dealer_id
                           LEFT JOIN vehicle_listings l ON l.id = p.listing_id
                           LEFT JOIN payments pay ON pay.id = p.payment_id`;

async function purchaseByReference(reference) {
  const row = await queryOne(`${PURCHASE_SELECT} WHERE p.reference = ? LIMIT 1`, [reference]);
  return shapePurchase(row);
}

async function purchaseById(id) {
  const row = await queryOne(`${PURCHASE_SELECT} WHERE p.id = ? LIMIT 1`, [id]);
  return shapePurchase(row);
}

async function purchaseByPayment(paymentId) {
  const row = await queryOne(`${PURCHASE_SELECT} WHERE p.payment_id = ? LIMIT 1`, [paymentId]);
  return shapePurchase(row);
}

/**
 * Everything a lot has bought, newest first. `active` is the derived view the
 * dashboard wants: paid, not cancelled, not past its end date.
 */
async function purchasesFor(dealerId, { limit = 50 } = {}) {
  const rows = await query(
    `${PURCHASE_SELECT} WHERE p.dealer_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    [dealerId, String(Math.min(200, limit))],
  );
  return rows.map(shapePurchase);
}

async function activeFor(dealerId) {
  const all = await purchasesFor(dealerId, { limit: 200 });
  return all.filter((purchase) => purchase.status === 'active');
}

/**
 * Raise a purchase and its payment in one go. The purchase exists from the
 * moment the dealer asks for it — an unpaid purchase is a real thing the desk
 * can chase, which is why the row is not created lazily when the money lands.
 *
 * The payment itself is raised by the caller (services/addons) so the provider
 * seam stays in one place.
 */
async function createPurchase({ dealerId, addonId, listingId = null, amountKobo, detail = null, actorId = null, conn = null } = {}) {
  const run = conn ? (sql, params) => conn.query(sql, params) : query;
  const reference = await ids.next('addon', { conn });
  const result = await run(
    `INSERT INTO dealer_purchases (reference, dealer_id, addon_id, listing_id, amount_kobo, status, detail, created_by)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [reference, dealerId, addonId, listingId, amountKobo, detail, actorId],
  );
  const id = result.insertId !== undefined ? result.insertId : result[0].insertId;
  return { id, reference };
}

/** Link the payment to the purchase it pays for. */
async function attachPayment(purchaseId, paymentId, { conn = null } = {}) {
  const run = conn ? (sql, params) => conn.query(sql, params) : query;
  await run('UPDATE dealer_purchases SET payment_id = ? WHERE id = ?', [paymentId, purchaseId]);
}

/**
 * Mark a purchase in effect. Called only from inside the payment transaction,
 * so `starts_at` is the moment the money actually landed.
 *
 * `endsAt` is NULL for a benefit that runs until cancelled; otherwise it is the
 * moment the benefit stops, computed from the add-on's duration. A purchase
 * with no duration that is *replaced* (a second featured placement on the same
 * car) still gets its window closed by the caller.
 */
async function activate(conn, purchaseId, { endsAt = null, detail = null } = {}) {
  await conn.query(
    `UPDATE dealer_purchases
        SET status = 'active', starts_at = UTC_TIMESTAMP(), ends_at = ?,
            detail = COALESCE(?, detail)
      WHERE id = ?`,
    [endsAt, detail, purchaseId],
  );
}

/** Cancel a pending or active purchase (a refund, or the dealer changing mind). */
async function cancel(purchaseId, { detail = null } = {}) {
  await query(
    "UPDATE dealer_purchases SET status = 'cancelled', detail = COALESCE(?, detail) WHERE id = ? AND status IN ('pending','active')",
    [detail, purchaseId],
  );
  return purchaseById(purchaseId);
}

/**
 * Expire every active purchase whose window has closed. Safe to run as often as
 * you like — it only touches rows that are already out of time — and it also
 * takes the featured rank back off the listing, because a placement that has
 * been paid for and finished must stop being an advantage.
 */
async function expireDue({ now = null } = {}) {
  const rows = await query(
    `SELECT p.id, p.listing_id, a.effect
       FROM dealer_purchases p JOIN dealer_addons a ON a.id = p.addon_id
      WHERE p.status = 'active' AND p.ends_at IS NOT NULL AND p.ends_at <= COALESCE(?, UTC_TIMESTAMP())`,
    [now],
  );
  for (const row of rows) {
    if (row.effect === 'featured_placement' && row.listing_id) {
      await query('UPDATE vehicle_listings SET featured_rank = 0 WHERE id = ?', [row.listing_id]);
    }
    await query("UPDATE dealer_purchases SET status = 'expired' WHERE id = ?", [row.id]);
  }
  return { expired: rows.length, ids: rows.map((row) => row.id) };
}

/** The fleet view: the newest purchases across every lot (§5.1 dealers screen). */
async function recentPurchases(limit = 20) {
  const rows = await query(
    `${PURCHASE_SELECT}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`,
    [Math.min(100, limit)],
  );
  return rows.map(shapePurchase);
}

module.exports = {
  EFFECT_LABELS,
  STATUS_LABELS,
  catalogue,
  bySlug,
  byId,
  purchaseByReference,
  purchaseById,
  purchaseByPayment,
  purchasesFor,
  activeFor,
  createPurchase,
  attachPayment,
  activate,
  cancel,
  expireDue,
  recentPurchases,
};
