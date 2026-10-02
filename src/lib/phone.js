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

/**
 * The only safe way to put a number on a screen or in a log line: `+234 803 ••• 4567`.
 * Staff who need the real number to send a WhatsApp message read it from the
 * record, not from a formatted string (§12.2 minimal PII).
 */
function mask(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 7) return '•••';
  return `+${digits.slice(0, 3)} ${digits.slice(3, 6)} ••• ${digits.slice(-4)}`;
}

module.exports = { normalise, variants, canonical, mask };
