'use strict';

/**
 * Machine payloads → sentences. Concierge briefs, audit details and old
 * stored lead messages are objects (or stringified objects) at heart; the
 * owner reads them on the console and on WhatsApp, so nothing may reach a
 * human looking like code (owner direction 2026-10-12).
 *
 * Units: brief budgets are NAIRA (the find-my-car slider speaks naira);
 * audit price moves are KOBO (the listings table speaks kobo).
 */

const naira = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
};

const kobo = (value) => naira(Number(value) / 100);

const WORDS = {
  not_sure: 'open to suggestions',
  any: 'any',
  asap: 'as soon as possible',
  two_weeks: 'within two weeks',
  one_month: 'within a month',
  researching: 'still researching',
  family: 'family use',
  self_employed: 'self-employed',
  business_owner: 'business owner',
  salaried: 'salaried',
  airport_pickup: 'airport pickup',
  inspection_included: 'inspection included',
};

/** one value, in words: underscores out, known codes translated */
function word(value) {
  if (value === null || value === undefined || value === '') return '—';
  const key = String(value);
  return WORDS[key] || key.replace(/_/g, ' ');
}

/** arrays and lone values alike, joined for reading */
function list(value) {
  if (Array.isArray(value)) return value.length ? value.map(word).join(', ') : 'any';
  return word(value);
}

function tryJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const KNOWN_BRIEF_KEYS = new Set([
  'budget_min', 'budget_max', 'makes', 'body_types', 'transmission', 'fuel',
  'must_haves', 'intended_use', 'timeline', 'financing', 'addons',
]);

/** The concierge brief as one readable line, in the order a buyer would say it. */
function briefText(brief = {}) {
  const parts = [];
  if (brief.budget_min || brief.budget_max) {
    parts.push(`Budget ${naira(brief.budget_min || 0)} to ${naira(brief.budget_max || 0)}`);
  }
  if (brief.makes) parts.push(`makes: ${list(brief.makes)}`);
  if (brief.body_types) parts.push(`body types: ${list(brief.body_types)}`);
  if (brief.transmission) parts.push(`${word(brief.transmission)} gearbox`);
  if (brief.fuel) parts.push(`fuel: ${word(brief.fuel)}`);
  if (brief.must_haves) parts.push(`must-haves: ${list(brief.must_haves)}`);
  if (brief.intended_use) parts.push(`for ${word(brief.intended_use)}`);
  if (brief.timeline) parts.push(`timeline: ${word(brief.timeline)}`);
  if (brief.financing) parts.push(brief.financing === 'yes' ? 'needs financing' : 'no financing needed');
  if (brief.addons) parts.push(`add-ons: ${list(brief.addons)}`);
  for (const [key, value] of Object.entries(brief)) {
    if (KNOWN_BRIEF_KEYS.has(key)) continue;
    parts.push(`${word(key)}: ${typeof value === 'object' && value !== null ? list(value) : word(value)}`);
  }
  return parts.length ? parts.join(' · ') : 'No brief captured.';
}

/** The audit log's detail column as a sentence, not a stringify. */
function detailText(detail) {
  if (detail === null || detail === undefined || detail === '') return '—';
  if (typeof detail === 'string') {
    const parsed = tryJson(detail);
    return parsed ? detailText(parsed) : detail;
  }
  if (typeof detail !== 'object') return String(detail);
  if ('stockNo' in detail) {
    return `${detail.stockNo}${detail.note ? ` — ${detail.note}` : ' — no note given'}`;
  }
  if ('from' in detail && 'to' in detail) {
    return `Price moved ${kobo(detail.from)} → ${kobo(detail.to)}${detail.note ? ` — ${detail.note}` : ''}`;
  }
  return Object.entries(detail)
    .map(([key, value]) => `${word(key)}: ${typeof value === 'object' && value !== null ? list(value) : word(value)}`)
    .join(' · ');
}

/** Stored lead messages: some old rows hold a JSON brief — read them as words. */
function messageText(message) {
  if (!message) return '';
  const parsed = typeof message === 'string' ? tryJson(message) : null;
  if (!parsed) return typeof message === 'string' ? message : detailText(message);
  if (Object.keys(parsed).some((key) => KNOWN_BRIEF_KEYS.has(key))) return briefText(parsed);
  return detailText(parsed);
}

/** One brief field for the console's definition list — budgets get the naira sign. */
function briefValue(key, value) {
  if (key === 'budget_min' || key === 'budget_max') return naira(value);
  return typeof value === 'object' && value !== null ? list(value) : word(value);
}

module.exports = { naira, kobo, word, list, briefText, detailText, messageText, briefValue };
