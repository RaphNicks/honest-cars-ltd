'use strict';

/**
 * The `hidden` attribute, which five components were each patching separately.
 *
 * The attribute means "do not render this", and the UA stylesheet implements it
 * as `display: none`. Any author rule setting `display` silently beats that, and
 * the failure is never loud: an empty card where a result will appear, a field
 * that shows before its data exists, a tab panel that shows alongside its
 * siblings. Five elements had grown a `[hidden]` guard of their own —
 * `.mega__panel`, `.area-switcher__panel`, `.footer__install`, `.flow__panel`,
 * `.info-tip__panel` — and the sixth, seventh and eighth had not:
 *
 *   • `.valuation__result` (display: grid) — the empty card a seller sees under
 *     "Show me the band" on /sell-swap.
 *   • `.field` on /financing (display: flex) — "The car you asked about" showing
 *     before any car was chosen.
 *   • `.grid` on the home page (display: grid) — all four tab feeds stacked,
 *     because toggling the attribute did nothing.
 *
 * One declaration in base.css ended the pattern. These tests keep it ended: the
 * rule must stay global, strong enough to win, and it must stay the *only* one,
 * because a second local guard is how the next element gets forgotten.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const CSS_FILES = fs.readdirSync(path.join(ROOT, 'public/css')).filter((f) => f.endsWith('.css'));
const allCss = () => CSS_FILES.map((f) => read(`public/css/${f}`)).join('\n');

/** Every `selector { body }` pair in a stylesheet, comments stripped. */
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

/** The declarations of the first rule whose selector list contains `selector`. */
function ruleFor(css, selector) {
  const found = rules(css).find((r) => r.selector.split(',').map((s) => s.trim()).includes(selector));
  assert.ok(found, `no rule found for ${selector}`);
  return found.body;
}

/** A declaration's value, e.g. `display` → `grid; gap: …` becomes `grid`. */
function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match ? match[1].trim() : null;
}

test('the attribute is unbeatable, and that is decided in exactly one place', () => {
  const css = allCss();
  const guard = rules(css).filter((r) => /(^|,)\s*\[hidden\]\s*$/.test(r.selector) || /(^|,)\s*\[hidden\]\s*($|,)/.test(r.selector));

  assert.equal(guard.length, 1, `the [hidden] rule must exist once for every element, found ${guard.length}`);

  const display = declaration(guard[0].body, 'display');
  assert.match(display, /^none\b/, `[hidden] must mean display: none, got ${display}`);
  assert.match(
    guard[0].body,
    /display:\s*none\s*!important/,
    'without !important any component rule that sets a display wins, which is the whole bug',
  );

  // It has to live in base.css, which every page loads before its components.
  assert.match(read('public/css/base.css'), /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test('the three elements that were leaking are hidden by it', () => {
  // Each of these ships the attribute and carries a class whose own rule sets a
  // display — so today they are hidden *because* of the global rule, and they
  // would be visible without it. Named individually: a future reader deleting
  // the rule should have to argue with these three by name.
  const leaks = [
    {
      what: 'the instant-estimate result card',
      view: 'views/pages/sell-swap.ejs',
      marker: 'data-valuation-result',
      className: 'valuation__result',
    },
    {
      what: '“The car you asked about” on /financing',
      view: 'views/pages/financing.ejs',
      marker: 'data-car-field',
      className: 'field',
    },
    {
      what: 'the home-page tab feeds',
      view: 'views/pages/home.ejs',
      marker: 'data-feed-panel',
      className: 'grid',
    },
  ];

  for (const leak of leaks) {
    const view = read(leak.view);
    const at = view.indexOf(leak.marker);
    assert.ok(at > -1, `${leak.what}: ${leak.view} must still ship ${leak.marker}`);
    // Either side of the marker: home.ejs writes the conditional attribute
    // before `data-feed-panel`, sell-swap after the class, and financing writes
    // it as `<%= car ? '' : 'hidden' %>` — so the word, not its surroundings,
    // is the signal.
    const nearby = view.slice(Math.max(0, at - 260), at + 260);
    assert.ok(
      /hidden/.test(nearby),
      `${leak.what}: the attribute must still be there — it is what hides it`,
    );

    // And the class really does set a display, which is why the rule is needed.
    const body = ruleFor(allCss(), `.${leak.className}`);
    assert.ok(
      declaration(body, 'display'),
      `${leak.what}: .${leak.className} no longer sets a display — if that is deliberate, this entry can go`,
    );
  }
});

test('plenty of markup depends on it, so it cannot be mistaken for dead code', () => {
  const views = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ejs')) views.push(fs.readFileSync(full, 'utf8'));
    }
  })(path.join(ROOT, 'views'));

  const shipping = views.reduce(
    (count, view) => count + [...view.matchAll(/<[a-z][^<>]*\shidden[\s>]/gi)].length,
    0,
  );
  assert.ok(shipping >= 15, `expected the attribute across the templates, found ${shipping}`);
});
