'use strict';

/**
 * Connection layer. The only place in the app that knows how to reach MySQL —
 * point it at your laptop instance by changing .env, nothing else.
 */

const mysql = require('mysql2/promise');
const config = require('../config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  socketPath: config.db.socketPath,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  charset: config.db.charset,
  timezone: config.db.timezone,
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
  namedPlaceholders: false,
  // MySQL 5.7 in the sandbox / MariaDB on a laptop: keep the wire protocol
  // conservative so both behave identically.
  multipleStatements: false,
  connectTimeout: 10000,
});

/** Run a parameterised query. Always use placeholders — never string concat. */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Convenience: first row or null. */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** Transaction helper for multi-statement writes. */
async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/** Used by /healthz and the DB setup script. */
async function healthcheck() {
  const row = await queryOne('SELECT 1 AS ok, DATABASE() AS db, VERSION() AS version');
  return { ok: Boolean(row && row.ok), database: row.db, version: row.version };
}

module.exports = { pool, query, queryOne, transaction, healthcheck };
