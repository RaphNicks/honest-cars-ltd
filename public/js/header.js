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
  // Reveal-on-scroll-up / retreat-on-scroll-down needs hysteresis: momentum
  // scrolling fires direction flips every tick, and without a threshold the
  // nav starts rising and instantly reverses — it never settles. Only toggle
  // after the page has moved a real distance in one direction.
  const NAV_HYSTERESIS = 28;
  let anchorY = window.scrollY;
  let navVisible = false;

  const onScroll = () => {
    const y = window.scrollY;
    if (header) header.dataset.scrolled = y > 8 ? 'true' : 'false';

    if (bottomNav) {
      const moved = y - anchorY;
      let visible = navVisible;
      if (y <= 160) {
        visible = false; // top of page: bar stays away
      } else if (y <= 320) {
        visible = true; // just scrolled in: bar is up
      } else if (moved >= NAV_HYSTERESIS) {
        visible = false; // settled into scrolling down: retreat
      } else if (moved <= -NAV_HYSTERESIS) {
        visible = true; // settled into scrolling up: reveal
      }
      if (visible !== navVisible) anchorY = y;
      navVisible = visible;
      bottomNav.dataset.visible = visible ? 'true' : 'false';
      document.body.dataset.bottomNav = visible ? 'true' : 'false';
    }
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

  // Closing is delayed, and coming back cancels it. The panel is bridged so a
  // pointer can cross the gap between the trigger and the panel without
  // leaving the menu (see `.mega__panel::before`), but two things that bridge
  // cannot help with remain: leaving the trigger's box sideways on the way to
  // a panel that is wider than the trigger, and an unsteady hand. Opening
  // stays immediate, so the menu still feels attached to the pointer.
  //
  // A keyboard user has neither problem and no pointer to hold still, so
  // focusout and Escape close at once — a delayed close there would only read
  // as the menu refusing to go away.
  const CLOSE_DELAY_MS = 160;
  const closeTimers = new WeakMap();

  // Hover only where there is such a thing. A touchscreen fires an emulated
  // mouseenter just before its click, so opening on hover and toggling on click
  // would open and immediately shut again — the same "it vanishes as I reach for
  // it" complaint, on a tablet.
  const canHover = typeof window.matchMedia === 'function' ? window.matchMedia('(hover: hover)').matches : true;

  function cancelClose(mega) {
    const timer = closeTimers.get(mega);
    if (timer === undefined) return;
    clearTimeout(timer);
    closeTimers.delete(mega);
  }

  function closeMega(mega) {
    cancelClose(mega);
    mega.querySelector('[data-mega-trigger]')?.setAttribute('aria-expanded', 'false');
    const panel = mega.querySelector('[data-mega-panel]');
    if (panel) panel.hidden = true;
  }

  function closeMegaSoon(mega) {
    cancelClose(mega);
    closeTimers.set(
      mega,
      setTimeout(() => {
        closeTimers.delete(mega);
        closeMega(mega);
      }, CLOSE_DELAY_MS),
    );
  }

  function closeAllMegas(except) {
    megas.forEach((mega) => {
      if (mega === except) return;
      closeMega(mega);
    });
  }

  megas.forEach((mega) => {
    const trigger = mega.querySelector('[data-mega-trigger]');
    const panel = mega.querySelector('[data-mega-panel]');
    if (!trigger || !panel) return;

    const open = () => {
      cancelClose(mega);
      closeAllMegas(mega);
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      cancelClose(mega);
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };

    if (canHover) {
      mega.addEventListener('mouseenter', open);
      mega.addEventListener('mouseleave', () => closeMegaSoon(mega));
    }
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
