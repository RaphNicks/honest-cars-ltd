'use strict';

/**
 * Small row-shaping helpers shared by the repositories.
 * MySQL 5.7 + mysql2 returns JSON columns already parsed; MariaDB may return
 * them as strings depending on the driver version, so normalise defensively.
 */

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Appendix B: money is stored as integer kobo. Format for display. */
function koboToNaira(kobo) {
  return Number(kobo) / 100;
}

/**
 * ₦8,650,000 — the canonical price format across the site (§3.3, "prices
 * always in ₦ with figure-friendly tabular styling").
 */
function formatNaira(kobo, { compact = false } = {}) {
  const naira = koboToNaira(kobo);
  if (!Number.isFinite(naira)) return '₦0';
  if (compact && naira >= 1_000_000) {
    const millions = naira / 1_000_000;
    return `₦${trimDecimal(millions)}m`;
  }
  return `₦${Math.round(naira).toLocaleString('en-NG')}`;
}

/** ₦8.5m — only for tight spaces (chips, badges). */
function formatNairaCompact(kobo) {
  return formatNaira(kobo, { compact: true });
}

function trimDecimal(value) {
  return (Math.round(value * 10) / 10).toString();
}

/** 68,400 km — mileage always in km (§3.3). */
function formatMileage(km) {
  return `${Number(km).toLocaleString('en-NG')} km`;
}

/** "Listed 3 days ago · Updated today" (§3.5 freshness chip). */
function relativeDays(date, now = new Date()) {
  if (!date) return null;
  const then = date instanceof Date ? date : new Date(date);
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

const CONDITION_LABELS = {
  tokunbo: 'Tokunbo',
  nigerian_used: 'Nigerian-used',
  new: 'New',
};

const GRADE_LABELS = {
  network_listed: 'Network-Listed',
  field_checked: 'Field-Checked',
  certified: 'HonestCars-Certified',
};

/** One-line tooltip copy for each verification grade (§3.5). */
const GRADE_TOOLTIPS = {
  network_listed:
    'Dealer data only — we have not seen this car. Useful for range and price checking.',
  field_checked:
    'One of our inspectors has physically seen this car and photographed it on site.',
  certified:
    'Full HonestCars inspection passed: OBD2 scan, documents sighted, honest condition note written.',
};

const BODY_TYPE_LABELS = {
  sedan: 'Sedan',
  suv: 'SUV',
  hatchback: 'Hatchback',
  pickup: 'Pickup',
  bus: 'Bus',
  coupe: 'Coupe',
  wagon: 'Wagon',
  van: 'Van',
};

const TRANSMISSION_LABELS = { automatic: 'Automatic', manual: 'Manual' };
const FUEL_LABELS = {
  petrol: 'Petrol',
  diesel: 'Diesel',
  hybrid: 'Hybrid',
  electric: 'Electric',
  cng: 'CNG',
};

const PRICE_POSITION = {
  below: { label: 'Below market', tone: 'green', copy: 'Priced below the current PH market band for this model and condition.' },
  within: { label: 'Within market band', tone: 'navy', copy: 'Priced within the current PH market band for this model and condition.' },
  premium: { label: 'Premium', tone: 'amber', copy: 'Priced above the current PH market band — usually a lower-mileage or better-documented car.' },
  no_data: { label: 'No band yet', tone: 'muted', copy: 'Not enough market data for this model yet — ask us and we will price-check it for you.' },
};

module.exports = {
  parseJson,
  koboToNaira,
  formatNaira,
  formatNairaCompact,
  formatMileage,
  relativeDays,
  CONDITION_LABELS,
  GRADE_LABELS,
  GRADE_TOOLTIPS,
  BODY_TYPE_LABELS,
  TRANSMISSION_LABELS,
  FUEL_LABELS,
  PRICE_POSITION,
};
