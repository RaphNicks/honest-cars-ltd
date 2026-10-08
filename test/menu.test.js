'use strict';

/**
 * The Services mega-menu, which used to close the moment anybody reached for it.
 *
 * Two independent causes, and both are pinned here:
 *
 *  1. Geometry. `.mega` is the trigger's box; `.mega__panel` was positioned
 *     `top: calc(100% + var(--space-1))`, leaving an 8px band that belongs to
 *     neither the trigger nor the panel. A pointer crossing it leaves `.mega`,
 *     which is what fired `mouseleave`. The panel now carries a bridge that
 *     covers exactly that band.
 *
 *  2. Timing. `mouseleave` closed the panel outright, so leaving the trigger
 *     sideways on the way to a panel wider than the trigger — or simply an
 *     unsteady hand — shut it too. Closing is now delayed and cancelled by
 *     coming back; the keyboard still closes at once.
 *
 * There is no layout engine here, so the bridge is verified as arithmetic read
 * out of the stylesheets, and the behaviour is verified by running the module
 * against a minimal DOM.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** The declarations inside the first rule whose selector matches. */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `no rule found for ${selector}`);
  return match[1];
}

/** The value of one declaration inside a rule. */
function declaration(block, property) {
  // A declaration may follow a `;`, a nested `}`, or the end of a comment.
  const match = block.match(new RegExp(`(?:^|[;}]|\\*/)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match ? match[1].trim() : null;
}

/** Resolve a token like var(--space-1) to the px value tokens.css gives it. */
function resolveLength(tokens, value) {
  const reference = value.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (!reference) return value;
  const declared = tokens.match(new RegExp(`(?:^|;|\\{)\\s*${reference[1]}\\s*:\\s*([^;]+)`, 'm'));
  assert.ok(declared, `${reference[1]} is not declared in tokens.css`);
  return declared[1].trim();
}

test('the panel is offset by exactly the gap the bridge fills', () => {
  const components = read('public/css/components.css');
  const tokens = read('public/css/tokens.css');

  const mega = rule(components, '.mega');
  const panel = rule(components, '.mega__panel');
  const bridge = rule(components, '.mega__panel::before');

  // The gap is named once, so the offset and the bridge cannot drift apart.
  const gap = declaration(mega, '--mega-gap');
  assert.ok(gap, '.mega must define --mega-gap');
  const gapPx = resolveLength(tokens, gap);
  assert.match(gapPx, /^\d+px$/, `--mega-gap must resolve to a length, got ${gapPx}`);
  assert.ok(parseFloat(gapPx) > 0, 'the gap must be a positive distance');

  // The panel sits the gap below the trigger…
  const top = declaration(panel, 'top');
  assert.ok(top, '.mega__panel must set top');
  assert.ok(top.includes('100%'), `the panel must hang from the trigger, got ${top}`);
  assert.ok(top.includes('--mega-gap'), `the panel's offset must be the named gap, got ${top}`);

  // …and the bridge covers precisely that distance above the panel, so the
  // pointer is never over neither element.
  const bridgeHeight = declaration(bridge, 'height');
  const bridgeTop = declaration(bridge, 'top');
  assert.equal(bridgeHeight, 'var(--mega-gap)', 'the bridge must be exactly the gap tall');
  assert.ok(bridgeTop.includes('--mega-gap') && bridgeTop.includes('-'), 'the bridge must sit above the panel by the gap');

  // It is absolutely positioned on purpose: .mega__panel is `display: grid`, and
  // an in-flow ::before would become a grid item and shift the two columns.
  assert.equal(declaration(bridge, 'position'), 'absolute', 'the bridge must be out of flow');
});

test('the panel still hides with the hidden attribute', () => {
  // `display: grid` beats the `hidden` attribute's default display, so this rule
  // is what makes `panel.hidden = true` actually hide anything.
  const components = read('public/css/components.css');
  const hidden = rule(components, '.mega__panel[hidden]');
  assert.match(declaration(hidden, 'display'), /none/);
});

test('the markup ships the panel hidden, which the toggle depends on', () => {
  // `panel.hidden` being truthy is "closed". If the template ever drops the
  // attribute the first click would close an already-hidden panel and the menu
  // would appear dead — so the attribute is part of the contract, not styling.
  const header = read('views/partials/header.ejs');
  const panel = header.match(/<div[^>]*data-mega-panel[^>]*>/);
  assert.ok(panel, 'the mega panel must be in the header partial');
  assert.match(panel[0], /\shidden(\s|>)/, `the panel must start hidden: ${panel[0]}`);

  // The anchor spans two lines and its href is an EJS expression, so match on
  // the text before the attribute rather than on a whole tag.
  const at = header.indexOf('data-mega-trigger');
  assert.ok(at > -1, 'the trigger must be in the header partial');
  const tagSoFar = header.slice(header.lastIndexOf('<a ', at), at);
  assert.match(tagSoFar, /aria-expanded="false"/, 'the trigger must start collapsed for screen readers');
});

// ---------------------------------------------------------------------------
// Behaviour, against a minimal DOM.
// ---------------------------------------------------------------------------

/** An element with only what initHeader touches. */
function element() {
  const listeners = new Map();
  return {
    hidden: undefined,
    attributes: {},
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    emit(type, event = {}) {
      // Enough of an event for header.js: it preventDefaults clicks and reads
      // relatedTarget on focusout.
      const full = { target: this, relatedTarget: null, preventDefault() {}, ...event };
      for (const handler of listeners.get(type) || []) handler(full);
      return full;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    contains() {
      return false;
    },
    querySelector(selector) {
      return this.parts?.[selector] ?? null;
    },
  };
}

/** Load public/js/header.js and run initHeader against stubs. */
async function withHeader(run, { hover = true } = {}) {
  const source = read('public/js/header.js');

  const trigger = element();
  const panel = element();
  // The real markup ships the panel `hidden`, and the toggle depends on that:
  // `panel.hidden` being falsy means "open". Verified in its own test below.
  panel.hidden = true;
  const mega = element();
  mega.parts = { '[data-mega-trigger]': trigger, '[data-mega-panel]': panel };

  const documentListeners = [];
  const document = {
    body: { dataset: {} },
    getElementById: () => null,
    querySelectorAll: (selector) => (selector === '[data-mega]' ? [mega] : []),
    querySelector: () => null,
    addEventListener: (type, handler) => documentListeners.push([type, handler]),
  };
  const window = {
    scrollY: 0,
    addEventListener() {},
    matchMedia: () => ({ matches: hover }),
  };

  // The module reads the globals, the way it does in a browser.
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = document;
  globalThis.window = window;

  try {
    // A data URL: the file is an ES module, but this package is CommonJS, so
    // Node would otherwise refuse to import it.
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    module.initHeader();
    return await run({
      mega,
      trigger,
      panel,
      keydown: (event) => {
        for (const [type, handler] of documentListeners) if (type === 'keydown') handler(event);
      },
    });
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a pointer crossing the gap keeps the menu open', async () => {
  await withHeader(async ({ mega, panel }) => {
    assert.equal(panel.hidden, true, 'the panel starts hidden, as the markup ships it');
    mega.emit('mouseenter');
    assert.equal(panel.hidden, false, 'entering the trigger opens it');

    // Crossing the gap is a mouseleave; the grace period is what saves it, and
    // the bridge in CSS is what usually stops the event happening at all.
    mega.emit('mouseleave');
    assert.equal(panel.hidden, false, 'it must not shut the instant the pointer leaves');
    await tick(90);
    assert.equal(panel.hidden, false, 'still open inside the grace period');

    // Coming back cancels the pending close.
    mega.emit('mouseenter');
    await tick(200);
    assert.equal(panel.hidden, false, 'returning must cancel the close');

    // Leaving for good does close it, just not instantly.
    mega.emit('mouseleave');
    await tick(220);
    assert.equal(panel.hidden, true, 'it closes once the pointer has gone for certain');
  });
});

test('a click toggles, and a second click shuts it', async () => {
  await withHeader(async ({ trigger, panel }) => {
    // The trigger is reachable without hover — a touch device, or a keyboard.
    trigger.emit('click');
    assert.equal(panel.hidden, false, 'a click opens it');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    trigger.emit('click');
    assert.equal(panel.hidden, true, 'a second click shuts it');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  });
});

test('the keyboard closes at once, with no grace period', async () => {
  await withHeader(async ({ mega, trigger, panel }) => {
    mega.emit('mouseenter');
    assert.equal(panel.hidden, false);

    // Tabbing away must not leave the panel hanging open behind the pointer.
    mega.emit('focusout', { relatedTarget: null });
    assert.equal(panel.hidden, true, 'leaving by keyboard closes immediately');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  });
});

test('Escape closes it immediately', async () => {
  await withHeader(async ({ mega, panel, keydown }) => {
    mega.emit('mouseenter');
    assert.equal(panel.hidden, false, 'open first');
    keydown({ key: 'Escape' });
    assert.equal(panel.hidden, true, 'Escape must not wait out the grace period');
  });
});

test('a device that cannot hover does not open on an emulated mouseenter', async () => {
  // A touchscreen fires mouseenter immediately before its click, so opening on
  // hover and toggling on click would open and shut in the same gesture.
  await withHeader(
    async ({ mega, trigger, panel }) => {
      mega.emit('mouseenter');
      assert.equal(panel.hidden, true, 'no hover, no hover-open');
      trigger.emit('click');
      assert.equal(panel.hidden, false, 'the tap opens it');
      trigger.emit('click');
      assert.equal(panel.hidden, true, 'and the next tap shuts it');
    },
    { hover: false },
  );
});
