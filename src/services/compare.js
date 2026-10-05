'use strict';

/**
 * The comparison rows — §6.4 (compare up to three cars side by side) and §7.3
 * (the concierge options page renders from listing data, not from someone
 * retyping it).
 *
 * There is exactly one definition of "what we compare", and both surfaces read
 * it: the visitor's own /cars/compare list and the shortlist a buyer gets from
 * the concierge. That matters more than it sounds — if ops curates a shortlist
 * on a comparison the site cannot draw the same way, the customer is comparing
 * different numbers from the ones the team used.
 *
 * `best` marks a row where one car is objectively ahead (cheapest, lowliest
 * mileage, highest grade). It is a highlight, never a verdict: ties light up
 * every winning cell, and a row with no clear winner stays unmarked. The buyer
 * decides; we just refuse to make them hunt.
 */

const ROWS = [
  { key: 'priceKobo', label: 'Price', best: 'min', format: 'naira' },
  { key: 'pricePosition', label: 'Price position', format: 'position' },
  { key: 'year', label: 'Year', best: 'max' },
  { key: 'mileageKm', label: 'Mileage', best: 'min', format: 'mileage' },
  { key: 'transmissionLabel', label: 'Transmission' },
  { key: 'fuelTypeLabel', label: 'Fuel' },
  { key: 'conditionLabel', label: 'Condition' },
  { key: 'grade', label: 'Verification grade', best: 'grade', format: 'grade' },
  { key: 'documentsSummary', label: 'Documents', format: 'documents' },
  { key: 'knownFaults', label: 'Known faults (certified)', format: 'faults' },
  { key: 'runningCostKobo', label: 'Running cost — 5-year estimate', best: 'min', format: 'naira' },
];

const GRADE_RANK = { network_listed: 1, field_checked: 2, certified: 3 };

function value(listing, key) {
  switch (key) {
    case 'documentsSummary':
      return listing.documentsSummary || '';
    case 'knownFaults':
      return listing.knownFaults || '';
    default:
      return listing[key];
  }
}

function rank(grade) {
  return GRADE_RANK[grade] || 0;
}

/** Index of the winning car in this row, or -1 when there is nothing to win. */
function bestIndex(listings, row) {
  if (!row.best || listings.length < 2) return -1;
  const values = listings.map((listing) => (row.best === 'grade' ? rank(listing.grade) : Number(value(listing, row.key))));
  const target = row.best === 'max' ? Math.max(...values) : Math.min(...values);
  // Ties keep every winning cell: "best" is a fact about the row, not a podium.
  return values.findIndex((entry) => entry === target);
}

/** One display string per car, or '—' — never a raw null on a page. */
function display(listing, row, formatNaira, formatMileage) {
  const raw = value(listing, row.key);
  switch (row.format) {
    case 'naira':
      return raw ? formatNaira(raw) : '—';
    case 'mileage':
      return raw ? formatMileage(raw) : '—';
    case 'grade':
      return listing.gradeLabel || '—';
    case 'position':
      return listing.pricePositionLabel || '—';
    default:
      return raw === null || raw === undefined || raw === '' ? '—' : String(raw);
  }
}

/**
 * Build every row for a set of listings, formatted for display.
 *
 * Formats are injected rather than required here: this module is used by a
 * route, a PDF builder and a test, and each already holds its own formatter.
 * Passing them keeps one definition of the row and no second currency helper.
 */
function rowsFor(listings, { formatNaira = (v) => String(v), formatMileage = (v) => String(v) } = {}) {
  return ROWS.map((row) => ({
    ...row,
    values: listings.map((listing) => display(listing, row, formatNaira, formatMileage)),
    bestIndex: bestIndex(listings, row),
  }));
}

module.exports = { ROWS, rowsFor, value, bestIndex, rank };
