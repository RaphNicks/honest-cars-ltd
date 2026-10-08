/**
 * FR-32 — the area switcher: a national city picker with a search box.
 *
 * The links work without this file: "All cities" and the markets we operate are
 * ordinary `<a href>` in the HTML, and they are the only cities with stock to
 * show. What this adds is:
 *
 *   1. the rest of the catalogue, built from the JSON island in the panel, so
 *      forty-eight cities do not cost every page 10 KB of markup;
 *   2. the search that filters them;
 *   3. memory. A prebuilt static page is one HTML file for every visitor, so
 *      Node cannot label it with *your* market — the cookie can, and this is
 *      where the cookie is written when you pick one.
 *
 * The server does the same thing for server-rendered pages (it applies `hc_city`
 * to /cars when no ?city= is given), so the two never disagree: one cookie, read
 * the same way on both sides.
 *
 * A city with no lots is listed and searchable but **not** remembered. Storing
 * "Lagos" for a visitor who would then land on an empty grid on every future
 * visit is not the memory they asked for; the server applies the same rule, so
 * the two agree on that as well.
 */

const COOKIE = 'hc_city';
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const ALL = 'all';

function readCookie() {
  return document.cookie
    .split(';')
    .map((part) => part.trim().split('='))
    .filter(([name]) => name === COOKIE)
    .map(([, ...rest]) => {
      try {
        return decodeURIComponent(rest.join('='));
      } catch (error) {
        return '';
      }
    })[0] || '';
}

function writeCookie(slug) {
  document.cookie = `${COOKIE}=${encodeURIComponent(slug)}; max-age=${MAX_AGE_SECONDS}; path=/; samesite=lax`;
}

function clearCookie() {
  document.cookie = `${COOKIE}=; max-age=0; path=/; samesite=lax`;
}

/**
 * The catalogue island, or an empty list when the page has none. Read at
 * document level: it is rendered once per page by city-index.ejs and describes
 * the country, not the control — both switchers (header and drawer) use it.
 */
function readIndex() {
  const host = document.querySelector('[data-city-index]');
  if (!host) return [];
  try {
    const parsed = JSON.parse(host.textContent || '[]');
    return Array.isArray(parsed) ? parsed.filter((city) => city && city.slug && city.name) : [];
  } catch (error) {
    // A malformed island must not break the switcher: the server-rendered
    // markets are still there and still work.
    return [];
  }
}

/** One city as list markup, cloned from the template in the partial. */
function cityItem(switcher, city) {
  const template = switcher.querySelector('[data-area-item-template]');
  const fragment = template && template.content ? template.content.cloneNode(true) : null;
  if (!fragment) return null;

  const item = fragment.querySelector('[data-area-option]');
  item.setAttribute('href', `/cars?city=${encodeURIComponent(city.slug)}`);
  item.dataset.areaOption = city.slug;
  if (city.served) item.dataset.served = '1';

  const name = fragment.querySelector('[data-city-name]');
  if (name) name.textContent = city.name;
  const state = fragment.querySelector('[data-city-state]');
  if (state) state.textContent = city.stateLabel || '';
  const count = fragment.querySelector('[data-city-count]');
  if (count) count.textContent = String(Number(city.live) || 0);

  return fragment.firstElementChild;
}

/** Everything the panel needs to know about one switcher, kept in one place. */
function initSwitcher(switcher, remembered) {
  const toggle = switcher.querySelector('[data-area-toggle]');
  const panel = switcher.querySelector('[data-area-panel]');
  const label = switcher.querySelector('[data-area-label]');
  const list = switcher.querySelector('[data-area-list]');
  const search = switcher.querySelector('[data-area-search]');
  const status = switcher.querySelector('[data-area-status]');
  const empty = switcher.querySelector('[data-area-empty]');

  const index = readIndex();

  /** Every option link currently in the list, "All cities" included. */
  const options = () => Array.from(switcher.querySelectorAll('[data-area-option]'));

  /** Links that are not "All cities" — the cities themselves. */
  const cityOptions = () => options().filter((option) => option.dataset.areaOption !== ALL);

  function markCurrent(slug) {
    for (const option of options()) {
      const current = option.dataset.areaOption === slug;
      option.classList.toggle('is-current', current);
      if (current) option.setAttribute('aria-current', 'true');
      else option.removeAttribute('aria-current');
    }
  }

  /**
   * Build the full catalogue the first time the panel opens. Until then the
   * island is inert data; afterwards the list is the whole country, in the
   * order the server sorted it — deepest stock first.
   */
  let hydrated = false;
  function hydrate() {
    if (hydrated || !list || !index.length) return;
    hydrated = true;

    // The list's own rows only: "All cities" stays where it is, the rendered
    // markets give way to the full catalogue in the same order. Read from
    // `list.children` rather than from a document-wide query, so nothing
    // outside the list — the item template, in particular — is ever in scope.
    for (const row of Array.from(list.children)) {
      const option = row.querySelector('[data-area-option]');
      if (!option || option.dataset.areaOption !== ALL) row.remove();
    }
    for (const city of index) {
      const item = cityItem(switcher, city);
      if (item) list.append(item);
    }
  }

  /** Filter by city name or state. Empty query shows everything again. */
  function filter(query) {
    const needle = String(query || '').trim().toLowerCase();
    let shown = 0;
    for (const option of cityOptions()) {
      const text = `${option.textContent}`.toLowerCase().replace(/\s+/g, ' ');
      const match = !needle || text.includes(needle);
      option.closest('li').hidden = !match;
      if (match) shown += 1;
    }
    // "All cities" is a reset, not a city: it goes when you are looking for one.
    for (const option of options()) {
      if (option.dataset.areaOption !== ALL) continue;
      const row = option.closest('li');
      if (row) row.hidden = Boolean(needle);
    }
    if (!status) return;
    if (!needle) {
      status.textContent = '';
    } else if (shown === 0) {
      status.textContent = `No city matches “${String(query).trim()}”.`;
    } else {
      status.textContent = `${shown} ${shown === 1 ? 'city' : 'cities'} match “${String(query).trim()}”.`;
    }
    if (empty) empty.classList.toggle('hidden', shown !== 0 || !needle);
  }

  function open(openNow) {
    if (!toggle || !panel) return;
    toggle.setAttribute('aria-expanded', openNow ? 'true' : 'false');
    panel.hidden = !openNow;
  }

  const isOpen = () => Boolean(toggle) && toggle.getAttribute('aria-expanded') === 'true';

  // Label the control with the visitor's own market — unless the page already
  // named one (a city facet, or /cars filtered to a market). The server is the
  // better source there: it knows the page is about Owerri even when the
  // visitor's remembered market is Port Harcourt.
  if (remembered && label && !switcher.dataset.cityPinned) {
    const match = options().find((option) => option.dataset.areaOption === remembered);
    const name = match && match.querySelector('strong') ? match.querySelector('strong').textContent.trim() : '';
    if (name) {
      label.textContent = name;
      markCurrent(remembered);
    }
  }

  if (toggle && panel) {
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const next = !isOpen();
      open(next);
      if (next) {
        hydrate();
        // The search box is the reason the panel exists at this size, so it
        // takes the focus — and with it, the keyboard.
        if (search) search.focus({ preventScroll: true });
      }
    });

    document.addEventListener('click', (event) => {
      if (switcher.contains(event.target)) return;
      open(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !isOpen()) return;
      open(false);
    });
  }

  // Picking a market is what remembers it — the link itself carries ?city=.
  switcher.addEventListener('click', (event) => {
    const option = event.target.closest('[data-area-option]');
    if (!option) return;
    const slug = option.dataset.areaOption;
    if (!slug) return;
    if (slug === ALL) clearCookie();
    else if (option.dataset.served === '1') writeCookie(slug);
    // A city we have no lots in is a one-visit look: leave the remembered
    // market alone so the visitor is not stranded on an empty grid next visit.
  });

  if (search) {
    search.addEventListener('input', () => filter(search.value));
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && search.value) {
        // Clear first, close second — Escape should undo one thing at a time.
        event.stopPropagation();
        search.value = '';
        filter('');
        return;
      }
      if (event.key !== 'Enter') return;
      const first = cityOptions().find((option) => !option.closest('li').hidden);
      if (!first) return;
      event.preventDefault();
      window.location.assign(first.getAttribute('href'));
    });
  }
}

export function initAreaSwitcher() {
  const switchers = Array.from(document.querySelectorAll('[data-area-switcher]'));
  if (!switchers.length) return;

  const remembered = readCookie();
  for (const switcher of switchers) initSwitcher(switcher, remembered);
}
