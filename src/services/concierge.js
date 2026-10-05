'use strict';

/**
 * Concierge flow spec — §6.5 — and the shortlist the buyer receives, §7.3.
 *
 * The flow spec is shared by the view, the client module and the server endpoint
 * so the four steps can never drift apart. The promise is fixed: three verified
 * options in 48–72 hours. What varies is how fast you want them — three SLA
 * options, all inside that window — and the retainer is credited against the
 * success fee either way.
 *
 * The shortlist half reads what ops curated (`request_candidates`) and renders
 * it twice from one set of numbers: the page the buyer opens at
 * /concierge/{id}, and the PDF they forward to whoever is co-signing the
 * decision. Both use the comparison rows from services/compare.js, so the
 * shortlist can never disagree with the compare tool a visitor would use.
 */

const SLA_OPTIONS = [
  {
    key: 'standard',
    label: 'Standard — 72 hours',
    hours: 72,
    retainerKobo: 5_000_000,
    note: 'Three verified options inside three working days.',
  },
  {
    key: 'priority',
    label: 'Priority — 48 hours',
    hours: 48,
    retainerKobo: 6_500_000,
    note: 'Front of the queue: two working days, same three options.',
  },
  {
    key: 'urgent',
    label: 'Same-week urgent — 48 hours + daily WhatsApp updates',
    hours: 48,
    retainerKobo: 7_500_000,
    note: 'For buyers flying in or holding a deposit deadline.',
  },
];

const MUST_HAVES = [
  'AC must chill',
  'low mileage',
  'first-car friendly',
  'fuel economy',
  'family size',
  'ground clearance',
  'automatic only',
  'service history',
];

const INTENDED_USE = [
  { key: 'commute', label: 'Daily commute' },
  { key: 'family', label: 'Family car' },
  { key: 'business', label: 'Business / executive' },
  { key: 'ride_hailing', label: 'Ride-hailing' },
];

const TIMELINES = [
  { key: 'asap', label: 'ASAP' },
  { key: 'two_weeks', label: 'Within 2 weeks' },
  { key: 'month', label: 'This month' },
  { key: 'researching', label: 'Just researching' },
];

const ADDONS = [
  {
    key: 'inspection_included',
    label: 'Physical inspection of every option',
    copy: 'Included on every concierge search — an inspector stands next to each car before you do.',
    included: true,
  },
  {
    key: 'document_verification',
    label: 'Document deep-verification',
    copy: 'Customs, registration and duty papers checked at the source before you commit.',
    priceKobo: 2_500_000,
  },
  {
    key: 'tracker_install',
    label: 'Tracker installed on delivery',
    copy: 'Standard tracker fitted before handover, first year of monitoring paid.',
    priceKobo: 4_500_000,
  },
  {
    key: 'service_intro',
    label: 'Post-purchase service intro',
    copy: 'We introduce you to a mechanic who knows the model, and schedule the first service.',
    priceKobo: 0,
  },
];

const DEFAULT_SLA = 'standard';

function slaOption(key) {
  return SLA_OPTIONS.find((option) => option.key === key) || SLA_OPTIONS[0];
}

// ---------------------------------------------------------------------------
// The shortlist (§7.3)
// ---------------------------------------------------------------------------

/**
 * Assemble everything the shortlist needs for one request: the cars in rank
 * order, the comparison rows for the first three (§6.4's cap), and the notes ops
 * wrote about each. A candidate whose listing has sold and dropped out of
 * `findByIds` is simply absent from the cards — the note goes with it, because a
 * note about a car nobody can see is noise.
 */
async function shortlist(request) {
  const db = require('../db');
  const compare = require('./compare');
  const candidates = await db.requests.candidatesFor(request.id);
  if (!candidates.length) return null;

  const listings = await db.listings.findByIds(candidates.map((entry) => entry.listingId), { limit: 12 });
  const notes = new Map(candidates.map((entry) => [entry.listingId, entry.note]));

  const cards = listings.map((listing, index) => ({
    rank: index + 1,
    listing,
    note: notes.get(listing.id) || null,
  }));

  const rows = compare.rowsFor(listings.slice(0, 3), {
    formatNaira: db.shape.formatNaira,
    formatMileage: db.shape.formatMileage,
  });

  return { cards, compared: listings.slice(0, 3), rows, count: listings.length };
}

/** The brief, as sentences rather than a raw key/value dump. */
function briefLines(request) {
  const brief = request.brief || {};
  return Object.entries(brief)
    .filter(([, value]) => value !== null && value !== '' && !(Array.isArray(value) && !value.length))
    .map(([key, value]) => [key.replace(/_/g, ' '), Array.isArray(value) ? value.join(', ') : String(value)]);
}

/**
 * The shortlist as an A4 PDF the buyer can forward.
 *
 * Same numbers as the page — the rows are passed in, not rebuilt — with each
 * car's note kept next to it, because the note is the reason to prefer one car
 * over another and a table cannot hold a paragraph.
 */
function pdf({ request, shortlist: list }, options = {}) {
  const business = businessInfo();
  const PDFDocument = require('pdfkit');
  const path = require('node:path');
  const fs = require('node:fs');

  const FONT = path.join(__dirname, '..', '..', 'assets', 'fonts', 'Inter-var.ttf');
  const doc = new PDFDocument({
    size: 'A4',
    margin: 44,
    bufferPages: true,
    compress: options.compress !== false,
    info: {
      Title: `Honest Cars shortlist ${request.trackingId}`,
      Author: 'Honest Cars Ltd',
      Subject: `Shortlist of ${list.count} verified cars for ${request.trackingId}`,
    },
  });

  const font = !options.plainFonts && fs.existsSync(FONT) ? FONT : null;
  if (font) doc.registerFont('Inter', font);
  const setFont = (size, bold = false) => (font ? doc.font('Inter') : doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')).fontSize(size);

  const navy = '#0E2A47';
  const slate = '#5B6B7C';
  const line = '#D8E0E8';
  const green = '#12A150';
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const naira = (kobo) => `₦${(Number(kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;

  doc.rect(0, 0, doc.page.width, 6).fill(navy);
  setFont(19, true).fillColor(navy).text('Honest Cars', left, 36);
  setFont(9).fillColor(slate).text(`${business.area} · ${String(business.site).replace(/^https?:\/\//, '')} · ${business.phone}`);
  setFont(20, true).fillColor(navy).text('Your shortlist', left, 74);
  setFont(10).fillColor(slate).text(
    `Request ${request.trackingId} · ${list.count} verified ${list.count === 1 ? 'car' : 'cars'} chosen against your brief`,
    left, 100,
  );

  // --- the brief they gave us, restated so the PDF is readable alone ----------
  let y = 132;
  setFont(11, true).fillColor(navy).text('What you asked for', left, y);
  y += 18;
  const lines = briefLines(request);
  setFont(9.5).fillColor('#1D2733');
  if (!lines.length) {
    doc.text('No brief was recorded on this request — call us and we will add it.', left, y, { width });
    y = doc.y + 10;
  } else {
    for (const [key, value] of lines) {
      doc.font(font ? 'Inter' : 'Helvetica').fontSize(9.5).fillColor(slate).text(`${key}: `, left, y, { continued: true });
      doc.fillColor('#1D2733').text(value);
      y = doc.y + 2;
    }
    y += 8;
  }

  // --- each car ---------------------------------------------------------------
  for (const card of list.cards) {
    const car = card.listing;
    const blockHeight = card.note ? 116 : 92;
    if (y + blockHeight > doc.page.height - doc.page.margins.bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top;
    }

    doc.roundedRect(left, y, width, blockHeight - 10, 8).fillAndStroke('#F7FAFC', line);
    setFont(13, true).fillColor(navy).text(`${card.rank}. ${car.title}`, left + 14, y + 12, { width: width - 28 });
    setFont(9).fillColor(slate).text(
      `${car.conditionLabel || ''} · ${Number(car.mileageKm || 0).toLocaleString('en-NG')} km · ${car.transmissionLabel || ''} ${car.fuelTypeLabel || ''}`.trim(),
      left + 14, y + 32, { width: width - 28 },
    );
    setFont(13, true).fillColor(navy).text(naira(car.priceKobo), left + 14, y + 48, { width: width / 2 });

    const positionColour = car.pricePosition === 'below' ? green : car.pricePosition === 'premium' ? '#C0392B' : slate;
    setFont(9, true).fillColor(positionColour).text(
      car.pricePositionLabel || 'No market band yet',
      left + width / 2, y + 50, { width: width / 2 - 14, align: 'right' },
    );
    setFont(9).fillColor(slate).text(
      `${car.gradeLabel || 'Network listed'}${car.documentsSummary ? ` · ${car.documentsSummary}` : ''}`,
      left + 14, y + 68, { width: width - 28 },
    );
    if (card.note) {
      setFont(9.5).fillColor('#1D2733').text(`“${card.note}”`, left + 14, y + 84, { width: width - 28, ellipsis: true, height: 24 });
    }
    y += blockHeight;
  }

  // --- the comparison of the top three ---------------------------------------
  if (list.compared.length >= 2) {
    if (y + 60 > doc.page.height - doc.page.margins.bottom - 10) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    setFont(12, true).fillColor(navy).text('Side by side', left, y);
    y += 20;
    const carWidth = (width - 120) / list.compared.length;
    const labelWidth = 120;

    setFont(8).fillColor(slate).text('', left, y);
    list.compared.forEach((car, index) => {
      setFont(8.5, true).fillColor(navy).text(car.title, left + labelWidth + index * carWidth, y, { width: carWidth - 6 });
    });
    y += 22;

    for (const row of list.rows) {
      if (y + 16 > doc.page.height - doc.page.margins.bottom - 10) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      setFont(8.5).fillColor(slate).text(row.label, left, y, { width: labelWidth - 6 });
      row.values.forEach((value, index) => {
        const winner = index === row.bestIndex;
        setFont(8.5, winner).fillColor(winner ? green : '#1D2733').text(value, left + labelWidth + index * carWidth, y, { width: carWidth - 6 });
      });
      doc.moveTo(left, y + 14).lineTo(left + width, y + 14).lineWidth(0.5).strokeColor(line).stroke();
      y += 18;
    }
  }

  // --- what happens next ------------------------------------------------------
  y += 12;
  if (y + 70 > doc.page.height - doc.page.margins.bottom - 10) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  setFont(11, true).fillColor(navy).text('What happens next', left, y);
  setFont(9.5).fillColor('#1D2733').text(
    'Pick the ones you want to see and reply on WhatsApp — we arrange the viewing, come with you, and hold the price we quoted. '
    + 'Anything on this list that is not what it promises, we say so before you travel.',
    left, y + 18, { width },
  );

  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    setFont(8).fillColor(slate).text(
      `${request.trackingId} · page ${index + 1} of ${range.count} · prices held 7 days from this date`,
      left, doc.page.height - 28, { width, align: 'center' },
    );
    doc.page.margins.bottom = saved;
  }

  doc.end();
  return doc;
}

/**
 * The letterhead, built here rather than at each call site — the same block
 * services/report.js puts on the inspection report, so two documents from the
 * same company cannot disagree about the phone number.
 */
function businessInfo() {
  const config = require('../config');
  return {
    name: 'Honest Cars Ltd',
    site: config.siteUrl,
    phone: config.business.phone,
    whatsapp: config.business.whatsapp,
    email: config.business.email,
    area: 'Port Harcourt, Rivers State',
  };
}

/** `honest-cars-shortlist-HC-2487.pdf` */
function fileName(request) {
  return `honest-cars-shortlist-${request.trackingId}.pdf`;
}

module.exports = {
  SLA_OPTIONS, MUST_HAVES, INTENDED_USE, TIMELINES, ADDONS, DEFAULT_SLA, slaOption,
  shortlist, briefLines, pdf, fileName, business: businessInfo,
};
