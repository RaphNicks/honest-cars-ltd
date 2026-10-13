'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const users = require('../src/db/users');
const { dbAvailable } = require('./helpers');

let available = false;
let db;
let sequence = 0;
const made = { users: [], phones: [], emails: new Set(), bookings: [], milestones: [] };

function nextEmail() {
  sequence += 1;
  const address = `account-${process.pid}-${Date.now()}-${sequence}@example.net`;
  made.emails.add(address);
  return address;
}

function nextPhone() {
  sequence += 1;
  const phone = `+2348${String((process.pid * 7919 + sequence * 977) % 1_000_000_000).padStart(9, '0')}`;
  made.phones.push(phone);
  return phone;
}

test.before(async () => {
  available = await dbAvailable();
  if (available) db = require('../src/db');
});

test.after(async () => {
  if (!available) return;
  for (const id of made.milestones) {
    await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['milestone', id]);
    await db.query('DELETE FROM payment_milestones WHERE id = ?', [id]);
  }
  for (const id of made.bookings) await db.query('DELETE FROM bookings WHERE id = ?', [id]);
  if (made.emails.size) {
    const emails = [...made.emails];
    const marks = emails.map(() => '?').join(',');
    await db.query(`DELETE FROM email_auth_codes WHERE email IN (${marks})`, emails);
  }
  if (made.users.length) {
    const ids = [...new Set(made.users)];
    const marks = ids.map(() => '?').join(',');
    await db.query(`DELETE FROM \`users\` WHERE id IN (${marks})`, ids);
  }
  if (made.phones.length) {
    const marks = made.phones.map(() => '?').join(',');
    await db.query(`DELETE FROM \`users\` WHERE phone IN (${marks})`, made.phones);
  }
  await db.pool.end();
});

test('Google sign-in state is signed, time-limited and bound to the callback state', () => {
  const customerAuth = require('../src/services/customer-auth');
  const created = customerAuth.createGoogleState({ next: '/account#profile', linkUserId: 42 });
  const verified = customerAuth.readGoogleState(created.cookie, created.payload.state);
  assert.equal(verified.next, '/account#profile');
  assert.equal(verified.linkUserId, 42);
  assert.throws(
    () => customerAuth.readGoogleState(created.cookie, 'attacker-state'),
    (error) => error.code === 'GOOGLE_STATE_INVALID',
  );

  const unsafe = customerAuth.createGoogleState({ next: 'https://attacker.example' });
  assert.equal(customerAuth.readGoogleState(unsafe.cookie, unsafe.payload.state).next, '/account');
});

test('email addresses are normalized and invalid values are rejected', () => {
  assert.equal(users.normaliseEmail('  Buyer@Example.com  '), 'buyer@example.com');
  assert.equal(users.normaliseEmail('not-an-email'), null);
  assert.equal(users.normaliseEmail(`a${'b'.repeat(160)}@example.com`), null);
});

test('an email-only customer has no login phone, and a contact phone is not an identity', async (t) => {
  if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
  const email = nextEmail();
  const user = await db.users.createEmailAccount({ email, name: 'Email Customer' });
  made.users.push(user.id);

  assert.equal(user.phone, null);
  assert.equal(user.contactPhone, null);
  assert.equal(user.email, email);
  assert.equal(user.emailVerified, true);
  assert.equal((await db.users.findByVerifiedEmail(email)).id, user.id);

  const googleEmail = nextEmail();
  const googleSubject = `google-${process.pid}-${Date.now()}`;
  const googleUser = await db.users.createEmailAccount({
    email: googleEmail,
    name: 'Google Customer',
    googleSubject,
  });
  made.users.push(googleUser.id);
  assert.equal((await db.users.findByGoogleSubject(googleSubject)).id, googleUser.id);
  await assert.rejects(
    db.users.createEmailAccount({ email: nextEmail(), name: 'Duplicate Google', googleSubject }),
    (error) => error.code === 'GOOGLE_IDENTITY_EXISTS',
  );

  const contactPhone = nextPhone();
  const updated = await db.users.updateContactPhone(user.id, contactPhone);
  assert.equal(updated.phone, null, 'contact information does not become a sign-in phone');
  assert.equal(updated.contactPhone, contactPhone);
  assert.equal(await db.users.findByPhone(contactPhone), null, 'contact numbers never find an account');
});

test('a legacy email is linked only from the already authenticated phone account', async (t) => {
  if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
  const phone = nextPhone();
  const legacyEmail = nextEmail();
  const legacy = await db.users.upsertByPhone({ phone, name: 'Legacy Customer' });
  made.users.push(legacy.id);
  await db.users.updateProfile(legacy.id, { email: legacyEmail });

  assert.equal((await db.users.findLegacyEmailOwner(legacyEmail)).id, legacy.id);
  await assert.rejects(
    db.users.createEmailAccount({ email: legacyEmail, name: 'Duplicate Customer' }),
    (error) => error.code === 'LEGACY_EMAIL_REQUIRES_PHONE_LINK',
  );

  const linked = await db.users.linkVerifiedEmail(legacy.id, legacyEmail);
  assert.equal(linked.id, legacy.id, 'linking retains the existing account and its history');
  assert.equal(linked.phone, phone);
  assert.equal(linked.emailVerified, true);
  assert.equal((await db.users.findByVerifiedEmail(legacyEmail)).id, legacy.id);

  const other = await db.users.createEmailAccount({ email: nextEmail(), name: 'Another Customer' });
  made.users.push(other.id);
  await assert.rejects(
    db.users.linkVerifiedEmail(other.id, legacyEmail),
    (error) => error.code === 'EMAIL_IN_USE',
  );

  const reservedEmail = nextEmail();
  const reservedPhone = nextPhone();
  const reservedLegacy = await db.users.upsertByPhone({ phone: reservedPhone, name: 'Another Legacy Customer' });
  made.users.push(reservedLegacy.id);
  await db.users.updateProfile(reservedLegacy.id, { email: reservedEmail });
  await assert.rejects(
    db.users.linkVerifiedEmail(other.id, reservedEmail),
    (error) => error.code === 'LEGACY_EMAIL_REQUIRES_PHONE_LINK',
  );
  const reservedLinked = await db.users.linkVerifiedEmail(reservedLegacy.id, reservedEmail);
  assert.equal(reservedLinked.id, reservedLegacy.id, 'only that signed-in legacy account can claim its old profile email');
});

test('a staff-created escrow milestone inherits the signed-in owner of its booking', async (t) => {
  if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
  const customer = await db.users.createEmailAccount({ email: nextEmail(), name: 'Email Buyer' });
  made.users.push(customer.id);
  const contactPhone = nextPhone();
  const bookingReference = `HC-BK-${process.pid.toString(36)}-${Date.now().toString(36)}-${sequence.toString(36)}`.toUpperCase().slice(0, 24);
  const bookingInsert = await db.query(
    `INSERT INTO bookings (reference, type, service_slug, slot_at, location, name, phone, user_id, status)
     VALUES (?, 'inspection', 'inspection', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY), 'Woji', ?, ?, ?, 'requested')`,
    [bookingReference, 'Email Buyer', contactPhone, customer.id],
  );
  const booking = { id: bookingInsert.insertId };
  made.bookings.push(booking.id);

  const milestone = await db.payments.createMilestone({
    kind: 'protected_purchase',
    subject: 'Escrow linked to an email-only customer',
    bookingId: booking.id,
    customerName: 'Email Buyer',
    customerPhone: contactPhone,
    amountKobo: 5_000_000,
  });
  assert.equal(milestone.ok, true);
  made.milestones.push(milestone.id);
  const row = await db.payments.milestoneById(milestone.id);
  assert.equal(Number(row.userId), Number(customer.id));
  const accountRows = await db.payments.milestonesForPhone(null, { userId: customer.id });
  assert.ok(accountRows.some((item) => Number(item.id) === Number(milestone.id)));
});

test('email codes are account-bound, rate-counted, and single-use', async (t) => {
  if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
  const email = nextEmail();
  const owner = await db.users.createEmailAccount({ email: nextEmail(), name: 'Code Owner' });
  made.users.push(owner.id);
  const codeId = await db.users.createEmailCode({
    email,
    purpose: 'link',
    userId: owner.id,
    codeHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 5 * 60_000),
    ip: '127.0.0.1',
    maxAttempts: 5,
  });

  const active = await db.users.findActiveEmailCode(email, 'link', owner.id);
  assert.equal(active.id, codeId);
  assert.equal(active.email, email);
  assert.equal(active.userId, owner.id);
  assert.equal(await db.users.findActiveEmailCode(email, 'link', owner.id + 1), null, 'another account cannot spend the code');
  assert.equal(await db.users.findActiveEmailCode(email, 'sign_in'), null);
  assert.equal(await db.users.countRecentEmailCodes(email, 'link'), 1);
  assert.equal(await db.users.registerEmailAttempt(codeId), 1);
  await db.users.consumeEmailCode(codeId);
  assert.equal(await db.users.findActiveEmailCode(email, 'link', owner.id), null);
});
