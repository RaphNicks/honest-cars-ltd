'use strict';

/**
 * The badge corner of a car card, where "Certified report" used to land on top
 * of the grade.
 *
 * The ribbon was absolutely positioned `right: 8px; top: 8px` *inside*
 * `.car-card__badges` — which is itself positioned. An absolutely positioned box
 * measures from its nearest positioned ancestor, so those 8px were measured from
 * the badge column, and the column shrink-wraps to the grade chip. The ribbon
 * therefore sat 8px inside the grade chip's own right edge, covering the end of
 * "HonestCars-Certified" and most of the tooltip button, whatever the width of
 * the card.
 *
 * The fix is not a number but an absence of one: the corner is now a wrapping
 * flex row spanning the photo. The chips place themselves, so they cannot
 * overlap at any card width, in any font — and the geometry below is checked
 * only to keep the *composition* honest: on the widest cards the two chips
 * should sit on one line, opposite corners, as §6.2 draws them.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `no rule found for ${selector}`);
  return match[1];
}

function declaration(block, property) {
  const match = block.match(new RegExp(`(?:^|[;}]|\\*/)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match ? match[1].trim() : null;
}

/** Resolve `var(--token)` (and one level of it) through tokens.css. */
function token(tokens, name) {
  const declared = tokens.match(new RegExp(`(?:^|;|\\{)\\s*${name}\\s*:\\s*([^;]+)`, 'm'));
  assert.ok(declared, `${name} is not declared in tokens.css`);
  return declared[1].trim();
}

/** A px length written literally or as a token, however many tokens deep. */
function px(value, tokens, where) {
  let resolved = value.trim();
  for (let hop = 0; hop < 5 && resolved.includes('var('); hop += 1) {
    resolved = resolved.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name) => token(tokens, name));
  }
  const match = resolved.match(/^(-?\d+(?:\.\d+)?)px$/);
  assert.ok(match, `expected a px length for ${where}, got ${value} → ${resolved}`);
  return parseFloat(match[1]);
}

test('the corner is one wrapping row spanning the photo, so chips cannot overlap', () => {
  const components = read('public/css/components.css');
  const badges = rule(components, '.car-card__badges');

  // The row spans the photo. Without `right`, the box shrink-wraps to the grade
  // chip and anything positioned inside it measures from the chip — which is
  // precisely how the ribbon ended up on top of it.
  assert.equal(declaration(badges, 'left'), 'var(--space-1)');
  assert.equal(declaration(badges, 'right'), 'var(--space-1)', 'the row must reach the photo’s right edge');
  assert.equal(declaration(badges, 'max-width'), null, 'a shrink-wrapped column is the old bug');

  // …and it wraps, which is the whole guarantee: two chips that do not fit on
  // one line go onto two, rather than onto each other.
  assert.equal(declaration(badges, 'display'), 'flex');
  assert.equal(declaration(badges, 'flex-wrap'), 'wrap', 'flex-wrap is what makes an overlap impossible');
});

test('the ribbon rides the row instead of being positioned over the chip', () => {
  const components = read('public/css/components.css');
  const ribbon = rule(components, '.car-card__ribbon');

  assert.equal(declaration(ribbon, 'position'), null, 'the ribbon must not be positioned at all');
  assert.equal(declaration(ribbon, 'right'), null);
  assert.equal(declaration(ribbon, 'top'), null);
  assert.equal(
    declaration(ribbon, 'margin-left'),
    'auto',
    'an auto margin is what pushes it to the far end of the row when there is room',
  );
});

test('“Reserved” keeps a line of its own, as it sat under the grade before', () => {
  const components = read('public/css/components.css');
  const reserved = rule(components, '.car-card__badges .badge--reserved');
  assert.equal(declaration(reserved, 'flex-basis'), '100%');
});

test('on a desktop card the two chips share one line, opposite corners', () => {
  // Flex-wrap already forbids an overlap. This measures the intended
  // composition instead: §6.2 puts the grade at the top-left and the report
  // ribbon opposite it, and they should only sit side by side when they fit.
  //
  // The card width is derived, not assumed — 1200px container, its own padding,
  // the 3-column grid gap, the two 8px insets — so this follows the design if
  // the tokens move.
  const tokens = read('public/css/tokens.css');
  const base = read('public/css/base.css');
  const components = read('public/css/components.css');
  const layout = rule(base, '.grid');
  const container = rule(base, '.container');

  const page = px(token(tokens, '--container-max'), tokens, 'container');
  const gutter = px(declaration(container, 'padding-inline'), tokens, 'container padding');
  const gap = px(declaration(layout, 'gap'), tokens, 'grid gap');
  const card = (page - gutter * 2 - gap * 2) / 3;
  const available = card - px(token(tokens, '--space-1'), tokens, 'inset') * 2;

  // What the chips ask for, from the shipped Inter at the shipped size.
  const PDFDocument = require('pdfkit');
  const font = path.join(
    path.dirname(require.resolve('typeface-inter/package.json')),
    'Inter Variable/Single axis/Inter-roman.ttf',
  );
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.registerFont('inter', font);
  const size = px(token(tokens, '--text-12'), tokens, 'chip text');
  const widthOf = (text) => doc.font('inter').fontSize(size).widthOfString(text);

  const chipPadding = px(token(tokens, '--space-1'), tokens, 'badge padding');

  const dot = px(declaration(rule(components, '.badge__dot'), 'width'), tokens, 'dot');
  const tipGap = px(declaration(rule(components, '.info-tip'), 'gap'), tokens, 'info-tip gap');
  const tipButton = px(declaration(rule(components, '.info-tip__button'), 'width'), tokens, 'info-tip button');
  const border = px(token(tokens, '--border-width'), tokens, 'border');
  const rowGap = px(declaration(rule(components, '.car-card__badges'), 'gap'), tokens, 'badge row gap');
  const ribbonPadding = px(token(tokens, '--space-1'), tokens, 'ribbon padding');

  const grade = widthOf('HonestCars-Certified') + dot + tipGap + tipButton + chipPadding * 2 + border * 2;
  const ribbon = widthOf('Certified report') + ribbonPadding * 2;
  const need = grade + rowGap + ribbon;

  // Inter-roman is the 400 instance; the chips are semibold, which is wider by
  // a few percent. 6% is comfortably more than that, and the assertion is meant
  // to catch a *layout* change, not to police a font metric.
  const semibold = need * 1.06;

  assert.ok(
    semibold <= available,
    `the two chips need ~${semibold.toFixed(0)}px of the ${available.toFixed(0)}px a desktop card gives them` +
      ' — the ribbon will wrap to a second line on the widest layout',
  );
});
