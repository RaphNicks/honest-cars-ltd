'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFirstAdmin } = require('../scripts/bootstrap-admin');

function fakePool({ admins = [], existingPhones = [], insertId = 17 } = {}) {
  const calls = [];
  const state = { committed: false, rolledBack: false, released: false };
  const conn = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql.includes("role = 'admin'")) return [admins.map((id) => ({ id })), []];
      if (sql.includes('WHERE phone = ?')) {
        const matches = existingPhones.includes(params[0]) ? [{ id: 3 }] : [];
        return [matches, []];
      }
      if (sql.startsWith('INSERT INTO `users`')) return [{ insertId }, []];
      return [{ affectedRows: 1 }, []];
    },
    async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
    async commit() { state.committed = true; calls.push({ sql: 'COMMIT' }); },
    async rollback() { state.rolledBack = true; calls.push({ sql: 'ROLLBACK' }); },
    release() { state.released = true; },
  };
  return {
    calls,
    state,
    pool: { async getConnection() { return conn; } },
  };
}

test('bootstrap creates the first admin with a normalized phone and an audit row, but no seeded MFA secret', async () => {
  const fake = fakePool();
  const result = await createFirstAdmin({ pool: fake.pool, name: 'Ada Obi', phone: '0803 123 4567' });

  assert.deepEqual(result, { ok: true, userId: 17, name: 'Ada Obi', phone: '+2348031234567' });
  assert.equal(fake.state.committed, true);
  assert.equal(fake.state.rolledBack, false);
  assert.equal(fake.state.released, true);
  const insert = fake.calls.find((call) => call.sql.startsWith('INSERT INTO `users`'));
  assert.match(insert.sql, /phone, name, role, status/);
  assert.doesNotMatch(insert.sql, /totp_secret|password/i);
  assert.deepEqual(insert.params, ['+2348031234567', 'Ada Obi']);
  const audit = fake.calls.find((call) => call.sql.startsWith('INSERT INTO admin_audit'));
  assert.equal(audit.params[0], 'user.bootstrap');
  assert.equal(audit.params[2], 17);
  assert.deepEqual(JSON.parse(audit.params[3]), { role: 'admin', source: 'first-admin-cli' });
});

test('bootstrap refuses to create a second active admin', async () => {
  const fake = fakePool({ admins: [4] });
  const result = await createFirstAdmin({ pool: fake.pool, name: 'Ada Obi', phone: '0803 123 4567' });

  assert.equal(result.ok, false);
  assert.match(result.error, /active admin already exists/i);
  assert.equal(fake.state.committed, false);
  assert.equal(fake.state.rolledBack, true);
  assert.equal(fake.calls.some((call) => call.sql.startsWith('INSERT INTO `users`')), false);
  assert.equal(fake.state.released, true);
});

test('bootstrap does not silently promote an account that already owns the phone', async () => {
  const fake = fakePool({ existingPhones: ['+2348031234567'] });
  const result = await createFirstAdmin({ pool: fake.pool, name: 'Ada Obi', phone: '0803 123 4567' });

  assert.equal(result.ok, false);
  assert.match(result.error, /already belongs to an account/i);
  assert.equal(fake.calls.some((call) => call.sql.startsWith('INSERT INTO `users`')), false);
  assert.equal(fake.state.rolledBack, true);
});

test('bootstrap validates the name and phone before opening a database connection', async () => {
  let connections = 0;
  const pool = { async getConnection() { connections += 1; throw new Error('unexpected connection'); } };

  await assert.rejects(createFirstAdmin({ pool, name: 'A', phone: '123' }), /name at least two/);
  await assert.rejects(createFirstAdmin({ pool, name: 'Ada Obi', phone: '123' }), /valid Nigerian mobile/);
  assert.equal(connections, 0);
});
