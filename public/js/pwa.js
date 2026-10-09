/**
 * FR-30 — the installable half of the PWA.
 *
 * Three quiet things, and no nagging (§13.3 is explicit: "no interstitials or
 * app-download nagging"):
 *
 *   1. Register the service worker. Registration is deferred until the page has
 *      finished loading and is idle-ish, so it never competes with the first
 *      paint on a slow phone.
 *   2. Offer an install button — but only on the evidence of the browser's own
 *      `beforeinstallprompt`. iOS never fires it and Chrome only fires it once
 *      its own criteria are met, so the footer control stays hidden until the
 *      browser says the app can actually be installed. Showing a button that
 *      does nothing would be the dishonest option.
 *   3. Say when a newer version is waiting, once, without reloading anyone's
 *      page underneath them.
 *
 * Offline *conduct* lives elsewhere on purpose: drafts.js already holds an
 * enquiry that failed to send and speaks up when one is waiting. This module
 * does not repeat that.
 */

const SW_URL = '/sw.js';

function canRegister() {
  return 'serviceWorker' in navigator && location.protocol !== 'file:';
}

/**
 * Keep the site honest about what is new: no auto-reload, no repeated toast —
 * and no old release left in charge when there is a new one waiting.
 *
 * A worker installs, then *waits*: it does not take over until every tab that
 * the previous worker controls has closed. That is the safe default for a site
 * mid-task, and it is also how a browser ends up running last release's
 * JavaScript for days — the reader reloads, gets fresh HTML, and the old worker
 * answers with the modules it cached, with nothing on screen to say so.
 *
 * So when a new worker is ready we tell it to take over (it handles
 * `SKIP_WAITING`). Nothing is reloaded underneath the reader: this page keeps
 * the files it has already loaded, and the *next* navigation is served by the
 * new worker. The toast is unchanged, and now it is true in one page rather than
 * once the last tab is closed.
 */
function watchForUpdates(registration) {
  const announce = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'installed') return;
      if (!navigator.serviceWorker.controller) return; // first ever install
      announceOnce();
      if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
  };

  let announced = false;
  const announceOnce = () => {
    if (announced) return;
    announced = true;
    import('./ui.js')
      .then(({ toast }) =>
        toast('A newer version of HonestCars is ready. It loads on your next page.', {
          variant: '',
          duration: 7000,
        }),
      )
      .catch(() => {});
  };

  // A worker can already be waiting when this page loads — the tab that
  // triggered the update is usually not the one that visits next.
  if (registration.waiting) {
    announceOnce();
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  announce(registration.installing);
  registration.addEventListener('updatefound', () => announce(registration.installing));
}

function initInstallPrompt() {
  const button = document.querySelector('[data-install-app]');
  if (!button) return;

  let deferred = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    button.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
    import('./ui.js')
      .then(({ toast }) => toast('Installed. HonestCars opens from your home screen now.', { variant: 'success' }))
      .catch(() => {});
  });

  button.addEventListener('click', async () => {
    if (!deferred) return;
    button.disabled = true;
    try {
      deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* the browser withdrew the offer — the button just stops doing anything */
    }
    deferred = null;
    button.hidden = true;
    button.disabled = false;
  });
}

/** The retry button on /offline. A reload is the whole mechanism: it asks the
    service worker for the page again, and the worker answers from the network if
    there is one and from the cache if there is not. */
function initOfflineRetry() {
  const button = document.querySelector('[data-offline-retry]');
  if (!button) return;
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Trying…';
    location.reload();
  });
}

export function initPWA() {
  initInstallPrompt();
  initOfflineRetry();

  if (!canRegister()) return;

  const register = () => {
    navigator.serviceWorker
      .register(SW_URL, { scope: '/' })
      .then((registration) => watchForUpdates(registration))
      .catch(() => {
        /* No service worker: the site behaves exactly as it did before. */
      });
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}
