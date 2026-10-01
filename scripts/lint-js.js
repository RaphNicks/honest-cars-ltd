'use strict';

/**
 * Front-end lint pass.
 *
 * 1. Every public/js/*.js parses as an ES module (they are loaded with
 *    type="module" and there is no bundler to catch mistakes).
 * 2. Every event name used in the templates or client code appears in the
 *    §15.1 plan — the one check that keeps analytics honest.
 *
 * Run: npm run lint:js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public', 'js');
const { EVENT_NAMES } = require('../src/services/events');

function checkModuleSyntax() {
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-js-'));
  const errors = [];

  for (const file of files) {
    const target = path.join(tmp, `${path.basename(file, '.js')}.mjs`);
    fs.copyFileSync(path.join(JS_DIR, file), target);
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    } catch (error) {
      errors.push(`public/js/${file}\n${String(error.stderr || error.message).split('\n').slice(0, 4).join('\n')}`);
    }
  }

  return { checked: files.length, errors };
}

function checkEventNames() {
  const sources = [
    ...fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(JS_DIR, f)),
    ...fs
      .readdirSync(path.join(ROOT, 'views'), { recursive: true })
      .filter((f) => f.endsWith('.ejs'))
      .map((f) => path.join(ROOT, 'views', f)),
  ];

  const allowed = new Set(EVENT_NAMES);
  const errors = [];
  let found = 0;

  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const patterns = [/track\(\s*'([a-z0-9_]+)'/g, /data-event="([a-z0-9_]+)"/g];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text))) {
        found += 1;
        if (!allowed.has(match[1])) {
          const line = text.slice(0, match.index).split('\n').length;
          errors.push(`${path.relative(ROOT, file)}:${line} event "${match[1]}" is not in the §15.1 plan`);
        }
      }
    }
  }

  return { found, errors };
}

function main() {
  const syntax = checkModuleSyntax();
  const events = checkEventNames();

  if (syntax.errors.length || events.errors.length) {
    console.error('✗ front-end lint failed:\n');
    for (const error of [...syntax.errors, ...events.errors]) console.error(`  • ${error}\n`);
    process.exit(1);
  }

  console.log(
    `✓ front-end lint passed — ${syntax.checked} ES modules parse, ${events.found} event references all match the §15.1 plan`,
  );
}

main();
