'use strict';

/**
 * One-time first-admin provisioning for a fresh production database.
 *
 * This is deliberately separate from public sign-up and refuses to run once
 * an active admin exists. It creates no password, OTP, or TOTP secret; the
 * administrator proves phone ownership at sign-in and enrolls TOTP in the
 * console. See README.md before using it on a live database.
 */

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const config = require('../src/config');
const db = require('../src/db');
const phones = require('../src/lib/phone');
const validate = require('../src/services/validate');

const BOOTSTRAP_LOCK = 'honestcars:first-admin-bootstrap';

async function createFirstAdmin({ pool, name: rawName, phone: rawPhone }) {
  const name = validate.name(rawName);
  const phone = phones.normalise(rawPhone);
  if (!name) throw new Error('Enter an administrator name at least two characters long.');
  if (!phone) throw new Error('Enter a valid Nigerian mobile number.');

  const conn = await pool.getConnection();
  let locked = false;
  let inTransaction = false;
  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS acquired', [BOOTSTRAP_LOCK]);
    if (Number(lockRows[0] && lockRows[0].acquired) !== 1) {
      throw new Error('Could not lock first-admin setup. Wait a moment and try again.');
    }
    locked = true;

    await conn.beginTransaction();
    inTransaction = true;

    const [admins] = await conn.query(
      "SELECT id FROM `users` WHERE role = 'admin' AND status = 'active' LIMIT 1 FOR UPDATE",
    );
    if (admins.length) {
      await conn.rollback();
      inTransaction = false;
      return { ok: false, error: 'An active admin already exists. Use the console to manage staff instead.' };
    }

    const [existing] = await conn.query('SELECT id FROM `users` WHERE phone = ? LIMIT 1 FOR UPDATE', [phone]);
    if (existing.length) {
      await conn.rollback();
      inTransaction = false;
      return { ok: false, error: 'That phone number already belongs to an account. No account was changed.' };
    }

    const [inserted] = await conn.query(
      "INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, 'admin', 'active')",
      [phone, name],
    );
    const userId = Number(inserted.insertId);
    await conn.query(
      'INSERT INTO admin_audit (actor_id, action, entity, entity_id, detail) VALUES (NULL, ?, ?, ?, ?)',
      ['user.bootstrap', 'user', userId, JSON.stringify({ role: 'admin', source: 'first-admin-cli' })],
    );

    await conn.commit();
    inTransaction = false;
    return { ok: true, userId, name, phone };
  } catch (error) {
    if (inTransaction) await conn.rollback().catch(() => {});
    throw error;
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [BOOTSTRAP_LOCK]).catch(() => {});
    conn.release();
  }
}

async function main() {
  if (!config.isProduction) {
    throw new Error('Refusing to create a real admin outside production. Set NODE_ENV=production on the host.');
  }
  if (!config.auth.pepper || config.auth.pepper.length < 32) {
    throw new Error('Set a strong AUTH_PEPPER (at least 32 characters) in the host secret manager first.');
  }

  const prompts = readline.createInterface({ input: stdin, output: stdout });
  try {
    const name = validate.name(await prompts.question('Administrator full name: '));
    if (!name) throw new Error('Enter a name at least two characters long.');

    const rawPhone = await prompts.question('Administrator mobile number (for example, 0803 123 4567): ');
    const phone = phones.normalise(rawPhone);
    if (!phone) throw new Error('Enter a valid Nigerian mobile number.');

    console.log(`\nThis will create the first active admin for ${name} (${phones.mask(phone)}).`);
    console.log('The account has no password or pre-seeded authenticator secret.');
    const confirmation = await prompts.question('Type CREATE FIRST ADMIN to continue: ');
    if (confirmation.trim() !== 'CREATE FIRST ADMIN') throw new Error('Setup cancelled; no account was created.');

    const result = await createFirstAdmin({ pool: db.pool, name, phone });
    if (!result.ok) throw new Error(result.error);

    console.log(`\nFirst admin account created (ID ${result.userId}, phone ${phones.mask(result.phone)}).`);
    console.log(`Sign in at ${config.admin.url}/login, then enroll an authenticator at /admin/security.`);
    console.log('Phone OTP delivery is still a stub in this build; production login will remain unavailable until a real provider adapter is installed.');
  } finally {
    prompts.close();
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Admin bootstrap stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createFirstAdmin };
