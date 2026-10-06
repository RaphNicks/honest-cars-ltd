'use strict';

/**
 * FR-28 — the referral module: links, attribution, reward status (§7.1).
 *
 * The thing worth testing here is not "does a count go up" — it is the two
 * rules the module exists to keep:
 *
 *   • **a referral counts once, and only when somebody actually bought.** The
 *     record is `users.referral_qualified_at` plus one row per (referrer,
 *     referred) pair, so a sweep that runs twice cannot inflate the queue, and
 *     a pending order cannot qualify anything.
 *   • **nothing is promised that a human has not approved.** The amount is typed
 *     by the desk; paying needs an approval; a paid reward is closed. Every
 *     transition leaves an audit row, and the customer hears about it through
 *     the channel-honest notification layer.
 *
 * Fixtures are made here and removed in `test.after`: accounts on unique numbers,
 * their orders, the reward rows and every notification and audit row the flow
 * writes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, sweepOrphanAudit } = require('./helpers');

let available = false;
let ctx;
let db;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

/** Unique per run so two runs never share an account, an order or a code. */
const run = (Number(process.pid) * 7919 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `0806${String((run * 17 + seq * 271) % 10_000_000).padStart(7, '0')}`;
}

const users = [];
const orders = [];
const rewards = [];
const notifications = [];

function newClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, { method = 'GET', body, form, headers = {} } = {}) {
      const payload = form
        ? new URLSearchParams(form).toString()
        : body
          ? JSON.stringify(body)
          : undefined;
      const response = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: payload,
      });
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(';');
        if (pair.split('=')[0] === 'hc_session') cookie = pair;
      }
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html */
      }
      return { status: response.status, text, json };
    },
  };
}

const { canonical } = require('../src/lib/phone');

/** A customer account, optionally brought in by somebody else's code. */
async function makeUser({ name, referredBy = null, role = 'customer', code = null } = {}) {
  const raw = nextPhone();
  const phone = canonical(raw);
  const referralCode = code || `HCT${String((run + seq * 37) % 100000).padStart(4, '0')}`.slice(0, 16);
  const userId = await db.query(
    'INSERT INTO `users` (phone, name, role, status, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?)',
    [phone, name, role, 'active', referralCode, referredBy],
  );
  users.push(Number(userId.insertId));
  const row = await db.queryOne('SELECT * FROM `users` WHERE id = ? LIMIT 1', [userId.insertId]);
  return { ...row, id: Number(row.id), phone, referralCode, client: newClient() };
}

/** A paid order, which is what makes a referral count. */
let orderSeq = 0;
async function makeOrder({ phone, name, status = 'paid', totalKobo = 4500000 }) {
  orderSeq += 1;
  const orderNo = `HC-ORD-T${String((run * 5 + orderSeq) % 1000000).padStart(6, '0')}`;
  const result = await db.query(
    `INSERT INTO orders (order_no, name, phone, delivery_area, delivery_fee_kobo, subtotal_kobo, total_kobo,
                         status, payment_ref, notes)
     VALUES (?, ?, ?, 'Test land', 0, ?, ?, ?, NULL, 'referral test fixture')`,
    [orderNo, name, phone, totalKobo, totalKobo, status],
  );
  orders.push(Number(result.insertId));
  return Number(result.insertId);
}

/** A throwaway staff account: the role is granted by SQL, then we sign in. */
async function signInAsRole(role, label) {
  const staff = await makeUser({ name: label, role });
  const verify = await signIn(staff.client, staff.phone);
  assert.equal(verify.status, 200, `sign-in failed for ${role}: ${verify.text}`);
  return staff.client;
}

/** Sign in over HTTP — the same path a real invitee takes. */
async function signIn(client, rawPhone, { ref: referralCode = null } = {}) {
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone: rawPhone } });
  assert.equal(otp.status, 200, `OTP failed: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', {
    method: 'POST',
    body: { phone: rawPhone, code: otp.json.devCode, ...(referralCode ? { ref: referralCode } : {}) },
  });
  return verify;
}

/**
 * The messages a flow wrote. Referral qualification is announced against the
 * *user* it happened to; an approval or a payment is announced against the
 * reward. Ask for whichever the moment used.
 */
async function notificationsFor({ userIds = [], rewardIds = [] } = {}) {
  const out = [];
  if (userIds.length) {
    out.push(...(await db.query(
      `SELECT id, template, recipient, channel, status FROM notifications
        WHERE entity = 'user' AND entity_id IN (${[...userIds, 0].map(() => '?').join(',')}) ORDER BY id`,
      [...userIds, 0],
    )));
  }
  if (rewardIds.length) {
    out.push(...(await db.query(
      `SELECT id, template, recipient, channel, status FROM notifications
        WHERE entity = 'referral_reward' AND entity_id IN (${[...rewardIds, 0].map(() => '?').join(',')}) ORDER BY id`,
      [...rewardIds, 0],
    )));
  }
  return out;
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  ctx = await startTestServer();
});

test.after(async () => {
  if (!available) return;
  await ctx.close();
  for (const id of notifications) await db.query('DELETE FROM notifications WHERE id = ?', [id]).catch(() => {});
  for (const id of orders) await db.query('DELETE FROM orders WHERE id = ?', [id]).catch(() => {});
  for (const id of rewards) await db.query('DELETE FROM referral_rewards WHERE id = ?', [id]).catch(() => {});
  // Deleting a `users` row cascades to the reward rows that name it, both ways.
  for (const id of users) await db.query('DELETE FROM `users` WHERE id = ?', [id]).catch(() => {});
  // Notifications the flow wrote about our fixtures: by referenced user, and by
  // reward — never a blanket delete, which could remove a real send.
  if (users.length || rewards.length) {
    await db.query(
      `DELETE FROM notifications WHERE entity = 'user' AND entity_id IN (${[...users, 0].map(() => '?').join(',')})`,
      [...users, 0],
    ).catch(() => {});
    await db.query(
      `DELETE FROM notifications WHERE entity = 'referral_reward' AND entity_id IN (${[...rewards, 0].map(() => '?').join(',')})`,
      [...rewards, 0],
    ).catch(() => {});
  }
  await sweepOrphanAudit(db.query);
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

maybe('a first sign-in through a link attaches the account to the code, once', async () => {
  const referrer = await makeUser({ name: 'Referrer One' });
  const inviteePhone = nextPhone();
  const client = newClient();

  const verify = await signIn(client, inviteePhone, { ref: referrer.referralCode });
  assert.equal(verify.status, 200, verify.text);

  const invitee = await db.users.findByPhone(canonical(inviteePhone));
  users.push(invitee.id);
  assert.equal(invitee.referredBy, referrer.id, 'the inviter is recorded');
  assert.equal(invitee.referralQualifiedAt, null, 'attribution is not qualification');

  // A second sign-in with a *different* code must not rewrite history.
  const other = await makeUser({ name: 'Referrer Two' });
  const again = newClient();
  const second = await signIn(again, inviteePhone, { ref: other.referralCode });
  assert.equal(second.status, 200);
  const unchanged = await db.users.findByPhone(canonical(inviteePhone));
  assert.equal(unchanged.referredBy, referrer.id, 'a referral is recorded once, at creation');

  // And nobody can bring themselves in.
  const self = await signIn(newClient(), referrer.phone, { ref: referrer.referralCode });
  assert.equal(self.status, 200);
  const referrerAfter = await db.users.findById(referrer.id);
  assert.equal(referrerAfter.referredBy, null, 'never self-referral');
});

maybe('the 007 migration files everybody under a real account', async () => {
  const orphans = await db.query(
    'SELECT COUNT(*) AS n FROM `users` u LEFT JOIN `users` r ON r.id = u.referred_by WHERE u.referred_by IS NOT NULL AND r.id IS NULL',
  );
  assert.equal(Number(orphans[0].n), 0, 'no dangling referrer');
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

maybe('a referral with no purchase stays uncounted and unqueued', async () => {
  const referrer = await makeUser({ name: 'Referrer Patient' });
  const invitee = await makeUser({ name: 'Invitee Browsing', referredBy: referrer.id });

  const sweep = await require('../src/services/referrals').sweep({});
  const mine = sweep.qualified.filter((row) => row.userId === invitee.id);
  assert.deepEqual(mine, [], 'signing up is not buying');

  const listed = await db.referrals.listForReferrer(referrer.id);
  const person = listed.find((row) => row.id === invitee.id);
  assert.equal(person.qualifiedAt, null);
  assert.equal(person.reward, null);
  assert.equal(person.orders, 0);
});

maybe('a pending order does not count — a paid one does, exactly once', async () => {
  const referralsService = require('../src/services/referrals');
  const referrer = await makeUser({ name: 'Referrer Counting' });
  const invitee = await makeUser({ name: 'Invitee Buying', referredBy: referrer.id });

  // Pending first: the order exists, no money has moved.
  await makeOrder({ phone: invitee.phone, name: invitee.name, status: 'pending_payment' });
  await referralsService.sweep({});
  let person = (await db.referrals.listForReferrer(referrer.id)).find((row) => row.id === invitee.id);
  assert.equal(person.qualifiedAt, null, 'pending_payment is not a purchase');

  // Now it is paid.
  const paidOrderId = await makeOrder({ phone: invitee.phone, name: invitee.name, status: 'paid' });
  const first = await referralsService.sweep({});
  assert.deepEqual(first.qualified.map((row) => row.userId), [invitee.id]);
  rewards.push(first.qualified[0].rewardId);

  person = (await db.referrals.listForReferrer(referrer.id)).find((row) => row.id === invitee.id);
  assert.equal(Boolean(person.qualifiedAt), true, 'qualified at last');
  assert.equal(person.reward.status, 'pending');
  assert.equal(person.reward.amountKobo, 0, 'the desk has not set an amount yet');
  assert.equal(person.paidOrders, 1);

  // Running it again is a no-op, not a second reward.
  const second = await referralsService.sweep({});
  assert.deepEqual(second.qualified, [], 'already counted');
  const rows = await db.query('SELECT COUNT(*) AS n FROM referral_rewards WHERE referred_user_id = ?', [invitee.id]);
  assert.equal(Number(rows[0].n), 1, 'one reward per person, ever');

  // The qualification is a permanent record: cancelling the order later does not
  // un-earn it, which is why `referral_qualified_at` exists at all.
  await db.query("UPDATE orders SET status = 'cancelled' WHERE id = ?", [paidOrderId]);
  const after = await db.users.findById(invitee.id);
  assert.equal(Boolean(after.referralQualifiedAt), true);
});

maybe('a dry run writes nothing at all', async () => {
  const referralsService = require('../src/services/referrals');
  const referrer = await makeUser({ name: 'Referrer Dry' });
  const invitee = await makeUser({ name: 'Invitee Dry', referredBy: referrer.id });
  await makeOrder({ phone: invitee.phone, name: invitee.name, status: 'paid' });

  const dry = await referralsService.sweep({ dryRun: true });
  assert.deepEqual(dry.qualified.map((row) => row.userId), [invitee.id]);
  assert.equal(dry.qualified[0].rewardId, null);

  const after = await db.users.findById(invitee.id);
  assert.equal(after.referralQualifiedAt, null, 'nothing written');
  const rows = await db.query('SELECT COUNT(*) AS n FROM referral_rewards WHERE referred_user_id = ?', [invitee.id]);
  assert.equal(Number(rows[0].n), 0);
  const sent = await notificationsFor({ userIds: [invitee.id] });
  assert.deepEqual(sent, [], 'and nobody told anything that did not happen');
});

// ---------------------------------------------------------------------------
// Reward status — the part a customer reads
// ---------------------------------------------------------------------------

maybe('approve → paid is the ladder, and the amount is always a human entry', async () => {
  const referralsService = require('../src/services/referrals');
  const referrer = await makeUser({ name: 'Referrer Paid' });
  const invitee = await makeUser({ name: 'Invitee Paid', referredBy: referrer.id });
  await makeOrder({ phone: invitee.phone, name: invitee.name, status: 'paid' });

  const sweep = await referralsService.sweep({});
  const rewardId = sweep.qualified.find((row) => row.userId === invitee.id).rewardId;
  rewards.push(rewardId);

  const staff = await makeUser({ name: 'Ops Tester', role: 'ops' });

  // Not payable before it is approved, and not approvable without an amount.
  const early = await referralsService.settleReward(rewardId, { status: 'paid' }, staff);
  assert.equal(early.ok, false);
  assert.match(early.error, /Approve/);

  const noAmount = await referralsService.approveReward(rewardId, { amountKobo: '' }, staff);
  assert.equal(noAmount.ok, false);
  assert.match(noAmount.error, /naira/);

  const approved = await referralsService.approveReward(
    rewardId,
    { amountKobo: '₦2,500', unitLabel: 'Referral credit — tracker', note: 'pilot campaign' },
    staff,
  );
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.reward.status, 'approved');
  assert.equal(approved.reward.amountKobo, 250000, '₦2,500 in kobo');

  // The referrer is told what was approved — and told it is approved, not paid.
  const approvedNotes = await notificationsFor({ userIds: [invitee.id], rewardIds: [rewardId] });
  const approval = approvedNotes.find((row) => row.template === 'referral_reward_approved');
  assert.equal(Boolean(approval), true, 'the approval is announced');
  assert.equal(approval.recipient, referrer.phone);
  const body = String((await db.query('SELECT body FROM notifications WHERE id = ?', [approval.id]))[0].body);
  assert.match(body, /₦2,500/);
  assert.match(body, /approved/i);
  assert.doesNotMatch(body, /has been paid/i);

  const paid = await referralsService.settleReward(rewardId, { status: 'paid', note: 'transfer ref TEST-1' }, staff);
  assert.equal(paid.ok, true, paid.error);
  assert.equal(paid.reward.status, 'paid');
  assert.equal(Boolean(paid.reward.paidAt), true, 'a paid_at is recorded');
  assert.equal(paid.reward.note, 'transfer ref TEST-1');

  // Closed record: no re-approval, no rewrite, and a void cannot undo a payment.
  const reapprove = await referralsService.approveReward(rewardId, { amountKobo: '5000' }, staff);
  assert.equal(reapprove.ok, false);
  assert.match(reapprove.error, /already been paid/);
  const voidPaid = await referralsService.settleReward(rewardId, { status: 'void', note: 'oops' }, staff);
  assert.equal(voidPaid.ok, false);

  const paidNotes = await notificationsFor({ userIds: [invitee.id], rewardIds: [rewardId] });
  assert.equal(paidNotes.some((row) => row.template === 'referral_reward_paid'), true, 'the payment is announced');

  // Audit: the whole ladder is on the record. Qualification is written against
  // the *user* (that is the row that changed); the reward steps against the
  // reward. Both name the actor where a human did it.
  const audit = await db.query(
    `SELECT action FROM admin_audit
      WHERE (entity = 'referral_reward' AND entity_id = ?)
         OR (entity = 'user' AND entity_id = ?)
      ORDER BY id`,
    [rewardId, invitee.id],
  );
  assert.deepEqual(
    audit.map((row) => row.action).filter((action) => action.startsWith('referral.')),
    ['referral.qualified', 'referral.approved', 'referral.paid'],
  );
  const approvedBy = await db.query(
    "SELECT actor_id FROM admin_audit WHERE action = 'referral.approved' AND entity_id = ? LIMIT 1",
    [rewardId],
  );
  assert.equal(Number(approvedBy[0].actor_id), staff.id, 'the approver is named');
});

maybe('void keeps the row and can be restored; only a void can be restored', async () => {
  const referralsService = require('../src/services/referrals');
  const referrer = await makeUser({ name: 'Referrer Void' });
  const invitee = await makeUser({ name: 'Invitee Void', referredBy: referrer.id });
  await makeOrder({ phone: invitee.phone, name: invitee.name, status: 'paid' });
  const sweep = await referralsService.sweep({});
  const rewardId = sweep.qualified.find((row) => row.userId === invitee.id).rewardId;
  rewards.push(rewardId);

  const staff = await makeUser({ name: 'Ops Tester Two', role: 'ops' });
  const voided = await referralsService.settleReward(rewardId, { status: 'void', note: 'duplicate account' }, staff);
  assert.equal(voided.ok, true, voided.error);
  const row = await db.referrals.rewardById(rewardId);
  assert.equal(row.status, 'void');
  assert.equal(row.note, 'duplicate account', 'the reason is kept on the row');
  assert.equal(row.paidAt, null);

  const restored = await referralsService.restoreReward(rewardId, staff);
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.reward.status, 'pending');

  const again = await referralsService.restoreReward(rewardId, staff);
  assert.equal(again.ok, false, 'there is nothing to restore from pending');
});

maybe('the console summary counts what the page shows', async () => {
  const summary = await db.referrals.summary();
  assert.equal(typeof summary.pending, 'number');
  assert.equal(summary.qualified <= summary.brought, true, 'you cannot count more accounts than came in');
  assert.equal(summary.referrers >= 1, true, 'the seeded demo has at least one working link');

  const links = await db.referrals.topLinks({ limit: 5 });
  assert.equal(links.length >= 1, true);
  assert.equal(typeof links[0].code, 'string');
  assert.equal(links[0].brought >= links[0].qualified, true);
});

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

maybe('/admin/referrals renders the queue, refuses marketing, and the buttons work', async () => {
  const referralsService = require('../src/services/referrals');
  const referrer = await makeUser({ name: 'Referrer Screen' });
  const invitee = await makeUser({ name: 'Invitee Screen', referredBy: referrer.id });
  await makeOrder({ phone: invitee.phone, name: invitee.name, status: 'paid' });
  const sweep = await referralsService.sweep({});
  const rewardId = sweep.qualified.find((row) => row.userId === invitee.id).rewardId;
  rewards.push(rewardId);

  const admin = await signInAsRole('admin', 'Admin Screen');
  const page = await admin.request('/admin/referrals');
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.match(page.text, /Reward queue/);
  assert.match(page.text, /Invitee Screen/);
  assert.match(page.text, /Referrer Screen/);
  assert.match(page.text, /Waiting on the desk/);

  const marketing = await signInAsRole('marketing', 'Marketing Screen');
  const refused = await marketing.request('/admin/referrals');
  assert.equal([302, 403].includes(refused.status), true, `marketing must not read the reward queue (${refused.status})`);

  // Approve over the real form, with the same cross-origin guard every POST has.
  const crossSite = await admin.request(`/admin/referrals/${rewardId}/approve`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    form: { amount: '3000' },
  });
  assert.equal(crossSite.status, 403, 'a cross-site POST is refused');
  assert.equal((await db.referrals.rewardById(rewardId)).status, 'pending', 'and it changed nothing');

  const approved = await admin.request(`/admin/referrals/${rewardId}/approve`, {
    method: 'POST',
    headers: { Origin: ctx.baseUrl },
    form: { amount: '3000', unit_label: 'Referral credit', note: 'screen test' },
  });
  assert.equal(approved.status, 303, approved.text.slice(0, 200));
  const after = await db.referrals.rewardById(rewardId);
  assert.equal(after.status, 'approved');
  assert.equal(after.amountKobo, 300000);
});

maybe('a customer sees the link, the people, and the honest state of each one', async () => {
  const referralsService = require('../src/services/referrals');
  const referrer = await makeUser({ name: 'Referrer Account' });
  const waiting = await makeUser({ name: 'Invitee Waiting', referredBy: referrer.id });
  const buying = await makeUser({ name: 'Invitee Bought', referredBy: referrer.id });
  await makeOrder({ phone: buying.phone, name: buying.name, status: 'paid' });
  const sweep = await referralsService.sweep({});
  rewards.push(sweep.qualified.find((row) => row.userId === buying.id).rewardId);

  const client = newClient();
  const verify = await signIn(client, referrer.phone);
  assert.equal(verify.status, 200, verify.text);

  const account = await client.request('/account');
  assert.equal(account.status, 200);
  const card = account.text.slice(account.text.indexOf('id="referrals"'), account.text.indexOf('Download my data'));
  assert.match(card, new RegExp(referrer.referralCode));
  assert.match(card, /Invitee Bought/);
  assert.match(card, /Invitee Waiting/);
  assert.match(card, /Not counted yet/, 'the person who has not bought is described as such');
  assert.match(card, /With the desk/, 'and the one who has is waiting on a human');
  assert.doesNotMatch(card, /₦\d/, 'no figure is shown before the desk approves one');

  // The export carries the same record — §18.3 right of access.
  const exported = await client.request('/account/export');
  assert.equal(exported.status, 200);
  assert.match(exported.text, /"referrals"/);
});

maybe('the sweep needs a real order status, not a cancelled one', async () => {
  const referralsService = require('../src/services/referrals');
  const referrer = await makeUser({ name: 'Referrer Cancelled' });
  const invitee = await makeUser({ name: 'Invitee Cancelled', referredBy: referrer.id });
  await makeOrder({ phone: invitee.phone, name: invitee.name, status: 'cancelled' });

  const sweep = await referralsService.sweep({});
  assert.deepEqual(sweep.qualified.filter((row) => row.userId === invitee.id), [], 'cancelled money never counted');
});
