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
 * The mark is drawn gold on transparency, so that is how it is served: it reads
 * on the white header, on the console's dark bar and on the navy share cards
 * alike. Where a platform wants an opaque square — the install icons, and iOS,
 * which renders transparency in an apple-touch icon as black — the artwork sits
 * on the brand navy instead. Android's maskable safe circle is measured per
 * pixel rather than trusted.
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
 * The artwork, scaled so its longer side is `side` px, transparency intact.
 *
 * The supplied master is gold on transparency, so this is a resize and nothing
 * else. `trim()` still runs: a future master may arrive with a margin, and
 * trimming one that has none is a no-op.
 *
 * @param {string} master
 * @param {number} side
 * @returns {Promise<Buffer>}
 */
async function artwork(master, side) {
  let tight = master;
  try {
    tight = await sharp(master).trim({ threshold: 12 }).png().toBuffer();
  } catch {
    /* nothing to trim */
  }
  return sharp(tight)
    .resize({
      width: side,
      height: side,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();
}

/**
 * A size cut from the master.
 *
 * `field: 'none'` keeps the transparency the artwork was drawn on — what the
 * header, the console bar, the favicon and the share cards want, each drawing
 * the gold on whatever is behind it. `field: 'navy'` lays it on the brand navy
 * — what the install icons want: an opaque square no launcher can fill in, and
 * not the black iOS would force on a transparent apple-touch icon.
 *
 * @param {string} master
 * @param {{size: number, radius?: number, markRatio: number, field?: 'navy'|'none'}} target
 * @returns {Promise<Buffer>}
 */
async function masterTile(master, { size, radius = 0, markRatio, field = 'none' }) {
  const art = await artwork(master, Math.round(size * markRatio));
  if (field === 'none') {
    const square = await sharp(art)
      .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return sharp(square).png({ compressionLevel: 9, palette: true }).toBuffer();
  }
  const rx = Math.round(size * radius);
  const plate = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<rect width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="${NAVY}"/></svg>`,
  );
  // Flattened rather than merely composited: a PNG that carries a fully opaque
  // alpha channel still declares itself transparent, and a launcher that
  // believes that puts the icon on white — the exact thing this field is for.
  return sharp(plate)
    .composite([{ input: art, gravity: 'center' }])
    .flatten({ background: NAVY })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

/**
 * Sizes, and how much of the square the artwork gets.
 *
 * The placeholder is a stroke glyph and always gets a navy tile — on
 * transparency it would be invisible as often as not.
 *
 * The company's mark is drawn gold on transparency, and the transparency is
 * kept wherever the gold has something dark to sit on: the console bar is navy,
 * the share cards are navy, and the header puts it on a navy chip of its own
 * (`img.header__logo-mark`). Everywhere else — the install icons, the
 * apple-touch icon, and the favicon, which lands on a light tab strip — the
 * artwork gets the navy field instead. Gold on white loses the laurel, the hand
 * and the car at these sizes; that was looked at, not assumed.
 *
 * `masterRatio` is the artwork's longer side as a fraction of the canvas. The
 * mark is portrait (about 0.81 as wide as it is tall), so its height is the
 * side that matters. Maskable is the smallest of the install icons because
 * Android may crop it to a circle of 80% of the canvas — `test/brand.test.js`
 * measures every pixel of the shipped file against that circle rather than
 * trusting the number here.
 *
 * @type {Array<{file: string, size: number, radius?: number, markRatio?: number, masterRatio: number, masterField: 'navy'|'none'}>}
 */
const TARGETS = [
  { file: 'icon-192.png', size: 192, masterRatio: 0.78, masterField: 'navy' },
  { file: 'icon-512.png', size: 512, masterRatio: 0.78, masterField: 'navy' },
  // Maskable: full bleed so no edge can show, artwork inside the safe circle.
  { file: 'maskable-192.png', size: 192, radius: 0, markRatio: 0.5, masterRatio: 0.6, masterField: 'navy' },
  { file: 'maskable-512.png', size: 512, radius: 0, markRatio: 0.5, masterRatio: 0.6, masterField: 'navy' },
  // Full bleed and opaque on purpose: iOS rounds these corners itself.
  { file: 'apple-touch-icon.png', size: 180, radius: 0, markRatio: 0.6, masterRatio: 0.78, masterField: 'navy' },
];

/**
 * Browser tabs and bookmarks. Not an install icon, so it is not in the manifest.
 *
 * This one gets the navy field even though the artwork is transparent: a tab
 * strip is light in every browser that ships one, and gold on white at 16–48px
 * loses the laurel, the hand and the car — measured, not assumed.
 */
const FAVICON = { file: 'favicon.png', size: 48, radius: 0.18, markRatio: 0.62, masterRatio: 0.88, masterField: 'navy' };

/** The mark the header, the drawer and the console draw — 4× its largest use. */
const MARK = { dir: 'img', file: 'logo.png', size: 128, masterRatio: 1, masterField: 'none' };

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
    field: target.masterField || 'none',
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
    const buffer = await render({ size: MARK.size, masterRatio: MARK.masterRatio, masterField: MARK.masterField }, master);
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
