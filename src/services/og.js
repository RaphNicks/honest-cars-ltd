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
function cardSvg({ title, subtitle, badge, withBackdrop = true }) {
  const grade = GRADE_COLOURS[badge] || GRADE_COLOURS.network_listed;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0E2A47" stop-opacity="0.15"/>
      <stop offset="58%" stop-color="#0E2A47" stop-opacity="0.84"/>
      <stop offset="100%" stop-color="#0E2A47" stop-opacity="0.97"/>
    </linearGradient>
  </defs>
  ${withBackdrop ? '<rect width="1200" height="630" fill="#0E2A47"/>' : ''}
  <rect width="1200" height="630" fill="url(#scrim)"/>
  <rect x="0" y="0" width="12" height="630" fill="#12A150"/>
  <text x="72" y="236" font-family="Inter, DejaVu Sans, sans-serif" font-size="30" font-weight="600" fill="#D8E0E8" letter-spacing="1">HONESTCARS · PORT HARCOURT</text>
  <text x="72" y="360" font-family="Inter, DejaVu Sans, sans-serif" font-size="74" font-weight="700" fill="#FFFFFF">${escXml(title)}</text>
  <text x="72" y="432" font-family="Inter, DejaVu Sans, sans-serif" font-size="72" font-weight="700" fill="#E8A13D">${escXml(subtitle)}</text>
  <rect x="72" y="486" rx="18" ry="18" width="${badge ? grade.label.length * 15 + 62 : 0}" height="44" fill="${grade.fill}" fill-opacity="0.18" stroke="${grade.fill}" stroke-width="2"/>
  ${badge ? `<circle cx="101" cy="508" r="7" fill="${grade.fill}"/><text x="120" y="517" font-family="Inter, DejaVu Sans, sans-serif" font-size="24" font-weight="600" fill="${grade.fill}">${escXml(grade.label)}</text>` : ''}
  <text x="72" y="592" font-family="Inter, DejaVu Sans, sans-serif" font-size="26" font-weight="500" fill="#8FA8C0">honestcarsltd.com</text>
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
      .update(JSON.stringify(input))
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
        cardSvg({ title: input.title, subtitle: input.subtitle, badge: input.badge, withBackdrop: false }),
      );
      await lib(base)
        .composite([{ input: overlay, top: 0, left: 0 }])
        .png({ compressionLevel: 9, palette: true })
        .toFile(outPath);
    } else {
      // No photo yet (or an SVG placeholder): the branded card still previews well.
      const svg = cardSvg({
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

/** The site-wide fallback card — generated once at boot if missing. */
async function ensureDefaultCard() {
  const outPath = path.join(OG_DIR, 'default.png');
  if (fs.existsSync(outPath)) return '/og/default.png';
  const lib = loadSharp();
  if (!lib) return null;
  try {
    prepareFontconfig();
    fs.mkdirSync(OG_DIR, { recursive: true });
    const svg = cardSvg({
      title: 'Every vehicle verified. Every price compared.',
      subtitle: 'Every deal honest.',
      badge: null,
      withBackdrop: true,
    });
    await lib(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toFile(outPath);
    return '/og/default.png';
  } catch {
    return null;
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

module.exports = { renderOgCard, ensureDefaultCard, listingOgCard, cardSvg, formatNaira, OG_DIR, localPhotoFile };
