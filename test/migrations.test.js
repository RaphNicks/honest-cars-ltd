'use strict';

/**
 * The migration files and the rules that keep `db:setup` portable.
 *
 * The bug this suite exists for: two migrations carried `USE honestcars;`, so
 * on any install whose database is named anything else — a laptop testing
 * against `honestcars_dev` — the rest of the file ran against a *different*
 * database and the row recording it was written there too. `npm run db:setup`
 * died with a duplicate-key error that said nothing about the real cause.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { statementsOf } = require('../scripts/lib/sql-statements');

const DIR = path.join(__dirname, '..', 'db', 'migrations');
const files = fs.readdirSync(DIR).filter((file) => file.endsWith('.sql')).sort();
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

test('no migration switches database', () => {
  // The runner connects to the database named in .env. A `USE` here would move
  // the session somewhere else, and nothing downstream would notice.
  const offenders = files.filter((file) => /^\s*USE\b/im.test(read(file)));
  assert.deepEqual(offenders, [], `these migration files hardcode a database: ${offenders.join(', ')}`);
});

test('the splitter drops a USE statement rather than passing it on', () => {
  // Belt and braces: should one be added again, the runners ignore it instead of
  // silently switching database. `test/migrations.test.js` still fails, above.
  const statements = statementsOf('USE honestcars;\nSELECT 1;\nUSE other_db;\nSELECT 2;');
  assert.deepEqual(statements.filter((s) => /^USE\b/i.test(s)), [], 'no USE statement may survive splitting');
  assert.equal(statements.length, 2, 'the real statements must survive');
});

test('the splitter keeps a semicolon that is inside a comment with the comment', () => {
  const statements = statementsOf([
    '-- a comment with a ; in it',
    'CREATE TABLE t (id INT);',
    '',
    '-- another ; comment',
    'ALTER TABLE t ADD COLUMN name VARCHAR(10);',
  ].join('\n'));
  assert.equal(statements.length, 2);
  assert.match(statements[0], /CREATE TABLE/);
  assert.match(statements[1], /ALTER TABLE/);
});

test('the migrations are numbered, unique and in order', () => {
  const numbers = files.map((file) => Number(file.slice(0, 3)));
  assert.ok(numbers.every((n) => Number.isInteger(n) && n > 0), 'every file starts with a number');
  assert.equal(new Set(numbers).size, numbers.length, 'no two migrations share a number');
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'the directory sorts the way it applies');
  for (const file of files) {
    assert.match(file, /^\d{3}-[a-z0-9-]+\.sql$/, `${file} must be NNN-name.sql`);
  }
});

test('schema.sql already contains every table the migrations create', () => {
  // The phpMyAdmin / "import the two files by hand" route is documented in
  // docs/RUN-LOCALLY.md and deliberately has no migration step: db/schema.sql
  // is the current state of the database, db/seed.sql is its data. That is only
  // true while schema.sql keeps up with the migrations — the moment one adds a
  // table and schema.sql is not updated, a laptop user importing by hand gets a
  // database the app cannot boot against, and nothing in the suite would say so.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const created = new Set(
    [...schema.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([\w]+)`?/gi)].map((m) => m[1].toLowerCase()),
  );

  const wanted = new Map();
  for (const file of files) {
    for (const match of read(file).matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([\w]+)`?/gi)) {
      wanted.set(match[1].toLowerCase(), file);
    }
  }

  const missing = [...wanted.entries()].filter(([table]) => !created.has(table));
  assert.deepEqual(
    missing.map(([table, file]) => `${table} (${file})`),
    [],
    'db/schema.sql must describe the current database — regenerate it when a migration adds a table',
  );
});

test('every migration says what it is for, and new ones how to undo it', () => {
  // §12.3: reversible changes. Every migration opens with a header saying what
  // it changes and why. A commented DOWN block is the other half — but only 17
  // of the first 28 carry one, because the early ones predate the rule, so the
  // requirement is enforced from 030 onwards rather than pretending the older
  // files meet a standard they were never written to.
  const FIRST_REQUIRED = 30;
  for (const file of files) {
    const sql = read(file);
    // Two rule styles are in use across the set — `---…` early, `===…` later.
    assert.ok(/^\s*-- [-=]{10,}/.test(sql), `${file} must open with its header rule`);
    if (Number(file.slice(0, 3)) >= FIRST_REQUIRED) {
      assert.match(sql, /--\s*DOWN/i, `${file} must carry a commented DOWN block (§12.3)`);
    }
  }
});

// ---------------------------------------------------------------------------
// schema.sql versus the migrations — the distinction the runners now enforce.
// ---------------------------------------------------------------------------

const { declaredObjects, compare, describeGaps } = require('../scripts/lib/schema-state');

test('the declarations are read out of schema.sql, tables and columns and views', () => {
  const { tables, views } = declaredObjects(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

  assert.ok(tables.size > 40, `expected the whole schema, found ${tables.size} tables`);
  assert.equal(views.size, 3, 'the three sold-archive views');

  // A named table, with its columns and without its keys.
  const consent = tables.get('consent_records');
  assert.ok(consent, 'consent_records must be found');
  assert.ok(consent.has('purpose') && consent.has('notice'), 'columns come through');
  assert.ok(!consent.has('primary'), 'PRIMARY KEY is not a column');
  assert.ok(!consent.has('key'), 'KEY is not a column');
  assert.ok(!consent.has('constraint'), 'CONSTRAINT is not a column');
});

test('a wrapped definition is not mistaken for a column', () => {
  // The trap this parser first fell into: a definition continued on the next
  // line read as a column named `references` or `not`, which made a perfectly
  // current database look like it was missing thirteen columns.
  const { tables } = declaredObjects([
    'CREATE TABLE IF NOT EXISTS `t` (',
    '  id      INT UNSIGNED NOT NULL,',
    '  status  ENUM(\'active\',\'inactive\')',
    '            NOT NULL DEFAULT \'active\',',
    '  owner   INT UNSIGNED NULL,',
    '  PRIMARY KEY (id),',
    '  CONSTRAINT fk_t_owner  FOREIGN KEY (owner)',
    '                         REFERENCES `users` (id) ON DELETE SET NULL',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
  ].join('\n'));
  assert.deepEqual([...tables.get('t')].sort(), ['id', 'owner', 'status']);
});

test('an inline comment on a column line does not become a column', () => {
  const { tables } = declaredObjects([
    'CREATE TABLE IF NOT EXISTS `t` (',
    '  id      INT UNSIGNED NOT NULL,',
    '  phone   VARCHAR(40)  NULL,   -- canonical, when we have one',
    '  PRIMARY KEY (id)',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
  ].join('\n'));
  assert.deepEqual([...tables.get('t')].sort(), ['id', 'phone']);
});

test('compare names what is missing, and nothing when nothing is', () => {
  const declared = declaredObjects([
    'CREATE TABLE IF NOT EXISTS `a` (\n  id INT NOT NULL,\n  name VARCHAR(10),\n  PRIMARY KEY (id)\n) ENGINE=InnoDB;',
    'CREATE TABLE IF NOT EXISTS `b` (\n  id INT NOT NULL\n) ENGINE=InnoDB;',
    'CREATE OR REPLACE VIEW v AS SELECT 1;',
  ].join('\n'));

  // A database that matches.
  const same = new Map([['a', new Set(['id', 'name'])], ['b', new Set(['id'])]]);
  assert.equal(describeGaps(compare(declared, { tables: same, views: new Set(['v']) })), '');

  // One missing column, one missing table, one missing view.
  const short = new Map([['a', new Set(['id'])]]);
  const gaps = compare(declared, { tables: short, views: new Set() });
  assert.deepEqual(gaps.missingColumns, ['a.name']);
  assert.deepEqual(gaps.missingTables, ['b']);
  assert.deepEqual(gaps.missingViews, ['v']);
  assert.match(describeGaps(gaps), /tables: b/);
});

test('a long gap list is truncated rather than printed whole', () => {
  const declared = declaredObjects(
    ['CREATE TABLE IF NOT EXISTS `t` ('].concat(
      // Zero-padded so the alphabetical sort in `compare` is what a reader expects.
      Array.from({ length: 20 }, (_, i) => `  col${String(i).padStart(2, '0')} INT NOT NULL,`),
      ['  PRIMARY KEY (col00)', ') ENGINE=InnoDB;'],
    ).join('\n'),
  );
  const gaps = compare(declared, { tables: new Map([['t', new Set()]]), views: new Set() });
  const text = describeGaps(gaps, 3);
  assert.match(text, /columns: t\.col00, t\.col01, t\.col02 \(\+17 more\)/, `got: ${text}`);
});
