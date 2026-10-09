'use strict';

/**
 * The six-step type scale is a hard requirement of PRD §3.3. This suite proves
 * the audit runs, passes on the shipped stylesheets, and actually fails when a
 * seventh size is introduced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, runScript } = require('./helpers');

const LADDER = [12, 14, 16, 20, 24, 32];

test('type-scale audit passes on the shipped stylesheets', () => {
  const output = runScript('scripts/lint-type-scale.js');
  assert.match(output, /type-scale audit passed/);
});

test('every ladder step is declared as a token', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'public', 'css', 'tokens.css'), 'utf8');
  for (const step of LADDER) {
    assert.match(tokens, new RegExp(`--text-${step}:`), `--text-${step} token is missing`);
  }
});

test('there is no seventh text size token', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'public', 'css', 'tokens.css'), 'utf8');
  const declared = [...tokens.matchAll(/--text-(\d+):/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(declared)].sort((a, b) => a - b), LADDER);
});

test('the audit rejects a size outside the ladder', () => {
  const probe = path.join(ROOT, 'public', 'css', '_probe.css');
  fs.writeFileSync(probe, '.probe { font-size: 13px; }\n');
  try {
    assert.throws(() => runScript('scripts/lint-type-scale.js'), /outside the six-step ladder/);
  } finally {
    fs.unlinkSync(probe);
  }
});

test('the audit rejects 12px on a prose selector', () => {
  const probe = path.join(ROOT, 'public', 'css', '_probe.css');
  fs.writeFileSync(probe, '.article li { font-size: var(--text-12); }\n');
  try {
    assert.throws(() => runScript('scripts/lint-type-scale.js'), /prose selector/);
  } finally {
    fs.unlinkSync(probe);
  }
});
