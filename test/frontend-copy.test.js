'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');
const INTERNAL_MARKER = /§\s*(?:\d+(?:\.\d+)*|Appendix\s+[A-Z])|\bPRD\b|\bFR-\d+\b/;

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(file);
    return entry.isFile() && entry.name.endsWith('.ejs') ? [file] : [];
  });
}

function visibleTemplateText(source) {
  return source
    .replace(/<%[\s\S]*?%>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

test('view templates never print internal spec references to the website', () => {
  const leaks = [];
  for (const file of filesUnder(VIEWS)) {
    const source = fs.readFileSync(file, 'utf8');
    const visible = visibleTemplateText(source);
    for (const [index, line] of visible.split('\n').entries()) {
      if (INTERNAL_MARKER.test(line)) {
        leaks.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(leaks, [], `Internal references visible in templates:\n${leaks.join('\n')}`);
});

test('the landing-page navy is used by all site navigation bars', () => {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const tokens = read('public/css/tokens.css');
  const components = read('public/css/components.css');
  const pages = read('public/css/pages.css');
  const admin = read('public/css/admin.css');

  const rule = (source, selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `missing CSS rule for ${selector}`);
    return match[1];
  };

  assert.match(tokens, /--navy-deep:\s*#071c2a/i, 'the landing-page navy is the shared brand token');
  assert.match(rule(components, '.header'), /background:\s*var\(--navy-deep\)/);
  assert.match(rule(pages, 'body[data-page="/"] .header'), /background:\s*var\(--navy-deep\)/);
  assert.match(rule(components, '.bottom-nav'), /background:\s*var\(--navy-deep\)/);
  assert.match(rule(admin, '.admin-bar'), /background:\s*var\(--navy-deep\)/);
});
