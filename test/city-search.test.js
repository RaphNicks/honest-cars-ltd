'use strict';

/**
 * The city picker's behaviour, driven against a minimal DOM.
 *
 * There is no browser here, so the interesting promises are the ones a stub can
 * keep: the panel builds the country from the island (in the order the server
 * sorted it), the search filters by city *and* state, an empty query restores
 * the list, Escape undoes one thing at a time, Enter takes the first match — and
 * a city we have no lots in is never written to the visitor's cookie, because
 * the server applies the same rule and the two must not disagree.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { Element, TemplateElement } = require('./dom');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/area.js'), 'utf8');

// ---------------------------------------------------------------------------
// The page: one switcher, the catalogue island, and a cookie jar.
// ---------------------------------------------------------------------------

const ISLAND = [
  { slug: 'port-harcourt', name: 'Port Harcourt', stateLabel: 'Rivers State', live: 43, served: true },
  { slug: 'owerri', name: 'Owerri', stateLabel: 'Imo State', live: 7, served: true },
  { slug: 'aba', name: 'Aba', stateLabel: 'Abia State', live: 6, served: true },
  { slug: 'abuja', name: 'Abuja', stateLabel: 'FCT', live: 0, served: false },
  { slug: 'jos', name: 'Jos', stateLabel: 'Plateau State', live: 0, served: false },
  { slug: 'lagos', name: 'Lagos', stateLabel: 'Lagos State', live: 0, served: false },
];

function marketItem(slug, name, stateLabel, live) {
  const li = new Element('li');
  const link = new Element('a', { attrs: { href: `/cars?city=${slug}` }, className: 'area-switcher__item', dataset: { areaOption: slug, served: '1' } });
  const wrap = new Element('span');
  wrap.append(new Element('strong', { text: name }));
  wrap.append(new Element('span', { className: 'area-switcher__state', text: stateLabel }));
  link.append(wrap);
  link.append(new Element('span', { className: 'count', text: String(live) }));
  li.append(link);
  return li;
}

function buildPage({ cookie = '', pinned = false, island = null } = {}) {
  const document = new Element('html');
  const documentHandlers = new Map();

  // `data-city-index` as an attribute marker, the way the partial writes it.
  const islandHost = new Element('script', { attrs: { type: 'application/json' }, dataset: { cityIndex: '' } });
  islandHost.ownText = island === null ? JSON.stringify(ISLAND) : island;
  document.append(islandHost);

  const switcher = new Element('div', { dataset: { areaSwitcher: '' } });
  // The server named the market this page is about — js/area.js must not
  // overwrite that label from the cookie.
  if (pinned) switcher.dataset.cityPinned = '1';
  const toggle = new Element('button', { dataset: { areaToggle: '' }, attrs: { 'aria-expanded': 'false' } });
  const panel = new Element('div', { dataset: { areaPanel: '' } });
  panel.hidden = true;
  const label = new Element('span', { dataset: { areaLabel: '' }, text: 'All cities' });
  const search = new Element('input', { dataset: { areaSearch: '' } });
  const status = new Element('p', { dataset: { areaStatus: '' } });
  const empty = new Element('p', { className: 'hidden', dataset: { areaEmpty: '' } });
  const list = new Element('ul', { dataset: { areaList: '' } });

  const allRow = new Element('li');
  allRow.append(new Element('a', { attrs: { href: '/cars' }, className: 'area-switcher__item', dataset: { areaOption: 'all' } }));
  list.append(allRow);
  list.append(marketItem('port-harcourt', 'Port Harcourt', 'Rivers State', 43));
  list.append(marketItem('owerri', 'Owerri', 'Imo State', 7));

  const template = new TemplateElement('template', { dataset: { areaItemTemplate: '' } });
  const templateRow = new Element('li');
  const templateLink = new Element('a', { className: 'area-switcher__item', dataset: { areaOption: '' } });
  const templateWrap = new Element('span');
  templateWrap.append(new Element('strong', { dataset: { cityName: '' } }));
  templateWrap.append(new Element('span', { className: 'area-switcher__state', dataset: { cityState: '' } }));
  templateLink.append(templateWrap);
  templateLink.append(new Element('span', { className: 'count', dataset: { cityCount: '' } }));
  templateRow.append(templateLink);
  template.append(templateRow);

  panel.append(label);
  panel.append(search);
  panel.append(list);
  panel.append(status);
  panel.append(empty);
  panel.append(template);
  switcher.append(toggle);
  switcher.append(panel);
  document.append(switcher);

  const jar = { value: cookie, writes: [] };
  document.querySelectorAll = Element.prototype.querySelectorAll.bind(document);
  document.querySelector = Element.prototype.querySelector.bind(document);
  document.addEventListener = (type, handler) => {
    if (!documentHandlers.has(type)) documentHandlers.set(type, []);
    documentHandlers.get(type).push(handler);
  };
  Object.defineProperty(document, 'cookie', {
    get: () => jar.value,
    set: (value) => {
      jar.writes.push(value);
      jar.value = value;
    },
  });

  const navigations = [];
  const window = { location: { assign: (url) => navigations.push(url) } };

  return {
    document,
    window,
    jar,
    navigations,
    switcher,
    toggle,
    panel,
    label,
    list,
    search,
    status,
    empty,
    // A document-level event, as the module binds them (outside click, Escape).
    fire(type, event) {
      return (documentHandlers.get(type) || []).map((handler) => handler({ target: switcher, preventDefault() {}, ...event }));
    },
    open() {
      toggle.emit('click');
    },
    visible() {
      return list
        .querySelectorAll('[data-area-option]')
        .filter((option) => option.dataset.areaOption !== 'all')
        .filter((option) => !option.closest('li').hidden);
    },
    clickCity(slug) {
      const option = list.querySelectorAll('[data-area-option]').find((row) => row.dataset.areaOption === slug);
      assert.ok(option, `no option for ${slug}`);
      const event = option.emit('click');
      // The module binds one listener on the switcher, so the event has to
      // arrive there the way it would in a browser: through the ancestor.
      switcher.emit('click', { target: option, ...event });
      return option;
    },
  };
}

/** Load the module against the page, the way a browser would. */
async function withPage({ cookie = '', pinned = false, island = null } = {}, run) {
  const page = buildPage({ cookie, pinned, island });
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = page.document;
  globalThis.window = page.window;
  try {
    const module = await import(`data:text/javascript,${encodeURIComponent(SOURCE)}`);
    module.initAreaSwitcher();
    return await run(page);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
}

// ---------------------------------------------------------------------------

test('opening the panel builds the whole country, in the order the server sorted it', async () => {
  await withPage({}, (page) => {
    // Before opening: the server-rendered markets only, plus "All cities".
    assert.equal(page.list.querySelectorAll('[data-area-option]').length, 3);

    page.open();
    assert.equal(page.panel.hidden, false, 'the toggle opens the panel');
    assert.equal(page.search.focused, true, 'and the search box takes the focus');

    const slugs = page.visible().map((option) => option.dataset.areaOption);
    assert.deepEqual(slugs, ['port-harcourt', 'owerri', 'aba', 'abuja', 'jos', 'lagos'], 'island order, deepest stock first');
    assert.equal(page.visible()[0].textContent.includes('Rivers State'), true);

    // Opening again must not build it twice.
    page.open();
    page.open();
    assert.equal(page.list.querySelectorAll('[data-area-option]').length, 7, 'one All-cities row and six cities');
  });
});

test('the search filters by city name and by state, and clears again', async () => {
  await withPage({}, (page) => {
    page.open();

    page.search.ownText = '';
    page.search.value = 'lag';
    page.search.emit('input');
    assert.deepEqual(page.visible().map((option) => option.dataset.areaOption), ['lagos']);
    assert.equal(page.status.textContent, '1 city match “lag”.');

    // By state: “rivers” is nowhere in the city name.
    page.search.value = 'rivers';
    page.search.emit('input');
    assert.deepEqual(page.visible().map((option) => option.dataset.areaOption), ['port-harcourt']);

    // And the state label is searched as written, so the word “State” counts:
    // every city in the fixture but Abuja reads “<something> State”.
    page.search.value = 'state';
    page.search.emit('input');
    assert.equal(page.visible().length, 5, 'Abuja is the one that reads “FCT”');

    // The FCT is one city, and searching “fct” finds it — the label is what a
    // person reads, so it is what the search has to match.
    page.search.value = 'fct';
    page.search.emit('input');
    assert.deepEqual(page.visible().map((option) => option.dataset.areaOption), ['abuja']);

    page.search.value = 'PORT';
    page.search.emit('input');
    assert.deepEqual(page.visible().map((option) => option.dataset.areaOption), ['port-harcourt'], 'case is not a reason to fail');

    page.search.value = '';
    page.search.emit('input');
    assert.equal(page.visible().length, 6, 'clearing the box brings the country back');
    assert.equal(page.status.textContent, '');
  });
});

test('a search that matches nothing says so, and offers the concierge', async () => {
  await withPage({}, (page) => {
    page.open();
    page.search.value = 'atlantis';
    page.search.emit('input');

    assert.equal(page.visible().length, 0);
    assert.equal(page.status.textContent, 'No city matches “atlantis”.');
    assert.equal(page.empty.classList.contains('hidden'), false, 'and the “tell us what you want” line appears');

    page.search.value = 'lag';
    page.search.emit('input');
    assert.equal(page.empty.classList.contains('hidden'), true, 'and goes away again');
  });
});

test('Escape undoes one thing at a time, then closes the panel', async () => {
  await withPage({}, (page) => {
    page.open();
    page.search.value = 'jos';
    page.search.emit('input');
    assert.equal(page.visible().length, 1);

    // First Escape: clear the query, stay open.
    page.search.emit('keydown', { key: 'Escape' });
    assert.equal(page.search.value, '');
    assert.equal(page.visible().length, 6);
    assert.equal(page.panel.hidden, false, 'the panel is still open');

    // Second Escape — the one the module binds on the document: close.
    page.fire('keydown', { key: 'Escape' });
    assert.equal(page.panel.hidden, true);
  });
});

test('Enter takes the first city still showing', async () => {
  await withPage({}, (page) => {
    page.open();
    page.search.value = 'lag';
    page.search.emit('input');
    page.search.emit('keydown', { key: 'Enter' });
    assert.deepEqual(page.navigations, ['/cars?city=lagos']);
  });
});

test('picking a market is remembered; looking at a city we have no lots in is not', async () => {
  await withPage({}, (page) => {
    page.open();

    page.clickCity('owerri');
    assert.equal(page.jar.writes.at(-1), 'hc_city=owerri; max-age=7776000; path=/; samesite=lax');

    const before = page.jar.writes.length;
    page.clickCity('lagos');
    assert.equal(page.jar.writes.length, before, 'Lagos must not become the visitor’s remembered market');
  });
});

test('a remembered market labels the control, unless the page is about another one', async () => {
  await withPage({ cookie: 'hc_city=owerri' }, (page) => {
    assert.equal(page.label.textContent, 'Owerri');
    const current = page.list.querySelectorAll('[data-area-option]').find((option) => option.classList.contains('is-current'));
    assert.equal(current.dataset.areaOption, 'owerri', 'and the list marks it');
  });

  // On a market page the server has already named the market. The cookie must
  // not overrule it: a visitor browsing Owerri while remembering Port Harcourt
  // should read “Owerri” at the top of the page they are on.
  await withPage({ cookie: 'hc_city=port-harcourt', pinned: true }, (page) => {
    assert.equal(page.label.textContent, 'All cities', 'the server-rendered label stands');
    assert.equal(
      page.list.querySelectorAll('[data-area-option]').filter((option) => option.classList.contains('is-current')).length,
      0,
      'and nothing else is marked current',
    );
  });
});

test('a malformed island is ignored rather than thrown', async () => {
  // The catalogue arrives as generated data. If it is ever truncated or
  // corrupted, the picker must degrade to the server-rendered markets rather
  // than throw on open and leave a dead control behind.
  await withPage({ island: '{"slug":"lagos",' }, (page) => {
    page.open();
    assert.equal(page.panel.hidden, false, 'the panel still opens');
    assert.deepEqual(
      page.visible().map((option) => option.dataset.areaOption),
      ['port-harcourt', 'owerri'],
      'and still offers the markets the server rendered',
    );
  });

  // Well-formed JSON of the wrong shape is also ignored.
  await withPage({ island: '{"not":"a list"}' }, (page) => {
    page.open();
    assert.equal(page.visible().length, 2);
  });
});
