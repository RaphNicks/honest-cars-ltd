'use strict';

/**
 * Content blocks — the CMS editor's format (§6.9 body components).
 *
 * The public site stores a post body as a JSON block list (paragraph, heading,
 * callout, checklist, table, quote, youtube, listings, stats). That is the
 * right shape for rendering and the wrong shape for a human at 4pm on a
 * Friday, so the editor writes a tiny line-based markup instead and this
 * module translates in both directions:
 *
 *     Ordinary line of prose            → paragraph
 *     ## Heading                        → heading
 *     > “Quote text” — Attribution      → quote
 *     ! Title | body copy               → callout
 *     !! Title | body copy              → callout (amber, a warning)
 *     - a checklist item                → checklist (consecutive - lines)
 *     | cell | cell | cell              → table (first row is the header)
 *     ^ Caption for the table below     → table caption
 *     = 1,200 | inspections completed   → stats band (consecutive = lines)
 *     [cars]                            → live listings that match the tags
 *     [video:VIDEOID | title | 4:12]    → tap-to-load YouTube facade
 *
 * Blank lines separate blocks. `parse()` never throws: a line it cannot place
 * becomes a paragraph, and anything genuinely wrong (an unknown directive, a
 * malformed table row in the middle of a table) comes back in `errors` with a
 * line number, so the editor can show it instead of silently eating copy.
 *
 * `toMarkup()` is the exact inverse, which is what makes the round-trip test
 * meaningful: every seeded post can be edited in the console and saved back
 * byte-for-byte.
 */

const BLOCK_TYPES = [
  'paragraph', 'heading', 'callout', 'checklist', 'table',
  'quote', 'youtube', 'listings', 'stats',
];

const DIRECTIVES = new Set(['cars', 'listings']);

/** Fixed key order, so parse() and toMarkup() always agree on shape. */
function canonical(blocks) {
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'paragraph':
        if (clean(block.text)) out.push({ type: 'paragraph', text: clean(block.text) });
        break;
      case 'heading':
        if (clean(block.text)) out.push({ type: 'heading', text: clean(block.text) });
        break;
      case 'callout': {
        const text = clean(block.text);
        if (!text) break;
        const entry = { type: 'callout' };
        if (clean(block.title)) entry.title = clean(block.title);
        entry.text = text;
        if (block.tone === 'amber') entry.tone = 'amber';
        out.push(entry);
        break;
      }
      case 'checklist': {
        const items = (block.items || []).map(clean).filter(Boolean);
        if (items.length) out.push({ type: 'checklist', items });
        break;
      }
      case 'table': {
        const rows = (block.rows || []).map((row) => (Array.isArray(row) ? row.map(clean) : []));
        const head = (block.head || []).map(clean);
        if (!head.length && !rows.length) break;
        const entry = { type: 'table' };
        if (clean(block.caption)) entry.caption = clean(block.caption);
        entry.head = head;
        entry.rows = rows;
        out.push(entry);
        break;
      }
      case 'quote': {
        const text = clean(block.text);
        if (!text) break;
        const entry = { type: 'quote', text };
        if (clean(block.attribution)) entry.attribution = clean(block.attribution);
        out.push(entry);
        break;
      }
      case 'youtube': {
        const videoId = clean(block.videoId);
        if (!videoId) break;
        const entry = { type: 'youtube', videoId };
        if (clean(block.title)) entry.title = clean(block.title);
        if (clean(block.duration)) entry.duration = clean(block.duration);
        if (clean(block.poster)) entry.poster = clean(block.poster);
        out.push(entry);
        break;
      }
      case 'listings':
        out.push({ type: 'listings' });
        break;
      case 'stats': {
        const items = (block.items || [])
          .map((item) => ({ value: clean(item && item.value), label: clean(item && item.label) }))
          .filter((item) => item.value || item.label);
        if (items.length) out.push({ type: 'stats', items });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/** Split a table row line, requiring the leading pipe. */
function tableCells(line) {
  return line
    .replace(/^\|\s?/, '')
    .replace(/\s?\|$/, '')
    .split('|')
    .map(clean);
}

/**
 * Markup → blocks.
 * @returns {{blocks: Array, errors: Array<{line: number, message: string}>, warnings: Array}}
 */
function parse(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const errors = [];
  let pendingCaption = null;
  let i = 0;

  const flushCaption = () => {
    if (pendingCaption) {
      errors.push({ line: i + 1, message: '“^ caption” must sit directly above a table — it was ignored.' });
      pendingCaption = null;
    }
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) {
      flushCaption();
      i += 1;
      continue;
    }

    // --- tables -------------------------------------------------------------
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(tableCells(lines[i].trim()));
        i += 1;
      }
      const width = Math.max(...rows.map((row) => row.length));
      const padded = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
      const block = { type: 'table' };
      if (pendingCaption) {
        block.caption = pendingCaption;
        pendingCaption = null;
      }
      block.head = padded[0];
      block.rows = padded.slice(1);
      blocks.push(block);
      continue;
    }

    // --- caption ------------------------------------------------------------
    if (line.startsWith('^')) {
      flushCaption();
      pendingCaption = clean(line.slice(1));
      i += 1;
      continue;
    }

    flushCaption();

    // --- headings -----------------------------------------------------------
    if (/^#{2,}\s+/.test(line)) {
      blocks.push({ type: 'heading', text: clean(line.replace(/^#{2,}\s+/, '')) });
      i += 1;
      continue;
    }

    // --- callouts -----------------------------------------------------------
    if (/^!{1,2}\s+/.test(line)) {
      const amber = line.startsWith('!!');
      const body = clean(line.replace(/^!{1,2}\s+/, ''));
      const [title, ...rest] = body.split('|');
      const entry = { type: 'callout' };
      if (rest.length) {
        entry.title = clean(title);
        entry.text = clean(rest.join('|'));
      } else {
        entry.text = body;
      }
      if (amber) entry.tone = 'amber';
      blocks.push(entry);
      i += 1;
      continue;
    }

    // --- quotes -------------------------------------------------------------
    if (line.startsWith('>')) {
      const body = clean(line.replace(/^>\s?/, ''));
      // “Text” — Attribution  ·  or the plain form without attribution.
      const match = body.match(/^(.*?)\s+[—–-]\s+([^—–]{2,80})$/);
      const entry = { type: 'quote' };
      if (match) {
        entry.text = clean(match[1].replace(/^[“"']|[”"']$/g, ''));
        entry.attribution = clean(match[2]);
      } else {
        entry.text = clean(body.replace(/^[“"']|[”"']$/g, ''));
      }
      blocks.push(entry);
      i += 1;
      continue;
    }

    // --- checklists ---------------------------------------------------------
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(clean(lines[i].replace(/^\s*[-*]\s+/, '')));
        i += 1;
      }
      blocks.push({ type: 'checklist', items });
      continue;
    }

    // --- stats --------------------------------------------------------------
    if (line.startsWith('=')) {
      const items = [];
      while (i < lines.length && lines[i].trim().startsWith('=')) {
        const body = clean(lines[i].trim().replace(/^=\s?/, ''));
        const [value, ...rest] = body.split('|');
        items.push({ value: clean(value), label: clean(rest.join('|')) });
        i += 1;
      }
      blocks.push({ type: 'stats', items });
      continue;
    }

    // --- directives ---------------------------------------------------------
    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      if (close === -1) {
        errors.push({ line: i + 1, message: 'Unclosed “[” — the line was treated as prose.' });
        blocks.push({ type: 'paragraph', text: line });
        i += 1;
        continue;
      }
      const head = clean(line.slice(1, close));
      const rest = clean(line.slice(close + 1));
      const [name, ...args] = head.split(':');
      const lower = name.toLowerCase();

      if (DIRECTIVES.has(lower)) {
        blocks.push({ type: 'listings' });
        i += 1;
        continue;
      }
      if (lower === 'video') {
        const parts = (args.join(':') + (rest ? `|${rest}` : '')).split('|').map(clean);
        const videoId = (parts.shift() || '').trim();
        if (!videoId) {
          errors.push({ line: i + 1, message: '[video:…] needs a YouTube id — e.g. [video:dQw4w9WgXcQ | Title | 4:12]' });
        } else {
          const entry = { type: 'youtube', videoId };
          if (parts[0]) entry.title = parts[0];
          if (parts[1]) entry.duration = parts[1];
          blocks.push(entry);
        }
        i += 1;
        continue;
      }
      errors.push({ line: i + 1, message: `Unknown directive “[${name}]” — try [cars] or [video:id | title].` });
      blocks.push({ type: 'paragraph', text: line });
      i += 1;
      continue;
    }

    // --- prose --------------------------------------------------------------
    // Consecutive plain lines are separate paragraphs, which is what a writer
    // means when they leave a blank line between them and what the seed data
    // already does.
    blocks.push({ type: 'paragraph', text: line });
    i += 1;
  }

  return { blocks: canonical(blocks), errors, warnings: [] };
}

/** Blocks → markup (the exact inverse of parse). */
function toMarkup(blocks) {
  const lines = [];
  const push = (line) => {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(line);
  };

  for (const block of canonical(blocks)) {
    switch (block.type) {
      case 'paragraph':
        push(block.text);
        break;
      case 'heading':
        push(`## ${block.text}`);
        break;
      case 'callout':
        push(`${block.tone === 'amber' ? '!!' : '!'} ${block.title ? `${block.title} | ` : ''}${block.text}`);
        break;
      case 'checklist': {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        block.items.forEach((item) => lines.push(`- ${item}`));
        break;
      }
      case 'table': {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        if (block.caption) lines.push(`^ ${block.caption}`);
        lines.push(`| ${block.head.join(' | ')} |`);
        block.rows.forEach((row) => lines.push(`| ${row.join(' | ')} |`));
        break;
      }
      case 'quote':
        push(`> ${block.text}${block.attribution ? ` — ${block.attribution}` : ''}`);
        break;
      case 'youtube':
        push(`[video:${block.videoId}${block.title ? ` | ${block.title}` : ''}${block.duration ? ` | ${block.duration}` : ''}]`);
        break;
      case 'listings':
        push('[cars]');
        break;
      case 'stats': {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        block.items.forEach((item) => lines.push(`= ${item.value} | ${item.label}`));
        break;
      }
      default:
        break;
    }
  }

  // Trim leading/trailing blanks but keep the internal rhythm single-spaced.
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Words in the rendered copy — the editor shows it next to the read time. */
function wordCount(blocks) {
  const text = canonical(blocks)
    .map((block) => {
      if (block.type === 'table') return [block.caption, ...block.head, ...block.rows.flat()].filter(Boolean).join(' ');
      if (block.type === 'checklist') return block.items.join(' ');
      if (block.type === 'stats') return block.items.map((item) => `${item.value} ${item.label}`).join(' ');
      return [block.title, block.text, block.attribution].filter(Boolean).join(' ');
    })
    .join(' ');
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * §6.9 house rule: every post links at least three listing or service pages.
 * A `[cars]` block counts as one (it renders live listings), and each inline
 * `[label](/cars/…)` or `[label](/services/…)` link counts as one.
 */
function linksIn(blocks) {
  const markup = toMarkup(canonical(blocks));
  const directive = (markup.match(/^\[cars\]$/gm) || []).length;
  const inline = (String(markup).match(/\[[^\]]+\]\(\/(?:cars|services)(?:[/?#)]|\b)/g) || []).length;
  return directive + inline;
}

/** The links a body points at, for the console's rule panel. */
function linksFound(blocks) {
  const markup = toMarkup(canonical(blocks));
  const found = [];
  const re = /\[([^\]]+)\]\((\/(?:cars|services)(?:[/?#][^)\s]*)?)\)/g;
  let match;
  while ((match = re.exec(markup))) found.push({ label: match[1], href: match[2] });
  if (/^\[cars\]$/m.test(markup)) found.push({ label: 'Live cars matching the tags', href: '/cars' });
  return found;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline markup for prose that came out of the CMS: escapes everything, then
 * turns `[label](/internal/path)` into a link. Only same-site paths survive —
 * an editor can link anywhere inside the site and nowhere outside it, which is
 * the right default for copy that is reviewed by whoever is on duty.
 */
function inline(value) {
  const escaped = escapeHtml(value);
  return escaped.replace(/\[([^\]]{1,120})\]\(([^)\s]+)\)/g, (whole, label, href) => {
    if (!/^\/(?!\/)[A-Za-z0-9\-._~\/%?=&+#]*$/.test(href)) return whole;
    return `<a href="${href}">${label}</a>`;
  });
}

module.exports = { BLOCK_TYPES, canonical, parse, toMarkup, wordCount, linksIn, linksFound, inline, escapeHtml, tableCells };
