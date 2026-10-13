'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const users = require('../src/db/users');
const { dbAvailable } = require('./helpers');

let available = false;
let db;
let sequence = 0;
const made = { users: [], phones: [], emails: new Set() };

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
});

test('email codes are scoped by purpose, rate-counted, and single-use', async (t) => {
  if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
  const email = nextEmail();
  const codeId = await db.users.createEmailCode({
    email,
    purpose: 'link',
    codeHash: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 5 * 60_000),
    ip: '127.0.0.1',
    maxAttempts: 5,
  });

  const active = await db.users.findActiveEmailCode(email, 'link');
  assert.equal(active.id, codeId);
  assert.equal(active.email, email);
  assert.equal(await db.users.findActiveEmailCode(email, 'sign_in'), null);
  assert.equal(await db.users.countRecentEmailCodes(email, 'link'), 1);
  assert.equal(await db.users.registerEmailAttempt(codeId), 1);
  await db.users.consumeEmailCode(codeId);
  assert.equal(await db.users.findActiveEmailCode(email, 'link'), null);
});
