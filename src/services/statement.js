'use strict';

/**
 * Dealer commission statement — FR-18, §7.2 “Commission statements per closed
 * deal”.
 *
 * `dealer_ledger` is append-only and signed (migration 012), which is what
 * makes a *statement* possible rather than a report: the balance at any moment
 * is the sum of the rows up to it, so a month can be stated with a real opening
 * balance, the entries inside it, and a closing balance that ties back to the
 * ledger. Nothing here recomputes money — it presents it.
 *
 * Two shapes, the same numbers:
 *
 *   build(dealerId, 'YYYY-MM')  → the object the page and the PDF both render
 *   pdf(statement)              → an A4 document a lot can file or forward
 *
 * The month's `closedDeals` are the sale commissions in the window, each with
 * the car and the payment behind it — “per closed deal” is the sentence §7.2
 * uses, and it is the one a dealer checks first.
 */

const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');
const db = require('../db');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'Inter-var.ttf');

const ENTRY_LABELS = {
  sale_commission: 'Commission on a sale',
  payout: 'Payout to the lot',
  adjustment: 'Adjustment',
  clawback: 'Clawback',
};

const MONTH_RE = /^\d{4}-\d{2}$/;

function naira(kobo) {
  return `₦${(Number(kobo || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

function signedNaira(kobo) {
  const value = Number(kobo || 0);
  return `${value < 0 ? '−' : ''}${naira(Math.abs(value))}`;
}

function monthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function monthBounds(key) {
  const [year, month] = String(key).split('-').map(Number);
  const start = `${key}-01 00:00:00`;
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
  return { start, endExclusive: `${nextMonth}-01 00:00:00` };
}

/** Every month this lot has any ledger activity in, newest first. */
async function months(dealerId) {
  const rows = await db.query(
    `SELECT DISTINCT DATE_FORMAT(created_at, '%Y-%m') AS month
       FROM dealer_ledger WHERE dealer_id = ?
      ORDER BY month DESC LIMIT 36`,
    [dealerId],
  );
  return rows.map((row) => row.month);
}

/**
 * One month, stated. Anything that fails to tie is shown rather than hidden:
 * `ties` compares the closing balance against the ledger's own sum, and the
 * page says so when it does not.
 */
async function build(dealerId, key = null) {
  const dealer = await db.queryOne('SELECT id, name, slug, city, lot_area, tier, verified FROM dealers WHERE id = ? LIMIT 1', [dealerId]);
  if (!dealer) return null;

  const month = MONTH_RE.test(String(key || '')) ? String(key) : monthKey();
  const { start, endExclusive } = monthBounds(month);

  const [openingRow] = await db.query(
    'SELECT COALESCE(SUM(amount_kobo), 0) AS balance FROM dealer_ledger WHERE dealer_id = ? AND created_at < ?',
    [dealerId, start],
  );
  const openingKobo = Number(openingRow.balance || 0);

  const rows = await db.query(
    `SELECT l.id, l.entry_type, l.amount_kobo, l.detail, l.reference, l.created_at,
            v.stock_no, v.seo_slug, v.make, v.model, v.year, v.commission_terms_ref,
            p.reference AS payment_reference, p.paid_at
       FROM dealer_ledger l
       LEFT JOIN vehicle_listings v ON v.id = l.listing_id
       LEFT JOIN payments p ON p.id = l.payment_id
      WHERE l.dealer_id = ? AND l.created_at >= ? AND l.created_at < ?
      ORDER BY l.created_at ASC, l.id ASC`,
    [dealerId, start, endExclusive],
  );

  let running = openingKobo;
  const entries = rows.map((row) => {
    const amountKobo = Number(row.amount_kobo);
    running += amountKobo;
    return {
      id: row.id,
      date: row.created_at,
      type: row.entry_type,
      label: ENTRY_LABELS[row.entry_type] || row.entry_type,
      amountKobo,
      balanceKobo: running,
      detail: row.detail || null,
      reference: row.reference || null,
      paymentReference: row.payment_reference || null,
      paidAt: row.paid_at || null,
      commissionTermsRef: row.commission_terms_ref || null,
      listing: row.stock_no
        ? {
          stockNo: row.stock_no,
          title: [row.year, row.make, row.model].filter(Boolean).join(' '),
          slug: row.seo_slug,
          url: `/cars/${row.seo_slug}`,
        }
        : null,
    };
  });

  const sum = (type) => entries.filter((entry) => entry.type === type).reduce((total, entry) => total + entry.amountKobo, 0);
  const closedDeals = entries.filter((entry) => entry.type === 'sale_commission');
  const closingKobo = openingKobo + entries.reduce((total, entry) => total + entry.amountKobo, 0);

  const ledgerRow = await db.queryOne(
    'SELECT COALESCE(SUM(amount_kobo), 0) AS balance FROM dealer_ledger WHERE dealer_id = ? AND created_at < ?',
    [dealerId, endExclusive],
  );
  const ledgerClosingKobo = Number(ledgerRow.balance || 0);

  return {
    dealer: {
      id: dealer.id,
      name: dealer.name,
      city: dealer.city,
      area: dealer.lot_area,
      tier: dealer.tier,
      verified: Boolean(dealer.verified),
    },
    month,
    label: monthLabel(month),
    period: { start, endExclusive },
    openingKobo,
    closingKobo,
    entries,
    closedDeals,
    totals: {
      commissionKobo: sum('sale_commission'),
      payoutKobo: sum('payout'),
      adjustmentKobo: sum('adjustment'),
      clawbackKobo: sum('clawback'),
      netKobo: closingKobo - openingKobo,
    },
    // The ledger is the source of truth. If these ever disagree, the statement
    // says so on its face rather than quietly rounding the difference away.
    ties: closingKobo === ledgerClosingKobo,
    ledgerClosingKobo,
    business: {
      name: 'Honest Cars Ltd',
      site: config.siteUrl,
      phone: config.business.phone,
      email: config.business.email,
      area: `${config.business.city}, ${config.business.region}`,
    },
    generatedAt: new Date(),
  };
}

/** The A4 document. Same numbers as the page — one object, two renderers. */
function pdf(statement, options = {}) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    bufferPages: true,
    compress: options.compress !== false,
    info: {
      Title: `Commission statement ${statement.label}`,
      Author: 'Honest Cars Ltd',
      Subject: `${statement.dealer.name} — ${statement.label}`,
    },
  });

  const font = !options.plainFonts && fs.existsSync(FONT_REGULAR) ? FONT_REGULAR : null;
  if (font) doc.registerFont('Inter', font);
  const setFont = (size, bold = false) => (font
    ? doc.font('Inter').fontSize(size)
    : doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size));

  const navy = '#0E2A47';
  const slate = '#5B6B7C';
  const line = '#D8E0E8';
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.rect(0, 0, doc.page.width, 6).fill(navy);
  setFont(20, true).fillColor(navy).text('Honest Cars', left, 40);
  setFont(10).fillColor(slate)
    .text(`${statement.business.area} · ${statement.business.site.replace(/^https?:\/\//, '')} · ${statement.business.phone}`);
  setFont(20, true).fillColor(navy).text('Commission statement', left, 84);
  setFont(11).fillColor(slate).text(`${statement.label} · issued ${statement.generatedAt.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })}`);

  // The lot this statement belongs to.
  setFont(13, true).fillColor(navy).text(statement.dealer.name, left, 128);
  setFont(10).fillColor(slate).text(`${statement.dealer.area || statement.dealer.city}${statement.dealer.verified ? ' · Verified partner' : ''}`);

  // Balance box, top right — the number a dealer checks first.
  const boxW = 190;
  const boxX = left + width - boxW;
  doc.roundedRect(boxX, 124, boxW, 58, 8).fillAndStroke('#F7F9FC', line);
  setFont(9).fillColor(slate).text('Closing balance', boxX + 12, 134);
  setFont(16, true).fillColor(navy).text(signedNaira(statement.closingKobo), boxX + 12, 146);
  setFont(9).fillColor(slate).text(`Opening ${signedNaira(statement.openingKobo)}`, boxX + 12, 168);

  // Closed deals in the window.
  let y = 206;
  setFont(12, true).fillColor(navy).text(`Closed deals (${statement.closedDeals.length})`, left, y);
  y += 18;
  if (!statement.closedDeals.length) {
    setFont(10).fillColor(slate).text('No closed deal was commissioned in this month.', left, y);
    y += 18;
  } else {
    for (const deal of statement.closedDeals) {
      setFont(10, true).fillColor(navy).text(deal.listing ? `${deal.listing.stockNo} · ${deal.listing.title}` : (deal.detail || 'Closed deal'), left, y, { width: width - 120 });
      setFont(10, true).fillColor(navy).text(signedNaira(deal.amountKobo), left + width - 120, y, { width: 120, align: 'right' });
      y = doc.y + 2;
      setFont(9).fillColor(slate).text(
        `${new Date(deal.date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}${deal.paymentReference ? ` · paid ${deal.paymentReference}` : ''}${deal.commissionTermsRef ? ` · terms ${deal.commissionTermsRef}` : ''}`,
        left, y, { width },
      );
      y = doc.y + 8;
      if (y > doc.page.height - 160) {
        doc.addPage();
        y = doc.page.margins.top;
      }
    }
  }

  // Every entry, in order, with the running balance.
  y += 6;
  setFont(12, true).fillColor(navy).text('Ledger', left, y);
  y += 18;
  const columns = [
    { x: left, w: 70, label: 'Date' },
    { x: left + 76, w: width - 76 - 210, label: 'Entry' },
    { x: left + width - 210, w: 100, label: 'Amount' },
    { x: left + width - 105, w: 105, label: 'Balance' },
  ];
  setFont(9, true).fillColor(slate);
  for (const column of columns) doc.text(column.label, column.x, y, { width: column.w });
  y += 14;
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor(line).stroke();
  y += 6;

  for (const entry of statement.entries) {
    setFont(9).fillColor(slate).text(new Date(entry.date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: '2-digit' }), columns[0].x, y, { width: columns[0].w });
    setFont(9).fillColor(navy).text(
      `${entry.label}${entry.listing ? ` — ${entry.listing.stockNo}` : ''}${entry.detail ? ` — ${entry.detail}` : ''}`,
      columns[1].x, y, { width: columns[1].w },
    );
    setFont(9, true).fillColor(entry.amountKobo < 0 ? '#B42318' : navy).text(signedNaira(entry.amountKobo), columns[2].x, y, { width: columns[2].w, align: 'right' });
    setFont(9).fillColor(slate).text(signedNaira(entry.balanceKobo), columns[3].x, y, { width: columns[3].w, align: 'right' });
    y = Math.max(doc.y, y + 14) + 4;
    if (y > doc.page.height - 90) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  }

  if (!statement.entries.length) {
    setFont(10).fillColor(slate).text('No ledger entries in this month.', left, y);
    y += 22;
  }

  // Totals.
  if (y > doc.page.height - 150) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  doc.moveTo(left, y).lineTo(left + width, y).strokeColor(line).stroke();
  y += 10;
  const totalRows = [
    ['Commission earned', statement.totals.commissionKobo],
    ['Payouts', statement.totals.payoutKobo],
    ['Adjustments', statement.totals.adjustmentKobo],
    ['Clawbacks', statement.totals.clawbackKobo],
  ];
  for (const [label, value] of totalRows) {
    setFont(9).fillColor(slate).text(label, left + width - 250, y, { width: 130, align: 'right' });
    setFont(9, true).fillColor(navy).text(signedNaira(value), left + width - 110, y, { width: 110, align: 'right' });
    y += 14;
  }
  setFont(11, true).fillColor(navy).text('Closing balance', left + width - 250, y + 4, { width: 130, align: 'right' });
  setFont(11, true).fillColor(navy).text(signedNaira(statement.closingKobo), left + width - 110, y + 4, { width: 110, align: 'right' });

  if (!statement.ties) {
    y += 34;
    setFont(9).fillColor('#B42318').text(
      `This statement does not tie to the ledger: it closes at ${signedNaira(statement.closingKobo)} and the ledger says ${signedNaira(statement.ledgerClosingKobo)}. Please raise it with the desk before paying against it.`,
      left, y, { width },
    );
  }

  setFont(8).fillColor(slate).text(
    `${statement.business.name} · ${statement.business.email} · This statement is generated from the append-only commission ledger.`,
    left, doc.page.height - 60, { width },
  );

  return doc;
}

function fileName(statement) {
  return `honestcars-commission-${statement.dealer.id}-${statement.month}.pdf`;
}

module.exports = { build, months, pdf, fileName, monthKey, monthLabel, naira, signedNaira, ENTRY_LABELS };
