'use strict';

/**
 * Add-on purchases — FR-18, §7.2 Orders & Billing.
 *
 * Buying an add-on is three steps, and each one is somebody's responsibility:
 *
 *   1. the dealer asks for it (the lot chooses the car for a shoot or a
 *      placement; intelligence needs no car) — purchase raised, payment raised
 *   2. the dealer pays. Until a PSP exists that means a bank transfer the desk
 *      records, exactly like every other payment in this build
 *   3. the money landing *is* the delivery. `applyPurchase` runs inside the
 *      transaction that marks the payment paid — the same seam hire and
 *      renewals use — so no path can take the money without delivering, and
 *      none can deliver twice
 *
 * What each effect actually does is deliberately small and inspectable:
 *
 *   featured_placement  sets `vehicle_listings.featured_rank` for the named car
 *                       for the paid window, and `expireDue()` takes it back
 *   media_shoot         raises a `bookings` row of type media_shoot, which the
 *                       dispatch calendar already runs — the crew picks a slot
 *   intelligence        creates an `intelligence` subscription, so the monthly
 *                       renewal queue built for FR-20 collects it with
 *                       everything else
 */

const db = require('../db');
const config = require('../config');
const payments = require('./payments');
const notify = require('./notify');

const ONE_DAY = 86_400_000;

/** Can this lot buy this add-on, right now, as asked? */
async function eligibility(dealerId, addon, { listingId = null } = {}) {
  if (!addon) return { ok: false, error: 'That add-on does not exist.' };
  if (!addon.isActive) return { ok: false, error: `${addon.name} is not on sale at the moment.` };

  if (!addon.needsListing) return { ok: true, listing: null };

  if (!listingId) {
    return { ok: false, error: `${addon.name} is for one car — pick which listing it is for.` };
  }
  const listing = await db.queryOne(
    'SELECT id, stock_no, seo_slug, make, model, year, status, dealer_id FROM vehicle_listings WHERE id = ? LIMIT 1',
    [listingId],
  );
  if (!listing) return { ok: false, error: 'That listing does not exist.' };
  if (Number(listing.dealer_id) !== Number(dealerId)) {
    return { ok: false, error: 'That listing is not on your lot.' };
  }
  if (!['draft', 'in_review', 'live', 'reserved'].includes(listing.status)) {
    return { ok: false, error: `That car is ${listing.status} — an add-on cannot be bought for it.` };
  }
  return {
    ok: true,
    listing: {
      id: listing.id,
      stockNo: listing.stock_no,
      title: [listing.year, listing.make, listing.model].filter(Boolean).join(' '),
      slug: listing.seo_slug,
    },
  };
}

/**
 * Raise the purchase and its payment together. Returns the payment so the
 * caller can show the dealer how to pay it — the same honest bank-transfer
 * page renewals and orders already use.
 */
async function purchase({ dealerId, addonSlug, listingId = null, actorId = null, customerPhone = null, customerName = null }) {
  const addon = await db.addons.bySlug(addonSlug);
  const check = await eligibility(dealerId, addon, { listingId });
  if (!check.ok) return check;

  const created = await db.addons.createPurchase({
    dealerId,
    addonId: addon.id,
    listingId: check.listing ? check.listing.id : null,
    amountKobo: addon.priceKobo,
    detail: check.listing ? `${addon.name} — ${check.listing.stockNo}` : addon.name,
    actorId,
  });

  // Through the payments *service*, not the table module: that is the seam
  // that records the request and sends the "here is how to pay" message.
  const payment = await payments.initiate({
    purpose: 'addon',
    amountKobo: addon.priceKobo,
    dealerPurchaseId: created.id,
    customerName: customerName || null,
    customerPhone: customerPhone || null,
    actorId,
  });
  if (!payment || payment.ok === false) {
    await db.addons.cancel(created.id, { detail: 'Payment could not be raised.' });
    return { ok: false, error: (payment && payment.error) || 'The payment could not be raised.' };
  }

  await db.addons.attachPayment(created.id, payment.id);
  const purchase = await db.addons.purchaseById(created.id);
  return {
    ok: true,
    purchase,
    payment: payment.payment || payment,
    // A hosted provider hands back a checkout URL; without one the dealer gets
    // the transfer details. Either way the caller renders the same page.
    checkoutUrl: payment.checkoutUrl || null,
    hosted: Boolean(payment.hosted),
  };
}

/** How long a paid purchase runs for, from the add-on's own duration. */
function windowFor(addon, from = new Date()) {
  if (!addon.durationDays) return { startsAt: from, endsAt: null };
  return { startsAt: from, endsAt: new Date(from.getTime() + addon.durationDays * ONE_DAY) };
}

/**
 * Deliver a paid purchase. Called from `db.payments.markPaid` **inside** its
 * transaction, so `payment` here is the row as it was read before the update;
 * everything this function writes commits with the money or not at all.
 *
 * Returns a small report so the caller (and the console) can say what happened
 * rather than implying it.
 */
async function applyPurchase(conn, payment) {
  if (!payment || !payment.dealerPurchaseId) return null;

  const [rows] = await conn.query(
    `SELECT p.*, a.slug AS addon_slug, a.name AS addon_name, a.effect, a.duration_days,
            l.stock_no, l.seo_slug, l.make, l.model, l.year,
            d.name AS dealer_name, u.phone AS dealer_phone
       FROM dealer_purchases p
       JOIN dealer_addons a ON a.id = p.addon_id
       JOIN dealers d ON d.id = p.dealer_id
       LEFT JOIN \`users\` u ON u.id = d.user_id
       LEFT JOIN vehicle_listings l ON l.id = p.listing_id
      WHERE p.id = ? LIMIT 1`,
    [payment.dealerPurchaseId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'cancelled') {
    return { ok: false, skipped: true, reason: 'That purchase was cancelled before the money landed.' };
  }
  if (row.status === 'active') {
    // Paying twice must not extend twice. The report says so plainly.
    return { ok: true, already: true, reference: row.reference, effect: row.effect };
  }

  const now = new Date();
  const { endsAt } = windowFor({ durationDays: row.duration_days }, now);
  const out = { ok: true, reference: row.reference, effect: row.effect, endsAt, detail: null };

  if (row.effect === 'featured_placement' && row.listing_id) {
    // A second paid placement on the same car replaces the first: the new
    // window is the one that counts, and `featured_rank` is what the listing
    // queries order by.
    await conn.query(
      `UPDATE dealer_purchases
          SET status = 'expired'
        WHERE listing_id = ? AND id <> ? AND status = 'active'`,
      [row.listing_id, row.id],
    );
    await conn.query('UPDATE vehicle_listings SET featured_rank = 1 WHERE id = ?', [row.listing_id]);
    out.detail = 'Featured placement is live on that listing.';
  } else if (row.effect === 'media_shoot') {
    const ids = require('../db/ids');
    const reference = await ids.nextId(conn, 'booking');
    // The booking is what the media desk works from, so it has to carry the
    // car and a number that answers. The lot's account phone is the fallback
    // when the payment was raised without one.
    const phone = payment.customerPhone || row.dealer_phone || null;
    if (!phone) {
      // Honest refusal: a shoot nobody can call about is worse than no shoot.
      throw new Error(`No phone number on file for ${row.dealer_name} — add one before paying for a media shoot.`);
    }
    const car = [row.year, row.make, row.model].filter(Boolean).join(' ') || 'Dealer stock';
    await conn.query(
      `INSERT INTO bookings (reference, type, service_slug, location, vehicle, name, phone, amount_kobo,
                             payment_status, status)
       VALUES (?, 'media_shoot', NULL, NULL, ?, ?, ?, ?, 'paid', 'requested')`,
      [
        reference,
        JSON.stringify({ label: car, listingId: row.listing_id || null, stockNo: row.stock_no || null, slug: row.seo_slug || null }),
        payment.customerName || row.dealer_name,
        phone,
        Number(row.amount_kobo),
      ],
    );
    out.bookingReference = reference;
    out.detail = `Shoot booked as ${reference} — the media desk will pick a slot.`;
  } else if (row.effect === 'intelligence') {
    const inserted = await conn.query(
      `INSERT INTO subscriptions (kind, dealer_id, plan_name, amount_kobo, device_state, renewal_at, period_months)
       VALUES ('intelligence', ?, ?, ?, 'activated', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 MONTH), 1)`,
      [row.dealer_id, row.addon_name, Number(row.amount_kobo)],
    );
    out.subscriptionId = inserted.insertId !== undefined ? inserted.insertId : (inserted[0] && inserted[0].insertId);
    out.detail = 'Market intelligence subscription is active.';
  }

  await db.addons.activate(conn, row.id, {
    endsAt: endsAt ? endsAt.toISOString().slice(0, 19).replace('T', ' ') : null,
    detail: out.detail,
  });
  return out;
}

/**
 * Tell the dealer their add-on is live. Deliberately outside the transaction:
 * a notification that fails must never undo a payment.
 */
async function announce(payment, report, { phone = null } = {}) {
  if (!report || !report.ok || report.already) return null;
  const to = phone || (payment && payment.customerPhone) || null;
  if (!to) return null;
  return notify.send({
    recipient: to,
    entity: 'payment',
    entityId: payment ? payment.id : null,
    template: 'addon_paid',
    values: {
      reference: report.reference,
      detail: report.detail || 'Your add-on is active.',
      ends: report.endsAt ? new Date(report.endsAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }) : null,
    },
  }).catch(() => null);
}

/** Bank details for an unpaid purchase — the same honest shape as every other. */
function bank(reference) {
  return {
    name: config.business.bankAccountName,
    bank: config.business.bankName,
    account: config.business.bankAccount,
    note: `Use ${reference} as the transfer narration so we match it in seconds.`,
  };
}

module.exports = { purchase, eligibility, applyPurchase, announce, bank, windowFor, payments };
