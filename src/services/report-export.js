'use strict';

/**
 * §7.3 Reports — the two file formats the PRD asks for: CSV and PDF.
 *
 * These are dumb on purpose. They take the header the report declared and the
 * rows the database returned, and they write them out; no report logic lives
 * here, so the file a reader downloads can never disagree with the table they
 * were looking at. `src/db/reports.js` owns the numbers, `src/routes/admin.js`
 * owns who may ask.
 *
 * Money arrives in kobo and is formatted here, once, for both formats.
 *
 * The PDF is a real A4 landscape document with Inter embedded (same font asset
 * as the inspection report), so the naira sign survives the file.
 */

const path = require('node:path');
const fs = require('node:fs');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'Inter-var.ttf');

const NAVY = '#0E2A47';
const SLATE = '#5B6B7C';
const LINE = '#D8E0E8';

function naira(kobo) {
  const value = Number(kobo || 0) / 100;
  return `₦${value.toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

/** One cell, formatted for a person to read in either format. */
function cell(column, row) {
  const value = row[column.key];
  if (column.format === 'money') return naira(value);
  if (column.format === 'pillar') return require('../db/reports').pillarLabel(value);
  if (column.format === 'name') return value || 'Unassigned';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/**
 * RFC 4180 CSV. A comma, a quote or a newline inside a value is data, not
 * structure, so it is quoted and its quotes are doubled — a dealer whose name
 * contains a comma must not shift every column in the file.
 */
function csvValue(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A CSV with a small preamble: the reader needs to know what window they are
 * looking at, and a spreadsheet is where they will be looking at it. Blank-line
 * separated so the table itself still starts at a clean row.
 */
function csv({ title, description, columns, rows, meta = [] }) {
  const lines = [
    ['Honest Cars Ltd', title].map(csvValue).join(','),
    ...[description].map(csvValue),
    ...meta.map((line) => line.map(csvValue).join(',')),
    '',
    columns.map((column) => csvValue(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => csvValue(cell(column, row))).join(',')),
    '',
  ];
  // The BOM keeps Excel from misreading the naira sign as Latin-1 mojibake.
  return `\uFEFF${lines.join('\r\n')}`;
}

/**
 * The same table as A4 landscape. Columns share the width evenly and the header
 * repeats on every page, because a report with 12 dealers runs past one page.
 */
function pdf({ title, description, columns, rows, meta = [] }, options = {}) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 40,
    bufferPages: true,
    compress: options.compress !== false,
    info: { Title: title, Author: 'Honest Cars Ltd', Subject: description },
  });

  const font = !options.plainFonts && fs.existsSync(FONT_REGULAR) ? FONT_REGULAR : null;
  if (font) doc.registerFont('Inter', font);
  const setFont = (size, bold = false) => (font ? doc.font('Inter') : doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')).fontSize(size);

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.rect(0, 0, doc.page.width, 5).fill(NAVY);
  setFont(18, true).fillColor(NAVY).text('Honest Cars', left, 32);
  setFont(9).fillColor(SLATE).text('Port Harcourt · honestcarsltd.com');
  setFont(16, true).fillColor(NAVY).text(title, left, 62);
  setFont(9).fillColor(SLATE).text(description, left, 84, { width });
  let y = 102;
  for (const line of meta) {
    setFont(9).fillColor(SLATE).text(line.join(' · '), left, y);
    y += 13;
  }

  const colWidth = width / columns.length;
  const rowHeight = 22;
  y += 8;

  const header = () => {
    doc.rect(left, y, width, rowHeight).fill('#F2F6FA');
    columns.forEach((column, index) => {
      setFont(8, true).fillColor(SLATE).text(column.label.toUpperCase(), left + index * colWidth + 6, y + 7, {
        width: colWidth - 12,
        ellipsis: true,
        lineBreak: false,
        characterSpacing: 0.4,
      });
    });
    y += rowHeight;
  };
  header();

  for (const row of rows) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 24) {
      doc.addPage();
      y = doc.page.margins.top;
      header();
    }
    columns.forEach((column, index) => {
      setFont(9, false).fillColor('#1D2733').text(cell(column, row), left + index * colWidth + 6, y + 7, {
        width: colWidth - 12,
        ellipsis: true,
        lineBreak: false,
      });
    });
    doc.moveTo(left, y + rowHeight).lineTo(left + width, y + rowHeight).lineWidth(0.5).strokeColor(LINE).stroke();
    y += rowHeight;
  }

  if (!rows.length) {
    setFont(10).fillColor(SLATE).text('Nothing was recorded in this window.', left, y + 10);
    y += 34;
  }

  // Footer on every page, with the page count the reader needs on paper.
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(index);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    setFont(8).fillColor(SLATE).text(
      `${rows.length} row${rows.length === 1 ? '' : 's'} · page ${index + 1} of ${range.count} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      left,
      doc.page.height - 30,
      { width, align: 'center' },
    );
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return doc;
}

/** `honest-cars-pillar-2026-09-05-to-2026-10-05.csv` — dated, so a folder sorts. */
function fileName(slug, { from, to }, extension) {
  return `honest-cars-${slug}-${from}-to-${to}.${extension}`;
}

module.exports = { csv, pdf, cell, naira, fileName };
