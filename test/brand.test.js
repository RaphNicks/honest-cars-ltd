'use strict';

/**
 * The brand mark is derived, never hand-exported: one master in `assets/brand/`
 * becomes the favicon, the install icons, the header mark and the console mark
 * (`scripts/generate-icons.js`). These tests hold the two failures that would
 * otherwise be invisible — a maskable icon whose artwork Android crops, and a
 * brand block that either ignores a mark or points at one that is not there.
 *
 * The third failure — an icon edited by hand, or a mark replaced after the icons
 * were cut — is already caught by `test/pwa.test.js` running the generator with
 * `--check`, so it is not repeated here.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');

const { helpers } = require('../src/lib/locals');

const ROOT = path.join(__dirname, '..');
const BRAND_DIR = path.join(ROOT, 'assets', 'brand');
const MARK = path.join(ROOT, 'public', 'img', 'logo.png');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The master artwork, when the company has supplied one (same rule as the script). */
function findMaster() {
  if (!fs.existsSync(BRAND_DIR)) return null;
  const found = fs.readdirSync(BRAND_DIR)
    .filter((file) => /^logo\.(png|jpe?g|webp|tiff?)$/i.test(file))
    .sort()[0];
  return found ? path.join(BRAND_DIR, found) : null;
}

const master = findMaster();

test('the tab icon is a PNG mark, and the old vector shield is gone', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'favicon.png')), 'public/favicon.png must exist');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public', 'favicon.svg')), 'the placeholder favicon.svg must not come back');

  const pwa = read('views/partials/pwa.ejs');
  assert.match(pwa, /href="\/favicon\.png"/, 'the head must link the PNG favicon');
  assert.ok(!pwa.includes('favicon.svg'), 'nothing may link the old placeholder favicon');

  // The favicon is a real size, not a stretched 1px file.
  const size = Number(read('views/partials/pwa.ejs').match(/favicon\.png" sizes="(\d+)x\1"/)?.[1]);
  assert.ok(size >= 32, 'the favicon must declare a usable size');
});

test('the maskable pair keeps its artwork inside Android’s safe circle', { skip: master ? false : 'no master in assets/brand/ yet — the placeholder tile is full bleed by design' }, async () => {
  // Android may crop a maskable icon to a circle of 80% of the canvas. The
  // master sits on its own black field, so "artwork" here is every lit pixel,
  // and none of them may fall outside that circle.
  for (const [file, size] of [['maskable-192.png', 192], ['maskable-512.png', 512]]) {
    const { data, info } = await sharp(path.join(ROOT, 'public', 'icons', file))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const limit = size * 0.4;
    let worst = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const at = (y * info.width + x) * info.channels;
        if (data[at] < 24 && data[at + 1] < 24 && data[at + 2] < 24) continue;
        worst = Math.max(worst, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
      }
    }
    assert.ok(worst <= limit, `${file}: artwork reaches r=${worst.toFixed(1)}, past the safe circle at ${limit.toFixed(1)}`);
  }
});

test('the brand block asks for the mark only while the file is there', () => {
  const mark = helpers().brandMark;
  assert.equal(mark, fs.existsSync(MARK) ? '/img/logo.png' : null, 'helpers.brandMark must follow the file');

  // Every brand block falls back, and none of them hard-codes the mark URL —
  // a template that hard-coded it would ship a broken image the day the file
  // was missing, and a template without the fallback would ignore the artwork.
  for (const file of ['views/partials/header.ejs', 'views/partials/drawer.ejs', 'views/layouts/admin.ejs']) {
    const source = read(file);
    assert.match(source, /helpers\.brandMark/, `${file} must ask whether there is a mark`);
    assert.ok(!source.includes('src="/img/logo.png"'), `${file} must not hard-code the mark URL`);
  }
});
