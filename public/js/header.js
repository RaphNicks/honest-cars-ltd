/**
 * Header behaviour — §5.2 / §3.4.
 *  · ≤64px sticky header, soft shadow only after scroll
 *  · mobile drawer (full height, accordion Services) with focus handling
 *  · Services mega-menu (desktop, keyboard accessible)
 *  · collapse-on-scroll, reveal-on-scroll-up for the bottom nav
 */

export function initHeader() {
  const header = document.getElementById('site-header');
  const bottomNav = document.getElementById('bottom-nav');
  const drawer = document.getElementById('mobile-drawer');
  const searchPanel = document.getElementById('header-search');
  let lastY = window.scrollY;

  const onScroll = () => {
    const y = window.scrollY;
    if (header) header.dataset.scrolled = y > 8 ? 'true' : 'false';

    if (bottomNav) {
      // Appears after the first scroll; retreats while scrolling down on mobile.
      const visible = y > 160 && (y < lastY || y < 320);
      bottomNav.dataset.visible = visible ? 'true' : 'false';
      document.body.dataset.bottomNav = visible ? 'true' : 'false';
    }
    lastY = y;
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // --- mobile drawer -------------------------------------------------------
  const openBtn = document.querySelector('[data-drawer-open]');
  const closeBtn = document.querySelector('[data-drawer-close]');

  const setDrawer = (open) => {
    if (!drawer) return;
    drawer.dataset.open = open ? 'true' : 'false';
    if (openBtn) openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.dataset.scrollLocked = open ? 'true' : 'false';
    if (open) {
      const first = drawer.querySelector('button, a');
      if (first) first.focus({ preventScroll: true });
    } else if (openBtn) {
      openBtn.focus({ preventScroll: true });
    }
  };

  openBtn?.addEventListener('click', () => setDrawer(true));
  closeBtn?.addEventListener('click', () => setDrawer(false));
  drawer?.addEventListener('click', (event) => {
    if (event.target.closest('a[href]')) setDrawer(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (drawer?.dataset.open === 'true') setDrawer(false);
      closeAllMegas();
      if (searchPanel && !searchPanel.classList.contains('hidden')) toggleSearch(false);
    }
  });

  // --- mega-menu -----------------------------------------------------------
  const megas = Array.from(document.querySelectorAll('[data-mega]'));

  function closeAllMegas(except) {
    megas.forEach((mega) => {
      if (mega === except) return;
      mega.querySelector('[data-mega-trigger]')?.setAttribute('aria-expanded', 'false');
      const panel = mega.querySelector('[data-mega-panel]');
      if (panel) panel.hidden = true;
    });
  }

  megas.forEach((mega) => {
    const trigger = mega.querySelector('[data-mega-trigger]');
    const panel = mega.querySelector('[data-mega-panel]');
    if (!trigger || !panel) return;

    const open = () => {
      closeAllMegas(mega);
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };

    mega.addEventListener('mouseenter', open);
    mega.addEventListener('mouseleave', close);
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      if (panel.hidden) open();
      else close();
    });
    mega.addEventListener('focusout', (event) => {
      if (!mega.contains(event.relatedTarget)) close();
    });
  });

  // --- header search -------------------------------------------------------
  const searchToggle = document.querySelector('[data-search-toggle]');

  function toggleSearch(force) {
    if (!searchPanel) return;
    const open = typeof force === 'boolean' ? force : searchPanel.classList.contains('hidden');
    searchPanel.classList.toggle('hidden', !open);
    searchToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) searchPanel.querySelector('input')?.focus();
  }

  searchToggle?.addEventListener('click', () => toggleSearch());
}
