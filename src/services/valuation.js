'use strict';

/**
 * Instant valuation — FR-29 (§6.6 "Instant estimate widget COULD: rough band
 * from pricing DB with 'confirm with free human valuation' CTA").
 *
 * The temptation with a widget like this is to produce a confident single
 * number. This one refuses to, for three reasons that are all visible in the
 * answer it gives:
 *
 *   1. **The band is what we hold, not what we think.** It comes from
 *      `price_bands` (§7.3) — the same table the VDP price-position badge reads,
 *      matched by the same rule — and the reply carries the sample size and the
 *      date it was last refreshed.
 *   2. **Old data is said out loud.** §7.3 asks for a weekly pass, so a band
 *      older than `STALE_DAYS` is flagged in the copy rather than quietly used.
 *   3. **Mileage is not a fudge factor.** We do not adjust the band by a
 *      mileage curve we do not have. We show the median mileage of the live
 *      comparable stock beside the seller's figure and say which way that
 *      usually moves the price — and the human valuation is what actually
 *      decides.
 *
 * When there is no band, that is a real answer too: the widget says we do not
 * hold data for that car yet, shows the range we do cover, and offers the free
 * human valuation — which is the promise /sell-swap has always made.
 */

const db = require('../db');
const money = require('../lib/money');
const validate = require('./validate');

const CONDITIONS = db.pricing.CONDITIONS;

/** The CTA the PRD asks for, in one place, on every answer. */
const HUMAN_CTA = {
  label: 'Get the free human valuation',
  href: '/sell-swap#sell-intake',
  detail: 'Written comparables and a real number inside 24 hours — no charge, no obligation to sell to us.',
};

function naira(kobo) {
  return kobo === null || kobo === undefined ? null : money.formatNaira(kobo);
}

/** Where a buyer can see the cars the band is drawn from, when we have a facet. */
async function facetPathFor({ make, model }) {
  const slug = `${String(make).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}/${String(model).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  try {
    const facet = await db.facets.findBySlug(slug);
    if (facet && facet.indexable) return `/cars/${facet.slug}`;
  } catch {
    /* the widget must never fail because a facet lookup did */
  }
  return null;
}

/**
 * The estimate.
 *
 * @param {object} input make, model, year, condition, mileageKm
 * @returns {Promise<object>} always an object with `ok`; a refusal carries
 *   `error` (HTTP 400 material) and an answer carries the band, the evidence
 *   and the words the page will render.
 */
async function estimate(input = {}) {
  const make = validate.text(input.make, 60);
  const model = validate.text(input.model, 60);
  const condition = validate.oneOf(input.condition, CONDITIONS, 'any');
  const yearRaw = String(input.year === undefined || input.year === null ? '' : input.year).trim();
  const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;
  const mileageRaw = input.mileageKm === undefined || input.mileageKm === null || input.mileageKm === '' ? null : String(input.mileageKm).replace(/[,\s]/g, '');
  const mileageKm = mileageRaw === null ? null : (/^\d{1,7}$/.test(mileageRaw) ? Number(mileageRaw) : NaN);

  if (!make) return { ok: false, error: 'Which make is the car?' };
  if (!model) return { ok: false, error: 'Which model is the car?' };
  // A make or model that is not name-shaped is refused rather than echoed into
  // a sentence and looked up in the price table. Same governance the filter rail
  // has: the widget renders a textContent answer, but the rule belongs here,
  // where it also keeps junk out of the band lookup.
  const NAME_LIKE = /^[A-Za-z][A-Za-z0-9 .'&/-]{0,39}$/;
  if (!NAME_LIKE.test(make) || !NAME_LIKE.test(model)) {
    return { ok: false, error: 'That does not look like a make and model — try something like “Toyota Camry”.' };
  }
  const thisYear = new Date().getUTCFullYear() + 1;
  if (!year || year < 1980 || year > thisYear) {
    return { ok: false, error: `What year is it? Give four digits between 1980 and ${thisYear}.` };
  }
  if (Number.isNaN(mileageKm)) {
    return { ok: false, error: 'Mileage has to be a number of kilometres — leave it blank if you would rather not say.' };
  }
  if (mileageKm !== null && mileageKm > 2_000_000) {
    return { ok: false, error: 'That mileage looks like a typo — we are happy to value a high-mileage car, but not a two-million-kilometre one.' };
  }

  const [band, coverage, otherModels] = await Promise.all([
    db.pricing.findBand({ make, model, year, condition }),
    db.pricing.coverageFor({ make, model }),
    db.pricing.modelsFor({ make, excludeModel: model, limit: 6 }),
  ]);

  const comparables = band
    ? await db.listings.comparablesFor({ make, model, yearFrom: band.yearFrom, yearTo: band.yearTo })
    : { count: 0 };

  const query = {
    make,
    model,
    year,
    condition,
    conditionLabel: db.pricing.CONDITION_LABELS[condition] || condition,
    mileageKm,
  };

  // ---------------------------------------------------------------- no band
  if (!band) {
    const alt = coverage
      ? `We do hold ${coverage.bands} band${coverage.bands === 1 ? '' : 's'} for the ${coverage.make} ${coverage.model}` +
        `${coverage.yearFrom === coverage.yearTo ? ` (${coverage.yearFrom})` : ` (${coverage.yearFrom}–${coverage.yearTo})`} — ` +
        `a ${year} is outside that range.`
      : otherModels.length
        ? `We hold bands for other ${make} models (${otherModels.map((alt) => alt.model).join(', ')}) but none for the ${model}.`
        : `We do not hold price data for the ${make} ${model} yet.`;

    return {
      ok: true,
      found: false,
      query,
      band: null,
      comparables: null,
      verdict: {
        tone: 'muted',
        headline: 'No band for that car yet',
        detail: `${alt} That is a real answer rather than a guess: send it to us and a human prices it from live comparables inside 24 hours.`,
      },
      alternatives: otherModels,
      humanCta: HUMAN_CTA,
    };
  }

  // --------------------------------------------------------------- the band
  const stale = band.stale;
  const refreshed = band.ageDays === null
    ? 'this band has never been re-checked'
    : band.ageDays === 0
      ? 'last refreshed today'
      : `last refreshed ${band.ageDays} day${band.ageDays === 1 ? '' : 's'} ago`;

  const rangeLabel = `${naira(band.minKobo)} – ${naira(band.maxKobo)}`;
  const yearsLabel = band.yearFrom === band.yearTo ? String(band.yearFrom) : `${band.yearFrom}–${band.yearTo}`;
  const evidence = `Based on ${band.sampleSize} comparable sale${band.sampleSize === 1 ? '' : 's'} in our price-intel table, for a ${yearsLabel} ${make} ${model}` +
    `${band.condition && band.condition !== 'any' ? ` in ${band.conditionLabel.toLowerCase()} condition` : ''} (${refreshed}).`;

  let mileageNote = null;
  let mileageDelta = null;
  if (mileageKm !== null && comparables && comparables.medianMileageKm) {
    mileageDelta = mileageKm - comparables.medianMileageKm;
    const km = (value) => `${Math.abs(value).toLocaleString('en-NG')} km`;
    const direction = Math.abs(mileageDelta) < 15_000
      ? 'about level with'
      : mileageDelta < 0
        ? `${km(mileageDelta)} below`
        : `${km(mileageDelta)} above`;
    mileageNote = `Live comparable stock in that window has a median of ${comparables.medianMileageKm.toLocaleString('en-NG')} km; yours is ${direction} that` +
      `${Math.abs(mileageDelta) < 15_000 ? ', so mileage should not move it much' : mileageDelta < 0 ? ', which usually sits toward the top of the band' : ', which usually sits toward the bottom of the band'}.` +
      ' We do not adjust the number for you — the human valuation does, with the comparables written down.';
  } else if (mileageKm !== null) {
    mileageNote = 'No live comparable stock to judge mileage against right now, so treat the band as the whole picture.';
  }

  const staleNote = stale
    ? 'Worth knowing: this band is past the weekly refresh §7.3 asks for, so the human valuation is the one to trust.'
    : null;

  const browsePath = await facetPathFor({ make, model });

  return {
    ok: true,
    found: true,
    query,
    band: {
      minKobo: band.minKobo,
      maxKobo: band.maxKobo,
      minLabel: naira(band.minKobo),
      maxLabel: naira(band.maxKobo),
      rangeLabel,
      widthKobo: band.widthKobo,
      condition: band.condition,
      conditionLabel: band.conditionLabel,
      yearFrom: band.yearFrom,
      yearTo: band.yearTo,
      yearsLabel,
      sampleSize: band.sampleSize,
      refreshedAt: band.refreshedAt,
      ageDays: band.ageDays,
      stale,
    },
    comparables: comparables && comparables.count
      ? {
        count: comparables.count,
        medianPriceLabel: naira(comparables.medianPriceKobo),
        medianMileageKm: comparables.medianMileageKm,
        minPriceLabel: naira(comparables.minPriceKobo),
        maxPriceLabel: naira(comparables.maxPriceKobo),
        yearsLabel: comparables.yearFrom === comparables.yearTo ? String(comparables.yearFrom) : `${comparables.yearFrom}–${comparables.yearTo}`,
        sampleUrl: comparables.sampleUrl,
        browsePath,
      }
      : null,
    verdict: {
      tone: stale ? 'amber' : 'navy',
      headline: `Likely ${rangeLabel}`,
      detail: evidence,
      mileageNote,
      staleNote,
    },
    alternatives: [],
    humanCta: HUMAN_CTA,
  };
}

/** A short line for anywhere that needs the promise in one sentence. */
const PROMISE = 'A rough band from live network data in seconds — confirmed by a free human valuation within 24 hours.';

module.exports = { estimate, PROMISE, HUMAN_CTA, CONDITIONS, facetPathFor };
