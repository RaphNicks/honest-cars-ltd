'use strict';

/**
 * OG card renderer — 1200×630 (§12.4, §14.1).
 *
 * Composites the car photo (or a navy gradient) with the title, price badge
 * and verification grade so a shared link previews properly in WhatsApp.
 * Cards are written to public/og/*.png and cached by content hash.
 *
 * Why sharp here and nowhere else: this is an *asset build* step, not the
 * frontend. The public site still ships zero build step (§17.2 "No frontend
 * frameworks; semantic HTML, modern CSS, modular vanilla JavaScript").
 * If sharp or fontconfig is missing, renderOgCard() returns null and every
 * caller falls back to /og/default.png — the site never breaks on this.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const OG_DIR = path.join(ROOT, 'public', 'og');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts');
const MARK_FILE = path.join(ROOT, 'public', 'img', 'logo.png');

let sharp = null;
let fontconfigReady = false;

function loadSharp() {
  if (sharp !== null) return sharp;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    sharp = require('sharp');
  } catch {
    sharp = false;
  }
  return sharp;
}

/**
 * Point fontconfig at assets/fonts so librsvg can render Inter. We write our
 * own config rather than mutating the host's, and only once per process.
 */
function prepareFontconfig() {
  if (fontconfigReady) return;
  fontconfigReady = true;
  if (!fs.existsSync(path.join(FONT_DIR, 'Inter-var.ttf'))) return;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honestcars-fc-'));
    const cache = path.join(dir, 'cache');
    fs.mkdirSync(cache, { recursive: true });
    const conf = path.join(dir, 'fonts.conf');
    fs.writeFileSync(
      conf,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <dir>/usr/share/fonts</dir>
  <cachedir>${cache}</cachedir>
</fontconfig>`,
    );
    process.env.FONTCONFIG_FILE = conf;
    process.env.FONTCONFIG_PATH = dir;
  } catch {
    /* fall back to whatever fontconfig the host has */
  }
}

function escXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatNaira(kobo) {
  const naira = Number(kobo) / 100;
  if (naira >= 1_000_000) {
    const m = Math.round((naira / 1_000_000) * 10) / 10;
    return `₦${m.toString().replace(/\.0$/, '')}m`;
  }
  return `₦${Math.round(naira).toLocaleString('en-NG')}`;
}

const GRADE_COLOURS = {
  network_listed: { fill: '#5B6B7C', label: 'NETWORK-LISTED' },
  field_checked: { fill: '#E8A13D', label: 'FIELD-CHECKED' },
  certified: { fill: '#12A150', label: 'HONESTCARS-CERTIFIED' },
};

const RASTER = /\.(jpe?g|png|webp|avif)$/i;

/**
 * The SVG card layout — one string so it is easy to eyeball.
 * `withBackdrop: false` renders only the scrim + text, for compositing over a
 * real car photo.
 */
// ---------------------------------------------------------------------------
// Fitting text to the card
//
// The first cut drew one <text> line per field and let librsvg clip whatever
// ran past the edge, so any title longer than about thirty characters was cut
// mid-word — which was most of the stock. Nothing here guesses at metrics:
// every glyph run is *measured* by rendering it and trimming to its ink, then
// every layout decision is arithmetic on those numbers. A title that does not
// fit on two lines at any sensible size is ellipsised rather than clipped, and
// a test asserts no <text> on a card ever ends past the right margin.
// ---------------------------------------------------------------------------

const CARD_WIDTH = 1200;
const TEXT_X = 72;
/** The text column: 72px of margin on each side. */
const TEXT_WIDTH = CARD_WIDTH - TEXT_X * 2;
/** Every string is measured once at this size; ink width scales linearly. */
const MEASURE_SIZE = 100;
/** 1% of headroom, because ink bounds are not advance widths. */
const FIT_MARGIN = 1.01;
const ELLIPSIS = '…';

const widthCache = new Map();

/**
 * Rough advance widths as a fraction of the font size — used only to size the
 * measuring canvas, and as the fallback when sharp is absent (in which case no
 * card is rendered at all, so nothing depends on its accuracy).
 */
const NARROW = new Set(['i', 'l', 'j', '!', '.', ',', "'", ':', ';', '|', '(', ')', '[', ']', 'I']);
const THIN = new Set(['f', 't', 'r', 'J']);
const WIDE = new Set(['m', 'w', 'M', 'W', '@', '%']);

function estimateWidth(text, size, weight = 700) {
  const bold = weight >= 600 ? 1.06 : 1;
  let units = 0;
  for (const char of String(text || '')) {
    if (char === ' ') units += 0.26;
    else if (NARROW.has(char)) units += 0.3;
    else if (THIN.has(char)) units += 0.42;
    else if (WIDE.has(char)) units += 0.92;
    else if (/[0-9]/.test(char)) units += 0.62;
    else if (char === char.toUpperCase() && /[A-Z]/.test(char)) units += 0.74;
    else units += 0.58;
  }
  return units * size * bold;
}

/** Render a run of text and trim to its ink; the canvas is sized from the estimate. */
async function measureRaw(text, size, weight) {
  const lib = loadSharp();
  if (!lib) return null;
  const canvas = Math.max(600, Math.ceil(estimateWidth(text, size, weight) * 1.6) + 40);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${size * 3}">`
    + `<rect width="${canvas}" height="${size * 3}" fill="#FFFFFF"/>`
    + `<text x="20" y="${size * 2}" font-family="Inter, DejaVu Sans, sans-serif" font-size="${size}"`
    + ` font-weight="${weight}" fill="#000000">${escXml(text)}</text></svg>`;
  try {
    const png = await lib(Buffer.from(svg)).png().toBuffer();
    const trimmed = await lib(png).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
    return trimmed.info.width;
  } catch {
    return null;
  }
}

/**
 * Ink width of `text` set at `size`/`weight`.
 *
 * Measured once at MEASURE_SIZE and scaled: advance widths are linear in font
 * size, and measured across Inter at four sizes the error is under 0.1%. That
 * turns "measure every candidate line at every candidate size" — dozens of
 * renders — into one render per distinct word.
 */
async function measureText(text, size, weight = 700) {
  const value = String(text === null || text === undefined ? '' : text);
  if (!value) return 0;
  const key = `${weight}\u0000${value}`;
  let base = widthCache.get(key);
  if (base === undefined) {
    const measured = await measureRaw(value, MEASURE_SIZE, weight);
    base = measured === null ? estimateWidth(value, MEASURE_SIZE, weight) : measured;
    widthCache.set(key, base);
  }
  return base * (size / MEASURE_SIZE) * FIT_MARGIN;
}

/** The space advance, derived from the font rather than assumed. */
const spaceCache = new Map();
async function spaceWidth(size, weight = 700) {
  let base = spaceCache.get(weight);
  if (base === undefined) {
    const lib = loadSharp();
    base = 0.26;
    if (lib) {
      const pair = await measureRaw('n n', MEASURE_SIZE, weight);
      const single = await measureRaw('nn', MEASURE_SIZE, weight);
      if (pair !== null && single !== null && pair > single) base = (pair - single) / MEASURE_SIZE;
    }
    spaceCache.set(weight, base);
  }
  return base * size * FIT_MARGIN;
}

async function wordWidths(words, size, weight) {
  const widths = [];
  for (const word of words) widths.push(await measureText(word, size, weight));
  return widths;
}

/** A line of words that fits `width`, with an ellipsis if some had to go. */
async function fitLine(words, widths, size, weight, width, space) {
  const ellipsis = await measureText(ELLIPSIS, size, weight);
  const kept = [];
  let used = 0;
  for (let i = 0; i < words.length; i += 1) {
    const next = kept.length ? used + space + widths[i] : widths[i];
    if (next + ellipsis > width && kept.length) break;
    kept.push(words[i]);
    used = next;
  }
  return `${kept.join(' ')}${kept.length < words.length ? ELLIPSIS : ''}`;
}

/**
 * Break `text` into at most `maxLines` lines that each fit `width`.
 * @returns {{lines: string[], size: number, over: boolean}} `over: true` means
 *   something was dropped and the last line carries an ellipsis.
 */
async function wrapText(text, { size, weight = 700, maxLines = 2, width = TEXT_WIDTH }) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [''], size, over: false };

  const space = await spaceWidth(size, weight);
  const widths = await wordWidths(words, size, weight);

  // Greedy wrap, unbounded.
  const breaks = [];
  let line = [];
  let lineWidth = 0;
  for (let i = 0; i < words.length; i += 1) {
    const next = line.length ? lineWidth + space + widths[i] : widths[i];
    if (next <= width || !line.length) {
      line.push(i);
      lineWidth = next;
    } else {
      breaks.push({ from: line[0], to: i });
      line = [i];
      lineWidth = widths[i];
    }
  }
  if (line.length) breaks.push({ from: line[0], to: words.length });

  if (breaks.length <= maxLines) {
    return {
      lines: breaks.map((b) => words.slice(b.from, b.to).join(' ')),
      size,
      over: false,
    };
  }

  // Too long for the lines available: keep the first maxLines-1 lines and
  // squeeze everything that follows onto the last one.
  const head = breaks.slice(0, maxLines - 1).map((b) => words.slice(b.from, b.to).join(' '));
  const tailFrom = breaks[maxLines - 1].from;
  const tail = await fitLine(
    words.slice(tailFrom),
    widths.slice(tailFrom),
    size,
    weight,
    width,
    space,
  );
  return { lines: [...head, tail], size, over: true };
}

/**
 * The title, at the largest size that keeps it legible on one line, then two.
 * A one-line title keeps the card's original geometry exactly.
 */
const TITLE_STEPS = [
  { size: 74, maxLines: 1 },
  { size: 74, maxLines: 2 },
  { size: 64, maxLines: 2 },
  { size: 58, maxLines: 2 },
  { size: 52, maxLines: 2 },
  { size: 46, maxLines: 2 },
];

/** The subtitle is short by construction; it shrinks rather than wraps. */
const SUBTITLE_STEPS = [
  { size: 72, maxLines: 1 },
  { size: 62, maxLines: 1 },
  { size: 54, maxLines: 1 },
  { size: 46, maxLines: 1 },
];

async function layoutField(text, steps, weight) {
  let last = null;
  for (const step of steps) {
    const wrapped = await wrapText(text, { ...step, weight });
    if (!wrapped.over) return wrapped;
    last = wrapped;
  }
  return last;
}

const textEl = (x, y, size, weight, fill, content, extra = '') =>
  `<text x="${x}" y="${y}" font-family="Inter, DejaVu Sans, sans-serif" font-size="${size}"`
  + ` font-weight="${weight}" fill="${fill}"${extra}>${escXml(content)}</text>`;

/**
 * The SVG card layout.
 *
 * `withBackdrop: false` renders only the scrim + text, for compositing over a
 * real car photo. Async because fitting the text measures it first.
 */
// Where the mark sits when there is one: the top-left of the empty upper band,
// well clear of the eyebrow line at y=236 and of the title below it.
const MARK_PX = 88;
const MARK_TOP = 96;

/**
 * The company's mark for the card's top-left corner.
 *
 * The same file the header draws, base64'd into the SVG because that is how
 * this module has always handed art to the renderer — one string in, one PNG
 * out, no temp files. There is no mark until the company supplies a master
 * (`scripts/generate-icons.js`), and the card then simply starts where it
 * always did.
 *
 * @returns {string} SVG markup, or an empty string
 */
function brandMarkMarkup() {
  let png;
  try {
    png = fs.readFileSync(MARK_FILE);
  } catch {
    return '';
  }
  return `<image x="${TEXT_X}" y="${MARK_TOP}" width="${MARK_PX}" height="${MARK_PX}" href="data:image/png;base64,${png.toString('base64')}"/>`;
}

/**
 * A short fingerprint of the mark, for the cache key.
 *
 * A card's filename hashes its input — title, subtitle, badge, photo — and the
 * mark is part of the art but none of those. Without this, every card rendered
 * before the company's logo arrived would keep its old corner for as long as
 * the cache file lived, which is exactly the "the fix is deployed and the old
 * picture is still showing" failure the module already works to avoid.
 */
function markStamp() {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(MARK_FILE)).digest('hex').slice(0, 8);
  } catch {
    return 'no-mark';
  }
}

async function cardSvg({ title, subtitle, badge, withBackdrop = true }) {
  const grade = GRADE_COLOURS[badge] || GRADE_COLOURS.network_listed;

  const heading = await layoutField(title, TITLE_STEPS, 700);
  const sub = subtitle ? await layoutField(subtitle, SUBTITLE_STEPS, 700) : null;

  // One line of title keeps the card's original geometry; two lines start
  // higher and close the gap, so nothing collides with the footer.
  const twoLine = heading.lines.length > 1;
  const lineStep = Math.round(heading.size * 1.16);
  const titleTop = twoLine ? 322 : 360;
  const titleLines = heading.lines.map((line, i) => textEl(TEXT_X, titleTop + i * lineStep, heading.size, 700, '#FFFFFF', line));
  const subtitleY = twoLine ? titleTop + (heading.lines.length - 1) * lineStep + 74 : 432;
  const badgeTop = twoLine ? subtitleY + 30 : 486;

  const badgeLabel = badge ? grade.label : '';
  const badgeWidth = badge ? Math.ceil(await measureText(badgeLabel, 24, 600)) + 62 : 0;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="630" viewBox="0 0 ${CARD_WIDTH} 630">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0E2A47" stop-opacity="0.15"/>
      <stop offset="58%" stop-color="#0E2A47" stop-opacity="0.84"/>
      <stop offset="100%" stop-color="#0E2A47" stop-opacity="0.97"/>
    </linearGradient>
  </defs>
  ${withBackdrop ? `<rect width="${CARD_WIDTH}" height="630" fill="#0E2A47"/>` : ''}
  <rect width="${CARD_WIDTH}" height="630" fill="url(#scrim)"/>
  <rect x="0" y="0" width="12" height="630" fill="#12A150"/>
  ${brandMarkMarkup()}
  ${textEl(TEXT_X, 236, 30, 600, '#D8E0E8', 'HONESTCARS · PORT HARCOURT', ' letter-spacing="1"')}
  ${titleLines.join('\n  ')}
  ${sub ? textEl(TEXT_X, subtitleY, sub.size, 700, '#E8A13D', sub.lines[0]) : ''}
  <rect x="${TEXT_X}" y="${badgeTop}" rx="18" ry="18" width="${badgeWidth}" height="44" fill="${grade.fill}" fill-opacity="0.18" stroke="${grade.fill}" stroke-width="2"/>
  ${badge ? `<circle cx="${TEXT_X + 29}" cy="${badgeTop + 22}" r="7" fill="${grade.fill}"/>${textEl(TEXT_X + 48, badgeTop + 31, 24, 600, grade.fill, badgeLabel)}` : ''}
  ${textEl(TEXT_X, 592, 26, 500, '#8FA8C0', 'honestcarsltd.com')}
</svg>`;
}

/** Resolve a public media URL to a local file, if we have it. */
function localPhotoFile(url) {
  if (!url || !url.startsWith('/')) return null;
  const file = path.join(ROOT, 'public', url.replace(/^\//, ''));
  return fs.existsSync(file) ? file : null;
}

/**
 * Render (and cache) a card. Returns the public path or null on failure.
 * @param {{ key: string, title: string, subtitle: string, badge?: string, photo?: string }} input
 */
async function renderOgCard(input) {
  const lib = loadSharp();
  if (!lib) return null;
  try {
    prepareFontconfig();
    fs.mkdirSync(OG_DIR, { recursive: true });

    const hash = crypto
      .createHash('sha1')
      .update(JSON.stringify(input) + markStamp())
      .digest('hex')
      .slice(0, 12);
    const filename = `${(input.key || 'card').replace(/[^a-z0-9-]/gi, '-').slice(0, 60)}-${hash}.png`;
    const outPath = path.join(OG_DIR, filename);
    if (fs.existsSync(outPath)) return `/og/${filename}`;

    const photoFile = localPhotoFile(input.photo);
    const hasRasterPhoto = Boolean(photoFile && RASTER.test(photoFile));

    if (hasRasterPhoto) {
      // Real photography: cover-crop the car photo, then lay the scrim + text on top.
      const base = await lib(photoFile).resize(1200, 630, { fit: 'cover', position: 'centre' }).toBuffer();
      const overlay = Buffer.from(
        await cardSvg({ title: input.title, subtitle: input.subtitle, badge: input.badge, withBackdrop: false }),
      );
      await lib(base)
        .composite([{ input: overlay, top: 0, left: 0 }])
        .png({ compressionLevel: 9, palette: true })
        .toFile(outPath);
    } else {
      // No photo yet (or an SVG placeholder): the branded card still previews well.
      const svg = await cardSvg({
        title: input.title,
        subtitle: input.subtitle,
        badge: input.badge,
        withBackdrop: true,
      });
      await lib(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toFile(outPath);
    }

    return `/og/${filename}`;
  } catch (error) {
    if (process.env.OG_DEBUG) console.warn('[og] render failed:', error.message);
    return null;
  }
}

/**
 * The site-wide fallback card, rendered at boot.
 *
 * It is written every boot rather than only when missing: the layout is code,
 * and a cached PNG from a previous version of it would keep showing whatever
 * that version drew — which is exactly how a clipped headline survives a fix.
 * The write is skipped when the bytes match, so a warm boot costs one render.
 */
async function ensureDefaultCard() {
  const outPath = path.join(OG_DIR, 'default.png');
  const lib = loadSharp();
  if (!lib) return fs.existsSync(outPath) ? '/og/default.png' : null;
  try {
    prepareFontconfig();
    fs.mkdirSync(OG_DIR, { recursive: true });
    const svg = await cardSvg({
      title: 'Every vehicle verified. Every price compared.',
      subtitle: 'Every deal honest.',
      badge: null,
      withBackdrop: true,
    });
    const png = await lib(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer();
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
    if (!current || !current.equals(png)) fs.writeFileSync(outPath, png);
    return '/og/default.png';
  } catch {
    return fs.existsSync(outPath) ? '/og/default.png' : null;
  }
}

/** VDP card: car photo + “2015 Toyota Camry LE · ₦8.5m” (§14.2, §6.3). */
async function listingOgCard(listing) {
  if (!listing) return null;
  return renderOgCard({
    key: listing.slug,
    title: listing.title,
    subtitle: `${formatNaira(listing.priceKobo)} · ${listing.area}`,
    badge: listing.grade,
    photo: listing.primaryImage ? listing.primaryImage.url : null,
  });
}

module.exports = {
  renderOgCard,
  ensureDefaultCard,
  listingOgCard,
  cardSvg,
  formatNaira,
  OG_DIR,
  localPhotoFile,
  // Exported for the suite, which measures what the layout emits rather than
  // trusting it: see test/og.test.js.
  wrapText,
  measureText,
  layoutField,
  TITLE_STEPS,
  SUBTITLE_STEPS,
  TEXT_X,
  TEXT_WIDTH,
  CARD_WIDTH,
};
