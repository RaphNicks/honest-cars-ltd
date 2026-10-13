/**
 * Shared UI primitives: tabs, accordions, grade tooltips, toasts, copy-link,
 * the WhatsApp float, and the VDP gallery.
 * All vanilla, all progressive — every one of these works without JavaScript,
 * this file just makes them feel fast.
 */

import { track, smallSrc } from './events.js';

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ tabs */
export function initTabs(root = document) {
  const groups = root.querySelectorAll('[data-feed-tab]');
  if (!groups.length) return;

  groups.forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.feedTab;
      const list = tab.closest('.section') || document;
      list.querySelectorAll('[data-feed-tab]').forEach((other) => {
        other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
      });
      list.querySelectorAll('[data-feed-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.feedPanel !== key;
      });
      track('filter_applied', { source: 'home_feed_tab', filters: { tab: key } });
    });
  });
}

/* ------------------------------------------------------------- accordions */
export function initAccordions(root = document) {
  root.querySelectorAll('[data-accordion]').forEach((accordion) => {
    accordion.querySelectorAll('.accordion__button').forEach((button) => {
      button.addEventListener('click', () => {
        const expanded = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        const panel = document.getElementById(button.getAttribute('aria-controls'));
        if (panel) panel.hidden = expanded;
      });
    });
  });
}

/* ------------------------------------------- grade tooltips (§3.5) */
export function initInfoTips(root = document) {
  const tips = root.querySelectorAll('.info-tip');

  const closeAll = (except) => {
    tips.forEach((tip) => {
      if (tip === except) return;
      tip.querySelector('[data-tip-panel]')?.setAttribute('hidden', '');
      tip.querySelector('[data-tip-toggle]')?.setAttribute('aria-expanded', 'false');
    });
  };

  tips.forEach((tip) => {
    const button = tip.querySelector('[data-tip-toggle]');
    const panel = tip.querySelector('[data-tip-panel]');
    if (!button || !panel) return;

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = !panel.hidden;
      closeAll(tip);
      panel.hidden = isOpen;
      button.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    });

    tip.addEventListener('mouseenter', () => {
      if (window.matchMedia('(hover: hover)').matches) panel.hidden = false;
    });
    tip.addEventListener('mouseleave', () => {
      if (window.matchMedia('(hover: hover)').matches) panel.hidden = true;
    });
  });

  document.addEventListener('click', () => closeAll());
}

/* -------------------------------------------------------------- toasts */
let toastTimer = null;

export function toast(message, { variant = '', duration = 4000 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast${variant ? ` toast--${variant}` : ''}`;
  el.dataset.open = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.open = 'false';
  }, duration);
}

/* ------------------------------------------------------------- print */
/**
 * Print buttons on receipts and inspection reports. A real print stylesheet
 * does the work; this only saves the customer from hunting the browser menu.
 */
export function initPrintButtons(root = document) {
  root.querySelectorAll('[data-print]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });
}

/* --------------------------------------------------------- copy-link */
export function initCopyLink(root = document) {
  root.querySelectorAll('[data-copy-link]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        toast('Link copied — paste it in WhatsApp.', { variant: 'success' });
      } catch {
        toast('Copy failed. Long-press the address bar instead.');
      }
    });
  });
}

/* ------------------------------------------------- floating WhatsApp */
export function initWhatsappFloat() {
  const float = document.getElementById('whatsapp-float');
  if (!float) return;
  // Collapse to the icon once the bottom bar is on screen so nothing overlaps.
  const observer = new MutationObserver(() => {
    const navVisible = document.body.dataset.bottomNav === 'true';
    float.dataset.collapsed = navVisible || window.scrollY > 900 ? 'true' : 'false';
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-bottom-nav'] });
  window.addEventListener(
    'scroll',
    () => {
      float.dataset.collapsed = window.scrollY > 900 ? 'true' : 'false';
    },
    { passive: true },
  );
}

/* ------------------------------------------------------------- gallery */
export function initGallery(root = document) {
  const gallery = root.querySelector('[data-gallery]');
  if (!gallery) return;

  const main = gallery.querySelector('[data-gallery-main]');
  const thumbs = Array.from(gallery.querySelectorAll('[data-gallery-thumb]'));
  if (!main || !thumbs.length) return;

  let engaged = false;
  const videoThumb = gallery.querySelector('[data-gallery-video]');

  const engage = () => {
    if (engaged) return;
    engaged = true;
    track('gallery_engaged', { source: 'vdp_gallery', value: thumbs.length });
  };

  const show = (thumb) => {
    main.src = thumb.dataset.src;
    // The browser picks from srcset before it ever looks at src: leaving the
    // first photo's srcset in place is why a picked thumb never showed
    // (reported 2026-10-09). Rebuild it from the picked photo's 600 sibling.
    const small = smallSrc(thumb.dataset.src);
    if (small === thumb.dataset.src) {
      main.removeAttribute('srcset');
    } else {
      main.setAttribute('srcset', `${small} 600w, ${thumb.dataset.src} 1200w`);
    }
    main.alt = thumb.dataset.alt || main.alt;
    main.parentElement.classList.remove('hc-blur');
    main.style.removeProperty('display');
    // A photo was picked after the video: put the picture back where it was.
    gallery.querySelector('.video-facade')?.remove();
    thumbs.forEach((other) => other.setAttribute('aria-current', other === thumb ? 'true' : 'false'));
    if (videoThumb) videoThumb.setAttribute('aria-current', 'false');
    engage();
  };

  thumbs.forEach((thumb) => thumb.addEventListener('click', () => show(thumb)));

  /**
   * FR-24 — the video in the gallery is tap-to-load like every other video
   * (§13.2): nothing is fetched until this button is pressed, and the label in
   * the accessible name states the duration and size first.
   */
  videoThumb?.addEventListener('click', () => {
    const src = videoThumb.dataset.videoSrc;
    if (!src) return;
    thumbs.forEach((other) => other.setAttribute('aria-current', 'false'));
    videoThumb.setAttribute('aria-current', 'true');
    engage();
    track('gallery_engaged', {
      source: 'vdp_video',
      value: 0,
      video_duration: Number(videoThumb.dataset.videoSeconds) || undefined,
      video_size: Number(videoThumb.dataset.videoBytes) || undefined,
    });

    const facade = document.createElement('div');
    facade.className = 'video-facade';
    facade.dataset.videoFacade = '';
    const frame = document.createElement('div');
    frame.className = 'video-facade__frame';
    const video = document.createElement('video');
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.poster = videoThumb.dataset.videoPoster || '';
    frame.appendChild(video);
    facade.appendChild(frame);

    // The video takes the main frame's place; the photo returns when a thumb is
    // pressed, so nothing is lost by trying it.
    main.style.display = 'none';
    main.parentElement.after(facade);
    video.play().catch(() => {
      /* controls are visible; a blocked autoplay is not a failure */
    });
  });

  // Keyboard: left/right arrows move between photos.
  gallery.addEventListener('keydown', (event) => {
    const current = thumbs.findIndex((thumb) => thumb.getAttribute('aria-current') === 'true');
    if (current < 0) return;
    if (event.key === 'ArrowRight') show(thumbs[Math.min(thumbs.length - 1, current + 1)]);
    if (event.key === 'ArrowLeft') show(thumbs[Math.max(0, current - 1)]);
  });

  // Swipe on the main image (native pinch-zoom still works).
  let startX = null;
  main.addEventListener(
    'touchstart',
    (event) => {
      startX = event.touches[0].clientX;
    },
    { passive: true },
  );
  main.addEventListener(
    'touchend',
    (event) => {
      if (startX === null) return;
      const delta = event.changedTouches[0].clientX - startX;
      startX = null;
      if (Math.abs(delta) < 40) return;
      const current = thumbs.findIndex((thumb) => thumb.getAttribute('aria-current') === 'true');
      const next = delta < 0 ? Math.min(thumbs.length - 1, current + 1) : Math.max(0, current - 1);
      if (next !== current) show(thumbs[next]);
    },
    { passive: true },
  );

  if (!prefersReducedMotion) {
    // Reserve nothing: we simply keep the first image eager so LCP is the photo.
    main.loading = 'eager';
  }
}

/* --------------------------------------------- compare selection (§6.4) */
const COMPARE_KEY = 'hc_compare';

export function getCompareIds() {
  try {
    return JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]').map(String);
  } catch {
    return [];
  }
}

export function initCompare(root = document) {
  const ids = getCompareIds();

  root.querySelectorAll('[data-compare-toggle]').forEach((input) => {
    if (ids.includes(String(input.value))) input.checked = true;

    input.addEventListener('change', () => {
      let current = getCompareIds();
      const id = String(input.value);

      if (input.checked) {
        if (current.length >= 3) {
          input.checked = false;
          toast('Compare takes up to 3 cars. Remove one first.', { variant: 'warning' });
          return;
        }
        current.push(id);
        track('compare_added', { compare_ids: current, listing_id: Number(id) });
      } else {
        current = current.filter((value) => value !== id);
      }

      try {
        localStorage.setItem(COMPARE_KEY, JSON.stringify(current));
      } catch {
        /* private mode: comparison simply will not persist */
      }

      document.querySelectorAll('[data-compare-count]').forEach((el) => {
        el.textContent = String(current.length);
      });
    });
  });
}

/**
 * The compare page renders server-side from ?ids= so links can be shared;
 * the visitor's own picks live in localStorage. This bridges the two:
 * land on /cars/compare with picks on this device and no ids in the URL,
 * and the page reloads with your picks in it.
 */
export function initCompareHydrate() {
  if (window.location.pathname !== '/cars/compare') return;
  const url = new URL(window.location.href);
  if (url.searchParams.has('ids')) return;
  const ids = getCompareIds();
  if (!ids.length) return;
  url.searchParams.set('ids', ids.join(','));
  window.location.replace(url.toString());
}

/* ------------------------------------ hero background video: desktop only */
export function initHeroVideo() {
  const video = document.querySelector('[data-hero-video]');
  if (!video || !video.dataset.src || typeof window.matchMedia !== 'function') return;

  const wide = window.matchMedia('(min-width: 900px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sync = () => {
    if (wide.matches && !reducedMotion.matches) {
      if (!video.hasAttribute('src')) {
        video.setAttribute('src', video.dataset.src);
        video.play().catch(() => { /* the navy field remains if autoplay is refused */ });
      }
    } else if (video.hasAttribute('src')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  };

  sync();
  wide.addEventListener?.('change', sync);
  reducedMotion.addEventListener?.('change', sync);
}

/* ------------------------------------ recently viewed (VDP, no PII) */
export function rememberViewed(listing) {
  if (!listing || !listing.id) return;
  try {
    const key = 'hc_recent';
    const list = JSON.parse(localStorage.getItem(key) || '[]').filter((item) => item.id !== listing.id);
    list.unshift({ ...listing, at: Date.now() });
    localStorage.setItem(key, JSON.stringify(list.slice(0, 6)));
  } catch {
    /* ignore */
  }
}

export function initRecentlyViewed(currentId) {
  const container = document.querySelector('[data-recently-viewed]');
  const list = container?.querySelector('[data-recently-viewed-list]');
  if (!container || !list) return;

  let items = [];
  try {
    items = JSON.parse(localStorage.getItem('hc_recent') || '[]').filter((item) => item.id !== currentId);
  } catch {
    items = [];
  }
  if (!items.length) return;

  // The localStorage snapshot is only a reminder of what this device looked
  // at. A purged demo car, a delisted or long-sold car must not keep haunting
  // the page from the device — the server decides what is still viewable, and
  // its copy of the title and price is the one that renders.
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const ids = items.slice(0, 3).map((item) => item.id).join(',');
  fetch(`/api/listings/compare?ids=${ids}`, { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.listings) || !data.listings.length) return;
      const live = new Map(data.listings.map((listing) => [Number(listing.id), listing]));
      const rows = items
        .filter((item) => live.has(Number(item.id)))
        .slice(0, 3)
        .map((item) => {
          const fresh = live.get(Number(item.id));
          return `
      <a class="card card--hoverable" href="${esc(fresh.url)}">
        <div class="card__body">
          <span class="car-card__title">${esc(fresh.title)}</span>
          <span class="car-card__price">${esc(fresh.priceFormatted)}</span>
        </div>
      </a>`;
        })
        .join('');
      if (!rows) return;
      list.innerHTML = rows;
      container.hidden = false;
    })
    .catch(() => {
      /* offline or blocked — the section simply stays hidden */
    });
}
