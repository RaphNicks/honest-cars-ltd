'use strict';

/**
 * Settings overrides held in memory.
 *
 * The storefront reads a setting on almost every page render — the footer's
 * phone number, the SLA card's retainer, the channel a message goes to — so the
 * values that are in force live here rather than behind a query per read. The
 * service layer (`src/services/settings.js`) loads them at boot, and again after
 * the console saves or resets one, on the same process.
 *
 * What this file deliberately is **not**:
 *
 *   • **Not a cache of the database.** It holds a copy of the *overrides*; the
 *     defaults come from the registry and the environment, so an empty map means
 *     "behave exactly as the .env says", which is the state a fresh install is
 *     in.
 *   • **Not multi-process.** Settings are written from the console and hydrated
 *     in the process that serves the site. That is the whole deployment here; a
 *     second web process would need a `hydrate()` on a timer or a pub/sub nudge,
 *     and until there is one, saying so is better than pretending.
 *
 * A row whose key is not in the registry is ignored on load rather than applied:
 * a typo in a manual INSERT must not quietly change a number, and the loader
 * reports the ignored keys so ops can see them.
 */

const schema = require('./settings-schema');

/** key → stored string. */
let stored = new Map();

/** When the newest override was written, or null when there are none. */
let changedAt = null;

/** Replace everything from a list of `{ setting_key, setting_value }` rows. */
function hydrate(rows = []) {
  const next = new Map();
  const ignored = [];
  let newest = null;
  for (const row of rows) {
    const key = row.setting_key ?? row.key;
    const value = row.setting_value ?? row.value;
    if (!key) continue;
    if (!schema.field(key)) {
      ignored.push(key);
      continue;
    }
    next.set(key, value === null || value === undefined ? '' : String(value));
    const at = row.updated_at ?? row.updatedAt;
    if (at) {
      const when = new Date(at).getTime();
      if (Number.isFinite(when) && (newest === null || when > newest)) newest = when;
    }
  }
  const before = stored.size;
  stored = next;
  changedAt = next.size ? newest : null;
  return { loaded: next.size, previous: before, ignored, changedAt };
}

/**
 * Has a setting been saved since the given moment?
 *
 * This is what keeps the promise on the settings screen — "change it here and it
 * is right everywhere without a deploy" — true for the prebuilt pages too. A
 * static page carries the footer's phone number, the CAC line and the retainer
 * prices baked into its HTML, so a build made before the change is wrong; the
 * caller falls back to rendering per request until the next `npm run build:static`
 * puts a newer build on disk. Self-healing, and visible: the save flash says so.
 */
function changedSince(iso) {
  if (!changedAt) return false;
  if (!iso) return true;
  const built = new Date(iso).getTime();
  if (!Number.isFinite(built)) return true;
  return changedAt > built;
}

/** The stored string for a key, or null when nothing overrides it. */
function raw(key) {
  const value = stored.get(key);
  return value === undefined || value === '' ? null : value;
}

/** True when the console has changed this setting away from its default. */
function changed(key) {
  return raw(key) !== null;
}

function set(key, value) {
  if (!schema.field(key)) throw new Error(`Unknown setting "${key}".`);
  stored.set(key, String(value));
}

function remove(key) {
  stored.delete(key);
}

/** The value in force, typed: the override, or the registry's default. */
function value(key) {
  const def = schema.field(key);
  if (!def) throw new Error(`Unknown setting "${key}" — it is not in the registry.`);
  return schema.coerce(def, raw(key));
}

/** Every key the console has changed, and to what — for the audit detail. */
function snapshot() {
  return Object.fromEntries([...stored.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function count() {
  return stored.size;
}

/** Tests only: back to "everything is a default". */
function clear() {
  stored = new Map();
  changedAt = null;
}

module.exports = { hydrate, raw, value, changed, changedSince, set, remove, snapshot, count, clear };
