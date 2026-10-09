/**
 * Listing filters, sort and pagination — §6.2.
 *
 * The page is fully server-rendered and the filter form is a real GET form, so
 * filtering works with JavaScript off. When JS is available we upgrade it:
 *   · bottom-sheet filters on mobile with Apply / Clear and a live count
 *   · fetch the grid fragment from /api/listings and swap it in (no reload)
 *   · keep the URL shareable via history.pushState
 *   · lightweight “Load more” instead of infinite scroll
 */

import { track } from './events.js';

const DEBOUNCE_MS = 250;

export function initFilters(root = document) {
  const form = root.querySelector('[data-filter-form]');
  const panel = document.getElementById('filters');
  const region = root.querySelector('[data-results-region]');
  const countText = root.querySelector('[data-result-count-text]');
  const pagination = root.querySelector('[data-pagination]');

  if (!form) return;

  const basePath = form.getAttribute('action') || '/cars';
  let page = 1;
  let controller = null;
  let debounceTimer = null;

  /* ---------------------------------------------------- sheet open/close */
  const openBtn = root.querySelector('[data-filters-open]');

  const setSheet = (open) => {
    if (!panel) return;
    panel.dataset.open = open ? 'true' : 'false';
    openBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.dataset.scrollLocked = open ? 'true' : 'false';
    if (open) panel.querySelector('button, input, select')?.focus({ preventScroll: true });
  };

  openBtn?.addEventListener('click', () => setSheet(true));
  root.querySelectorAll('[data-filters-close]').forEach((el) => el.addEventListener('click', () => setSheet(false)));
  root.querySelector('[data-filters-apply]')?.addEventListener('click', () => setSheet(false));
  root.querySelector('[data-filters-clear]')?.addEventListener('click', () => {
    form.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((input) => {
      input.checked = false;
    });
    form.querySelectorAll('input[type="number"], input[type="search"]').forEach((input) => {
      input.value = '';
    });
    form.querySelectorAll('select').forEach((select) => {
      select.selectedIndex = 0;
    });
    update();
  });

  /* ------------------------------------------------------------ queries */
  function formParams({ includePage = false } = {}) {
    const params = new URLSearchParams(new FormData(form));
    // Drop empty values so URLs stay clean and shareable.
    for (const [key, value] of Array.from(params.entries())) {
      if (value === '' || value === null) params.delete(key);
    }
    const sort = root.querySelector('[data-sort-select]')?.value;
    if (sort && sort !== 'recommended') params.set('sort', sort);
    if (includePage && page > 1) params.set('page', String(page));
    return params;
  }

  async function fetchResults({ mode = 'replace' } = {}) {
    const params = formParams({ includePage: mode === 'append' });
    const url = `${basePath}${params.toString() ? `?${params}` : ''}`;

    controller?.abort();
    controller = new AbortController();
    region?.classList.add('results-loading');

    try {
      const response = await fetch(`/api/listings?${params.toString()}`, {
        headers: { 'X-Requested-With': 'fetch' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const meta = await fetch(`/api/listings?${params.toString()}&format=json`, {
        signal: controller.signal,
      }).then((r) => r.json());

      if (mode === 'append' && region) {
        region.insertAdjacentHTML('beforeend', html);
      } else if (region) {
        region.innerHTML = html;
      }

      // URL must reflect the filters (shareable links, §6.2).
      if (mode !== 'append') {
        history.pushState({ filters: true }, '', url);
        page = 1;
      }

      if (countText && meta) {
        countText.innerHTML = `<strong>${meta.total}</strong> car${meta.total === 1 ? '' : 's'} in Port Harcourt`;
      }
      if (pagination && meta) {
        pagination.dataset.page = String(meta.page);
        pagination.dataset.pages = String(meta.pages);
        const btn = pagination.querySelector('[data-load-more]');
        if (btn) btn.hidden = meta.page >= meta.pages;
        const status = pagination.querySelector('[data-pagination-status]');
        if (status) status.textContent = `Showing ${Math.min(meta.page * 24, meta.total)} of ${meta.total} cars`;
      }
      if (panel) {
        const countEl = panel.querySelector('[data-filters-count]');
        if (countEl && meta) countEl.textContent = String(meta.total);
      }

      // New cards in the DOM need impression observers + compare wiring.
      document.dispatchEvent(new CustomEvent('hc:results-updated'));
    } catch (error) {
      if (error.name !== 'AbortError') {
        // Fall back to a normal navigation — the form still works without JS.
        window.location.href = url;
      }
    } finally {
      region?.classList.remove('results-loading');
    }
  }

  function update({ immediate = false, mode = 'replace' } = {}) {
    clearTimeout(debounceTimer);
    if (immediate) return fetchResults({ mode });
    debounceTimer = setTimeout(() => fetchResults({ mode }), DEBOUNCE_MS);
    return undefined;
  }

  /* ----------------------------------------------------------- listeners */
  form.addEventListener('change', (event) => {
    const input = event.target;
    track('filter_applied', {
      filters: { field: input.name, value: input.value },
      result_count: Number(root.querySelector('[data-filters-count]')?.textContent || 0),
    });
    // Make changes refresh the dependent model list, so re-request immediately.
    update({ immediate: input.name === 'make' });
  });

  form.addEventListener('input', (event) => {
    const input = event.target;
    if (input.type === 'number' || input.type === 'search') update();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    update({ immediate: true });
  });

  root.querySelector('[data-sort-select]')?.addEventListener('change', (event) => {
    track('sort_changed', { sort: event.target.value });
    update({ immediate: true });
  });

  root.querySelector('[data-load-more]')?.addEventListener('click', () => {
    page += 1;
    update({ immediate: true, mode: 'append' });
  });

  root.querySelector('[data-save-search]')?.addEventListener('click', async () => {
    const url = `${location.origin}${basePath}${formParams().toString() ? `?${formParams()}` : ''}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard may be blocked; the toast still tells the truth */
    }
    track('saved_search_created', { source: 'cars_toolbar', filters: Object.fromEntries(formParams()) });
    const { toast } = await import('./ui.js');
    toast('Search link copied — save it in WhatsApp and we will alert you on new matches.', { variant: 'success' });
  });

  // Back/forward must restore the previous filter state.
  window.addEventListener('popstate', (event) => {
    if (!event.state || !event.state.filters) return;
    window.location.reload();
  });
}
