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
