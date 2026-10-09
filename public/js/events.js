/**
 * §15.1 event tracking.
 *
 * Event names are the verbatim snake_case contract from the PRD and are
 * validated server-side against the same list (src/services/events.js).
 * Nothing here sends PII: no names, no phone numbers, no free text from forms.
 *
 * Batching: events queue for 1.5s (or 10 items) and post once, so browsing
 * never costs a request per click.
 */

const config = (window.HonestCars && window.HonestCars.config) || {};
const ALLOWED = new Set((window.HonestCars && window.HonestCars.eventNames) || []);

let queue = [];
let timer = null;

/** The five UTM parameters worth storing — the names Google/analytics use. */
const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'];

/**
 * First-touch campaign for this session, or {}.
 *
 * Read once from the landing URL and kept in sessionStorage: a visitor who
 * arrives on an Instagram link and browses to a listing before enquiring must
 * still be credited to Instagram, not to the page they happened to be on when
 * they filled the form. Session-scoped, not a cookie — nothing follows them
 * around the web, and closing the tab forgets it (§12.2, minimal PII).
 *
 * `gclid`/`fbclid` are counted as paid clicks from those networks, because that
 * is what they are; a campaign with neither UTM nor a click id is recorded as
 * no campaign, which is an honest answer rather than a guessed one.
 */
export function utm() {
  try {
    const stored = sessionStorage.getItem('hc_utm');
    if (stored) return JSON.parse(stored) || {};

    const params = new URLSearchParams(location.search);
    const found = {};
    for (const key of UTM_KEYS) {
      const value = params.get(`utm_${key}`);
      if (value) found[key] = value.slice(0, 80);
    }
    if (!found.source) {
      if (params.get('gclid')) found.source = 'google';
      else if (params.get('fbclid')) found.source = 'facebook';
      if (found.source && !found.medium) found.medium = 'cpc';
    }
    if (Object.keys(found).length) sessionStorage.setItem('hc_utm', JSON.stringify(found));
    return found;
  } catch {
    /* private mode, or a storage quota — attribution is not worth breaking a page */
    return {};
  }
}

/**
 * §13.2 — has the visitor asked us to spend less data?
 *
 * Two answers, and either one is enough. The server sees the `Save-Data: on`
 * header and hands the flag down in the inline config. But most of this site is
 * prebuilt to disk and served as a file, so no server code runs for it: there the
 * client's own `navigator.connection.saveData` is the only signal. (Chrome and
 * Opera expose it; Safari and Firefox do not, and for them the answer is "no".)
 */
export function saveData() {
  if (config.saveData) return true;
  try {
    return Boolean(navigator.connection && navigator.connection.saveData);
  } catch {
    return false;
  }
}

/**
 * The site photos that have a 600×450 sibling, and nothing else.
 *
 * Deliberately narrow: a video poster or a dealer-hosted URL has no `-600`
 * sibling, and rewriting one of those would replace a working image with a 404.
 * Every photo in these folders has its sibling (scripts/prepare-images.js, run
 * as `npm run images:check`).
 */
const SITE_PHOTO = /^\/img\/(?:cars|details|site|blog|shop|hire)\/[\w-]+\.jpg$/;

/** The 600×450 sibling, for the same reason src/lib/locals.js has one. */
export function smallSrc(url) {
  return typeof url === 'string' && SITE_PHOTO.test(url) ? url.replace(/\.jpg$/, '-600.jpg') : url;
}

/**
 * Drop to the small photo and drop the srcset that would invite a bigger one.
 *
 * Used for the case the server cannot handle — a prebuilt page — and it is
 * deliberately conservative: only the `src` and `srcset` attributes change, so
 * whichever variant was already being fetched finishes normally.
 */
export function applySaveData(root = document) {
  if (!saveData()) return false;
  root.querySelectorAll('img[src]').forEach((img) => {
    if (img.dataset.hcReduced === 'done') return;
    const current = img.getAttribute('src');
    const small = smallSrc(current);
    if (small === current) return;
    img.dataset.hcReduced = 'done';
    img.removeAttribute('srcset');
    img.setAttribute('src', small);
  });
  return true;
}

/**
 * Blur-up (§13.2): hold the photo back while its placeholder shows.
 *
 * Runs before the image is painted, so the fade is the first thing seen rather
 * than a flash of a loaded photo followed by a fade to nothing. Only script can
 * put `hc-blur` on a frame, so without JavaScript the photo is simply visible —
 * the placeholder never becomes a permanent grey box.
 */
export function initBlurUp(root = document) {
  const frames = root.querySelectorAll('.media-blur > img[data-blur-img]');
  frames.forEach((img) => {
    const frame = img.parentElement;
    const reveal = () => {
      img.dataset.hcLoaded = 'done';
      frame.classList.remove('hc-blur');
    };
    if (img.complete && img.naturalWidth) {
      reveal();
      return;
    }
    frame.classList.add('hc-blur');
    img.addEventListener('load', reveal, { once: true });
    // A broken photo reveals the frame rather than leaving a blur forever.
    img.addEventListener('error', reveal, { once: true });
  });
}

function sessionId() {
  try {
    let id = sessionStorage.getItem('hc_session');
    if (!id) {
      id = Math.random().toString(36).slice(2, 12);
      sessionStorage.setItem('hc_session', id);
    }
    return id;
  } catch {
    return null;
  }
}

/** Drop anything not on the §15.1 list — better a missing event than a wrong one. */
export function track(name, payload = {}) {
  if (!ALLOWED.has(name)) {
    if (window.HonestCars && window.HonestCars.config && /localhost|127\.0\.0\.1/.test(location.host)) {
      console.warn(`[events] unknown event name "${name}" — not in the §15.1 plan`);
    }
    return;
  }

  const campaign = utm();
  queue.push({
    name,
    payload: {
      ...payload,
      source: payload.source || config.source,
      ...(Object.keys(campaign).length ? { utm: campaign } : {}),
    },
  });

  // Mirror into GA4 when it is configured.
  if (typeof window.gtag === 'function') {
    window.gtag('event', name, payload);
  }

  if (queue.length >= 10) return flush();
  if (!timer) timer = setTimeout(flush, 1500);
  return undefined;
}

export async function flush() {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  clearTimeout(timer);
  timer = null;

  const body = JSON.stringify({ events: batch, path: location.pathname, session: sessionId() });
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(config.eventsEndpoint || '/api/events', new Blob([body], { type: 'application/json' }));
      return;
    }
    await fetch(config.eventsEndpoint || '/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    /* analytics must never break a page */
  }
}

/** Any element can opt in: data-event="whatsapp_click" data-source="vdp". */
export function bindDeclarativeEvents(root = document) {
  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-event]');
    if (!el) return;
    const name = el.dataset.event;
    const payload = { source: el.dataset.source || 'unknown' };
    if (el.dataset.listingId) payload.listing_id = Number(el.dataset.listingId);
    if (el.dataset.grade) payload.grade = el.dataset.grade;
    if (el.dataset.pricePosition) payload.price_position = el.dataset.pricePosition;
    track(name, payload);
  });

  // Flush on the way out.
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/**
 * listing_impression — fire once per card that actually enters the viewport,
 * with id/grade/price_position (§15.1).
 */
export function observeImpressions(root = document) {
  const cards = root.querySelectorAll('[data-listing-card]:not([data-impressed])');
  if (!cards.length) return;

  if (!('IntersectionObserver' in window)) {
    cards.forEach((card) => {
      card.dataset.impressed = '1';
      track('listing_impression', {
        listing_id: Number(card.dataset.listingId),
        grade: card.dataset.grade,
        price_position: card.dataset.pricePosition,
        save_data: saveData(),
      });
    });
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const card = entry.target;
        card.dataset.impressed = '1';
        track('listing_impression', {
          listing_id: Number(card.dataset.listingId),
          grade: card.dataset.grade,
          price_position: card.dataset.pricePosition,
          save_data: saveData(),
        });
        observer.unobserve(card);
      });
    },
    { rootMargin: '80px' },
  );

  cards.forEach((card) => observer.observe(card));
}

/**
 * article_read_75 — blog posts only (§15.1). Bound here so the behaviour exists
 * before the blog routes land.
 */
export function observeReadDepth(article, { threshold = 0.75 } = {}) {
  if (!article) return;
  const onScroll = () => {
    const rect = article.getBoundingClientRect();
    const seen = Math.min(1, Math.max(0, (window.innerHeight - rect.top) / rect.height));
    if (seen >= threshold) {
      track('article_read_75', { scroll_depth: Math.round(seen * 100) });
      window.removeEventListener('scroll', onScroll);
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}
