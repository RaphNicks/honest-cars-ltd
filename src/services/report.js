'use strict';

/**
 * Inspection report — FR-07 “mobile checklist → auto PDF report”, §7.3.
 *
 * The inspector fills the checklist in /admin/jobs; this module turns the
 * booking row into the document the customer keeps:
 *
 *   • `build()`  — one structured object, used by both renderers, so the page
 *                  and the PDF can never disagree.
 *   • `pdf()`    — a real A4 PDF (pdfkit), Inter embedded, naira-safe.
 *   • the print view at /report/inspection/{reference} for anyone who would
 *     rather read it in a browser or print it.
 *
 * Access is decided by the route, not here: staff, or the customer whose phone
 * matches the booking. The report is never indexable and never cached publicly.
 */

const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');
const phone = require('../lib/phone');
const db = require('../db');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'Inter-var.ttf');

/** The seven sections the inspector marks (same keys as the console form). */
const SECTIONS = [
  { key: 'engine', label: 'Engine & fluids' },
  { key: 'transmission', label: 'Transmission' },
  { key: 'suspension', label: 'Suspension & steering' },
  { key: 'brakes', label: 'Brakes & tyres' },
  { key: 'electricals', label: 'Electricals & AC' },
  { key: 'body', label: 'Body, paint & interior' },
  { key: 'documents', label: 'Documents & VIN' },
];

const MARK_LABELS = {
  ok: 'OK',
  attention: 'Attention',
  fail: 'Fail',
  '—': 'Not recorded',
};

const VERDICT_LABELS = {
  pass: 'Pass',
  pass_with_advisory: 'Pass with advisories',
  fail: 'Fail — do not buy at this price',
};

function naira(kobo) {
  const value = Number(kobo || 0) / 100;
  return `₦${value.toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

function longDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-NG', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The report for one booking. Returns null when the booking does not exist;
 * `ready: false` when no checklist has been filed yet (the page then explains
 * that rather than printing an empty document).
 */
async function build(bookingId) {
  const booking = await db.queryOne('SELECT * FROM bookings WHERE id = ? LIMIT 1', [bookingId]);
  if (!booking) return null;

  const inspector = booking.inspector_id
    ? await db.queryOne('SELECT id, name FROM `users` WHERE id = ? LIMIT 1', [booking.inspector_id])
    : null;
  const request = booking.request_id
    ? await db.queryOne('SELECT tracking_id FROM service_requests WHERE id = ? LIMIT 1', [booking.request_id])
    : null;

  const checklist = typeof booking.checklist === 'string' ? JSON.parse(booking.checklist) : booking.checklist || null;
  const vehicle = typeof booking.vehicle === 'string' ? JSON.parse(booking.vehicle) : booking.vehicle || null;
  const marks = (checklist && checklist.sections) || {};

  const sections = SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    mark: marks[section.key] || '—',
    markLabel: MARK_LABELS[marks[section.key] || '—'],
  }));

  const decided = sections.filter((section) => section.mark !== '—');
  const attention = sections.filter((section) => section.mark === 'attention');
  const failed = sections.filter((section) => section.mark === 'fail');

  return {
    ready: Boolean(checklist && decided.length),
    reference: booking.reference,
    type: booking.type,
    status: booking.status,
    filedAt: booking.completed_at || booking.updated_at,
    slotAt: booking.slot_at,
    location: booking.location,
    serviceSlug: booking.service_slug,
    trackingId: request ? request.tracking_id : null,
    customer: { name: booking.name, phone: booking.phone },
    vehicle: vehicle
      ? {
        title: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' '),
        make: vehicle.make || null,
        model: vehicle.model || null,
        year: vehicle.year || null,
        vin: vehicle.vin || null,
        mileageKm: vehicle.mileage_km || null,
      }
      : null,
    inspector: inspector ? { id: inspector.id, name: inspector.name || 'Inspector' } : null,
    inspectorName: inspector && inspector.name ? inspector.name : 'Not recorded',
    checklist: {
      obd2Codes: (checklist && checklist.obd2_codes) || 'Not recorded',
      photos: (checklist && checklist.photos) || null,
      checkedOn: (checklist && checklist.checked_on) || null,
    },
    sections,
    counts: { recorded: decided.length, attention: attention.length, failed: failed.length },
    verdict: booking.verdict,
    verdictLabel: VERDICT_LABELS[booking.verdict] || 'Not decided',
    notes: booking.report_notes || null,
    amountKobo: Number(booking.amount_kobo || 0),
    paymentStatus: booking.payment_status,
    business: {
      name: 'Honest Cars Ltd',
      site: config.siteUrl,
      phone: config.business.phone,
      whatsapp: config.business.whatsapp,
      email: config.business.email,
      area: 'Port Harcourt, Rivers State',
    },
    // §6.10: the liability wording the client's counsel supplied for reports.
    disclaimer:
      'This report records what was visible and measurable on the day of inspection, using the checklist above. It is not a warranty and not a guarantee of future condition: a used car can develop a fault the day after it was checked. Mileage readings are reported as seen; where the odometer history looked inconsistent we have said so. The price opinion is based on our market data for Port Harcourt on the inspection date.',
  };
}

/** Everything the report needs is a booking id; names resolve here for files. */
function fileName(report) {
  return `honestcars-inspection-${String(report.reference).toLowerCase()}.pdf`;
}

/**
 * Render the A4 PDF. Returns a Node stream — the route pipes it to the client,
 * so nothing large is held in memory and no file is written to disk.
 *
 * `options.plainFonts` swaps Inter for the built-in fonts, which makes the text
 * readable to test tooling; production always embeds Inter (it is also the only
 * way the naira sign reaches the page).
 */
function pdf(report, options = {}) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, compress: options.compress !== false, info: {
    Title: `Inspection report ${report.reference}`,
    Author: 'Honest Cars Ltd',
    Subject: report.vehicle ? `${report.vehicle.title} — pre-purchase inspection` : 'Pre-purchase inspection',
  } });

  const font = !options.plainFonts && fs.existsSync(FONT_REGULAR) ? FONT_REGULAR : null;
  if (font) doc.registerFont('Inter', font);
  const setFont = (size, bold = false) => {
    if (font) return doc.font('Inter').fontSize(size);
    return doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  };

  const navy = '#0E2A47';
  const green = '#12A150';
  const amber = '#E8A13D';
  const red = '#C0392B';
  const slate = '#5B6B7C';
  const line = '#D8E0E8';
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // --- header ---------------------------------------------------------------
  doc.rect(0, 0, doc.page.width, 6).fill(navy);
  setFont(20, true).fillColor(navy).text('Honest Cars', left, 40);
  setFont(10).fillColor(slate).text(`${report.business.area} · ${report.business.site.replace(/^https?:\/\//, '')} · ${phone.pretty(report.business.phone)}`);
  setFont(22, true).fillColor(navy).text('Pre-purchase inspection report', left, 84);
  setFont(11).fillColor(slate).text(`Reference ${report.reference} · filed ${longDate(report.filedAt)}`);

  // --- verdict block --------------------------------------------------------
  const verdictColour = report.verdict === 'fail' ? red : report.verdict === 'pass' ? green : amber;
  const boxTop = 150;
  doc.roundedRect(left, boxTop, width, 54, 8).fillAndStroke('#F7FAFC', line);
  doc.rect(left, boxTop, 5, 54).fill(verdictColour);
  setFont(9).fillColor(slate).text('VERDICT', left + 16, boxTop + 10, { characterSpacing: 0.6 });
  setFont(15, true).fillColor(verdictColour).text(report.verdictLabel, left + 16, boxTop + 24);
  setFont(9).fillColor(slate).text(
    `${report.counts.recorded}/7 sections recorded · ${report.counts.attention} advisory · ${report.counts.failed} failing`,
    left, boxTop + 26, { width: width - 32, align: 'right' },
  );

  // --- who and what ---------------------------------------------------------
  let y = boxTop + 74;
  const column = (label, value, x, w) => {
    setFont(9).fillColor(slate).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.5 });
    setFont(11).fillColor('#1D2733').text(value || '—', x, y + 14, { width: w });
  };
  column('Customer', report.customer.name, left, width / 2 - 12);
  column('Inspector', report.inspectorName, left + width / 2, width / 2);
  y += 40;
  column('Vehicle', report.vehicle ? report.vehicle.title : '—', left, width / 2 - 12);
  column('Mileage seen', report.vehicle && report.vehicle.mileageKm ? `${Number(report.vehicle.mileageKm).toLocaleString('en-NG')} km` : 'Not recorded', left + width / 2, width / 2);
  y += 40;
  column('Inspected at', report.location || '—', left, width / 2 - 12);
  column('Fee', report.amountKobo ? `${naira(report.amountKobo)} · ${report.paymentStatus}` : '—', left + width / 2, width / 2);

  // --- checklist ------------------------------------------------------------
  y += 46;
  setFont(13, true).fillColor(navy).text('The checklist', left, y);
  y += 22;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(line).stroke();
  y += 8;

  for (const section of report.sections) {
    const colour = section.mark === 'ok' ? green : section.mark === 'attention' ? amber : section.mark === 'fail' ? red : slate;
    setFont(11).fillColor('#1D2733').text(section.label, left, y, { width: width - 120 });
    setFont(10, true).fillColor(colour).text(section.markLabel, left + width - 110, y, { width: 110, align: 'right' });
    y += 20;
    doc.moveTo(left, y - 4).lineTo(left + width, y - 4).lineWidth(0.5).strokeColor(line).stroke();
  }

  y += 10;
  setFont(10, true).fillColor(navy).text('OBD2 codes read', left, y);
  setFont(11).fillColor('#1D2733').text(report.checklist.obd2Codes, left, y + 16, { width });
  y = doc.y + 14;
  if (report.checklist.photos) {
    setFont(10, true).fillColor(navy).text('Photos', left, y);
    setFont(11).fillColor('#1D2733').text(report.checklist.photos, left, y + 16, { width });
    y = doc.y + 14;
  }

  if (report.notes) {
    setFont(13, true).fillColor(navy).text('What the inspector found', left, y);
    y = doc.y + 8;
    setFont(11).fillColor('#1D2733').text(report.notes, left, y, { width, lineGap: 3 });
    y = doc.y + 16;
  }

  // --- footer on every page -------------------------------------------------
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    // Writing inside the bottom margin would itself create a new page, so the
    // margin is lifted for the footer and put back afterwards.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const bottom = doc.page.height - 70;
    doc.moveTo(left, bottom).lineTo(left + width, bottom).lineWidth(0.5).strokeColor(line).stroke();
    setFont(8).fillColor(slate).text(report.disclaimer, left, bottom + 8, { width, lineGap: 2 });
    setFont(8).fillColor(slate).text(
      `${report.reference} · page ${i + 1} of ${pages.count}`,
      left, doc.page.height - 40, { width, align: 'right' },
    );
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return doc;
}

module.exports = { SECTIONS, MARK_LABELS, VERDICT_LABELS, build, pdf, fileName, naira };
