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
const MARK = path.join(ROOT, 'public', 'img', 'logo.png');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

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

test('the maskable pair keeps its artwork inside Android’s safe circle', async () => {
  // Android may crop a maskable icon to a circle of 80% of the canvas, so
  // nothing that is not the tile's own field may fall outside it. The field is
  // read from the corner rather than assumed, which keeps this honest whichever
  // way the icons are drawn — the placeholder's navy tile or the company's mark.
  for (const [file, size] of [['maskable-192.png', 192], ['maskable-512.png', 512]]) {
    const { data, info } = await sharp(path.join(ROOT, 'public', 'icons', file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const field = [data[0], data[1], data[2], data[3]];
    const limit = size * 0.4;
    let worst = 0;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const at = (y * info.width + x) * info.channels;
        const differs = Math.max(
          Math.abs(data[at] - field[0]),
          Math.abs(data[at + 1] - field[1]),
          Math.abs(data[at + 2] - field[2]),
          Math.abs(data[at + 3] - field[3]),
        );
        if (differs <= 24) continue;
        worst = Math.max(worst, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
      }
    }
    assert.ok(worst <= limit, `${file}: artwork reaches r=${worst.toFixed(1)}, past the safe circle at ${limit.toFixed(1)}`);
  }
});

test('the install icons are opaque, the in-page mark keeps its transparency', async () => {
  // Where the mark lands decides whether it needs a field of its own. The
  // install icons and the favicon sit on whatever the launcher or the tab strip
  // is — white as often as not — so they are opaque navy squares. The header
  // mark, the console mark and the share card all draw the gold directly, and
  // the header supplies its own navy chip in CSS.
  for (const file of ['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'favicon.png']) {
    const meta = await sharp(path.join(ROOT, 'public', file)).metadata();
    assert.equal(meta.hasAlpha, false, `public/${file} must be an opaque square`);
  }
  const mark = await sharp(path.join(ROOT, 'public', 'img', 'logo.png')).metadata();
  assert.equal(mark.hasAlpha, true, 'public/img/logo.png must keep the artwork’s transparency');

  // …and the header must actually give it that chip, and actually size it.
  const css = read('public/css/components.css');
  const rule = css.match(/img\.header__logo-mark \{([^}]*)\}/);
  assert.ok(rule, 'img.header__logo-mark needs a rule of its own');
  assert.match(rule[1], /background:\s*var\(--honest-navy\)/, 'the header chip must be the brand navy');
  assert.match(rule[1], /border-radius/, 'the chip must take the house radius');
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
