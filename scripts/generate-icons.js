'use strict';

/**
 * The brand mark, in every size the site asks for.
 *
 *   node scripts/generate-icons.js                 # write the set into public/
 *   node scripts/generate-icons.js --check         # byte-compare, exit 1 on drift
 *   node scripts/generate-icons.js --out DIR       # render somewhere else
 *   node scripts/generate-icons.js --source FILE   # derive from another master
 *
 * One master, everything derived: `assets/brand/logo.png` is the company's own
 * artwork — the black shield with the gold double border, the laurel and three
 * stars, the hand cradling a sedan. The favicon, the install icons, the header
 * mark and the console mark are all cut from that one file here, so they cannot
 * drift apart the way four hand-exported PNGs would:
 *
 *   public/img/logo.png                  128  header · drawer · console
 *   public/favicon.png                    48  browser tabs, bookmarks
 *   public/icons/icon-192.png            192  any-purpose, rounded tile
 *   public/icons/icon-512.png            512  any-purpose, rounded tile
 *   public/icons/maskable-192.png        192  full bleed, art inside the safe zone
 *   public/icons/maskable-512.png        512  full bleed, art inside the safe zone
 *   public/icons/apple-touch-icon.png    180  iOS home screen
 *   public/manifest.webmanifest               the icon list, from the same facts
 *
 * Until the master arrives this script draws the shield-and-check placeholder
 * (verbatim the mark the header drew) into the same filenames, so no template
 * has to know which of the two is in force. The single difference is
 * `public/img/logo.png`: it exists only when there is a master, which is
 * exactly how the header knows whether to draw its inline fallback.
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
const PUBLIC = path.join(ROOT, 'public');
const BRAND_DIR = path.join(ROOT, 'assets', 'brand');

// §3.2 tokens. Duplicated here on purpose: a build script must not parse CSS.
const NAVY = '#0e2a47';
const GREEN = '#12a150';
const WHITE = '#ffffff';
// The artwork's own field: the master is gold on black, and every derived size
// keeps that black, because the mark was drawn on it.
const INK = '#000000';

// Geometry from src/services/icons.js (24×24 viewBox, 1.5px stroke family).
const SHIELD = 'M12 3 5 6v6c0 4 3 7.4 7 9 4-1.6 7-5 7-9V6l-7-3Z';
const CHECK = 'm9 12 2 2 4-4';

function arg(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : process.argv[at + 1] || null;
}

/**
 * The master artwork, or null when the company has not supplied one.
 *
 * Any image named `logo.*` in `assets/brand/` counts — the file arrives by
 * upload, and an upload does not always keep the extension it started with.
 * `--source` overrides it for one run (a new master, a test fixture).
 *
 * @returns {string|null}
 */
function findMaster() {
  const override = arg('--source');
  if (override) return override;
  if (!fs.existsSync(BRAND_DIR)) return null;
  const found = fs.readdirSync(BRAND_DIR)
    .filter((file) => /^logo\.(png|jpe?g|webp|tiff?)$/i.test(file))
    .sort()[0];
  return found ? path.join(BRAND_DIR, found) : null;
}

/**
 * The placeholder mark: the same shield-and-check the in-page icon set draws,
 * on the brand navy. Kept byte-for-byte as it was, so switching to the real
 * artwork is the only thing that ever changes an icon.
 *
 * @param {object} options
 * @param {number} options.size        canvas in px
 * @param {number} [options.radius]    corner radius (0 = full bleed, maskable)
 * @param {number} [options.markRatio] artwork width as a fraction of canvas
 */
function placeholderSvg({ size, radius = 0.22, markRatio = 0.62 }) {
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

/**
 * The artwork on its own black field: trimmed of the master's outer margin and
 * scaled so its longer side is `side` px.
 *
 * `trim()` takes its reference colour from the corner. The corner of a supplied
 * master is black — the artwork is gold on black — and a transparent master is
 * flattened to black first, so the corner is black either way. A master with no
 * margin to trim is not an error, it is already tight.
 *
 * @param {string} master
 * @param {number} side
 * @returns {Promise<Buffer>}
 */
async function artwork(master, side) {
  const flat = await sharp(master).flatten({ background: { r: 0, g: 0, b: 0, alpha: 1 } }).png().toBuffer();
  let tight = flat;
  try {
    tight = await sharp(flat).trim({ threshold: 12 }).png().toBuffer();
  } catch {
    /* nothing to trim */
  }
  return sharp(tight)
    .resize({ width: side, height: side, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 }, kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/**
 * A size cut from the master: the artwork centred on the black it was drawn on,
 * corners rounded when the platform will not crop them itself.
 *
 * @param {string} master
 * @param {{size: number, radius?: number, markRatio: number}} target
 * @returns {Promise<Buffer>}
 */
async function masterTile(master, { size, radius = 0, markRatio }) {
  const rx = Math.round(size * radius);
  const field = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<rect width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="${INK}"/></svg>`,
  );
  const art = await artwork(master, Math.round(size * markRatio));
  return sharp(field)
    .composite([{ input: art, gravity: 'center' }])
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

/**
 * Sizes, and the two artwork ratios.
 *
 * The placeholder is a glyph on a coloured tile and needs air around it. The
 * company's mark *is* the tile — its own black field is the background — so it
 * fills the square, except where the platform crops: Android may crop a
 * maskable icon to a circle of 80% of the canvas, and iOS rounds the corners of
 * an apple-touch icon, so both keep the artwork well inside.
 *
 * @type {Array<{file: string, size: number, radius?: number, markRatio?: number, masterRatio: number}>}
 */
const TARGETS = [
  { file: 'icon-192.png', size: 192, masterRatio: 0.96 },
  { file: 'icon-512.png', size: 512, masterRatio: 0.96 },
  // Maskable: full bleed so no edge can show, artwork inside the safe circle.
  { file: 'maskable-192.png', size: 192, radius: 0, markRatio: 0.5, masterRatio: 0.56 },
  { file: 'maskable-512.png', size: 512, radius: 0, markRatio: 0.5, masterRatio: 0.56 },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, markRatio: 0.6, masterRatio: 0.72 },
];

/** Browser tabs and bookmarks. Not an install icon, so it is not in the manifest. */
const FAVICON = { file: 'favicon.png', size: 48, markRatio: 0.62, masterRatio: 0.96 };

/** The mark the header, the drawer and the console draw — 4× its largest use. */
const MARK = { dir: 'img', file: 'logo.png', size: 128 };

/** @param {object} target @param {string|null} master */
async function render(target, master) {
  if (!master) {
    return sharp(Buffer.from(placeholderSvg(target)))
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
  }
  return masterTile(master, {
    size: target.size,
    radius: target.radius || 0,
    markRatio: target.masterRatio,
  });
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

/** The one place that knows where a rendered file lands, relative to a root. */
function relPath(target) {
  return target === FAVICON ? 'favicon.png' : path.join('icons', target.file);
}

async function main() {
  const check = process.argv.includes('--check');
  const master = findMaster();
  const outRoot = check
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'hc-icons-'))
    : (arg('--out') || PUBLIC);
  const iconDir = path.join(outRoot, 'icons');
  fs.mkdirSync(iconDir, { recursive: true });

  const drift = [];
  const written = [];

  for (const target of [...TARGETS, FAVICON]) {
    const buffer = await render(target, master);
    fs.writeFileSync(path.join(outRoot, relPath(target)), buffer);
    const badge = await sharp(buffer).metadata();
    if (badge.width !== target.size || badge.height !== target.size) {
      throw new Error(`${target.file} rendered ${badge.width}×${badge.height}, expected ${target.size}`);
    }
    written.push(`public/${relPath(target)} (${(buffer.length / 1024).toFixed(1)} kB)`);

    if (check) {
      const committed = path.join(PUBLIC, relPath(target));
      const same = fs.existsSync(committed) && fs.readFileSync(committed).equals(buffer);
      if (!same) drift.push(`public/${relPath(target)}`);
    }
  }

  // The header/console mark. It is the one output that does not exist before the
  // master does — its presence is the flag every template falls back on.
  const markRel = path.join(MARK.dir, MARK.file);
  const markCommitted = path.join(PUBLIC, markRel);
  if (master) {
    const buffer = await render({ size: MARK.size, masterRatio: 1 }, master);
    fs.mkdirSync(path.dirname(path.join(outRoot, markRel)), { recursive: true });
    fs.writeFileSync(path.join(outRoot, markRel), buffer);
    written.push(`public/${markRel} (${(buffer.length / 1024).toFixed(1)} kB)`);
    if (check && (!fs.existsSync(markCommitted) || !fs.readFileSync(markCommitted).equals(buffer))) {
      drift.push(`public/${markRel}`);
    }
  } else if (check) {
    if (fs.existsSync(markCommitted)) drift.push(`public/${markRel} (no master to derive it from)`);
  } else {
    // No master: make sure a stale mark cannot survive and keep the header on
    // the real artwork after the artwork is gone.
    fs.rmSync(path.join(outRoot, markRel), { force: true });
  }

  // The manifest is checked against what is on disk, because a manifest naming a
  // missing icon is the difference between "installable" and "install prompt
  // never appears, for reasons nobody can see".
  const manifestFile = path.join(outRoot, 'manifest.webmanifest');
  const expected = manifestJson();
  fs.writeFileSync(manifestFile, expected);
  const missing = manifestIcons()
    .map((icon) => path.join(PUBLIC, icon.src))
    .filter((file) => !fs.existsSync(file));

  if (check) {
    const actual = fs.existsSync(path.join(PUBLIC, 'manifest.webmanifest'))
      ? fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8')
      : '';
    if (actual !== expected) drift.push('public/manifest.webmanifest');
    if (missing.length || drift.length) {
      console.error('✗ app icons are out of date — run: node scripts/generate-icons.js');
      for (const file of [...drift, ...missing.map((f) => path.relative(ROOT, f))]) console.error(`  · ${file}`);
      process.exit(1);
    }
    console.log(`✓ app icons current — ${TARGETS.length + 1} PNGs + manifest, ${master ? 'from ' + path.relative(ROOT, master) : 'placeholder mark'}`);
    return;
  }

  console.log(`✓ brand mark — ${written.length} PNGs${master ? ` from ${path.relative(ROOT, master)}` : ' from the placeholder mark'}`);
  for (const line of written) console.log(`  · ${line}`);
  console.log('  · public/manifest.webmanifest');
  if (!master) {
    console.log('  · no master in assets/brand/ — the placeholder mark is in force, and');
    console.log('    the header keeps drawing its inline icon until one is added.');
  }
}

main().catch((error) => {
  console.error(`✗ icon generation failed: ${error.message}`);
  process.exit(1);
});
