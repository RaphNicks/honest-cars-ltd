'use strict';

/**
 * Partner onboarding data layer — §7.2 "become a partner".
 *
 * Drives the new dealer_applications pipeline and the lot create/edit directly
 * against the database: filing an application, reading it back with the account
 * joined in, the queue filters, the decision record, and the unique-slug lot a
 * "new" approval creates. Every row this file creates is removed in test.after.
 *
 * Skips itself when MySQL is not reachable, like the rest of the suite. The
 * routes over HTTP (the form, the admin queue, the approval orchestration) are
 * thin wrappers over these functions and are exercised with the dealer and
 * admin suites.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, makeAccount, sweepOrphanAudit } = require('./helpers');

let available = false;
let db;
let dealers;

const created = { users: [], applications: [], lots: [] };

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  dealers = db.dealers;
});

test.after(async () => {
  if (!available || !db) return;
  // Applications reference users and dealers, so they go first, then the lots,
  // then the accounts, leaving the dev database as it was found.
  if (created.applications.length) {
    await db.query(
      `DELETE FROM dealer_applications WHERE id IN (${created.applications.map(() => '?').join(',')})`,
      created.applications,
    ).catch(() => {});
  }
  for (const id of created.lots) await db.query('DELETE FROM dealers WHERE id = ?', [id]).catch(() => {});
  for (const id of created.users) await db.query('DELETE FROM `users` WHERE id = ?', [id]).catch(() => {});
  await sweepOrphanAudit(db.query).catch(() => {});
  await db.pool.end();
});

maybe('filing a new-partner application stores it pending, with the account joined in', async () => {
  const account = await makeAccount({ role: 'customer', name: 'Ada Otieno' });
  created.users.push(account.id);

  const result = await dealers.createApplication(
    {
      userId: account.id,
      type: 'new',
      lotName: 'Ada Autos',
      city: 'Port Harcourt',
      lotArea: 'GRA',
      tier: 'standard',
      contactName: 'Ada',
      phone: '+2348000000000',
      email: account.email,
      notes: 'about ten cars',
    },
    { actorId: account.id },
  );
  assert.equal(result.ok, true);
  created.applications.push(result.id);

  const row = await dealers.applicationById(result.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.type, 'new');
  assert.equal(row.lot_name, 'Ada Autos');
  assert.equal(row.tier, 'standard');
  assert.equal(row.account_name, 'Ada Otieno');
  assert.equal(row.account_email, account.email);
});

maybe('a lot-update application points at the existing lot it proposes to change', async () => {
  const account = await makeAccount({ role: 'dealer', name: 'Chinedu Obi' });
  created.users.push(account.id);
  const lot = await dealers.createLot(
    { name: 'Obi Motors', lotArea: 'Trans Amadi', city: 'Port Harcourt', tier: 'pilot', userId: account.id, commissionPct: 3 },
    { actorId: account.id },
  );
  assert.equal(lot.ok, true);
  created.lots.push(lot.id);

  const result = await dealers.createApplication(
    { userId: account.id, type: 'update', dealerId: lot.id, lotName: 'Obi Auto Park', city: 'Port Harcourt', lotArea: 'Trans Amadi', tier: 'standard' },
    { actorId: account.id },
  );
  assert.equal(result.ok, true);
  created.applications.push(result.id);

  const row = await dealers.applicationById(result.id);
  assert.equal(row.type, 'update');
  assert.equal(row.dealer_id, lot.id);
  assert.equal(row.current_lot_name, 'Obi Motors');
});

maybe('the queue filters by status, and a decline keeps its reason', async () => {
  const a = await makeAccount({ role: 'customer', name: 'Queue One' });
  const b = await makeAccount({ role: 'customer', name: 'Queue Two' });
  created.users.push(a.id, b.id);

  const one = await dealers.createApplication(
    { userId: a.id, type: 'new', lotName: 'Queue One Lot', lotArea: 'x', tier: 'pilot' },
    { actorId: a.id },
  );
  const two = await dealers.createApplication(
    { userId: b.id, type: 'new', lotName: 'Queue Two Lot', lotArea: 'y', tier: 'premium' },
    { actorId: b.id },
  );
  created.applications.push(one.id, two.id);

  const pending = await dealers.listApplications({ status: 'pending' });
  assert.ok(pending.some((r) => r.id === one.id));
  assert.ok(pending.some((r) => r.id === two.id));

  await dealers.markApplication(one.id, 'declined', { actorId: a.id, declineReason: 'no fit in this area' });

  const pendingAfter = await dealers.listApplications({ status: 'pending' });
  assert.ok(pendingAfter.some((r) => r.id === two.id));
  assert.ok(!pendingAfter.some((r) => r.id === one.id));

  const declined = await dealers.listApplications({ status: 'declined' });
  const declinedRow = declined.find((r) => r.id === one.id);
  assert.equal(declinedRow.decline_reason, 'no fit in this area');
});

maybe('approving records the decision and the settled commission', async () => {
  const a = await makeAccount({ role: 'customer', name: 'Approved One' });
  created.users.push(a.id);
  const app = await dealers.createApplication(
    { userId: a.id, type: 'new', lotName: 'Approved Lot', lotArea: 'z', tier: 'premium' },
    { actorId: a.id },
  );
  created.applications.push(app.id);

  const mark = await dealers.markApplication(app.id, 'approved', { actorId: a.id, commissionPct: 8 });
  assert.equal(mark.ok, true);
  const row = await dealers.applicationById(app.id);
  assert.equal(row.status, 'approved');
  assert.equal(Number(row.commission_pct), 8);
});

maybe('createLot gives two lots with the same name distinct slugs, and updateLot edits partially', async () => {
  const first = await dealers.createLot(
    { name: 'Woji Auto Park', lotArea: 'GRA', city: 'Port Harcourt', tier: 'standard', commissionPct: 5 },
    { actorId: null },
  );
  const second = await dealers.createLot(
    { name: 'Woji Auto Park', lotArea: 'GRA', city: 'Port Harcourt', tier: 'standard' },
    { actorId: null },
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  created.lots.push(first.id, second.id);

  // Same name, but the slug must be unique per lot.
  assert.notEqual(first.slug, second.slug);
  assert.equal(first.commissionPct, 5);

  // A partial edit changes only the field given; the rest is preserved.
  const update = await dealers.updateLot(first.id, { name: 'Woji Auto Park Ltd' });
  assert.equal(update.ok, true);
  assert.equal(update.lot.name, 'Woji Auto Park Ltd');
  assert.equal(update.lot.city, 'Port Harcourt');
  assert.equal(update.lot.commissionPct, 5);
});
