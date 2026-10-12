/* ==========================================================================
   Dealer portal behaviour (§7.2). Vanilla ES module, no dependencies.

   Everything here is optional polish: with JavaScript off, the wizard shows
   all three steps on one page and the forms still post. With it on, the
   wizard walks a step at a time and keeps a draft in this browser, so a lot
   that loses signal in the middle of typing does not lose the typing.
   ========================================================================== */

const DRAFT_KEY = 'honestcars.dealer.listing-draft.v1';

/** Step switching, with the URL kept honest so Back behaves. */
function wireWizard() {
  const form = document.querySelector('[data-dealer-wizard]');
  if (!form) return;

  const panels = Array.from(form.querySelectorAll('[data-wizard-panel]'));
  const steps = Array.from(form.querySelectorAll('[data-wizard-steps] [data-step]'));
  if (!panels.length) return;

  const show = (step, { scroll = true } = {}) => {
    const target = String(step);
    panels.forEach((panel) => {
      const active = panel.getAttribute('data-wizard-panel') === target;
      panel.hidden = !active;
    });
    steps.forEach((item) => {
      if (item.tagName === 'LI') item.setAttribute('aria-current', item.getAttribute('data-step') === target ? 'true' : 'false');
    });
    const input = form.querySelector('input[name="step"]');
    if (input) input.value = target;
    const url = new URL(window.location.href);
    if (target === '1') url.searchParams.delete('step');
    else url.searchParams.set('step', target);
    window.history.replaceState({}, '', url);
    if (scroll) form.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  form.querySelectorAll('[data-wizard-next]').forEach((button) => {
    button.addEventListener('click', () => {
      const current = form.querySelector('input[name="step"]');
      const from = current ? Number(current.value) : 1;
      const to = Number(button.getAttribute('data-wizard-next'));
      // Moving forward validates the panel you are leaving, so a missing year
      // or price is caught where it was typed rather than at the end.
      const leaving = form.querySelector(`[data-wizard-panel="${from}"]`);
      if (to > from && leaving && !validatePanel(leaving)) return;
      show(to);
    });
  });

  form.querySelectorAll('[data-wizard-prev]').forEach((button) => {
    button.addEventListener('click', () => show(Number(button.getAttribute('data-wizard-prev'))));
  });

  const start = Number(new URLSearchParams(window.location.search).get('step') || 1);
  show(start >= 1 && start <= panels.length ? start : 1, { scroll: false });
}

/** Native validation on one panel. Says which field, in the browser's words. */
function validatePanel(panel) {
  const fields = Array.from(panel.querySelectorAll('input, textarea, select'));
  for (const field of fields) {
    if (typeof field.checkValidity === 'function' && !field.checkValidity()) {
      field.reportValidity();
      field.focus();
      return false;
    }
  }
  return true;
}

/** Draft autosave — this browser only, never something we send without asking. */
function wireDraftAutosave() {
  const form = document.querySelector('[data-dealer-wizard]');
  if (!form) return;
  const note = document.querySelector('[data-autosave-note]');

  const save = () => {
    try {
      const data = {};
      new FormData(form).forEach((value, key) => {
        if (key === 'step') return;
        if (Object.prototype.hasOwnProperty.call(data, key)) return; // first checkbox wins
        data[key] = value;
      });
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), data }));
      if (note) note.textContent = 'Draft saved on this device. Nothing reaches HonestCars until you press “Save the draft”.';
    } catch {
      /* private mode, or storage full — the form still works */
    }
  };

  // Restore only if the server sent an empty form: a re-render after an error
  // must never be overwritten by a stale local copy.
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    const hasValues = Array.from(form.elements).some((el) => el.name && el.value && el.name !== 'step');
    if (raw && !hasValues) {
      const draft = JSON.parse(raw);
      const data = (draft && draft.data) || {};
      Object.entries(data).forEach(([key, value]) => {
        const field = form.elements.namedItem(key);
        if (!field) return;
        if (field instanceof RadioNodeList || typeof field.length === 'number') return;
        if (field.type === 'checkbox') field.checked = Boolean(value);
        else field.value = value;
      });
      if (note && draft.at) {
        note.textContent = `Draft restored from this device (${new Date(draft.at).toLocaleString()}).`;
      }
    }
  } catch {
    /* a corrupt draft is not worth a broken page */
  }

  let timer = null;
  form.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(save, 600);
  });
  form.addEventListener('submit', () => {
    try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
  });
}

/**
 * FR-33 — read the chosen CSV in the browser and put it in the paste box.
 *
 * The file is never uploaded by this script: it fills the textarea, so the
 * dealer sees exactly what is about to be sent, and the import is the same
 * request either way (paste or pick). With JavaScript off, the paste box and
 * the file input still work — the input simply sends its name and nothing else,
 * which is why the page tells the dealer to paste in that case.
 */
function wireCsvPicker() {
  document.querySelectorAll('[data-csv-target]').forEach((input) => {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      const target = document.getElementById(input.getAttribute('data-csv-target'));
      if (!file || !target) return;
      if (file.size > 512 * 1024) {
        target.value = '';
        input.setCustomValidity('That file is over 512 KB — split it and import the rest after.');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        target.value = String(reader.result || '');
        target.focus();
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      reader.readAsText(file);
    });
  });
}

wireWizard();
wireDraftAutosave();
wireCsvPicker();
