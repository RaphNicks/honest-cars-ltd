'use strict';

/**
 * Money, in one place.
 *
 * Kobo are integers — every amount in the database is an integer number of
 * kobo so nothing is ever rounded twice (§12.2). The only conversions happen
 * at the edges: a form field a human typed, or a line of HTML.
 *
 * `nairaToKobo` is deliberately strict: it accepts what a Nigerian staff member
 * would actually type — `₦2,500,000`, `NGN 2500000`, `2500000.50` — and returns
 * null for anything else, so a typo can never become a payment.
 */

function nairaToKobo(naira) {
  const raw = String(naira == null ? '' : naira).replace(/\s/g, '');
  if (!/^(?:₦|NGN)?\d[\d,]*(?:\.\d{1,2})?$/i.test(raw)) return null;
  const value = Number(raw.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function koboToNaira(kobo) {
  return Number(kobo || 0) / 100;
}

/** ₦2,500,000 — how money reads on a page. */
function formatNaira(kobo, { withKobo = false } = {}) {
  const naira = koboToNaira(kobo);
  return `₦${naira.toLocaleString('en-NG', {
    minimumFractionDigits: withKobo ? 2 : 0,
    maximumFractionDigits: withKobo ? 2 : 0,
  })}`;
}

/** ₦2.5m / ₦450k — for tiles where the full figure would wrap. */
function formatNairaShort(kobo) {
  const naira = koboToNaira(kobo);
  if (naira >= 1_000_000) return `₦${(naira / 1_000_000).toFixed(naira % 1_000_000 === 0 ? 0 : 1)}m`;
  if (naira >= 1_000) return `₦${Math.round(naira / 1000)}k`;
  return `₦${naira.toLocaleString('en-NG')}`;
}

module.exports = { nairaToKobo, koboToNaira, formatNaira, formatNairaShort };
