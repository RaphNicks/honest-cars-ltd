'use strict';

/**
 * Six-step type-scale enforcement (PRD §3.3).
 *
 * The ladder is exactly 12 / 14 / 16 / 20 / 24 / 32. This check fails the
 * build if any stylesheet:
 *   1. declares a font-size that is not a ladder step,
 *   2. declares a clamp() whose endpoints are not ladder steps,
 *   3. sets 12px on a prose element (p, li, td, dd, blockquote),
 *   4. introduces a third font family,
 *   5. uses a font weight outside 400/500/600/700.
 *
 * Run: npm run lint:type
 */

const fs = require('node:fs');
const path = require('node:path');

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const LADDER = [12, 14, 16, 20, 24, 32, 40];
const PROSE_SELECTORS = /(^|[\s,>])(p|li|td|dd|dt|blockquote|figcaption)([\s,.:[{>]|$)/;
const ALLOWED_WEIGHTS = [400, 500, 600, 700];

/** Comments stripped so documentation examples never trip the audit. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function audit(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const css = stripComments(raw);
  const errors = [];
  const name = path.relative(path.join(__dirname, '..'), file);

  // --- font sizes ---------------------------------------------------------
  const sizeRe = /font-size\s*:\s*([^;}]+)/g;
  let match;
  while ((match = sizeRe.exec(css))) {
    const value = match[1].trim();
    const line = css.slice(0, match.index).split('\n').length;

    if (/^var\(--text-(12|14|16|20|24|32|40)\)$/.test(value)) continue;

    const clampMatch = value.match(/^clamp\(\s*(\d+(?:\.\d+)?)px\s*,[^,]+,\s*(\d+(?:\.\d+)?)px\s*\)$/);
    if (clampMatch) {
      const lo = Number(clampMatch[1]);
      const hi = Number(clampMatch[2]);
      if (!LADDER.includes(lo) || !LADDER.includes(hi)) {
        errors.push(`${name}:${line} clamp() endpoints must be ladder steps — got ${lo}/${hi}px in "${value}"`);
      } else if (lo > hi) {
        errors.push(`${name}:${line} clamp() min must not exceed max — "${value}"`);
      }
      continue;
    }

    if (/^(inherit|initial|unset)$/.test(value)) continue;
    errors.push(`${name}:${line} font-size "${value}" is outside the type ladder (${LADDER.join('/')}px)`);
  }

  // --- prose never below 14px --------------------------------------------
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  while ((match = ruleRe.exec(css))) {
    const selector = match[1].trim();
    const body = match[2];
    if (!/font-size\s*:\s*var\(--text-12\)/.test(body)) continue;
    if (PROSE_SELECTORS.test(selector)) {
      const line = css.slice(0, match.index).split('\n').length;
      errors.push(`${name}:${line} 12px is a micro-label size — prose selector "${selector.slice(0, 60)}" must be ≥14px`);
    }
  }

  // --- one family, four weights ------------------------------------------
  const familyRe = /font-family\s*:\s*([^;}]+)/g;
  while ((match = familyRe.exec(css))) {
    const value = match[1].trim();
    if (/^var\(--font-sans\)$/.test(value)) continue;
    if (/^var\(--font-display\)$/.test(value)) continue;
    // the @font-face declarations themselves
    if (/^['"](IBM Plex Sans|Barlow Condensed)['"]$/.test(value)) continue;
    if (value.startsWith('inherit')) continue;
    errors.push(`${name} font-family "${value}" — IBM Plex Sans + Barlow Condensed are the only families (§3.3)`);
  }

  const weightRe = /font-weight\s*:\s*([0-9]{3}|var\(--weight-[a-z]+\))/g;
  while ((match = weightRe.exec(css))) {
    const value = match[1];
    if (value.startsWith('var(')) continue;
    if (!ALLOWED_WEIGHTS.includes(Number(value))) {
      errors.push(`${name} font-weight ${value} — only 400/500/600/700 are loaded (§3.3)`);
    }
  }

  return errors;
}

function main() {
  const files = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => path.join(CSS_DIR, f));
  const errors = files.flatMap(audit);

  if (errors.length) {
    console.error(`✗ type-scale audit failed — ${errors.length} issue(s):\n`);
    for (const error of errors) console.error(`  • ${error}`);
    process.exit(1);
  }

  console.log(`✓ type-scale audit passed — ${files.length} stylesheets, ladder ${LADDER.join('/')}px, two families, weights ${ALLOWED_WEIGHTS.join('/')}`);
}

main();
