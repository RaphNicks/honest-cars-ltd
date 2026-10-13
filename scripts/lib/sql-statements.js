'use strict';

/**
 * Turning a .sql file into statements, for `db-setup.js` and `migrate.js`.
 *
 * They used to do this separately and slightly differently, which is how a
 * defect can live in one path and not the other. The rules are:
 *
 *   · `--` comment lines are dropped (a semicolon inside a comment must not
 *     split a statement);
 *   · statements are split on `;` and trimmed, empties discarded;
 *   · `USE …` is dropped.
 *
 * The last one matters more than it looks. A migration that says `USE honestcars`
 * sets the *session's* database, so on an install whose database is named
 * anything else — a laptop testing against `honestcars_dev`, say — the rest of
 * that file silently runs against a different database, and the row recording
 * the migration is written there too. Two of the committed migrations did
 * exactly that. The connection is already pointed at the right database before
 * any of these run, so a `USE` statement is never wanted here; dropping it is
 * the difference between "the runner cannot go to the wrong database" and
 * "it can, quietly".
 *
 * `test/migrations.test.js` fails if a migration file contains one, so the
 * rule is enforced at the source as well as here.
 */

/** A statement that only switches database, e.g. `USE honestcars;`. */
const USE_STATEMENT = /^USE\s+[`"']?[\w$]+[`"']?$/i;

/**
 * @param {string} sql the contents of a .sql file
 * @returns {string[]} statements to execute, in order
 */
function statementsOf(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement && !USE_STATEMENT.test(statement));
}

module.exports = { statementsOf, USE_STATEMENT };
