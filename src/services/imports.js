'use strict';

/**
 * Bulk listing import — FR-33.
 *
 * A dealer's stock lives in a spreadsheet, and asking them to re-type forty cars
 * into the wizard is how a portal goes unused. So the same columns the wizard
 * writes are accepted as CSV (or as JSON over the API), and the important part
 * is not the parsing — it is that nothing is written until the dealer has seen
 * what *would* be written. `run()` therefore has two modes:
 *
 *   dry run   validate every row, write nothing, report line by line
 *   apply     the same validation, then create the rows that passed
 *
 * Three rules that keep it honest:
 *
 *   1. Imports create **drafts**. Live is ops' decision (§7.3 moderation queue),
 *      whether a listing arrived through the wizard or a spreadsheet.
 *   2. A row that fails validation is refused *by itself* — the other thirty
 *      still import, and the report names the line and the column. A whole-file
 *      refusal happens only when the file cannot be read as listings at all.
 *   3. Anything suspicious is a warning, not a silence: a car the lot already
 *      has, two identical rows in one file, the template's example row left in.
 *
 * The template is generated from the same table that validates, so the two can
 * never drift apart.
 */

const db = require('../db');
const csv = require('../lib/csv');
const validate = require('./validate');

const MAX_ROWS = 200;
const MAX_PHOTOS = 6;
const EXAMPLE_MAKE = 'EXAMPLE — delete this row';

/**
 * The columns, in the order the template writes them. `required` columns decide
 * whether a file is even about listings; the rest are normalised with the
 * wizard's own rules (`services/validate.js`, the same enums the DB enforces).
 */
const COLUMNS = [
  { name: 'make', label: 'Make', required: true, example: 'Toyota' },
  { name: 'model', label: 'Model', required: true, example: 'Corolla' },
  { name: 'year', label: 'Year', required: true, example: '2016' },
  { name: 'price', label: 'Asking price', required: true, example: '₦12,500,000' },
  { name: 'trim', label: 'Trim', example: 'LE' },
  { name: 'body_type', label: 'Body type', example: 'sedan', note: 'sedan · suv · hatchback · pickup · bus · coupe · wagon · van' },
  { name: 'transmission', label: 'Transmission', example: 'automatic', note: 'automatic · manual' },
  { name: 'fuel_type', label: 'Fuel', example: 'petrol', note: 'petrol · diesel · hybrid · electric · cng' },
  { name: 'condition', label: 'Condition', example: 'tokunbo', note: 'tokunbo · nigerian_used · new' },
  { name: 'mileage_km', label: 'Mileage (km)', example: '92000' },
  { name: 'engine_size', label: 'Engine', example: '1.8L' },
  { name: 'drivetrain', label: 'Drivetrain', example: 'fwd', note: 'fwd · rwd · awd · 4wd' },
  { name: 'ext_colour', label: 'Colour', example: 'Silver' },
  { name: 'area', label: 'Area', example: 'Woji' },
  { name: 'negotiable', label: 'Negotiable', example: 'yes', note: 'yes · no' },
  { name: 'features', label: 'Features', example: 'Air conditioning, Reverse camera', note: 'comma or semicolon separated, up to 12' },
  { name: 'customs_verified', label: 'Customs verified', example: 'yes', note: 'yes · no' },
  { name: 'registration', label: 'Registration papers', example: 'yes', note: 'yes · no' },
  { name: 'duty_sighted', label: 'Duty sighted', example: 'no', note: 'yes · no' },
  { name: 'tinted_permit', label: 'Tinted permit', example: 'no', note: 'yes · no' },
  { name: 'description', label: 'Description', example: 'One owner, full service history, cold AC.' },
  { name: 'honest_note', label: 'Honest note', example: 'Two small stone chips on the bonnet — photographed.' },
  { name: 'photos', label: 'Photo URLs', example: 'https://…/front.jpg | https://…/rear.jpg', note: 'separated by | — up to 6' },
];

const REQUIRED = COLUMNS.filter((column) => column.required).map((column) => column.name);
const KNOWN = COLUMNS.map((column) => column.name);
const ENUMS = {
  body_type: ['sedan', 'suv', 'hatchback', 'pickup', 'bus', 'coupe', 'wagon', 'van'],
  transmission: ['automatic', 'manual'],
  fuel_type: ['petrol', 'diesel', 'hybrid', 'electric', 'cng'],
  condition: ['tokunbo', 'nigerian_used', 'new'],
  drivetrain: ['fwd', 'rwd', 'awd', '4wd'],
};

/** The CSV a lot downloads: header plus one row showing every column in use. */
function template() {
  return csv.stringify(
    [COLUMNS.map((column) => column.example)],
    COLUMNS.map((column) => column.name),
  );
}

/** The same columns as data, for the import page's field guide. */
function fieldGuide() {
  return COLUMNS.map((column) => ({ ...column, required: Boolean(column.required) }));
}

/**
 * Money as a person writes it in a spreadsheet: `12500000`, `₦12,500,000`,
 * `12.5m`, `850k`. Never a guess about magnitude — `12.5` alone is ₦12.50 in
 * kobo and is almost certainly a mistake, so a bare number under 1000 is
 * refused with a note about the `m` suffix rather than silently listed at ₦12.
 */
function moneyFromText(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return null;
  const cleaned = raw.replace(/[₦$,\s]/g, '');
  const suffixed = /^(\d+(?:\.\d+)?)(m|million|k|thousand)$/.exec(cleaned);
  if (suffixed) {
    const amount = Number(suffixed[1]);
    const scale = ['m', 'million'].includes(suffixed[2]) ? 1_000_000 : 1_000;
    return Math.round(amount * scale * 100);
  }
  const kobo = validate.kobo(cleaned);
  if (kobo === null) return null;
  return kobo;
}

/** yes/no/1/0/true/false/blank → boolean. Anything else is a refusal. */
function boolFromText(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return false;
  if (['yes', 'y', 'true', '1'].includes(raw)) return true;
  if (['no', 'n', 'false', '0'].includes(raw)) return false;
  return null;
}

function splitList(value, separator = /[,;|]/) {
  return String(value == null ? '' : value)
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * One row in, one listing input (or a list of refusals) out. Identical rules to
 * the wizard: the same enums, the same price floor, the same mileage ceiling.
 */
function normalise(values, { line, market = null } = {}) {
  const errors = [];
  const warnings = [];
  const add = (column, message) => errors.push({ column, message });

  const make = validate.text(values.make, 60);
  const model = validate.text(values.model, 80);
  const year = validate.integer(values.year, { min: 1990, max: new Date().getFullYear() + 1 });
  const priceKobo = moneyFromText(values.price);

  if (!make) add('make', 'A car needs a make.');
  if (!model) add('model', 'A car needs a model.');
  if (year === null) add('year', `“${values.year || ''}” is not a year we can list — cars are 1990 or newer.`);
  if (priceKobo === null) {
    add('price', `“${values.price || ''}” is not a price I can read. Use 12500000, ₦12,500,000 or 12.5m.`);
  } else if (priceKobo < 100_000_00) {
    add('price', 'That price is under ₦100,000 — if you meant millions, write 12.5m.');
  }

  const enums = {};
  for (const [column, allowed] of Object.entries(ENUMS)) {
    const raw = String(values[column] || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!raw) {
      enums[column] = { sedan: 'sedan', automatic: 'automatic', petrol: 'petrol' }[column]
        || { condition: 'nigerian_used', drivetrain: 'fwd' }[column]
        || allowed[0];
      continue;
    }
    if (!allowed.includes(raw)) {
      add(column, `“${values[column]}” is not one of ${allowed.join(', ')}.`);
      enums[column] = allowed[0];
      continue;
    }
    enums[column] = raw;
  }

  const mileageKm = String(values.mileage_km || '').trim()
    ? validate.integer(values.mileage_km, { min: 0, max: 900_000 })
    : 0;
  if (mileageKm === null) add('mileage_km', `“${values.mileage_km}” is not a mileage between 0 and 900,000.`);

  const flags = {};
  for (const column of ['negotiable', 'customs_verified', 'registration', 'duty_sighted', 'tinted_permit']) {
    const parsed = boolFromText(values[column]);
    if (parsed === null) add(column, `“${values[column]}” — answer yes or no.`);
    flags[column] = parsed === true;
  }

  const features = splitList(values.features).slice(0, 12);
  const photos = splitList(values.photos, /\s*\|\s*/)
    .filter((url) => /^(https?:\/\/|\/img\/)/i.test(url))
    .slice(0, MAX_PHOTOS);
  const rejectedPhotos = splitList(values.photos, /\s*\|\s*/).length - photos.length;
  if (rejectedPhotos > 0) {
    warnings.push({ column: 'photos', message: `${rejectedPhotos} photo link(s) were not http(s) or /img/ and were left out.` });
  }
  if (!photos.length) {
    warnings.push({ column: 'photos', message: 'No photos on this row — the car stays a draft until it has at least three.' });
  } else if (photos.length < 3) {
    warnings.push({ column: 'photos', message: `Only ${photos.length} photo(s); a listing needs three before it can go for review.` });
  }

  if (make && make.toUpperCase().startsWith('EXAMPLE')) {
    warnings.push({ column: 'make', message: 'This looks like the template’s example row — delete it before importing.' });
  }


  const input = {
    make,
    model,
    year,
    trim: validate.text(values.trim, 80),
    bodyType: enums.body_type,
    transmission: enums.transmission,
    fuelType: enums.fuel_type,
    engineSize: validate.text(values.engine_size, 20),
    drivetrain: enums.drivetrain,
    extColour: validate.text(values.ext_colour, 40),
    condition: enums.condition,
    mileageKm: mileageKm === null ? 0 : mileageKm,
    features,
    priceKobo,
    negotiable: flags.negotiable,
    // No area becomes the lot's own market (createListing fills it in) —
    // never a hard-coded Port Harcourt.
    area: validate.text(values.area, 80) || null,
    documents: {
      customs_verified: flags.customs_verified,
      registration: flags.registration,
      duty_sighted: flags.duty_sighted,
      tinted_permit: flags.tinted_permit,
    },
    description: validate.text(values.description, 4000),
    honestNote: validate.text(values.honest_note, 1000),
  };

  // FR-32: the area has to exist in the lot's own market, or the car lands in a
  // filter no buyer can reach. A warning, not a refusal — ops can add the area,
  // and the listing is still worth having.
  if (market) {
    if (!input.area) {
      warnings.push({ column: 'area', message: `No area on this row — the car will be filed under ${market.city} generally until you name a neighbourhood.` });
    } else if (market.names.size && !market.names.has(input.area)) {
      warnings.push({
        column: 'area',
        message: `“${input.area}” is not one of the areas we list in ${market.city}. It still imports, but buyers filtering by area will not find it — ask ops to add the area.`,
      });
    }
  }

  return { line, input, photos, errors, warnings };
}

/**
 * Validate a whole file. No writes, ever — this is what the page shows before
 * the dealer commits, and what the API returns when `dry_run` is left on.
 */
async function validateText(text, { dealerId } = {}) {
  const { columns, rows } = csv.table(text);
  const market = dealerId ? await marketAreas(dealerId) : null;
  const fileErrors = [];

  if (!columns.length) {
    fileErrors.push('That file is empty.');
    return { ok: false, fatal: true, fileErrors, columns: { missing: REQUIRED, unknown: [] }, counts: zeroCounts(), rows: [] };
  }
  const missing = REQUIRED.filter((column) => !columns.includes(column));
  const unknown = columns.filter((column) => column && !KNOWN.includes(column));
  if (missing.length) {
    fileErrors.push(`The header is missing ${missing.join(', ')}. Download the template and keep its column names.`);
  }
  if (unknown.length) {
    fileErrors.push(`The header has column(s) we do not know: ${unknown.join(', ')}. They were ignored — everything else still imported.`);
  }
  if (!rows.length) {
    fileErrors.push('There is a header but no rows under it.');
  }
  if (rows.length > MAX_ROWS) {
    fileErrors.push(`That is ${rows.length} rows — the limit is ${MAX_ROWS} in one file. Split it and import the rest after.`);
  }

  const fatal = Boolean(missing.length) || rows.length > MAX_ROWS;
  const analysed = rows.map((row) => {
    const result = normalise(row.values, { line: row.line, market });
    if (row.extra.length) {
      result.errors.push({ column: 'row', message: `${row.extra.length} extra value(s) after the last column — check for a stray comma: “${row.extra.join('”, “')}”.` });
    }
    return result;
  });

  // Duplicates are warnings, not refusals: a lot may genuinely have two
  // identical cars, and only the lot knows. Within the file first…
  const seen = new Map();
  for (const row of analysed) {
    const key = `${String(row.input.make).toLowerCase()}|${String(row.input.model).toLowerCase()}|${row.input.year}`;
    if (!row.input.make || !row.input.model || !row.input.year) continue;
    if (seen.has(key)) {
      row.warnings.push({ column: 'row', message: `Same car as line ${seen.get(key)} in this file.` });
    } else {
      seen.set(key, row.line);
    }
  }

  // …then against what the lot already has on its books.
  if (dealerId) {
    const existing = await db.query(
      `SELECT stock_no, make, model, year, status FROM vehicle_listings
        WHERE dealer_id = ? AND status IN ('draft', 'in_review', 'live', 'reserved')
        ORDER BY id DESC LIMIT 500`,
      [dealerId],
    );
    const key = (make, model, year) => `${String(make).toLowerCase()}|${String(model).toLowerCase()}|${Number(year)}`;
    const onBooks = new Map(existing.map((row) => [key(row.make, row.model, row.year), row]));
    for (const row of analysed) {
      const match = onBooks.get(key(row.input.make, row.input.model, row.input.year));
      if (match) {
        row.warnings.push({ column: 'row', message: `You already have ${match.stock_no} — a ${match.status.replace(/_/g, ' ')} ${match.year} ${match.make} ${match.model}.` });
      }
    }
  }

  const ready = fatal ? [] : analysed.filter((row) => !row.errors.length);
  const refused = analysed.filter((row) => row.errors.length);
  const warnings = analysed.filter((row) => !row.errors.length && row.warnings.length);

  return {
    ok: !fatal && ready.length > 0,
    fileErrors,
    fatal,
    columns: { missing, unknown, present: columns },
    counts: {
      total: analysed.length,
      ready: ready.length,
      refused: refused.length,
      warned: warnings.length,
    },
    rows: analysed,
    limit: MAX_ROWS,
  };
}

/**
 * The area list the lot's own market offers (FR-32). A lookup failure must
 * never be the reason an import fails, so this degrades to null — the import
 * still validates, it just cannot say anything about the area.
 */
async function marketAreas(dealerId) {
  try {
    const market = await db.dealers.marketFor(dealerId);
    const areas = await db.areas.areas({ cityName: market.city });
    return { city: market.city, names: new Set(areas.map((area) => area.name)) };
  } catch (error) {
    return null;
  }
}

function zeroCounts() {
  return { total: 0, ready: 0, refused: 0, warned: 0 };
}

/**
 * Validate, then (unless this is a dry run) create the rows that passed.
 *
 * Drafts only. A partially-successful import is the honest outcome: the report
 * says what was created, what was refused and why, and the lot fixes the
 * refusals and imports them again.
 */
async function run(text, { dealerId, actorId = null, dryRun = true } = {}) {
  const report = await validateText(text, { dealerId });
  if (dryRun || report.fatal) {
    return { ...report, dryRun: true, created: [] };
  }

  const created = [];
  for (const row of report.rows) {
    if (row.errors.length) continue;
    const listing = await db.dealers.createListing(dealerId, row.input);
    for (const [index, url] of row.photos.entries()) {
      // Position is assigned by the store; the shot label is what the dealer
      // sees in the wizard, so the first one is named for what it is.
      await db.dealers.addPhoto(dealerId, listing.id, {
        url,
        alt: `${row.input.year} ${row.input.make} ${row.input.model} — photograph ${index + 1}`,
        shot: index === 0 ? 'Front three-quarter' : `Photograph ${index + 1}`,
      }).catch(() => {});
    }
    created.push({ line: row.line, id: listing.id, stockNo: listing.stockNo, slug: listing.slug, photos: row.photos.length });
  }

  return {
    ...report,
    dryRun: false,
    created,
    counts: { ...report.counts, created: created.length },
  };
}

module.exports = {
  COLUMNS,
  MAX_ROWS,
  MAX_PHOTOS,
  template,
  fieldGuide,
  moneyFromText,
  boolFromText,
  normalise,
  validateText,
  run,
};
