'use strict';

/**
 * Phone numbers — the account key (§7.1) and the join key between the public
 * forms and the ops records they create.
 *
 * People type their number in whatever shape they like:
 *   08031234567 · 8031234567 · +2348031234567 · 234 803 123 4567
 * Everything is stored normalised as +234XXXXXXXXXX, and every lookup matches
 * the shapes that might already be in the table from an earlier write.
 */

/** Nigerian mobile numbers are 10 digits after the country code: 070/080/081/090… */
function normalise(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  let local = digits;
  if (local.startsWith('234')) local = local.slice(3);
  else if (local.startsWith('0')) local = local.slice(1);
  if (!/^[789]\d{9}$/.test(local)) return null;

  return `+234${local}`;
}

/**
 * Every stored shape of the same number, for `phone IN (…)` lookups.
 * A record written before normalisation still belongs to its owner.
 */
function variants(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return [];
  const normalised = normalise(digits);
  const local = normalised ? normalised.slice(4) : digits.replace(/^234/, '').replace(/^0/, '');
  const set = new Set([String(raw), digits, local, `0${local}`, `234${local}`, normalised].filter(Boolean));
  return [...set];
}

/** The one shape to store: normalised when we can read it, else what was typed. */
function canonical(raw, { fallback = null } = {}) {
  return normalise(raw) || (String(raw || '').trim() ? String(raw).trim().slice(0, 40) : fallback);
}

module.exports = { normalise, variants, canonical };
