'use strict';

/**
 * App icons for the installable site (FR-30).
 *
 *   node scripts/generate-icons.js            # write the icon set
 *   node scripts/generate-icons.js --check    # report only, exit 1 if drift
 *
 * There is no designer and no icon file checked in twice: the mark below is the
 * same shield-and-check the header draws (`src/services/icons.js` → `shield`),
 * on the brand navy from §3.2. Change the mark here and every size follows —
 * including the maskable pair, whose artwork is deliberately smaller so
 * Android's circular crop cannot eat an edge.
 *
 * Output (`public/icons/`):
 *   icon-192.png · icon-512.png                  any-purpose, rounded tile
 *   maskable-192.png · maskable-512.png          full bleed, safe-zone artwork
 *   apple-touch-icon.png  180×180                iOS home screen
 *   ../favicon.svg                               the same tile, as vectors
 *
 * `--check` renders into a temporary directory and byte-compares, so a drifted
 * icon fails `npm run icons:check` the same way a needless image resize fails
 * `npm run images:check`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'public', 'icons');

// §3.2 tokens. Duplicated here on purpose: a build script must not parse CSS.
const NAVY = '#0e2a47';
const GREEN = '#12a150';
const WHITE = '#ffffff';

// Geometry from src/services/icons.js (24×24 viewBox, 1.5px stroke family).
const SHIELD = 'M12 3 5 6v6c0 4 3 7.4 7 9 4-1.6 7-5 7-9V6l-7-3Z';
const CHECK = 'm9 12 2 2 4-4';

/**
 * @param {object} options
 * @param {number} options.size        canvas in px
 * @param {number} [options.radius]    corner radius (0 = full bleed, maskable)
 * @param {number} [options.markRatio] artwork width as a fraction of canvas
 */
function tileSvg({ size, radius = 0.22, markRatio = 0.62 }) {
  const mark = size * markRatio;
  const scale = mark / 24;
  const offset = (size - mark) / 2;
  const r = Math.round(size * radius);
  // 1.8 units of stroke on a 24-unit grid: the 1.5 of the in-page icon set
  // disappears at 32 px on an icon tile, and 1.8 still reads as the same mark.
  const stroke = 1.8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${NAVY}"/>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(4)})"
     fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${SHIELD}" stroke="${WHITE}"/>
    <path d="${CHECK}" stroke="${GREEN}"/>
  </g>
</svg>
`;
}

/** @type {Array<{file: string, size: number, radius?: number, markRatio?: number}>} */
const TARGETS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  // Maskable: Android may crop to a circle of 80% of the canvas, so the tile is
  // edge-to-edge and the mark shrinks to stay inside that circle.
  { file: 'maskable-192.png', size: 192, radius: 0, markRatio: 0.5 },
  { file: 'maskable-512.png', size: 512, radius: 0, markRatio: 0.5 },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, markRatio: 0.6 },
];

async function render(target) {
  return sharp(Buffer.from(tileSvg(target))).png({ compressionLevel: 9, palette: true }).toBuffer();
}

function manifestIcons() {
  return [
    { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ];
}

/**
 * The manifest is generated, not hand-written: its icon list and its colours are
 * the same two facts this script already knows, and a manifest that points at a
 * file the icon script does not write is exactly the silent breakage that would
 * stop the site being installable without anyone noticing.
 */
function manifestJson() {
  return `${JSON.stringify(
    {
      name: 'Honest Cars LTD',
      short_name: 'HonestCars',
      description:
        'Verified used cars in Port Harcourt — inspection reports, protected payments, financing and hire from vetted partner lots.',
      start_url: '/?utm_source=pwa',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: WHITE,
      theme_color: NAVY,
      lang: 'en-NG',
      dir: 'ltr',
      categories: ['shopping', 'business'],
      icons: manifestIcons(),
      shortcuts: [
        { name: 'Browse cars', short_name: 'Cars', url: '/cars' },
        { name: 'Sell or swap', short_name: 'Sell', url: '/sell-swap' },
        { name: 'My account', short_name: 'Account', url: '/account' },
      ],
    },
    null,
    2,
  )}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const outDir = check ? fs.mkdtempSync(path.join(os.tmpdir(), 'hc-icons-')) : ICON_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const drift = [];
  const written = [];

  for (const target of TARGETS) {
    const buffer = await render(target);
    const file = path.join(outDir, target.file);
    fs.writeFileSync(file, buffer);
    const badge = await sharp(buffer).metadata();
    if (badge.width !== target.size || badge.height !== target.size) {
      throw new Error(`${target.file} rendered ${badge.width}×${badge.height}, expected ${target.size}`);
    }
    written.push(`${target.file} (${(buffer.length / 1024).toFixed(1)} kB)`);

    if (check) {
      const committed = path.join(ICON_DIR, target.file);
      const same = fs.existsSync(committed) && fs.readFileSync(committed).equals(buffer);
      if (!same) drift.push(`public/icons/${target.file}`);
    }
  }

  // favicon.svg — the same tile as vectors, for browser tabs and bookmarks.
  const favicon = path.join(check ? outDir : path.join(ROOT, 'public'), 'favicon.svg');
  fs.writeFileSync(favicon, tileSvg({ size: 512, radius: 0.22, markRatio: 0.62 }));
  if (check) {
    const committed = path.join(ROOT, 'public', 'favicon.svg');
    if (!fs.existsSync(committed) || fs.readFileSync(committed, 'utf8') !== fs.readFileSync(favicon, 'utf8')) {
      drift.push('public/favicon.svg');
    }
  }

  // The manifest is checked against what is on disk, because a manifest naming a
  // missing icon is the difference between "installable" and "install prompt
  // never appears, for reasons nobody can see".
  const manifestFile = path.join(ROOT, 'public', 'manifest.webmanifest');
  const expected = manifestJson();
  const missing = manifestIcons()
    .map((icon) => path.join(ROOT, 'public', icon.src))
    .filter((file) => !fs.existsSync(file));

  if (check) {
    const actual = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : '';
    if (actual !== expected) drift.push('public/manifest.webmanifest');
    if (missing.length || drift.length) {
      console.error('✗ app icons are out of date — run: node scripts/generate-icons.js');
      for (const file of [...drift, ...missing.map((f) => path.relative(ROOT, f))]) console.error(`  · ${file}`);
      process.exit(1);
    }
    console.log(`✓ app icons current — ${TARGETS.length} PNGs + favicon.svg + manifest, all ${TARGETS[0].size}–${TARGETS[1].size}px`);
    return;
  }

  const currentManifest = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : '';
  if (currentManifest !== expected) fs.writeFileSync(manifestFile, expected);

  console.log(`✓ app icons — ${written.length} PNGs into public/icons/`);
  for (const line of written) console.log(`  · ${line}`);
  console.log('  · public/favicon.svg');
  console.log('  · public/manifest.webmanifest');
}

main().catch((error) => {
  console.error(`✗ icon generation failed: ${error.message}`);
  process.exit(1);
});
