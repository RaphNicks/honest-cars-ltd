/**
 * §13.2 — forms that survive a dropped connection.
 *
 * Two failures this module exists to prevent, both of them common on a mobile
 * connection in Port Harcourt:
 *
 *   1. Someone spends three minutes filling in a concierge brief, the page
 *      reloads (or the phone sleeps, or the tab is closed), and everything they
 *      typed is gone. So the form keeps a draft in localStorage as they type, and
 *      when they come back they are offered it rather than an empty form.
 *   2. They press Send, the connection has just died, and the enquiry vanishes
 *      with an error message. So a send that fails *because of the network* — not
 *      because the server said no — is held in an outbox and sent when the phone
 *      is back online, with the visitor told plainly that it is waiting.
 *
 * Nothing here is required for the site to work: without JavaScript the forms
 * are ordinary HTML forms and post normally. This only removes the ways a
 * good connection is assumed.
 *
 * Storage is per-browser and per-form, holds only what the visitor typed, and is
 * cleared the moment a send succeeds. Drafts expire after 7 days — a two-week-old
 * half-finished brief surfacing unasked is worse than an empty form.
 */

const DRAFT_PREFIX = 'hc_draft:';
const OUTBOX_KEY = 'hc_outbox';
const DRAFT_TTL_MS = 7 * 86_400_000;
const SAVE_DEBOUNCE_MS = 400;

/** Inputs worth keeping. Never files, never anything marked as a secret. */
const SKIP_TYPES = new Set(['file', 'password', 'submit', 'button', 'reset', 'hidden']);

function store() {
  try {
    return window.localStorage;
  } catch {
    return null; // private mode, or storage disabled
  }
}

function fieldsFor(form) {
  return [...form.elements].filter((el) => {
    if (!el.name || SKIP_TYPES.has(el.type)) return false;
    return el.type === 'checkbox' || el.type === 'radio' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  });
}

/**
 * What the visitor has typed so far, in the shape a browser can put back.
 *
 * Radio groups are stored as one value per group name, not one per button:
 * storing each button's `checked` would fight the browser on restore.
 */
function readForm(form) {
  const values = {};
  for (const el of fieldsFor(form)) {
    if (el.type === 'checkbox') {
      if (el.value) {
        const list = values[el.name] || [];
        if (el.checked) list.push(el.value);
        values[el.name] = list;
      } else {
        values[el.name] = el.checked;
      }
      continue;
    }
    if (el.type === 'radio') {
      if (el.checked) values[el.name] = el.value;
      continue;
    }
    if (el.value) values[el.name] = el.value;
  }
  // Chip groups (sell/swap, service pages) are buttons, not inputs.
  form.querySelectorAll('[data-chip-group]').forEach((group) => {
    const picked = [...group.querySelectorAll('[data-chip][aria-pressed="true"]')].map((chip) => chip.dataset.chip);
    if (picked.length) values[`chip:${group.dataset.chipGroup}`] = picked;
  });
  return values;
}

function applyForm(form, values) {
  for (const el of fieldsFor(form)) {
    if (!(el.name in values)) continue;
    if (el.type === 'checkbox') {
      if (el.value) el.checked = (values[el.name] || []).includes(el.value);
      else el.checked = Boolean(values[el.name]);
      continue;
    }
    if (el.type === 'radio') {
      el.checked = values[el.name] === el.value;
      continue;
    }
    el.value = values[el.name];
  }
  form.querySelectorAll('[data-chip-group]').forEach((group) => {
    const picked = values[`chip:${group.dataset.chipGroup}`] || [];
    group.querySelectorAll('[data-chip]').forEach((chip) => {
      chip.setAttribute('aria-pressed', picked.includes(chip.dataset.chip) ? 'true' : 'false');
    });
  });
}

/** The storage key for a form: `data-draft`, else its action + id, else a hash of its fields. */
function keyFor(form) {
  if (form.dataset.draft) return `${DRAFT_PREFIX}${form.dataset.draft}`;
  const id = form.id || form.getAttribute('action') || 'form';
  return `${DRAFT_PREFIX}${id}`;
}

function writeDraft(form, values = null) {
  const memory = store();
  if (!memory) return;
  try {
    memory.setItem(keyFor(form), JSON.stringify({ at: Date.now(), values: values || readForm(form) }));
  } catch {
    /* quota or private mode: the form still works, it just will not resume */
  }
}

export function readDraft(form) {
  const memory = store();
  if (!memory) return null;
  try {
    const raw = JSON.parse(memory.getItem(keyFor(form)) || 'null');
    if (!raw || !raw.values) return null;
    if (Date.now() - Number(raw.at || 0) > DRAFT_TTL_MS) {
      memory.removeItem(keyFor(form));
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function clearDraft(form) {
  const memory = store();
  if (!memory) return;
  try {
    memory.removeItem(keyFor(form));
  } catch {
    /* nothing to clear */
  }
}

/** "3 minutes ago" — enough to say when the draft is from, in plain words. */
function agoText(timestamp) {
  const minutes = Math.round((Date.now() - Number(timestamp || 0)) / 60_000);
  if (minutes < 1) return 'a moment ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Show the "resume where you left off" line above a form.
 *
 * Deliberately offered rather than applied silently: a form that fills itself in
 * with something you typed last week, on a shared phone, is a surprise. The
 * visitor chooses.
 */
function showResume(form, draft) {
  const host = form.querySelector('[data-draft-note]') || form;
  const note = document.createElement('p');
  note.className = 'draft-note';
  note.setAttribute('role', 'status');
  note.innerHTML = `<span>You started this ${agoText(draft.at)} — we kept what you typed.</span>`;
  const resume = document.createElement('button');
  resume.type = 'button';
  resume.className = 'draft-note__action';
  resume.textContent = 'Fill it back in';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'draft-note__action';
  discard.textContent = 'Start fresh';
  note.append(resume, discard);
  host.prepend(note);

  resume.addEventListener('click', () => {
    applyForm(form, draft.values);
    note.remove();
  });
  discard.addEventListener('click', () => {
    clearDraft(form);
    note.remove();
  });
}

/**
 * Keep a draft of every form that asks for one, and offer it back on return.
 *
 * `data-draft="name"` opts a form in; the note goes wherever `[data-draft-note]`
 * is inside it, or at the top of the form if there is no such element.
 */
export function initFormDrafts(root = document) {
  root.querySelectorAll('form[data-draft]').forEach((form) => {
    const draft = readDraft(form);
    if (draft && Object.keys(draft.values || {}).length) showResume(form, draft);

    let timer = null;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => writeDraft(form), SAVE_DEBOUNCE_MS);
    };
    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);
    // A form that is closed or navigated away from should still keep the draft.
    window.addEventListener('pagehide', () => {
      if (timer) {
        window.clearTimeout(timer);
        writeDraft(form);
      }
    });
  });
}

/* ---------------------------------------------------------------------------
   The outbox: a send that failed because the network was gone, not because the
   server said no. Held here and offered again on `online`.
   --------------------------------------------------------------------------- */

function readOutbox() {
  const memory = store();
  if (!memory) return [];
  try {
    const list = JSON.parse(memory.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeOutbox(list) {
  const memory = store();
  if (!memory) return;
  try {
    if (list.length) memory.setItem(OUTBOX_KEY, JSON.stringify(list));
    else memory.removeItem(OUTBOX_KEY);
  } catch {
    /* nothing we can do, and nothing the visitor should be shown about storage */
  }
}

/** How many enquiries are waiting to go out. Used by the UI to be honest. */
export function queuedCount() {
  return readOutbox().length;
}

export function queueSend(endpoint, payload) {
  const list = readOutbox();
  list.push({ at: Date.now(), endpoint, payload });
  writeOutbox(list);
  return list.length;
}

function offline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Send, or hold the enquiry if the connection is the problem.
 *
 * Returns the same `{ ok }` shape the callers already render, plus `queued: true`
 * when the enquiry is waiting rather than delivered — because "sent" and "will
 * send when you have signal" are different promises and the visitor is owed the
 * difference.
 *
 * A 4xx is *not* queued: the server understood the request and refused it, and
 * retrying it later would be wrong. Only a network failure is.
 */
export async function sendOrQueue(endpoint, payload) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      // A refusal is final: say so, do not hold it.
      if (response.status >= 500) queueSend(endpoint, payload);
      return response.status >= 500
        ? { ok: false, error: 'Our side had a problem with that. Your details are saved on this device — nothing was lost.', queued: true }
        : { ok: false, error: body.error };
    }
    return { ok: true, ...body };
  } catch {
    // No response at all: almost always the connection.
    queueSend(endpoint, payload);
    return {
      ok: false,
      queued: true,
      error: offline() || true
        ? 'You are offline, so we kept this on your device. It sends itself the moment you are back online.'
        : 'Network problem — your details are saved on this device.',
    };
  }
}

/**
 * Send whatever is waiting. Called on `online` and once per page load, because a
 * phone that was offline when the tab closed may never fire an `online` event
 * again for that page.
 */
export async function flushOutbox() {
  const list = readOutbox();
  if (!list.length || offline()) return { sent: 0, left: list.length };

  const remaining = [];
  let sent = 0;
  for (const item of list) {
    try {
      const response = await fetch(item.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.ok) {
        sent += 1;
        continue;
      }
      // Understood and refused: dropping it is correct, and the visitor was
      // already told it was waiting rather than sent.
      if (response.status < 500) continue;
      remaining.push(item);
    } catch {
      remaining.push(item);
    }
  }
  writeOutbox(remaining);
  if (sent) window.dispatchEvent(new CustomEvent('hc:outbox-flushed', { detail: { sent } }));
  return { sent, left: remaining.length };
}

/**
 * Wire the outbox to the browser's own connection events.
 *
 * The visitor is told what happened, in the order it happened: if something is
 * still waiting and they are offline, that is said plainly rather than left to
 * be discovered; when a flush succeeds, it is confirmed. Both messages are about
 * their own enquiry, which is the one thing they cannot check themselves.
 */
export function initOutbox() {
  const note = async (message, variant = 'success') => {
    try {
      const { toast } = await import('./ui.js');
      toast(message, { variant, duration: 6000 });
    } catch {
      /* no toast on this page — the send itself still happened */
    }
  };

  const report = ({ sent } = {}) => {
    if (!sent) return;
    note(sent === 1 ? 'The enquiry you saved on this device has been sent.' : `${sent} saved enquiries have been sent.`);
  };

  window.addEventListener('hc:outbox-flushed', (event) => report(event.detail));

  const waiting = queuedCount();
  if (waiting && offline()) {
    const noun = waiting === 1 ? 'An enquiry is' : `${waiting} enquiries are`;
    note(`${noun} waiting on this device — ${waiting === 1 ? 'it sends' : 'they send'} itself the moment you are back online.`, 'warning');
    return;
  }

  flushOutbox().then(report);
  window.addEventListener('online', () => {
    flushOutbox().then(report);
  });
}
