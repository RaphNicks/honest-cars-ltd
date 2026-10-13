'use strict';

/**
 * Referral programme — FR-28 (§7.1 "Referrals: personal link + reward status").
 *
 * The link and the attribution have existed since migration 007. This service
 * is the part the PRD actually asks for and no screen has ever answered:
 *
 *   • **when a referral starts to count.** `sweep()` finds referred accounts
 *     that have bought something and marks them — once, permanently, with the
 *     order that did it. The threshold is configuration
 *     (`config.referral.qualifyOrders`), not a constant, because "one paid
 *     order" is a campaign decision.
 *   • **where the reward is.** `pending → approved → paid`, or `void` when the
 *     desk says it does not count. No amount is ever set in code: the desk
 *     enters it at approval, and the form is only *pre-filled* with
 *     `config.referral.rewardKobo`.
 *
 * Two rules this service keeps:
 *
 *   1. **Nothing is promised to a customer that a human has not approved.** The
 *      account card says "with the desk" until a reward row is approved, and it
 *      shows the amount only from that moment on.
 *   2. **A decision leaves a record.** Every transition writes an audit row
 *      (`referral.*`) and, where the customer should hear about it, a
 *      notification — through the same channel-honest `notify.send` everything
 *      else uses, so an unconfigured channel is recorded `skipped` rather than
 *      silently dropped.
 */

const config = require('../config');
const db = require('../db');
const notify = require('./notify');
const money = require('../lib/money');
const validate = require('./validate');

/** The label every account card and console row uses for the state. */
const STATUS_LABELS = {
  pending: 'With the desk',
  approved: 'Approved',
  paid: 'Paid',
  void: 'Voided',
};

/**
 * Find newly-counting referrals and queue them. Safe to run repeatedly: the
 * UPDATE only matches unqualified rows, and the reward insert is `INSERT
 * IGNORE` against the unique pair, so a second run reports "nothing new"
 * instead of inflating the queue. `dryRun` answers "who would count?" and
 * writes nothing — including no notifications, because telling somebody they
 * qualified and then not writing the record is worse than saying nothing.
 */
async function sweep({ actorId = null, limit = 200, dryRun = false } = {}) {
  const qualifyOrders = Math.max(1, Number(config.referral.qualifyOrders) || 1);
  const candidates = await db.referrals.awaitingQualification({ qualifyOrders, limit });
  const qualified = [];

  for (const candidate of candidates) {
    if (dryRun) {
      qualified.push({
        userId: candidate.id,
        referrerId: candidate.referrerId,
        referralCode: candidate.referralCode,
        paidOrders: candidate.paidOrders,
        rewardId: null,
      });
      continue;
    }
    const marked = await db.referrals.markQualified(candidate.id);
    if (!marked) continue; // another sweep got there first — not an error
    const reward = await db.referrals.ensurePending({
      referrerId: candidate.referrerId,
      referredUserId: candidate.id,
      basis: 'order',
      note: `Qualified on ${candidate.paidOrders} paid order${candidate.paidOrders === 1 ? '' : 's'}.`,
    });

    await db.admin
      .recordAudit({
        actorId,
        action: 'referral.qualified',
        entity: 'user',
        entityId: candidate.id,
        detail: {
          referrerId: candidate.referrerId,
          referrerCode: candidate.referralCode,
          paidOrders: candidate.paidOrders,
          rewardId: reward ? reward.id : null,
        },
      })
      .catch(() => {});

    // Tell the referrer their link did something. The wording promises a human
    // review, not a payout, because that is what happens next.
    if (candidate.referrerPhone) {
      await notify
        .send({
          template: 'referral_qualified',
          recipient: candidate.referrerPhone,
          entity: 'user',
          entityId: candidate.id,
          createdBy: actorId,
          values: {
            code: candidate.referralCode || '',
            count: candidate.paidOrders,
          },
        })
        .catch(() => {});
    }

    await db.analytics
      .record('referral_qualified', {
        sourcePath: '/account',
        payload: { referral: candidate.referralCode || null, value: candidate.paidOrders },
      })
      .catch(() => {});

    qualified.push({
      userId: candidate.id,
      referrerId: candidate.referrerId,
      referralCode: candidate.referralCode,
      paidOrders: candidate.paidOrders,
      rewardId: reward ? reward.id : null,
    });
  }

  return { considered: candidates.length, qualified, dryRun };
}

/**
 * Everything the account card needs, in the shape §7.1 asks for: the link, the
 * counts, and the status of each person the link brought in.
 *
 * `link` is absolute so the copy button and the WhatsApp share text agree with
 * what is on the page.
 */
function accountView(user, stats) {
  if (!stats) return null;
  const people = stats.people || [];
  return {
    ...stats,
    link: `${config.siteUrl}${stats.path}`,
    qualifyOrders: Math.max(1, Number(config.referral.qualifyOrders) || 1),
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      phoneMasked: person.phoneMasked,
      joinedAt: person.joinedAt,
      orders: person.orders,
      paidOrders: person.paidOrders,
      qualifiedAt: person.qualifiedAt,
      counted: Boolean(person.qualifiedAt),
      reward: person.reward
        ? {
          ...person.reward,
          label: STATUS_LABELS[person.reward.status] || person.reward.status,
          amountLabel: person.reward.amountKobo ? money.formatNaira(person.reward.amountKobo) : null,
        }
        : null,
    })),
  };
}

/** The console's page: the queue, the totals and the links that worked. */
async function consoleView({ status = null, q = null } = {}) {
  const [rows, summary, links] = await Promise.all([
    db.referrals.listAll({ status, q }),
    db.referrals.summary(),
    db.referrals.topLinks({ limit: 20 }),
  ]);
  return {
    rows: rows.map((row) => ({
      ...row,
      statusLabel: STATUS_LABELS[row.status] || row.status,
      amountLabel: row.amountKobo ? money.formatNaira(row.amountKobo) : null,
    })),
    summary: {
      ...summary,
      pendingKoboLabel: summary.pendingKobo ? money.formatNaira(summary.pendingKobo) : null,
      approvedKoboLabel: summary.approvedKobo ? money.formatNaira(summary.approvedKobo) : null,
      paidKoboLabel: summary.paidKobo ? money.formatNaira(summary.paidKobo) : null,
    },
    links: links.map((link) => ({ ...link, rewardLabel: link.rewardKobo ? money.formatNaira(link.rewardKobo) : null })),
    suggestedRewardKobo: config.referral.rewardKobo,
    suggestedRewardLabel: money.formatNaira(config.referral.rewardKobo),
    qualifyOrders: Math.max(1, Number(config.referral.qualifyOrders) || 1),
  };
}

/** Approve a reward, then tell the referrer what was approved and what happens next. */
async function approveReward(id, { amountKobo, basis = null, unitLabel = null, note = null } = {}, actor = null) {
  const amount = validate.kobo(amountKobo);
  if (amount === null) return { ok: false, error: 'Amount must be a naira figure — the desk sets the reward, not this screen.' };
  const result = await db.referrals.approve(id, {
    amountKobo: amount,
    basis: validate.oneOf(basis, db.referrals.BASES, null),
    unitLabel: validate.text(unitLabel, 120) || null,
    note: validate.text(note, 200) || null,
    actorId: actor ? actor.id : null,
  });
  if (!result.ok) return result;

  await db.admin
    .recordAudit({
      actorId: actor ? actor.id : null,
      action: 'referral.approved',
      entity: 'referral_reward',
      entityId: id,
      detail: { referrerId: result.reward.referrerId, referredUserId: result.reward.referredUserId, amountKobo: result.reward.amountKobo },
    })
    .catch(() => {});

  const referrer = await db.users.findById(result.reward.referrerId);
  if (referrer && referrer.phone) {
    await notify
      .send({
        template: 'referral_reward_approved',
        recipient: referrer.phone,
        entity: 'referral_reward',
        entityId: id,
        createdBy: actor ? actor.id : null,
        values: { amount: money.formatNaira(result.reward.amountKobo), detail: result.reward.unitLabel || '' },
      })
      .catch(() => {});
  }
  return result;
}

/** Mark it paid (the money left) or void (it does not count after all). */
async function settleReward(id, { status, note = null } = {}, actor = null) {
  const result = await db.referrals.settle(id, {
    status,
    note: validate.text(note, 200) || null,
    actorId: actor ? actor.id : null,
  });
  if (!result.ok) return result;

  await db.admin
    .recordAudit({
      actorId: actor ? actor.id : null,
      action: status === 'paid' ? 'referral.paid' : 'referral.voided',
      entity: 'referral_reward',
      entityId: id,
      detail: { referrerId: result.reward.referrerId, referredUserId: result.reward.referredUserId, amountKobo: result.reward.amountKobo, note: result.reward.note },
    })
    .catch(() => {});

  const referrer = await db.users.findById(result.reward.referrerId);
  if (status === 'paid' && referrer && referrer.phone) {
    await notify
      .send({
        template: 'referral_reward_paid',
        recipient: referrer.phone,
        entity: 'referral_reward',
        entityId: id,
        createdBy: actor ? actor.id : null,
        values: { amount: money.formatNaira(result.reward.amountKobo) },
      })
      .catch(() => {});
    await db.analytics
      .record('referral_reward_paid', {
        sourcePath: '/admin/referrals',
        payload: { value: result.reward.amountKobo / 100 },
      })
      .catch(() => {});
  }
  return result;
}

async function restoreReward(id, actor = null) {
  const result = await db.referrals.restore(id, { actorId: actor ? actor.id : null });
  if (!result.ok) return result;
  await db.admin
    .recordAudit({
      actorId: actor ? actor.id : null,
      action: 'referral.restored',
      entity: 'referral_reward',
      entityId: id,
      detail: { referrerId: result.reward.referrerId, referredUserId: result.reward.referredUserId },
    })
    .catch(() => {});
  return result;
}

module.exports = { sweep, accountView, consoleView, approveReward, settleReward, restoreReward, STATUS_LABELS };
