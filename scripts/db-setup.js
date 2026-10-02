'use strict';

/**
 * Create the database, apply db/schema.sql, then load db/seed.sql.
 *
 *   node scripts/db-setup.js                 # schema + seed
 *   node scripts/db-setup.js --schema-only   # no data
 *   node scripts/db-setup.js --no-seed
 *
 * Uses the DB_* variables from .env. To create the database and app user it
 * needs an account with CREATE privileges — set DB_ADMIN_USER /
 * DB_ADMIN_PASSWORD, or leave them blank to use DB_USER as-is (works on the
 * bundled sandbox server, where root has no password).
 */

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

const args = new Set(process.argv.slice(2));
const schemaOnly = args.has('--schema-only');
const skipSeed = args.has('--no-seed') || schemaOnly;

const ADMIN_USER = process.env.DB_ADMIN_USER || (process.env.DB_USER === 'root' ? 'root' : 'root');
const ADMIN_PASSWORD = process.env.DB_ADMIN_PASSWORD ?? (process.env.DB_USER === 'root' ? config.db.password : '');

/**
 * Apply db/migrations/*.sql in order, tolerating “already present” errors so a
 * database created from schema.sql and one upgraded by migrations converge.
 * Mirrors scripts/migrate.js — kept inline so `db:setup` is a single command.
 */
async function runMigrations(conn) {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  if (!fs.existsSync(dir)) return;

  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   VARCHAR(120) NOT NULL,
       applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
       statements SMALLINT     NOT NULL DEFAULT 0,
       PRIMARY KEY (filename)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  const [applied] = await conn.query('SELECT filename FROM schema_migrations');
  const done = new Set(applied.map((row) => row.filename));
  const tolerated = new Set(['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_CANT_DROP_FIELD_OR_KEY']);

  let count = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const statements = fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await conn.query(statement);
      } catch (error) {
        if (!tolerated.has(error.code)) throw error;
      }
    }
    await conn.query('INSERT INTO schema_migrations (filename, statements) VALUES (?, ?)', [file, statements.length]);
    count += 1;
  }
  if (count) console.log(`✓ migrations applied (${count})`);
}

async function main() {
  const baseOptions = {
    host: config.db.host,
    port: config.db.port,
    socketPath: config.db.socketPath,
    charset: 'utf8mb4_unicode_ci',
    multipleStatements: true,
    connectTimeout: 15000,
  };

  console.log(`→ connecting to MySQL at ${config.db.socketPath || `${config.db.host}:${config.db.port}`} as ${ADMIN_USER}`);

  const admin = await mysql.createConnection({
    ...baseOptions,
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
  });

  const dbName = config.db.database;
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  console.log(`✓ database \`${dbName}\` ready`);

  if (config.db.user !== ADMIN_USER) {
    try {
      await admin.query(
        `CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`,
        [config.db.user, config.db.password],
      );
      await admin.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'%'`, [config.db.user]);
      await admin.query('FLUSH PRIVILEGES');
      console.log(`✓ app user \`${config.db.user}\` granted on \`${dbName}\``);
    } catch (error) {
      console.warn(`! could not create app user (${error.code || error.message}) — continuing as ${ADMIN_USER}`);
    }
  }

  await admin.end();

  const conn = await mysql.createConnection({ ...baseOptions, user: ADMIN_USER, password: ADMIN_PASSWORD, database: dbName });

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await conn.query(schema);
  console.log('✓ schema applied (tables + views)');

  // Bring an older database up to the current schema, then record it.
  await runMigrations(conn);

  if (!skipSeed) {
    const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
    await conn.query(seed);
    const [[counts]] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM vehicle_listings) AS listings,
         (SELECT COUNT(*) FROM listing_media) AS media,
         (SELECT COUNT(*) FROM facets WHERE indexable = 1) AS facets,
         (SELECT COUNT(*) FROM services) AS services,
         (SELECT COUNT(*) FROM blog_posts WHERE status = 'published') AS posts`,
    );
    console.log(`✓ seed loaded — ${counts.listings} listings, ${counts.media} media rows, ${counts.facets} curated facets, ${counts.services} services, ${counts.posts} posts`);
  }

  await conn.end();
  console.log('\nDone. Start the site with: npm start');
}

main().catch((error) => {
  console.error('\n✗ setup failed:', error.code || '', error.message);
  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('  Check DB_USER / DB_PASSWORD in .env (see .env.example).');
  }
  if (error.code === 'ECONNREFUSED') {
    console.error('  Is MySQL running? Check DB_HOST / DB_PORT / DB_SOCKET in .env.');
  }
  process.exit(1);
});
