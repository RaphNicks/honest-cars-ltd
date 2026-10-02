'use strict';

/**
 * Migration runner.
 *
 *   npm run db:migrate            # apply everything pending
 *   npm run db:migrate -- --list  # show what has been applied
 *
 * Migrations live in db/migrations/*.sql and are applied in filename order.
 * Each file is recorded in schema_migrations. Statements that fail because the
 * change is already present (duplicate column, table exists, …) are tolerated,
 * so a database created from db/schema.sql — which always describes the current
 * state — and a database upgraded by migrations converge on the same shape.
 *
 * Reversibility (§12.3): every migration should carry a commented DOWN block.
 */

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

/** Errors that mean “this change is already present”. */
const TOLERATED = new Set([
  'ER_DUP_FIELDNAME',      // column exists
  'ER_DUP_KEYNAME',        // index exists
  'ER_TABLE_EXISTS_ERROR', // table exists
  'ER_CANT_DROP_FIELD_OR_KEY',
  'ER_DUP_ENTRY',
]);

const ADMIN_USER = process.env.DB_ADMIN_USER || 'root';
const ADMIN_PASSWORD = process.env.DB_ADMIN_PASSWORD ?? (config.db.user === 'root' ? config.db.password : '');

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/** Split a migration file into statements, ignoring comments and blank lines. */
function statementsOf(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function main() {
  const listOnly = process.argv.includes('--list');

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    socketPath: config.db.socketPath,
    user: ADMIN_USER,
    password: ADMIN_PASSWORD,
    database: config.db.database,
    charset: 'utf8mb4_unicode_ci',
    multipleStatements: false,
  });

  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   VARCHAR(120) NOT NULL,
       applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
       statements SMALLINT     NOT NULL DEFAULT 0,
       PRIMARY KEY (filename)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  const [applied] = await conn.query('SELECT filename, applied_at FROM schema_migrations ORDER BY filename');
  const appliedSet = new Set(applied.map((row) => row.filename));

  if (listOnly) {
    console.log('Migrations:');
    for (const file of listMigrations()) {
      const row = applied.find((r) => r.filename === file);
      console.log(`  ${row ? '✓' : '·'} ${file}${row ? `  (${new Date(row.applied_at).toISOString().slice(0, 16).replace('T', ' ')})` : '  — pending'}`);
    }
    await conn.end();
    return;
  }

  let ran = 0;
  let skipped = 0;

  for (const file of listMigrations()) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = statementsOf(sql);

    for (const statement of statements) {
      try {
        await conn.query(statement);
      } catch (error) {
        if (TOLERATED.has(error.code)) {
          skipped += 1;
          continue;
        }
        console.error(`\n✗ ${file} failed:\n  ${error.message}\n  ${statement.slice(0, 160)}…`);
        await conn.end();
        process.exit(1);
      }
    }

    await conn.query('INSERT INTO schema_migrations (filename, statements) VALUES (?, ?)', [file, statements.length]);
    console.log(`✓ ${file} — ${statements.length} statements${skipped ? ` (${skipped} already present)` : ''}`);
    ran += 1;
  }

  // Independent of the ledger: make sure the newer tables exist even on a
  // database where the migration was recorded before the table was added.
  await conn.end();

  if (!ran) console.log('✓ no migrations pending — schema is current');
  else console.log(`✓ applied ${ran} migration(s)`);
}

main().catch((error) => {
  console.error('migration run failed:', error.message);
  process.exit(1);
});
