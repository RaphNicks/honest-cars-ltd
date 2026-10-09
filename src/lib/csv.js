'use strict';

/**
 * CSV in and out — small, strict and reversible (FR-33).
 *
 * A dealer's spreadsheet is the least trustworthy input on the site: exported
 * from Excel, re-saved from Google Sheets, edited on a phone. So the parser
 * follows RFC 4180 where it matters and forgives where it is safe:
 *
 *   • quoted fields may contain commas, quotes ("") and newlines
 *   • CRLF, LF and a UTF-8 BOM are all accepted
 *   • a row may have fewer cells than the header; missing trailing cells are
 *     empty, and extra cells are reported by the caller as a row error rather
 *     than silently dropped
 *
 * What it will *not* do is guess. A ragged row is data, not an exception: the
 * caller decides whether that is a refusal or a warning.
 */

/** Parse CSV text into an array of rows (arrays of strings). */
function parse(input) {
  const text = String(input == null ? '' : input).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF or a lone CR both end the record.
      i += text[i + 1] === '\n' ? 2 : 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // A file that does not end in a newline still has a last row.
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

/**
 * Parse into objects keyed by the header row.
 *
 * Returns `{ columns, rows }` where each row carries its 1-based *line number*
 * — the number a spreadsheet shows, header included — because "row 4" is what
 * a dealer can find, and "index 3" is not.
 */
function table(input) {
  const raw = parse(input);
  if (!raw.length) return { columns: [], rows: [] };
  const columns = raw[0].map((cell) => String(cell).trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = raw.slice(1).map((cells, index) => {
    const values = {};
    const extra = [];
    columns.forEach((column, position) => {
      values[column] = String(cells[position] == null ? '' : cells[position]).trim();
    });
    for (let position = columns.length; position < cells.length; position += 1) {
      const cell = String(cells[position]).trim();
      if (cell) extra.push(cell);
    }
    return { line: index + 2, values, extra };
  });
  return { columns, rows };
}

/** One CSV field, quoted only when it has to be. */
function cell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows (arrays or objects with a column order) out as CSV text. */
function stringify(rows, columns = null) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = columns || (list.length && typeof list[0] === 'object' ? Object.keys(list[0]) : []);
  const lines = [];
  if (keys.length) lines.push(keys.map(cell).join(','));
  for (const row of list) {
    const values = Array.isArray(row) ? row : keys.map((key) => row[key]);
    lines.push(values.map(cell).join(','));
  }
  // A trailing newline: every spreadsheet does it, and it keeps `cat` honest.
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { parse, table, stringify, cell };
