'use strict';

/**
 * Settings — §5.1's settings screen, the half that is not the area list.
 *
 * Three things live here:
 *
 *   • `hydrate()` — load the overrides into memory and hand them to the rest of
 *     the app, called at boot and again after every save. It also reports keys
 *     the registry does not know, because a value nobody reads is the failure
 *     mode this screen has to avoid.
 *   • `saveGroup()` / `resetGroup()` — one group per submission. A group that
 *     half-applied is worse than one that did not apply: a retainer changed
 *     without its hours bills a new price against an old promise. Both validate
 *     everything first, then write in one transaction.
 *   • `view()` — what the console renders, with each row carrying both the value
 *     in force *and* the default it would fall back to, so the screen can say
 *     which one you are looking at.
 *
 * Cross-field rules live here too (`redirect after visible`), because the
 * registry validates one field at a time and some things only make sense as a
 * pair.
 */

const schema = require('../lib/settings-schema');
const overrides = require('../lib/overrides');
const db = require('../db');
const money = require('../lib/money');

/** Load the overrides from the table. Safe to call before the table exists. */
async function hydrate({ quiet = true } = {}) {
  let rows = [];
  try {
    rows = await db.settings.all();
  } catch (error) {
    // A database that predates migration 027 is not a reason to refuse to boot:
    // the defaults are correct, and the console will say the table is missing.
    if (!quiet) console.warn(`  ! settings not loaded (${error.code || error.message}) — using defaults`);
    return { loaded: 0, previous: 0, ignored: [], missing: true };
  }
  const result = overrides.hydrate(rows);
  if (result.ignored.length && !quiet) {
    console.warn(`  ! ${result.ignored.length} setting(s) ignored — not in the registry: ${result.ignored.join(', ')}`);
  }
  return result;
}

/**
 * Everything the settings screen needs, grouped.
 *
 * Each field carries `value` (the typed value in force), `display` (how it
 * reads: naira, not kobo), `current` (the raw stored string, or null when the
 * default is in force) and `changed`.
 */
function view() {
  return schema.GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    hint: group.hint,
    changed: group.fields.filter((field) => overrides.changed(field.key)).length,
    fields: group.fields.map((field) => {
      const current = overrides.raw(field.key);
      const value = overrides.value(field.key);
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        hint: field.hint,
        unit: field.unit || null,
        placeholder: field.placeholder || null,
        options: field.options || null,
        changed: current !== null,
        current,
        value,
        display: schema.display(field, current),
        defaultDisplay: schema.display(field, null),
      };
    }),
  }));
}

/** Just the channel rows, for anything that wants to show or check them. */
function channels() {
  return schema.FIELDS.filter((field) => field.type === 'enum' && field.key.startsWith('notify.channel.')).map((field) => ({
    key: field.key,
    template: field.hint,
    label: field.label,
    channel: overrides.value(field.key),
    changed: overrides.changed(field.key),
  }));
}

/**
 * Validate and save one group.
 *
 * @param {string} groupKey
 * @param {object} body      raw form fields, keyed by setting key
 * @param {object} [context] { actorId }
 */
async function saveGroup(groupKey, body = {}, { actorId = null } = {}) {
  const group = schema.GROUPS.find((candidate) => candidate.key === groupKey);
  if (!group) return { ok: false, error: 'Unknown settings group.' };

  const entries = [];
  const resets = [];
  const problems = [];

  for (const field of group.fields) {
    if (!(field.key in body)) continue;
    const raw = body[field.key];

    // An empty submission means "leave it alone"; the reset button is how you
    // take a value back to the default, and the two must not be confused by a
    // form posted with one field left blank.
    if (String(raw).trim() === '') continue;

    const parsed = schema.parse(field, raw);
    if (!parsed.ok) {
      problems.push(`${field.label}: ${parsed.error}`);
      continue;
    }
    if (String(parsed.value) === String(schema.defaultValue(field))) resets.push(field.key);
    else entries.push({ key: field.key, value: parsed.value });
  }

  const cross = crossCheck(groupKey, body);
  if (cross) problems.push(cross);
  if (problems.length) return { ok: false, error: problems.join(' ') };

  await db.settings.save(entries, { actorId });
  if (resets.length) await db.settings.remove(resets);
  await hydrate();

  return {
    ok: true,
    saved: entries.length,
    reset: resets.length,
    changedKeys: entries.map((entry) => entry.key),
    summary: entries.length || resets.length
      ? `${entries.length} saved, ${resets.length} back to default`
      : 'nothing changed',
    // The audit line names what moved, so "who changed the retainer?" is a
    // question the log can answer.
    detail: Object.fromEntries(
      [...entries.map((entry) => [entry.key, entry.value]), ...resets.map((key) => [key, '(default)'])],
    ),
  };
}

/** Take a whole group (or one key) back to the registry defaults. */
async function resetGroup(groupKey, { keys = null, actorId = null } = {}) {
  const group = schema.GROUPS.find((candidate) => candidate.key === groupKey);
  if (!group) return { ok: false, error: 'Unknown settings group.' };
  const wanted = group.fields.map((field) => field.key).filter((key) => !keys || keys.includes(key));
  const changedKeys = wanted.filter((key) => overrides.changed(key));
  if (!changedKeys.length) {
    return { ok: true, reset: 0, summary: 'everything in this group is already at its default', detail: {} };
  }
  await db.settings.remove(changedKeys);
  await hydrate();
  return {
    ok: true,
    reset: changedKeys.length,
    detail: Object.fromEntries(changedKeys.map((key) => [key, '(default)'])),
    summary: `${changedKeys.length} back to default`,
  };
}

/**
 * Rules that only make sense as a pair.
 *
 * The submitted body is checked first, then the values already in force — a form
 * that changes only the redirect window has to be measured against the visible
 * window it will sit beside, not against a blank.
 */
function crossCheck(groupKey, body) {
  if (groupKey !== 'thresholds') return null;
  const read = (key) => {
    const def = schema.field(key);
    if (body[key] !== undefined && String(body[key]).trim() !== '') {
      const parsed = schema.parse(def, body[key]);
      return parsed.ok ? Number(parsed.value) : null;
    }
    return Number(overrides.value(key));
  };
  const visible = read('sold.visible_days');
  const redirect = read('sold.redirect_days');
  if (visible === null || redirect === null) return null;
  if (redirect <= visible) {
    return `Sold cars cannot redirect after ${redirect} days when they are visible for ${visible} — the redirect has to come later than the window.`;
  }
  return null;
}

/** A one-line summary for ops: how many settings differ from their defaults. */
function summary() {
  const changed = schema.keys().filter((key) => overrides.changed(key));
  return {
    total: schema.keys().length,
    changed: changed.length,
    keys: changed,
    groups: schema.GROUPS.map((group) => ({
      key: group.key,
      title: group.title,
      changed: group.fields.filter((field) => overrides.changed(field.key)).length,
      total: group.fields.length,
    })),
  };
}

/** Where a value came from — used by the screen's badges and by tests. */
function describe(key) {
  const def = schema.field(key);
  if (!def) return null;
  return {
    key,
    changed: overrides.changed(key),
    stored: overrides.raw(key),
    value: overrides.value(key),
    display: schema.display(def, overrides.raw(key)),
    defaultDisplay: schema.display(def, null),
    naira: def.type === 'money' ? money.formatNaira(overrides.value(key)) : null,
  };
}

module.exports = { hydrate, view, channels, saveGroup, resetGroup, summary, describe, crossCheck };
