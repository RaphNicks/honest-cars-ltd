'use strict';

/**
 * Regression for the 2026-10-09 report: picking a gallery thumbnail moved the
 * aria-current ring but the main photo never changed, because the browser
 * selects from `srcset` before it looks at `src`. The gallery must rebuild the
 * srcset from the picked photo, or drop it when no small sibling exists.
 *
 * Runs the real public/js/ui.js (and its real events.js import) against the
 * dom stub, the way a browser would click.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Element } = require('./dom');

const ROOT = path.join(__dirname, '..');

/**
 * ui.js imports events.js, and a data: URL cannot resolve that — so splice the
 * real events.js (exports stripped) in front of the real ui.js (import line
 * stripped) and load the pair as one ES module, exactly as shipped.
 */
function moduleSource() {
  const events = fs
    .readFileSync(path.join(ROOT, 'public', 'js', 'events.js'), 'utf8')
    .replace(/^export /gm, '');
  const ui = fs
    .readFileSync(path.join(ROOT, 'public', 'js', 'ui.js'), 'utf8')
    .replace(/^import \{[^}]*\} from '\.\/events\.js';\n/m, '');
  return `${events}\n${ui}`;
}

function makeWindow() {
  return {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    location: new URL('http://localhost/'),
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
}

function buildPage() {
  const section = new Element('section', { dataset: { gallery: '' } });
  const frame = new Element('div', { className: 'media-blur' });
  const main = new Element('img', {
    attrs: {
      src: '/img/cars/toyota-corolla-white.jpg',
      srcset: '/img/cars/toyota-corolla-white-600.jpg 600w, /img/cars/toyota-corolla-white.jpg 1200w',
      sizes: '(min-width: 1024px) 720px, 92vw',
    },
    dataset: { galleryMain: '', blurImg: '' },
  });
  frame.append(main);
  section.append(frame);

  const thumbs = new Element('div', { dataset: {} });
  const first = new Element('button', {
    dataset: { galleryThumb: '', src: '/img/cars/toyota-corolla-white.jpg', alt: 'front' },
  });
  const second = new Element('button', {
    dataset: { galleryThumb: '', src: '/img/details/interior.jpg', alt: 'interior' },
  });
  const orphan = new Element('button', {
    dataset: { galleryThumb: '', src: '/img/external/scan.jpg', alt: 'no sibling' },
  });
  thumbs.append(first);
  thumbs.append(second);
  thumbs.append(orphan);
  section.append(thumbs);

  const page = new Element('html');
  page.append(section);
  return { page, main, first, second, orphan };
}

async function withPage(run) {
  const built = buildPage();
  const saved = { document: globalThis.document, window: globalThis.window, location: globalThis.location };
  globalThis.document = built.page;
  globalThis.window = makeWindow();
  globalThis.location = new URL('http://localhost/');
  try {
    const encoded = Buffer.from(moduleSource()).toString('base64');
    const module = await import(`data:text/javascript;base64,${encoded}#${Date.now()}`);
    module.initGallery();
    return await run(built);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.location = saved.location;
  }
}

test('picking a thumb swaps the main photo AND its srcset', async () => {
  await withPage(({ main, second }) => {
    second.emit('click');
    assert.equal(main.src, '/img/details/interior.jpg', 'the picked photo must become the main src');
    assert.equal(
      main.getAttribute('srcset'),
      '/img/details/interior-600.jpg 600w, /img/details/interior.jpg 1200w',
      'the srcset must follow the picked photo, or the browser keeps showing the first one',
    );
    assert.ok(!String(main.getAttribute('srcset')).includes('toyota-corolla'), 'the first photo must not linger in the srcset');
    assert.equal(second.getAttribute('aria-current'), 'true');
  });
});

test('a photo without a 60 sibling drops the srcset instead of keeping a stale one', async () => {
  await withPage(({ main, orphan }) => {
    orphan.emit('click');
    assert.equal(main.src, '/img/external/scan.jpg');
    assert.equal(main.getAttribute('srcset'), null, 'no small sibling means no srcset at all');
  });
});
