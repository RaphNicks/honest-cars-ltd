'use strict';

/**
 * §13.2 low-bandwidth + FR-24/§16 video.
 *
 * The features here all exist to save a visitor money on a metered connection,
 * which makes them easy to claim and easy to get wrong in a way nobody notices
 * until a bill arrives. So the tests are about the specific promises:
 *
 *   • a blur-up placeholder is in the HTML itself (not a second request), and
 *     there is one for every photo the site can render
 *   • `Save-Data: on` swaps to the small file and removes the srcset that would
 *     otherwise invite the browser to fetch the big one — and the client does the
 *     same for prebuilt static pages, where no server code runs
 *   • the client's reduce step can only ever touch site photos: a video poster or
 *     a dealer-hosted URL has no `-600` sibling, and rewriting one would turn a
 *     working image into a 404
 *   • a video states its duration and size before anything is fetched, and no
 *     `<video>` (or `.mp4` request) exists in the HTML until the visitor taps
 *   • the manifest that supplies those numbers matches the files on disk
 *
 * No database is needed for most of this; the two rendering assertions start the
 * test server so they check the real HTML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { dbAvailable, startTestServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
let available = false;
let ctx;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const locals = require('../src/lib/locals');
const { wantsLessData } = require('../src/lib/respond');

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  ctx = await startTestServer();
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (available) await require('../src/db').pool.end();
});

/**
 * Node 22 exposes `navigator` (and `location`) as getters, so `global.navigator =
 * …` throws. The client module must be loaded against its own globals, so they
 * are replaced with a configurable property and put back afterwards.
 */
function setGlobal(name, value) {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(globalThis, name, had);
    else delete globalThis[name];
  };
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

test('every photo has a blur-up placeholder, and it is small enough to inline', () => {
  const manifest = require('../src/lib/image-blur.json');
  const keys = Object.keys(manifest);
  assert.ok(keys.length >= 40, `expected the photo set, got ${keys.length}`);

  for (const key of keys) {
    assert.match(key, /^\/img\/(cars|details|site|blog|shop|hire)\/[\w-]+\.jpg$/, `${key} is not a site photo path`);
    const uri = manifest[key];
    assert.match(uri, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/, `${key} is not an inline WebP`);
    // The whole point is that these are cheap: at 20px wide a placeholder that
    // is not a few hundred bytes is a bug, not a placeholder.
    assert.ok(uri.length < 600, `${key} placeholder is ${uri.length} chars — too big to inline`);
  }

  // ...and every photo file on disk is in it, so a new photo cannot silently
  // ship without one.
  for (const group of ['cars', 'details', 'site', 'blog', 'shop', 'hire']) {
    const dir = path.join(ROOT, 'public', 'img', group);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.jpg') || entry.includes('-600.')) continue;
      assert.ok(manifest[`/img/${group}/${entry}`], `/img/${group}/${entry} has no placeholder`);
    }
  }
});

test('a placeholder is returned for a photo and never for anything else', () => {
  assert.match(locals.blurFor('/img/cars/honda-crv-silver.jpg'), /^data:image\/webp/);
  assert.equal(locals.blurFor('/video/odometer-check-poster.jpg'), null, 'a poster is not a photo');
  assert.equal(locals.blurFor('https://dealer.example/car.jpg'), null);
  assert.equal(locals.blurFor(null), null);
});

// ---------------------------------------------------------------------------
// Save-Data
// ---------------------------------------------------------------------------

test('Save-Data is read from the header, and only when it says on', () => {
  const req = (value) => ({ get: (name) => (name === 'save-data' ? value : undefined) });
  assert.equal(wantsLessData(req('on')), true);
  assert.equal(wantsLessData(req('ON')), true);
  assert.equal(wantsLessData(req('off')), false);
  assert.equal(wantsLessData(req(undefined)), false);
});

test('the server hands a Save-Data visitor the small file and no srcset', () => {
  const url = '/img/cars/honda-crv-silver.jpg';

  // Normal: both files offered, browser decides.
  assert.equal(locals.srcsetFor(url), '/img/cars/honda-crv-silver-600.jpg 600w, /img/cars/honda-crv-silver.jpg 1200w');
  assert.equal(locals.photoSrc(url), url);

  // Save-Data: one file, the small one — and no srcset offering the big one.
  assert.equal(locals.srcsetFor(url, { saveData: true }), null);
  assert.equal(locals.photoSrc(url, { saveData: true }), '/img/cars/honda-crv-silver-600.jpg');

  // The helpers the views actually call carry the flag.
  const helper = locals.helpers({ saveData: true });
  assert.equal(helper.saveData, true);
  assert.equal(helper.srcsetFor(url), null);
  assert.equal(helper.photoSrc(url), '/img/cars/honda-crv-silver-600.jpg');
});

// ---------------------------------------------------------------------------
// The client half
// ---------------------------------------------------------------------------

/** Load the shipped client module with just enough DOM to run it. */
async function loadEventsModule({ url = 'https://honestcarsltd.com/cars', saveData = false, connection } = {}) {
  const listeners = [];
  const frames = [];

  const restore = [
    setGlobal('window', {
      HonestCars: { config: { source: 'web', saveData }, eventNames: ['listing_view'] },
      addEventListener: () => {},
    }),
    setGlobal('navigator', connection === undefined ? { sendBeacon: undefined } : { connection, sendBeacon: undefined }),
    setGlobal('location', new URL(url)),
    setGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }),
    setGlobal('document', {
      addEventListener: () => {},
      querySelectorAll: (selector) => (selector.includes('data-blur-img') ? frames : []),
      querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    }),
  ];

  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'events.js'), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`);
  return { module, frames, listeners, restore: () => restore.forEach((undo) => undo()) };
}

test('the client reduces photos only when it was asked to, and only real photos', async () => {
  const images = [
    { src: '/img/cars/honda-crv-silver.jpg', srcset: 'x', dataset: {},
      getAttribute() { return this.src; }, setAttribute(k, v) { if (k === 'src') this.src = v; }, removeAttribute(k) { if (k === 'srcset') this.srcset = null; } },
    { src: '/video/odometer-check-poster.jpg', srcset: 'y', dataset: {},
      getAttribute() { return this.src; }, setAttribute(k, v) { if (k === 'src') this.src = v; }, removeAttribute(k) { if (k === 'srcset') this.srcset = null; } },
  ];
  const root = { querySelectorAll: () => images };

  // Not asked: nothing is touched.
  const off = await loadEventsModule({ saveData: false });
  assert.equal(off.module.applySaveData(root), false);
  assert.equal(images[0].src, '/img/cars/honda-crv-silver.jpg');
  assert.equal(images[0].srcset, 'x', 'srcset survives when data is not a concern');

  // Asked (via the header flag): photos drop to the small file...
  const on = await loadEventsModule({ saveData: true });
  assert.equal(on.module.applySaveData(root), true);
  assert.equal(images[0].src, '/img/cars/honda-crv-silver-600.jpg');
  assert.equal(images[0].srcset, null, 'and the srcset that would fetch the big one is gone');

  // ...and a URL with no small sibling is left exactly as it was, because
  // rewriting it would replace a working image with a 404.
  assert.equal(images[1].src, '/video/odometer-check-poster.jpg');
  assert.equal(images[1].srcset, 'y');
});

test('a prebuilt page can still detect Save-Data — the browser is the only signal there', async () => {
  // The inline config says false (the page was built to disk before the request),
  // so the decision has to come from navigator.connection.
  const slow = await loadEventsModule({ saveData: false, connection: { saveData: true } });
  assert.equal(slow.module.saveData(), true);

  const fast = await loadEventsModule({ saveData: false, connection: { saveData: false } });
  assert.equal(fast.module.saveData(), false);

  // Browsers without the API (Safari, Firefox) must not throw.
  const unknown = await loadEventsModule({ saveData: false, connection: undefined });
  assert.equal(unknown.module.saveData(), false);
});

test('blur-up holds the photo back and reveals it on load, or on failure', async () => {
  const makeImage = () => {
    const handlers = {};
    // A real classList, because the test asserts on what the module toggled.
    const classList = {
      blurred: false,
      add() {
        this.blurred = true;
      },
      remove() {
        this.blurred = false;
      },
    };
    return {
      complete: false,
      naturalWidth: 1200,
      dataset: {},
      classList,
      parentElement: { classList },
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
      fire: (type) => handlers[type] && handlers[type](),
    };
  };

  const first = makeImage();
  const second = makeImage();
  const { module } = await loadEventsModule({});
  module.initBlurUp({ querySelectorAll: () => [first, second] });

  // Both frames are in blur state until their photo says something.
  assert.equal(first.classList.blurred, true);
  first.fire('load');
  assert.equal(first.classList.blurred, false, 'a loaded photo reveals the frame');
  assert.equal(first.dataset.hcLoaded, 'done');
  assert.equal(second.classList.blurred, true, 'the other one is untouched');

  // A broken photo must reveal too: a permanent grey box is worse than a gap.
  second.fire('error');
  assert.equal(second.classList.blurred, false);
});

// ---------------------------------------------------------------------------
// Video — the label, and the promise that nothing loads before the tap
// ---------------------------------------------------------------------------

test('every clip states what it costs, and the number matches the file', () => {
  const manifest = require('../src/lib/video-manifest.json');
  const clips = Object.keys(manifest);
  assert.ok(clips.length >= 3, '§16 asks for at least three embedded videos');

  for (const src of clips) {
    const info = manifest[src];
    const file = path.join(ROOT, 'public', src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `${src} is in the manifest but not on disk`);
    assert.equal(fs.statSync(file).size, info.bytes, `${src} size in the manifest does not match the file`);

    // Real, small, silent H.264 (§13.2 is about data, and a data-conscious
    // visitor should not pay for a soundtrack on top of the picture).
    const buffer = fs.readFileSync(file);
    assert.equal(buffer.slice(4, 8).toString(), 'ftyp', `${src} is not an MP4 container`);
    assert.ok(buffer.includes(Buffer.from('avc1')), `${src} has no H.264 track`);
    assert.ok(!buffer.includes(Buffer.from('mp4a')), `${src} carries an audio track — bigger than it needs to be`);
    assert.ok(buffer.indexOf(Buffer.from('moov')) < buffer.indexOf(Buffer.from('mdat')), `${src} is not faststart`);
    assert.ok(info.bytes < 400_000, `${src} is ${Math.round(info.bytes / 1024)} KB — too heavy for a metered visitor`);

    assert.ok(info.seconds >= 5 && info.seconds <= 60, `${src} duration looks wrong`);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', info.poster.replace(/^\//, ''))), `${src} has no poster`);
  }
});

test('durations and sizes read the way a person says them', () => {
  assert.equal(locals.formatDuration(9), '0:09');
  assert.equal(locals.formatDuration(65), '1:05');
  assert.equal(locals.formatBytes(106_364), '106 KB');
  assert.equal(locals.formatBytes(243_775), '244 KB');
  assert.equal(locals.formatBytes(1_560_000), '1.6 MB');
});

maybe('a post with a video shows the cost and fetches nothing until it is pressed', async () => {
  const response = await fetch(`${ctx.baseUrl}/blog/odometer-fraud-check-yourself`);
  const html = await response.text();
  assert.equal(response.status, 200);

  assert.match(html, /data-video-facade/, 'the facade is what renders');
  assert.match(html, /video-facade__cost[^<]*(?:<[^>]+>)?\s*0:10 · 106 KB/, 'the button states duration and size');
  assert.equal(html.includes('<video'), false, 'no player element before the tap');
  // The only mention of the file is the link/attribute — a poster, not the clip.
  const clipMentions = html.split('.mp4').length - 1;
  assert.ok(clipMentions <= 2, `the .mp4 appears ${clipMentions} times — is something prefetching it?`);
  assert.match(html, /odometer-check-poster\.jpg/, 'the poster is what a visitor sees');
});

maybe('a listing with a video puts it in the gallery, not on the card', async () => {
  const db = require('../src/db');
  const row = await db.queryOne(
    `SELECT l.seo_slug FROM vehicle_listings l
      JOIN listing_media m ON m.listing_id = l.id AND m.type = 'video'
     LIMIT 1`,
  );
  if (!row) return; // a database seeded before §13.2 — the unit tests above still hold

  const response = await fetch(`${ctx.baseUrl}/cars/${row.seo_slug}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /gallery__thumb--video/, 'the video is a thumb in the gallery');
  assert.match(html, /data-video-seconds="\d+"/, 'and it carries its own cost');
  assert.equal(html.includes('<video'), false, 'nothing plays before the tap');

  // The card/hero image must still be a photograph: an <img src="…mp4"> is the
  // exact bug that appears the moment a listing has a video.
  const main = html.match(/<img class="gallery__img"[^>]*>/);
  assert.ok(main, 'the gallery main frame is an image');
  assert.equal(main[0].includes('.mp4'), false, 'the main frame never points at the clip');

  // ...and the listing renders the video poster as the thumb, from our own host.
  assert.match(html, /src="\/video\/[a-z-]+-poster\.jpg"/);
});

maybe('the blog lists eight posts and the video category has one', async () => {
  const db = require('../src/db');
  const counts = await db.query("SELECT category, COUNT(*) AS n FROM blog_posts WHERE status = 'published' GROUP BY category");
  const total = counts.reduce((sum, row) => sum + Number(row.n), 0);
  assert.ok(total >= 8, `§16 asks for 8 posts, found ${total}`);
  const video = counts.find((row) => row.category === 'video');
  assert.ok(video, 'FR-24 names video posts, so the category must have one');
});

// ---------------------------------------------------------------------------
// §13.2 — drafts and the outbox
// ---------------------------------------------------------------------------

/** A localStorage good enough to test against, with a real key/value contract. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map,
  };
}

/** A form element with just the parts the module uses. */
function fakeForm({ id = 'test-form', fields = [], chips = [] } = {}) {
  const listeners = {};
  const form = {
    id,
    dataset: {},
    elements: fields,
    querySelector: (selector) => (selector === '[data-draft-note]' ? null : null),
    querySelectorAll: (selector) => (selector === '[data-chip-group]' ? chips : []),
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch: (type) => (listeners[type] || []).forEach((fn) => fn({ type })),
    prepend: (node) => {
      form._note = node;
    },
  };
  return form;
}

/** Load drafts.js with its own window/localStorage, like the browser gives it. */
async function loadDraftsModule({ storage = fakeStorage(), created = [], listeners = {} } = {}) {
  const restore = [
    setGlobal('window', {
      localStorage: storage,
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (id) => clearTimeout(id),
      addEventListener: (type, fn) => {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      dispatchEvent: (event) => {
        (listeners[event.type] || []).forEach((fn) => fn(event));
      },
    }),
    setGlobal('navigator', { onLine: true }),
    setGlobal('document', {
      createElement: () => {
        const node = {
          className: '',
          textContent: '',
          children: [],
          setAttribute: () => {},
          append: (...kids) => node.children.push(...kids),
          remove: () => {
            node._removed = true;
          },
          addEventListener: (type, fn) => {
            if (type === 'click') node._click = fn;
          },
        };
        created.push(node);
        return node;
      },
    }),
  ];
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'drafts.js'), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`);
  return { module, storage, restore: () => restore.forEach((undo) => undo()) };
}

function textField(name, value = '') {
  return { name, type: 'text', tagName: 'INPUT', value, checked: false };
}

test('a draft holds what was typed, and only for a week', async () => {
  const storage = fakeStorage();
  const { module, restore } = await loadDraftsModule({ storage });
  try {
    const form = fakeForm({ fields: [textField('name', 'Ada'), textField('phone', '08031234567')] });
    module.clearDraft(form);
    window.localStorage.setItem(`hc_draft:${form.id}`, JSON.stringify({ at: Date.now(), values: { name: 'Ada', phone: '0803' } }));
    const draft = module.readDraft(form);
    assert.equal(draft.values.name, 'Ada');

    // Eight days later it is gone: a half-finished brief surfacing unasked is
    // worse than an empty form.
    window.localStorage.setItem(`hc_draft:${form.id}`, JSON.stringify({ at: Date.now() - 8 * 86_400_000, values: { name: 'Ada' } }));
    assert.equal(module.readDraft(form), null);
    assert.equal(window.localStorage.getItem(`hc_draft:${form.id}`), null, 'and the stale draft is deleted');
  } finally {
    restore();
  }
});

test('the outbox holds a failed send, then empties when the connection is back', async () => {
  const storage = fakeStorage();
  const { module, restore } = await loadDraftsModule({ storage });
  const realFetch = global.fetch;
  try {
    assert.equal(module.queuedCount(), 0);

    // Offline: the enquiry is kept, and the visitor is told it is waiting.
    global.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const failed = await module.sendOrQueue('/api/leads', { name: 'Ada', phone: '08031234567' });
    assert.equal(failed.ok, false);
    assert.equal(failed.queued, true);
    assert.match(failed.error, /kept this on your device/);
    assert.equal(module.queuedCount(), 1);
    assert.equal(window.localStorage.getItem('hc_outbox') !== null, true);

    // Back online: it goes out, and the outbox is empty again.
    const sent = [];
    global.fetch = async (endpoint, options) => {
      sent.push({ endpoint, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, leadId: 7 }) };
    };
    const flushed = await module.flushOutbox();
    assert.equal(flushed.sent, 1);
    assert.equal(flushed.left, 0);
    assert.equal(module.queuedCount(), 0);
    assert.equal(window.localStorage.getItem('hc_outbox'), null, 'nothing is left behind');
    assert.equal(sent[0].endpoint, '/api/leads');
    assert.equal(sent[0].body.phone, '08031234567');
  } finally {
    global.fetch = realFetch;
    restore();
  }
});

test('a refusal from the server is never queued — only a lost connection is', async () => {
  const storage = fakeStorage();
  const { module, restore } = await loadDraftsModule({ storage });
  const realFetch = global.fetch;
  try {
    // 422: the server understood and said no. Retrying later would be wrong.
    global.fetch = async () => ({ ok: false, status: 422, json: async () => ({ ok: false, error: 'That phone number does not look right.' }) });
    const refused = await module.sendOrQueue('/api/leads', { phone: 'abc' });
    assert.equal(refused.ok, false);
    assert.equal(refused.queued, undefined);
    assert.match(refused.error, /phone number/);
    assert.equal(module.queuedCount(), 0, 'a refusal is final, not held');

    // 500: our fault, not theirs — held, and said so.
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) });
    const broke = await module.sendOrQueue('/api/leads', { phone: '08031234567' });
    assert.equal(broke.queued, true);
    assert.equal(module.queuedCount(), 1);
  } finally {
    global.fetch = realFetch;
    restore();
  }
});

test('a form opts itself in with data-draft, and the note offers a choice', async () => {
  const storage = fakeStorage();
  const created = [];
  const { module, restore } = await loadDraftsModule({ storage, created });
  try {
    const form = fakeForm({ id: 'service-inspection', fields: [textField('name', '')] });
    form.dataset.draft = 'service-inspection';
    window.localStorage.setItem('hc_draft:service-inspection', JSON.stringify({ at: Date.now() - 300_000, values: { name: 'Ada' } }));

    module.initFormDrafts({ querySelectorAll: () => [form] });
    assert.ok(form._note, 'the resume note is offered above the form');

    // It fades in the old values only when the visitor asks for them.
    const [resume] = form._note.children;
    assert.equal(resume.textContent, 'Fill it back in');
    assert.equal(form.elements[0].value, '', 'nothing is filled in until the visitor chooses');
    resume._click();
    assert.equal(form.elements[0].value, 'Ada', 'and then it is');
    assert.equal(form._note._removed, true, 'and the note goes away once it has been used');
  } finally {
    restore();
  }
});

test('the §13.2 payload keys get past the allowlist that silently drops the rest', () => {
  const { sanitizePayload } = require('../src/services/events');
  const kept = sanitizePayload({
    save_data: true,
    blur_up: true,
    video_duration: 12,
    video_size: 243_775,
    source: 'video_facade',
    // ...and the reason the allowlist exists: a phone number in a payload.
    phone: '08031234567',
    email: 'ada@example.com',
  });
  assert.equal(kept.save_data, true);
  assert.equal(kept.blur_up, true);
  assert.equal(kept.video_duration, 12);
  assert.equal(kept.video_size, 243_775);
  assert.equal(kept.phone, undefined, 'no PII in analytics (§12.2)');
  assert.equal(kept.email, undefined);
});

test('the outbox sends itself when the connection comes back', async () => {
  const storage = fakeStorage();
  const listeners = {};
  const { module, restore } = await loadDraftsModule({ storage, listeners });
  const realFetch = global.fetch;
  try {
    // Nothing reaches the network at first, so the enquiry is held.
    global.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    module.initOutbox();
    await module.sendOrQueue('/api/leads', { name: 'Ada' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(module.queuedCount(), 1, 'still waiting');

    // The connection comes back.
    const sent = [];
    global.fetch = async (endpoint) => {
      sent.push(endpoint);
      return { ok: true, status: 200, json: async () => ({ ok: true, leadId: 1 }) };
    };
    assert.ok(listeners.online, 'the boot wires an online listener');
    listeners.online.forEach((fn) => fn({ type: 'online' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(sent, ['/api/leads']);
    assert.equal(module.queuedCount(), 0, 'and the outbox is empty afterwards');
  } finally {
    global.fetch = realFetch;
    restore();
  }
});
