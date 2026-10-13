'use strict';

/**
 * Campaign attribution — the five UTM keys, and the one place they are cleaned.
 *
 * Shared by the events pipeline (§15.1) and lead capture (§6.3–§6.7) so a click
 * id that arrives on the landing URL is recorded identically wherever it lands.
 * §15.2 needs "channel → lead → paid", and that chain is only as good as the
 * first link: one of the two callers dropping the campaign quietly breaks the
 * whole report.
 *
 * The values are attacker-controlled (they come from a query string), so the
 * shape is fixed here: five known keys, strings, capped. Anything else is
 * dropped rather than stored — an events table is not a place for whatever a
 * stranger puts in a URL.
 */

const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'];

/** Reduce whatever arrived to an object of the five keys, or null. */
function sanitizeUtm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of UTM_KEYS) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim()) out[key] = entry.trim().slice(0, 80);
  }
  return Object.keys(out).length ? out : null;
}

/** The channel a campaign belongs to: source, or "(direct / none)" — never a guess. */
function channelOf(utm) {
  const clean = sanitizeUtm(utm);
  return clean && clean.source ? clean.source : '(direct / none)';
}

module.exports = { UTM_KEYS, sanitizeUtm, channelOf };
