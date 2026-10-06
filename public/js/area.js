/**
 * FR-32 — the area switcher.
 *
 * The links work without this file: every market is a plain `<a href>`. What
 * the script adds is memory. A prebuilt static page is one HTML file for every
 * visitor, so Node cannot label it with *your* market — the cookie can, and this
 * is where the cookie is written when you pick one.
 *
 * The server does the same thing for server-rendered pages (it applies `hc_city`
 * to /cars when no ?city= is given), so the two never disagree: one cookie, read
 * the same way on both sides.
 */

const COOKIE = 'hc_city';
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

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

export function initAreaSwitcher() {
  const switchers = Array.from(document.querySelectorAll('[data-area-switcher]'));
  if (!switchers.length) return;

  const remembered = readCookie();

  for (const switcher of switchers) {
    const toggle = switcher.querySelector('[data-area-toggle]');
    const panel = switcher.querySelector('[data-area-panel]');
    const label = switcher.querySelector('[data-area-label]');
    const options = Array.from(switcher.querySelectorAll('[data-area-option]'));

    // Label the control with the visitor's own market unless the page already
    // named one (a city facet, or /cars filtered to a market — the server is
    // the better source there).
    if (remembered && label && !switcher.dataset.cityPinned) {
      const match = options.find((option) => option.dataset.areaOption === remembered);
      const name = match && match.querySelector('strong') ? match.querySelector('strong').textContent.trim() : '';
      if (name) {
        label.textContent = name;
        for (const option of options) {
          const current = option.dataset.areaOption === remembered;
          option.classList.toggle('is-current', current);
          if (current) option.setAttribute('aria-current', 'true');
          else option.removeAttribute('aria-current');
        }
      }
    }

    if (toggle && panel) {
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
      });

      document.addEventListener('click', (event) => {
        if (switcher.contains(event.target)) return;
        toggle.setAttribute('aria-expanded', 'false');
        panel.hidden = true;
      });

      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        toggle.setAttribute('aria-expanded', 'false');
        panel.hidden = true;
      });
    }

    // Picking a market is what remembers it — the link itself carries ?city=.
    for (const option of options) {
      option.addEventListener('click', () => {
        const slug = option.dataset.areaOption;
        if (!slug || slug === 'all') clearCookie();
        else writeCookie(slug);
      });
    }
  }
}
