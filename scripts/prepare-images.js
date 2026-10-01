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
 * It is idempotent: a file already at 1200×900 with its sibling present is left
 * alone, so it is safe to run on every build.
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

/** The letterboxes we expect: any landscape photo is centre-cropped to 4:3. */
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

  for (const group of GROUPS) {
    const dir = path.join(IMG_DIR, group);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.(jpe?g|png)$/i.test(entry) || entry.includes('-600.')) continue;
      const file = path.join(dir, entry);
      const result = await prepare(file, { check });
      if (result) pending.push(path.relative(ROOT, result));
    }
  }

  if (check) {
    if (pending.length) {
      console.error(`✗ ${pending.length} image(s) need preparing — run: node scripts/prepare-images.js`);
      for (const file of pending.slice(0, 10)) console.error(`  · ${file}`);
      process.exit(1);
    }
    console.log('✓ images: all photos are 1200×900 with 600px siblings');
    return;
  }

  console.log(`✓ prepared ${pending.length} image(s) → ${WIDTH}×${HEIGHT} + ${SMALL_WIDTH}×${SMALL_HEIGHT}`);
  for (const file of pending) console.log(`  · ${file}`);
}

main().catch((error) => {
  console.error('image preparation failed:', error.message);
  process.exit(1);
});
