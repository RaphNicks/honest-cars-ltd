'use strict';

/**
 * Referrals — FR-28 (migration 025), the reward half of §7.1's "Referrals
 * (personal link + reward status)".
 *
 * Two different readers, two different questions:
 *
 *   • The *account holder* asks "did it count, and where is my money?" — so
 *     `listForReferrer` returns the people their link brought in, with the
 *     honest state of each: signed up, counted (or why not), reward pending,
 *     approved, paid, or voided.
 *   • The *desk* asks the same across every account, plus the totals it has to
 *     answer for: what is queued, what has been promised, what has been paid.
 *
 * Money is kobo and only ever set by a human through `approve`/`settle`. A
 * referral that has not been approved shows `amount_kobo = 0`, which the views
 * render as "not set yet" rather than "₦0" — nothing here ever promises a
 * number the desk has not entered.
 *
 * The pair (referrer_id, referred_user_id) is unique, so a sweep that runs
 * twice, or two sweeps racing, cannot double-count a person.
 */

const { query, queryOne } = require('./pool');

const STATUSES = ['pending', 'approved', 'paid', 'void'];
const BASES = ['signup', 'order'];

/** Orders that mean somebody actually bought something. */
const PAID_ORDER_STATUSES = ['paid', 'processing', 'fulfilled'];

function shapeReward(row) {
  if (!row) return null;
  return {
    id: row.id,
    referrerId: row.referrer_id,
    referredUserId: row.referred_user_id,
    status: row.status,
    basis: row.basis,
    amountKobo: Number(row.amount_kobo || 0),
    unitLabel: row.unit_label || null,
    note: row.note || null,
    approvedAt: row.approved_at || null,
    paidAt: row.paid_at || null,
    createdAt: row.created_at || null,
  };
}

function shapePerson(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || null,
    phoneMasked: row.phone_masked || null,
    joinedAt: row.created_at,
    orders: Number(row.orders || 0),
    qualifiedAt: row.referral_qualified_at || null,
    note: row.referral_note || null,
    reward: row.reward_id ? shapeReward({
      id: row.reward_id,
      referrer_id: row.referrer_id,
      referred_user_id: row.id,
      status: row.reward_status,
      basis: row.reward_basis,
      amount_kobo: row.reward_amount_kobo,
      unit_label: row.reward_unit_label,
      note: row.reward_note,
      approved_at: row.reward_approved_at,
      paid_at: row.reward_paid_at,
      created_at: row.reward_created_at,
    }) : null,
  };
}

/** The mask is applied in SQL-side JS, not in the query: MySQL cannot call it. */
function maskPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 6) return null;
  return `${digits.slice(0, 6)} ••• ${digits.slice(-4)}`;
}

/**
 * Everyone this account's link brought in, newest first.
 *
 * The order count is the same definition the dashboard has always used
 * (`status <> 'cancelled'`), so the card cannot disagree with itself. The
 * *qualified* flag is the separate, permanent record.
 */
async function listForReferrer(referrerId, { limit = 50 } = {}) {
  const rows = await query(
    `SELECT u.id, u.name, u.phone, u.created_at, u.referral_qualified_at, u.referral_note,
            (SELECT COUNT(*) FROM orders o WHERE o.phone = u.phone AND o.status <> 'cancelled') AS orders,
            (SELECT COUNT(*) FROM orders o2 WHERE o2.phone = u.phone AND o2.status IN ('paid','processing','fulfilled')) AS paid_orders,
            r.id AS reward_id, r.referrer_id, r.status AS reward_status, r.basis AS reward_basis,
            r.amount_kobo AS reward_amount_kobo, r.unit_label AS reward_unit_label,
            r.note AS reward_note, r.approved_at AS reward_approved_at,
            r.paid_at AS reward_paid_at, r.created_at AS reward_created_at
       FROM \`users\` u
       LEFT JOIN referral_rewards r
              ON r.referred_user_id = u.id AND r.referrer_id = ?
      WHERE u.referred_by = ? AND u.status <> 'deleted'
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ?`,
    [referrerId, referrerId, Math.min(200, Math.max(1, Number(limit) || 50))],
  );
  return rows.map((row) => {
    const person = shapePerson({ ...row, phone_masked: maskPhone(row.phone) });
    person.paidOrders = Number(row.paid_orders || 0);
    return person;
  });
}

/** The totals the account card shows, in one place so they cannot drift. */
function tally(people) {
  const byStatus = { pending: 0, approved: 0, paid: 0, void: 0 };
  let approvedKobo = 0;
  let paidKobo = 0;
  for (const person of people) {
    if (!person.reward) continue;
    byStatus[person.reward.status] = (byStatus[person.reward.status] || 0) + 1;
    if (person.reward.status === 'approved') approvedKobo += person.reward.amountKobo;
    if (person.reward.status === 'paid') paidKobo += person.reward.amountKobo;
  }
  return {
    people: people.length,
    joined: people.length,
    qualified: people.filter((person) => person.qualifiedAt).length,
    orders: people.reduce((sum, person) => sum + person.orders, 0),
    pending: byStatus.pending,
    approved: byStatus.approved,
    paid: byStatus.paid,
    voided: byStatus.void,
    approvedKobo,
    paidKobo,
  };
}

/**
 * The desk's view: every referral, with both ends named.
 *
 * `q` searches either side by name or phone — the same "one inbox" habit the
 * rest of the console has, because the desk's first move on a WhatsApp message
 * is to find the account.
 */
async function listAll({ status = null, q = null, limit = 200 } = {}) {
  const where = ["u.status <> 'deleted'"];
  const params = [];
  if (status && STATUSES.includes(status)) {
    where.push('r.status = ?');
    params.push(status);
  }
  const term = String(q || '').trim();
  if (term) {
    where.push('(u.name LIKE ? OR u.phone LIKE ? OR ref.name LIKE ? OR ref.phone LIKE ? OR ref.referral_code LIKE ?)');
    const like = `%${term.slice(0, 60)}%`;
    params.push(like, like, like, like, like.toUpperCase());
  }
  const rows = await query(
    `SELECT r.*, u.name AS referred_name, u.phone AS referred_phone,
            u.created_at AS referred_joined_at, u.referral_qualified_at AS referred_qualified_at,
            ref.name AS referrer_name, ref.phone AS referrer_phone, ref.referral_code,
            (SELECT COUNT(*) FROM orders o WHERE o.phone = u.phone AND o.status <> 'cancelled') AS orders,
            (SELECT COUNT(*) FROM orders o2 WHERE o2.phone = u.phone AND o2.status IN ('paid','processing','fulfilled')) AS paid_orders,
            a.name AS actor_name
       FROM referral_rewards r
       JOIN \`users\` u   ON u.id = r.referred_user_id
       JOIN \`users\` ref ON ref.id = r.referrer_id
       LEFT JOIN \`users\` a ON a.id = r.actor_id
      WHERE ${where.join(' AND ')}
      ORDER BY FIELD(r.status, 'pending','approved','paid','void'), r.created_at DESC, r.id DESC
      LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 200))],
  );
  return rows.map((row) => ({
    ...shapeReward(row),
    referredName: row.referred_name || null,
    referredPhoneMasked: maskPhone(row.referred_phone),
    referredJoinedAt: row.referred_joined_at || null,
    referredQualifiedAt: row.referred_qualified_at || null,
    referrerName: row.referrer_name || null,
    referrerPhoneMasked: maskPhone(row.referrer_phone),
    referralCode: row.referral_code || null,
    orders: Number(row.orders || 0),
    paidOrders: Number(row.paid_orders || 0),
    actorName: row.actor_name || null,
  }));
}

/**
 * Referred accounts that have bought something but are not yet marked as
 * counted — the sweep's work list. `qualifyOrders` is passed in from the
 * service (configuration), not hard-coded here.
 */
async function awaitingQualification({ qualifyOrders = 1, limit = 200 } = {}) {
  const rows = await query(
    `SELECT u.id, u.phone, u.name, u.referred_by, u.created_at, ref.phone AS referrer_phone,
            ref.name AS referrer_name, ref.referral_code,
            (SELECT COUNT(*) FROM orders o WHERE o.phone = u.phone AND o.status IN ('paid','processing','fulfilled')) AS paid_orders
       FROM \`users\` u
       JOIN \`users\` ref ON ref.id = u.referred_by
      WHERE u.referred_by IS NOT NULL
        AND u.referral_qualified_at IS NULL
        AND u.status = 'active'
      HAVING paid_orders >= ?
      ORDER BY u.created_at ASC, u.id ASC
      LIMIT ?`,
    [Math.max(1, Number(qualifyOrders) || 1), Math.min(500, Math.max(1, Number(limit) || 200))],
  );
  return rows.map((row) => ({
    id: row.id,
    phone: row.phone,
    name: row.name || null,
    referrerId: row.referred_by,
    referrerPhone: row.referrer_phone,
    referrerName: row.referrer_name || null,
    referralCode: row.referral_code || null,
    paidOrders: Number(row.paid_orders || 0),
    joinedAt: row.created_at,
  }));
}

/**
 * Mark a referral as counted. Idempotent by construction: the UPDATE only
 * matches a row that is not qualified yet, so a second sweep writes nothing and
 * says so.
 */
async function markQualified(userId) {
  const result = await query(
    'UPDATE `users` SET referral_qualified_at = UTC_TIMESTAMP() WHERE id = ? AND referral_qualified_at IS NULL',
    [userId],
  );
  return result.affectedRows > 0;
}

/**
 * Put a referral in the reward queue. `INSERT IGNORE` against the unique pair:
 * if the desk already decided (and maybe already paid), the existing row is
 * what counts — a sweep never resets a paid reward to pending.
 */
async function ensurePending({ referrerId, referredUserId, basis = 'order', note = null, actorId = null }) {
  await query(
    `INSERT IGNORE INTO referral_rewards (referrer_id, referred_user_id, status, basis, note, actor_id)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
    [referrerId, referredUserId, BASES.includes(basis) ? basis : 'order', note ? String(note).slice(0, 200) : null, actorId],
  );
  return rewardForPair(referrerId, referredUserId);
}

async function rewardForPair(referrerId, referredUserId) {
  return shapeReward(await queryOne(
    'SELECT * FROM referral_rewards WHERE referrer_id = ? AND referred_user_id = ? LIMIT 1',
    [referrerId, referredUserId],
  ));
}

async function rewardById(id) {
  return shapeReward(await queryOne('SELECT * FROM referral_rewards WHERE id = ? LIMIT 1', [id]));
}

/**
 * Approve: a human sets the amount. Re-approving an already-approved reward is
 * allowed (campaigns change mid-flight) but never after it has been paid — that
 * would silently rewrite what somebody was told they were getting.
 */
async function approve(id, { amountKobo, basis = null, unitLabel = null, note = null, actorId = null }) {
  const existing = await rewardById(id);
  if (!existing) return { ok: false, error: 'That referral no longer exists.' };
  if (existing.status === 'paid') return { ok: false, error: 'That reward has already been paid — it cannot be re-approved.' };
  if (existing.status === 'void') return { ok: false, error: 'That referral was voided. Restore it first if that was wrong.' };
  const amount = Math.max(0, Math.round(Number(amountKobo) || 0));
  if (!amount) return { ok: false, error: 'Enter the amount to approve — the desk sets the reward, not this screen.' };
  await query(
    `UPDATE referral_rewards
        SET status = 'approved', amount_kobo = ?, basis = ?, unit_label = ?, note = ?,
            approved_at = UTC_TIMESTAMP(), actor_id = ?
      WHERE id = ?`,
    [amount, BASES.includes(basis) ? basis : existing.basis, unitLabel ? String(unitLabel).slice(0, 120) : existing.unitLabel,
      note ? String(note).slice(0, 200) : existing.note, actorId, id],
  );
  return { ok: true, reward: await rewardById(id), previous: existing };
}

/**
 * Settle: paid (the money left) or void (it does not count after all). Both
 * keep the row — a decision with no record is indistinguishable from a mistake.
 */
async function settle(id, { status, note = null, actorId = null }) {
  if (!['paid', 'void'].includes(status)) return { ok: false, error: 'Unknown outcome.' };
  const existing = await rewardById(id);
  if (!existing) return { ok: false, error: 'That referral no longer exists.' };
  if (existing.status === 'paid' && status !== 'paid') return { ok: false, error: 'A paid reward is a closed record.' };
  if (status === 'paid' && existing.status !== 'approved') {
    return { ok: false, error: 'Approve the amount before marking it paid.' };
  }
  await query(
    `UPDATE referral_rewards
        SET status = ?, note = COALESCE(?, note), actor_id = ?,
            paid_at = CASE WHEN ? = 'paid' THEN UTC_TIMESTAMP() ELSE paid_at END
      WHERE id = ?`,
    [status, note ? String(note).slice(0, 200) : null, actorId, status, id],
  );
  return { ok: true, reward: await rewardById(id), previous: existing };
}

/** Restore a voided referral to the queue. Nothing else can leave `void`. */
async function restore(id, { actorId = null } = {}) {
  const existing = await rewardById(id);
  if (!existing) return { ok: false, error: 'That referral no longer exists.' };
  if (existing.status !== 'void') return { ok: false, error: 'Only a voided referral can be restored.' };
  await query(
    `UPDATE referral_rewards SET status = 'pending', actor_id = ? WHERE id = ?`,
    [actorId, id],
  );
  return { ok: true, reward: await rewardById(id), previous: existing };
}

/** The console's counters. */
async function summary() {
  const rows = await query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_kobo), 0) AS kobo
       FROM referral_rewards GROUP BY status`,
  );
  const out = { pending: 0, approved: 0, paid: 0, void: 0, pendingKobo: 0, approvedKobo: 0, paidKobo: 0 };
  for (const row of rows) {
    out[row.status] = Number(row.n || 0);
    if (row.status === 'pending') out.pendingKobo = Number(row.kobo || 0);
    if (row.status === 'approved') out.approvedKobo = Number(row.kobo || 0);
    if (row.status === 'paid') out.paidKobo = Number(row.kobo || 0);
  }
  const [links] = await query(
    `SELECT COUNT(DISTINCT referred_by) AS referrers, COUNT(*) AS brought
       FROM \`users\` WHERE referred_by IS NOT NULL AND status <> 'deleted'`,
  );
  const [counted] = await query(
    'SELECT COUNT(*) AS n FROM `users` WHERE referred_by IS NOT NULL AND referral_qualified_at IS NOT NULL AND status <> \'deleted\'',
  );
  out.referrers = Number((links && links.referrers) || 0);
  out.brought = Number((links && links.brought) || 0);
  out.qualified = Number((counted && counted.n) || 0);
  return out;
}

/** The codes the desk's report links to, so "which link worked" has an answer. */
async function topLinks({ limit = 20 } = {}) {
  const rows = await query(
    `SELECT ref.id, ref.name, ref.phone, ref.referral_code,
            COUNT(u.id) AS brought,
            SUM(CASE WHEN u.referral_qualified_at IS NOT NULL THEN 1 ELSE 0 END) AS qualified,
            COALESCE(SUM(CASE WHEN r.status IN ('approved','paid') THEN r.amount_kobo ELSE 0 END), 0) AS reward_kobo
       FROM \`users\` ref
       JOIN \`users\` u ON u.referred_by = ref.id AND u.status <> 'deleted'
       LEFT JOIN referral_rewards r ON r.referred_user_id = u.id AND r.referrer_id = ref.id
      WHERE ref.status <> 'deleted'
      GROUP BY ref.id
      ORDER BY qualified DESC, brought DESC, ref.id ASC
      LIMIT ?`,
    [Math.min(100, Math.max(1, Number(limit) || 20))],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name || null,
    phoneMasked: maskPhone(row.phone),
    code: row.referral_code || null,
    brought: Number(row.brought || 0),
    qualified: Number(row.qualified || 0),
    rewardKobo: Number(row.reward_kobo || 0),
  }));
}

module.exports = {
  STATUSES,
  BASES,
  PAID_ORDER_STATUSES,
  listForReferrer,
  tally,
  listAll,
  awaitingQualification,
  markQualified,
  ensurePending,
  rewardForPair,
  rewardById,
  approve,
  settle,
  restore,
  summary,
  topLinks,
  maskPhone,
};
