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

test('homepage match hero uses the existing navy, green and white palette', () => {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const tokens = read('public/css/tokens.css');
  const components = read('public/css/components.css');
  const pages = read('public/css/pages.css');
  const home = read('views/pages/home.ejs');

  assert.match(home, /hero hero--match/);
  assert.match(pages, /\.hero--match\s*\{[^}]*background:\s*var\(--navy-deep\)/);
  assert.match(pages, /\.hero__eyebrow\s*\{[^}]*color:\s*var\(--green-bright\)/);
  assert.match(components, /\.btn--primary\s*\{[^}]*background:\s*var\(--color-action\)/);
  assert.match(tokens, /--color-action:\s*var\(--honest-green\)/);
  assert.match(pages, /\.hero--match \.hero__actions \.btn--secondary\s*\{[^}]*color:\s*var\(--white\)/);
});

test('find-my-car explains tracking without publishing a demo ID, and lookup accepts real IDs', () => {
  const template = fs.readFileSync(path.join(ROOT, 'views/pages/find-my-car.ejs'), 'utf8');
  assert.match(template, /Track an existing request/);
  assert.match(template, /tracking ID from your WhatsApp confirmation/);
  assert.doesNotMatch(template, /HC-2481|Demo record for review/);

  const flow = fs.readFileSync(path.join(ROOT, 'public/js/flow.js'), 'utf8');
  const literal = flow.match(/if \(!\/([^/]+)\/\.test\(id\)\)/);
  assert.ok(literal, 'the client-side tracking ID validation is present');
  const trackingIdPattern = new RegExp(literal[1]);
  assert.equal(trackingIdPattern.test('HC-2481'), true);
  assert.equal(trackingIdPattern.test('HC-12'), false);
  assert.equal(trackingIdPattern.test('HC-1234567'), false);
});

test('concierge form success does not scroll to the tracking section after collapsing the form', () => {
  const flow = fs.readFileSync(path.join(ROOT, 'public/js/flow.js'), 'utf8');
  assert.match(
    flow,
    /form\.classList\.add\('hidden'\);\s*const progress = flow\.querySelector\('\.flow__progress'\);\s*if \(progress\) progress\.classList\.add\('hidden'\);[\s\S]*?renderSuccess\(success, \{ kind, serviceSlug: kind, result \}, \{ scroll: false \}\);/,
  );

  const forms = fs.readFileSync(path.join(ROOT, 'public/js/service-forms.js'), 'utf8');
  assert.match(forms, /export function renderSuccess\(container, \{ kind, serviceSlug, result \}, \{ scroll = true \} = \{\}\)/);
  assert.equal((forms.match(/if \(scroll\) container\.scrollIntoView/g) || []).length, 2);
});

test('flow field spacing does not offset the second control inside a two-column grid', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/sections.css'), 'utf8');
  assert.match(css, /\.flow__panel > \.field \+ \.field \{ margin-top: var\(--space-2\); \}/);
  assert.doesNotMatch(css, /\.flow__panel \.field \+ \.field/);
});
