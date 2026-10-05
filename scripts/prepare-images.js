'use strict';

/**
 * Image preparation — the (small) media pipeline this project needs until the
 * real one lands (§11: S3 + CDN + WebP variants).
 *
 *   node scripts/prepare-images.js            # normalise everything
 *   node scripts/prepare-images.js --check    # report only, exit 1 if work is due
 *
 * Photos are generated/dropped into public/img/{cars,details,site,blog,shop,hire}
 * at whatever size they arrive. This script crops them to the 4:3 frame the
 * listing gallery and the OG compositor expect (1200×900), strips metadata and
 * writes a 600×450 `-600` sibling so cards can use a lighter file.
 *
 * It also writes the blur-up placeholders (§13.2): a 20px-wide WebP of every
 * photo, inlined as a data URI in `src/lib/image-blur.json`. Inline rather than
 * a file on purpose — a second request per image costs a data-conscious visitor
 * more than the ~300 bytes the placeholder adds to the HTML, and a placeholder
 * that arrives after the photo is useless.
 *
 * It is idempotent: a file already at 1200×900 with its sibling present is left
 * alone, so it is safe to run on every build. `--check` fails when any sibling
 * or placeholder is missing, or when the manifest has drifted from the photos.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'public', 'img');
const GROUPS = ['cars', 'details', 'site', 'blog', 'shop', 'hire'];
const WIDTH = 1200;
const HEIGHT = 900;
const SMALL_WIDTH = 600;
const SMALL_HEIGHT = 450;
// The blur-up placeholder. 20px wide is enough to read as "a car, dark blue,
// shot outdoors" once it is blurred; anything larger is bytes for nothing.
const BLUR_WIDTH = 20;
const BLUR_FILE = path.join(ROOT, 'src', 'lib', 'image-blur.json');

/** The letterboxes we expect: any landscape photo is centre-cropped to 4:3. */
/** The public URL a photo is served at, which is the key the helpers look up. */
function publicUrl(file) {
  return `/${path.relative(path.join(ROOT, 'public'), file).split(path.sep).join('/')}`;
}

/** A 20px WebP of the photo, as the data URI a card can put in a style tag. */
async function blurDataUri(file) {
  const buffer = await sharp(file)
    .resize(BLUR_WIDTH, Math.round((BLUR_WIDTH * HEIGHT) / WIDTH), { fit: 'cover', position: 'centre' })
    .webp({ quality: 25 })
    .toBuffer();
  return `data:image/webp;base64,${buffer.toString('base64')}`;
}

async function prepare(file, { check }) {
  const name = path.basename(file);
  if (name.includes('-600.')) return null;

  const meta = await sharp(file).metadata();
  const small = file.replace(/\.(jpe?g|png)$/i, '-600.jpg');
  const alreadyFramed = meta.width === WIDTH && meta.height === HEIGHT;
  if (alreadyFramed && fs.existsSync(small)) return null;
  if (check) return file;

  await sharp(file)
    .rotate() // honour EXIF orientation before we strip it
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 82, progressive: true, mozjpeg: true })
    .toFile(`${file}.tmp`)
    .then(() => fs.renameSync(`${file}.tmp`, file));

  await sharp(file)
    .resize(SMALL_WIDTH, SMALL_HEIGHT, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 80, progressive: true, mozjpeg: true })
    .toFile(`${small}.tmp`)
    .then(() => fs.renameSync(`${small}.tmp`, small));

  return file;
}

async function main() {
  const check = process.argv.includes('--check');
  const pending = [];
  const photos = [];

  for (const group of GROUPS) {
    const dir = path.join(IMG_DIR, group);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.(jpe?g|png)$/i.test(entry) || entry.includes('-600.')) continue;
      const file = path.join(dir, entry);
      photos.push(file);
      const result = await prepare(file, { check });
      if (result) pending.push(path.relative(ROOT, result));
    }
  }

  if (check && pending.length) {
    console.error(`✗ ${pending.length} image(s) need preparing — run: node scripts/prepare-images.js`);
    for (const file of pending.slice(0, 10)) console.error(`  · ${file}`);
    process.exit(1);
  }

  // The placeholder manifest is derived from the photos, so it is rebuilt (or
  // compared) on every run — a photo that changed shape changes its blur.
  const manifest = {};
  for (const file of photos.sort()) manifest[publicUrl(file)] = await blurDataUri(file);

  const previous = fs.existsSync(BLUR_FILE) ? fs.readFileSync(BLUR_FILE, 'utf8') : '';
  // One key per line: a 200-character data URI per photo is unreviewable as one
  // long line, and the diff should show which photo changed.
  const next = `{\n${Object.entries(manifest).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')}\n}\n`;
  if (check) {
    if (previous.trim() !== next.trim()) {
      console.error('✗ src/lib/image-blur.json is out of date — run: node scripts/prepare-images.js');
      process.exit(1);
    }
    console.log(`✓ images: all photos are ${WIDTH}×${HEIGHT} with 600px siblings and a blur-up placeholder`);
    return;
  }

  if (previous.trim() !== next.trim()) fs.writeFileSync(BLUR_FILE, next);
  console.log(`✓ prepared ${pending.length} image(s) → ${WIDTH}×${HEIGHT} + ${SMALL_WIDTH}×${SMALL_HEIGHT}`);
  console.log(`✓ ${Object.keys(manifest).length} blur-up placeholder(s) in ${path.relative(ROOT, BLUR_FILE)}`);
  for (const file of pending) console.log(`  · ${file}`);
}

main().catch((error) => {
  console.error('image preparation failed:', error.message);
  process.exit(1);
});
