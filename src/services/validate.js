'use strict';

/**
 * Form validation shared by the public routes and the JSON endpoints.
 *
 * Rules are deliberately boring: trim, cap length, check the phone shape we
 * actually see in Nigeria, and never trust a price that came from a browser
 * (§11 — every amount is recomputed server-side from the DB).
 */

const PHONE_RE = /^[+()\d\s-]{7,20}$/;
const TRACKING_RE = /^HC-\d{3,6}$/i;

function text(value, max = 200) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function phone(value) {
  const cleaned = text(value, 40);
  return PHONE_RE.test(cleaned) ? cleaned : null;
}

function name(value) {
  const cleaned = text(value, 120);
  return cleaned.length >= 2 ? cleaned : null;
}

function oneOf(value, allowed, fallback = null) {
  const cleaned = text(value, 80);
  return allowed.includes(cleaned) ? cleaned : fallback;
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function kobo(value) {
  // Accepts "12500", "12,500", "₦12,500" and "12500.50" — never a negative.
  const raw = String(value ?? '').replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
}

/** Briefs are free-form objects; this keeps them small and stringly-typed. */
function brief(value, { maxKeys = 40, maxString = 400, maxArray = 24 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, maxKeys)) {
    const safeKey = text(key, 40).replace(/[^a-z0-9_]/gi, '');
    if (!safeKey) continue;
    if (Array.isArray(raw)) out[safeKey] = raw.slice(0, maxArray).map((item) => text(item, maxString));
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[safeKey] = raw;
    else out[safeKey] = text(raw, maxString);
  }
  return out;
}

/** ISO date-time, sanity-checked: not in the past, not more than 6 months out. */
function futureDateTime(value, { maxDays = 180 } = {}) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return null;
  const now = Date.now();
  if (date.getTime() < now - 86_400_000) return null;
  if (date.getTime() > now + maxDays * 86_400_000) return null;
  return date;
}

/** Per-service SLA in hours (§6.5: three options, 48–72h). */
function slaHours(value, fallback = 72) {
  const allowed = [48, 72];
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return allowed.includes(parsed) ? parsed : fallback;
}

module.exports = {
  PHONE_RE,
  TRACKING_RE,
  text,
  phone,
  name,
  oneOf,
  integer,
  kobo,
  brief,
  futureDateTime,
  slaHours,
};
