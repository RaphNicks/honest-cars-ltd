/**
 * OG cards — §12.4 / §14.1, 1200×630.
 *
 * The suite exists because of a bug that shipped invisibly: the card layout
 * drew one <text> line per field and let librsvg clip whatever ran past the
 * edge, so every listing title longer than about thirty characters was cut
 * mid-word. Most of the stock is longer than that. Nothing about a PNG says so
 * — the card still looks deliberate — so the check has to be arithmetic.
 *
 * These tests parse the SVG the layout emits and measure each <text> run with
 * the same renderer the card itself uses. A title is only allowed to reach the
 * edge if the layout decided it did not fit, and then it has to end in an
 * ellipsis rather than a chopped word.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const og = require('../src/services/og');

/** Every <text> element in the card: position, size, weight and content. */
function textRuns(svg) {
  const runs = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = pattern.exec(svg))) {
    const [, attrs, inner] = match;
    const attr = (name) => {
      const found = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return found ? found[1] : null;
    };
    runs.push({
      x: Number(attr('x')),
      y: Number(attr('y')),
      size: Number(attr('font-size')),
      weight: attr('font-weight'),
      text: inner.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
    });
  }
  return runs;
}

/** Real titles, in the shape the seeded stock and the dealer portal produce. */
const TITLES = [
  '2015 Toyota Camry LE',
  '2012 Lexus RX 350 F Sport',
  '2018 Toyota Land Cruiser Prado TX-L',
  'Mercedes-Benz GLE 450 4MATIC AMG Line Premium Plus',
  'Toyota Land Cruiser V8 Diesel Automatic Full Option With Sunroof And Leather Interior',
  'Honda',
  '',
];

test('every line of a title fits inside the card, at every length', async () => {
  for (const title of TITLES) {
    const svg = await og.cardSvg({ title, subtitle: '₦48.5m · Port Harcourt', badge: 'certified' });
    const runs = textRuns(svg);

    assert.ok(runs.length >= 2, `a card for “${title}” should carry text`);
    for (const run of runs) {
      const width = await og.measureText(run.text, run.size, Number(run.weight));
      assert.ok(
        run.x + width <= og.CARD_WIDTH,
        `“${run.text}” (${run.size}px) ends at ${(run.x + width).toFixed(0)}px — past the ${og.CARD_WIDTH}px edge`,
      );
      assert.ok(run.x >= 0 && run.y > 0 && run.y < 630, 'and sits on the card');
    }
  }
});

test('a title that has to be shortened ends in an ellipsis, never mid-word', async () => {
  const title = 'Toyota Land Cruiser V8 Diesel Automatic Full Option With Sunroof And Leather Interior';
  const layout = await og.wrapText(title, { size: 74, maxLines: 2 });
  assert.equal(layout.over, true, 'this one genuinely does not fit two 74px lines');
  assert.equal(layout.lines.length, 2);
  assert.ok(layout.lines[1].endsWith('…'), `the last line must say it was cut: ${JSON.stringify(layout.lines)}`);
  // The remainder is a prefix of the original, minus the ellipsis — no word has
  // been spliced, which is what “clipped mid-word” looked like.
  const kept = layout.lines.join(' ').replace(/…$/, '').trim();
  assert.ok(title.startsWith(kept), `${kept} must be a prefix of the title`);
});

test('the layout keeps the original geometry when one line will do', async () => {
  const short = await og.cardSvg({ title: '2015 Toyota Camry LE', subtitle: '₦8.5m · Port Harcourt' });
  const runs = textRuns(short);
  const title = runs.find((run) => run.text.startsWith('2015'));
  assert.ok(title, 'the title is drawn');
  assert.equal(title.size, 74, 'a short title is not shrunk for the sake of it');
  assert.equal(title.y, 360, 'and keeps the card’s original baseline');
});

test('a long title moves up rather than colliding with the footer', async () => {
  const svg = await og.cardSvg({
    title: '2018 Toyota Land Cruiser Prado TX-L',
    subtitle: '₦48.5m · Port Harcourt',
    badge: 'certified',
  });
  const runs = textRuns(svg);
  const title = runs.find((run) => run.text.startsWith('2018'));
  const subtitle = runs.find((run) => run.text.includes('Port Harcourt') && run.size > 40);
  const footer = runs.find((run) => run.text === 'honestcarsltd.com');
  const badge = runs.find((run) => /CERTIFIED|CHECKED|LISTED/.test(run.text));

  assert.equal(title.y, 322, 'two lines start higher');
  assert.ok(subtitle.y > title.y, 'the subtitle sits under the title');
  assert.ok(badge.y > subtitle.y, 'the badge sits under the subtitle');
  assert.ok(badge.y < footer.y, 'and everything stays above the footer');
  assert.ok(footer.y + 26 < 630, 'the footer is on the card');
});

test('a two-line title is measured against the text column, not the whole card', async () => {
  const svg = await og.cardSvg({ title: '2018 Toyota Land Cruiser Prado TX-L', subtitle: '₦48.5m · Port Harcourt' });
  const lines = textRuns(svg).filter((run) => run.size === 74).map((run) => run.text);
  assert.equal(lines.length, 2, 'it wrapped onto two lines');
  for (const line of lines) {
    const width = await og.measureText(line, 74, 700);
    assert.ok(width <= og.TEXT_WIDTH * 1.02, `“${line}” is ${width.toFixed(0)}px wide; the column is ${og.TEXT_WIDTH}`);
  }
});

test('the badge is sized to its own label, measured not guessed', async () => {
  for (const badge of ['certified', 'field_checked', 'network_listed']) {
    const svg = await og.cardSvg({ title: '2015 Toyota Camry LE', subtitle: '₦8.5m', badge });
    // `\swidth=` and not `stroke-width=`, which sits later in the same tag and
    // is 2px — a greedy match found that one first and the test read "2px pill".
    const pill = svg.match(/<rect x="72" y="\d+" rx="18"[^>]*?\swidth="(\d+)"/);
    const label = textRuns(svg).find((run) => /CERTIFIED|CHECKED|LISTED/.test(run.text));
    assert.ok(pill && label, `the ${badge} badge is drawn`);
    const labelWidth = await og.measureText(label.text, label.size, Number(label.weight));
    assert.ok(
      label.x + labelWidth <= Number(pill[1]) + og.TEXT_X,
      `“${label.text}” must fit inside its ${pill[1]}px pill`,
    );
  }
});

test('a rendering is still written to disk and cached by content', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const input = { key: 'test-card', title: '2015 Toyota Camry LE', subtitle: '₦8.5m · Port Harcourt', badge: 'certified' };
  const first = await og.renderOgCard(input);
  assert.match(first, /^\/og\/test-card-[0-9a-f]{12}\.png$/);
  const file = path.join(og.OG_DIR, path.basename(first));
  assert.ok(fs.existsSync(file), 'the card exists on disk');
  const second = await og.renderOgCard(input);
  assert.equal(second, first, 'the same input renders to the same file');
  fs.unlinkSync(file);
});

test('the fallback card is the same art as the layout, not a stale PNG', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const out = path.join(og.OG_DIR, 'default.png');
  const before = fs.existsSync(out) ? fs.statSync(out).mtimeMs : 0;
  const result = await og.ensureDefaultCard();
  assert.equal(result, '/og/default.png');
  assert.ok(fs.existsSync(out), 'the default card is on disk');
  // Re-running it now produces identical bytes, so the file is left alone…
  const after = fs.statSync(out).mtimeMs;
  await og.ensureDefaultCard();
  assert.equal(fs.statSync(out).mtimeMs, after, 'a second boot does not rewrite identical bytes');
  assert.ok(after >= before);
});
