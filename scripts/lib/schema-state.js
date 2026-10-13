'use strict';

/**
 * What `db/schema.sql` declares, and whether a database matches it.
 *
 * `db/schema.sql` is the *state* of the database; `db/migrations/` is the path
 * an older database takes to reach it. That distinction matters, because the
 * migrations are transitions, not assertions — they move a schema forward
 * through intermediate shapes, and some of those shapes are narrower than the
 * current one. `020-hire-management.sql` narrows `payments.purpose` to an enum
 * without `'addon'`, which `022` adds back. Replaying the series against a
 * database that is already current therefore *rewinds* that column, and MySQL
 * truncates any row using a value the intermediate shape does not know.
 *
 * So before either runner touches the migrations it has to answer one question:
 * was this database built from `schema.sql`, or has it been following the
 * migration path? A `schema_migrations` table answers it — its absence means
 * nobody has ever run a migration here, and a database that matches
 * `schema.sql` already contains every migration's effect.
 *
 * This module provides the comparison that backs that decision, and keeps it
 * honest: it does not assume the match, it checks the tables, the columns and
 * the views.
 */

/** Leading words inside a CREATE TABLE body that are not column names. */
const NOT_COLUMNS = new Set([
  'primary', 'unique', 'key', 'index', 'constraint', 'foreign', 'fulltext', 'spatial', 'check',
]);

/**
 * Every table, column and view a .sql file declares.
 *
 * Deliberately a light parser rather than a complete one: it only has to
 * understand the conventions `db/schema.sql` follows — one column per line,
 * backticked or bare identifiers, `CREATE TABLE IF NOT EXISTS` and
 * `CREATE OR REPLACE VIEW`.
 *
 * @param {string} sql
 * @returns {{tables: Map<string, Set<string>>, views: Set<string>}}
 */
function declaredObjects(sql) {
  const clean = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');

  const tables = new Map();
  const views = new Set();

  for (const match of clean.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([\w$]+)`?\s*\(([^;]*?)\)\s*ENGINE/gi)) {
    const name = match[1].toLowerCase();
    const columns = new Set();
    // A definition only starts on a line that follows a comma (or the opening
    // paren). Without this, a wrapped definition — `CONSTRAINT … FOREIGN KEY (x)`
    // on one line and `REFERENCES y (z)` on the next, or an enum with its
    // NOT NULL on the following line — reads as columns called `references`
    // and `not`. That is not a hypothetical: it is what this parser did.
    let startsDefinition = true;
    for (const raw of match[2].split('\n')) {
      const line = raw.replace(/--.*$/, '').trim();
      if (!line) continue;

      if (startsDefinition) {
        const column = line.match(/^`?([A-Za-z_][\w$]*)`?\s+[A-Za-z]/);
        if (column && !NOT_COLUMNS.has(column[1].toLowerCase())) columns.add(column[1].toLowerCase());
      }
      startsDefinition = line.endsWith(',');
    }
    tables.set(name, columns);
  }

  for (const match of clean.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+`?([\w$]+)`?/gi)) {
    views.add(match[1].toLowerCase());
  }

  return { tables, views };
}

/**
 * Compare what a schema declares with what a database actually has.
 *
 * @param {{tables: Map<string, Set<string>>, views: Set<string>}} declared
 * @param {{tables: Map<string, Set<string>>, views: Set<string>}} actual
 * @returns {{missingTables: string[], missingColumns: string[], missingViews: string[]}}
 */
function compare(declared, actual) {
  const missingTables = [];
  const missingColumns = [];

  for (const [table, columns] of declared.tables) {
    const present = actual.tables.get(table);
    if (!present) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) missingColumns.push(`${table}.${column}`);
    }
  }

  const missingViews = [...declared.views].filter((view) => !actual.views.has(view));

  return {
    missingTables: missingTables.sort(),
    missingColumns: missingColumns.sort(),
    missingViews: missingViews.sort(),
  };
}

/**
 * Read the database's own description of itself.
 *
 * @param {import('mysql2/promise').Connection} conn
 * @param {string} database
 * @returns {Promise<{tables: Map<string, Set<string>>, views: Set<string>}>}
 */
async function actualObjects(conn, database) {
  const [tableRows] = await conn.query(
    `SELECT table_name AS name, table_type AS type
       FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type IN ('BASE TABLE', 'VIEW')`,
    [database],
  );

  const tables = new Map();
  const views = new Set();
  for (const row of tableRows) {
    const name = String(row.name).toLowerCase();
    if (row.type === 'VIEW') views.add(name);
    else tables.set(name, new Set());
  }

  if (tables.size) {
    const [columnRows] = await conn.query(
      // `column` is reserved: alias it to `col`.
      `SELECT table_name AS name, column_name AS col
         FROM information_schema.columns
        WHERE table_schema = ?`,
      [database],
    );
    for (const row of columnRows) {
      const set = tables.get(String(row.name).toLowerCase());
      if (set) set.add(String(row.col).toLowerCase());
    }
  }

  return { tables, views };
}

/** A printable summary of a comparison, empty string when everything matches. */
function describeGaps(gaps, limit = 6) {
  const parts = [];
  const list = (items) => {
    const shown = items.slice(0, limit).join(', ');
    return items.length > limit ? `${shown} (+${items.length - limit} more)` : shown;
  };
  if (gaps.missingTables.length) parts.push(`tables: ${list(gaps.missingTables)}`);
  if (gaps.missingColumns.length) parts.push(`columns: ${list(gaps.missingColumns)}`);
  if (gaps.missingViews.length) parts.push(`views: ${list(gaps.missingViews)}`);
  return parts.join('; ');
}

module.exports = { declaredObjects, compare, actualObjects, describeGaps, NOT_COLUMNS };
