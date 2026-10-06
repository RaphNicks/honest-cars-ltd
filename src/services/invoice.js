'use strict';

/**
 * Hire invoice and completion note — FR-22, J6 “completion + invoice PDF”.
 *
 * One structured object, two renderers (the print view and the PDF), so the
 * page and the document can never disagree — the same shape as the inspection
 * report, for the same reason.
 *
 * The invoice is only real once the hire is confirmed or finished: a document
 * titled “invoice” that the client has not agreed to pay is a request, and the
 * quote already covers that. `ready` says which of the two this is, and the
 * routes refuse to print an invoice for a hire that is still a request.
 */

const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');
const db = require('../db');
const money = require('../lib/money');
const hireService = require('./hire');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'Inter-var.ttf');

const INVOICE_FROM = ['confirmed', 'on_hire', 'completed'];

function longDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Everything the invoice shows, from the booking row.
 *
 * Line amounts come off the booking, never off the current rate card: a hire
 * agreed at ₦35,000 a day stays ₦35,000 a day after the class is repriced.
 */
async function build(bookingId) {
  const booking = await db.hire.bookingById(bookingId);
  if (!booking) return null;

  const hireClass = await hireService.classBySlug(booking.classSlug);
  const incidents = await db.hire.incidents({ bookingId: booking.id });
  const chargedIncidents = incidents.filter((i) => i.chargedKobo > 0);
  const chargedKobo = chargedIncidents.reduce((sum, i) => sum + i.chargedKobo, 0);

  const lines = [];
  const weeks = booking.days >= hireService.WEEKLY_FROM_DAYS && hireClass && Number(hireClass.weekly_rate_kobo) > 0
    ? Math.floor(booking.days / 7)
    : 0;
  const looseDays = weeks ? booking.days % 7 : booking.days;
  const hireLineKobo = weeks
    ? weeks * Number(hireClass.weekly_rate_kobo) + looseDays * Number(hireClass.daily_rate_kobo)
    : booking.days * booking.dayRateKobo;

  lines.push({
    label: weeks
      ? `Vehicle hire — ${hireClass.name}, ${weeks} week${weeks === 1 ? '' : 's'}${looseDays ? ` + ${looseDays} day${looseDays === 1 ? '' : 's'}` : ''}`
      : `Vehicle hire — ${hireClass ? hireClass.name : booking.className}, ${booking.days} day${booking.days === 1 ? '' : 's'}`,
    detail: `${longDate(booking.pickupAt)} to ${longDate(booking.dropoffAt)} · ${booking.plate || 'unit to be confirmed'}`,
    amountKobo: hireLineKobo,
  });
  if (booking.driverKobo) {
    lines.push({ label: `Driver — ${booking.days} day${booking.days === 1 ? '' : 's'}`, detail: booking.driverName || 'Assigned driver', amountKobo: booking.driverKobo });
  }
  if (booking.extrasKobo) {
    lines.push({ label: 'Extras', detail: 'Agreed at quote', amountKobo: booking.extrasKobo });
  }
  if (booking.depositKobo) {
    lines.push({ label: 'Refundable deposit', detail: 'Returned in full at handover, less any recorded damage or fines', amountKobo: booking.depositKobo });
  }
  for (const incident of chargedIncidents) {
    lines.push({ label: `Incident charge — ${incident.kindLabel}`, detail: incident.detail, amountKobo: incident.chargedKobo });
  }

  const totalKobo = lines.reduce((sum, line) => sum + line.amountKobo, 0);
  const paidKobo = booking.paymentStatus === 'paid' ? Number(booking.totalKobo) : 0;
  const depositKobo = booking.depositKobo;

  return {
    reference: booking.reference,
    isInvoice: true,
    booking,
    customer: { name: booking.clientName, company: booking.company, phone: booking.phone },
    vehicle: booking.vehicleId
      ? { plate: booking.plate, title: booking.vehicleTitle, className: booking.className }
      : { plate: null, title: null, className: booking.className },
    period: { from: booking.pickupAt, to: booking.dropoffAt, days: booking.days, label: `${longDate(booking.pickupAt)} to ${longDate(booking.dropoffAt)}` },
    lines,
    chargedIncidents,
    chargedKobo,
    hireKobo: hireLineKobo,
    totalKobo,
    depositKobo,
    balanceKobo: Math.max(0, totalKobo - paidKobo),
    paidKobo,
    depositReturnKobo: booking.status === 'completed' && booking.paymentStatus === 'paid' ? depositKobo : 0,
    status: booking.status,
    statusLabel: booking.statusLabel,
    dueDate: booking.pickupAt,
    filedAt: booking.completedAt || booking.acceptedAt || booking.createdAt,
    // Only a confirmed or finished hire is an invoice; before that it is a quote.
    ready: INVOICE_FROM.includes(booking.status),
    payment: booking.paymentReference
      ? { reference: booking.paymentReference, status: booking.paymentStatus, id: booking.paymentId }
      : null,
    fuel: { out: booking.fuelOut, in: booking.fuelIn, odometerOut: booking.odometerOut, odometerIn: booking.odometerIn },
    business: {
      name: 'Honest Cars Ltd',
      site: config.siteUrl,
      phone: config.business.phone,
      whatsapp: config.business.whatsapp,
      email: config.business.email,
      area: 'Port Harcourt, Rivers State',
    },
    // §6.10: what the client is agreeing to when they take the keys.
    terms:
      'The vehicle is supplied roadworthy and insured for third-party use, with the papers on board. Fuel is the hirer’s cost and the tank is read out and in. Any traffic fine or toll incurred during the hire is the hirer’s, and we pass the notice on at cost. The deposit is refunded in full at handover, less any recorded damage beyond fair wear, unpaid fines or missing fuel, which are itemised above before any deduction is made.',
  };
}

function fileName(invoice) {
  return `honestcars-hire-${String(invoice.reference).toLowerCase()}-invoice.pdf`;
}

/**
 * A4 invoice. Naira-safe (Inter carries the sign), streamed — the route pipes it
 * out, so nothing is buffered whole or written to disk.
 */
function pdf(invoice, options = {}) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    bufferPages: true,
    compress: options.compress !== false,
    info: {
      Title: `Hire invoice ${invoice.reference}`,
      Author: 'Honest Cars Ltd',
      Subject: `${invoice.period.label} — vehicle hire invoice`,
    },
  });

  const font = !options.plainFonts && fs.existsSync(FONT_REGULAR) ? FONT_REGULAR : null;
  if (font) doc.registerFont('Inter', font);
  const setFont = (size, bold = false) => {
    if (font) return doc.font('Inter').fontSize(size);
    return doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  };

  const navy = '#0E2A47';
  const green = '#12A150';
  const amber = '#E8A13D';
  const slate = '#5B6B7C';
  const line = '#D8E0E8';
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const paid = invoice.paidKobo >= invoice.totalKobo && invoice.totalKobo > 0;

  // --- header ---------------------------------------------------------------
  doc.rect(0, 0, doc.page.width, 6).fill(navy);
  setFont(20, true).fillColor(navy).text('Honest Cars', left, 40);
  setFont(10).fillColor(slate).text(`${invoice.business.area} · ${invoice.business.site.replace(/^https?:\/\//, '')} · ${invoice.business.phone}`);
  setFont(22, true).fillColor(navy).text(invoice.ready ? 'Hire invoice' : 'Hire quote', left, 84);
  setFont(11).fillColor(slate).text(`Reference ${invoice.reference} · ${invoice.statusLabel} · issued ${longDate(invoice.filedAt)}`);

  // Paid / due block, top right — the first thing the client looks for.
  const boxW = 170;
  const boxX = left + width - boxW;
  doc.roundedRect(boxX, 40, boxW, 62, 8).fillAndStroke(paid ? '#F2FBF6' : '#FFF9F0', line);
  setFont(9).fillColor(slate).text(paid ? 'PAID IN FULL' : 'AMOUNT DUE', boxX + 14, 52, { characterSpacing: 0.6 });
  setFont(16, true).fillColor(paid ? green : amber).text(money.formatNaira(invoice.totalKobo), boxX + 14, 68);
  setFont(8).fillColor(slate).text(invoice.payment ? `${invoice.payment.reference} · ${invoice.payment.status}` : 'No payment recorded yet', boxX + 14, 88, { width: boxW - 28 });

  // --- who and what ---------------------------------------------------------
  let y = 150;
  const column = (label, value, x, w) => {
    setFont(9).fillColor(slate).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.5 });
    setFont(11).fillColor('#1D2733').text(value || '—', x, y + 14, { width: w });
  };
  column('Hired by', invoice.customer.company ? `${invoice.customer.company} — ${invoice.customer.name}` : invoice.customer.name, left, width / 2 - 12);
  column('Contact', invoice.customer.phone ? maskPhone(invoice.customer.phone) : '—', left + width / 2, width / 2);
  y += 40;
  column('Vehicle', invoice.vehicle.title ? `${invoice.vehicle.title} (${invoice.vehicle.plate})` : `${invoice.vehicle.className} — unit assigned at handover`, left, width / 2 - 12);
  column('Period', `${invoice.period.label} · ${invoice.period.days} day${invoice.period.days === 1 ? '' : 's'}`, left + width / 2, width / 2);
  y += 40;
  column('Driver', invoice.booking.withDriver ? (invoice.booking.driverName || 'Included') : 'Self-drive', left, width / 2 - 12);
  column('Handover', invoice.booking.pickupPoint || 'Port Harcourt office', left + width / 2, width / 2);

  // --- lines ----------------------------------------------------------------
  y += 48;
  setFont(13, true).fillColor(navy).text(invoice.ready ? 'What you are paying for' : 'What the quote covers', left, y);
  y += 24;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(line).stroke();
  y += 8;
  for (const item of invoice.lines) {
    setFont(11).fillColor('#1D2733').text(item.label, left, y, { width: width - 130 });
    setFont(11, true).fillColor('#1D2733').text(money.formatNaira(item.amountKobo), left + width - 120, y, { width: 120, align: 'right' });
    y += 18;
    setFont(9).fillColor(slate).text(item.detail || '', left, y, { width: width - 130 });
    y = doc.y + 10;
    doc.moveTo(left, y - 6).lineTo(left + width, y - 6).lineWidth(0.5).strokeColor(line).stroke();
  }

  // --- total ----------------------------------------------------------------
  y += 6;
  setFont(12, true).fillColor(navy).text('Total', left, y, { width: width - 130 });
  setFont(13, true).fillColor(navy).text(money.formatNaira(invoice.totalKobo), left + width - 130, y, { width: 130, align: 'right' });
  y += 22;
  setFont(10).fillColor(slate).text(
    invoice.paidKobo
      ? `Paid ${money.formatNaira(invoice.paidKobo)}${invoice.balanceKobo ? ` · balance ${money.formatNaira(invoice.balanceKobo)}` : ' · nothing outstanding'}`
      : 'Payable before handover — bank transfer or card link.',
    left, y, { width: width - 130 },
  );
  if (invoice.depositKobo) {
    y += 16;
    setFont(10).fillColor(slate).text(
      invoice.depositReturnKobo
        ? `Deposit of ${money.formatNaira(invoice.depositReturnKobo)} released back at handover.`
        : `Includes a refundable deposit of ${money.formatNaira(invoice.depositKobo)}, returned at handover.`,
      left, y, { width: width - 130 },
    );
  }

  // --- handover readings & incidents ---------------------------------------
  y += 26;
  setFont(11, true).fillColor(navy).text('Handover readings', left, y);
  y += 18;
  setFont(10).fillColor('#1D2733').text(
    `Fuel out ${invoice.fuel.out === null || invoice.fuel.out === undefined ? '—' : `${invoice.fuel.out}%`} · in ${invoice.fuel.in === null || invoice.fuel.in === undefined ? '—' : `${invoice.fuel.in}%`} · ` +
    `Odometer out ${invoice.fuel.odometerOut ? `${Number(invoice.fuel.odometerOut).toLocaleString('en-NG')} km` : '—'} · in ${invoice.fuel.odometerIn ? `${Number(invoice.fuel.odometerIn).toLocaleString('en-NG')} km` : '—'}`,
    left, y, { width },
  );

  if (invoice.chargedIncidents.length) {
    y = doc.y + 18;
    setFont(11, true).fillColor(navy).text('Incidents charged on this hire', left, y);
    y += 18;
    for (const incident of invoice.chargedIncidents) {
      setFont(10).fillColor('#1D2733').text(`${incident.kindLabel} — ${incident.detail}`, left, y, { width: width - 110 });
      setFont(10, true).fillColor('#1D2733').text(money.formatNaira(incident.chargedKobo), left + width - 100, y, { width: 100, align: 'right' });
      y = doc.y + 8;
    }
  }

  // --- terms ----------------------------------------------------------------
  y = doc.y + 22;
  if (y > doc.page.height - 190) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  setFont(11, true).fillColor(navy).text('Terms of hire', left, y);
  setFont(9).fillColor(slate).text(invoice.terms, left, y + 16, { width, lineGap: 2.5 });

  // --- footer on every page -------------------------------------------------
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const bottom = doc.page.height - 62;
    doc.moveTo(left, bottom).lineTo(left + width, bottom).lineWidth(0.5).strokeColor(line).stroke();
    setFont(8).fillColor(slate).text(
      `${invoice.business.name} · ${invoice.business.address || invoice.business.area} · ${invoice.business.email}`,
      left, bottom + 8, { width, align: 'left' },
    );
    setFont(8).fillColor(slate).text(`${invoice.reference} · page ${i + 1} of ${pages.count}`, left, bottom + 8, { width, align: 'right' });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return doc;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 6) return value || '—';
  return `${String(value).slice(0, String(value).length - 6).trim()}••• ${digits.slice(-4)}`;
}

module.exports = { INVOICE_FROM, build, pdf, fileName, longDate };
