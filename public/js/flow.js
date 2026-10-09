/**
 * Multi-step flows — §6.5 concierge (4 steps) and §6.6 sell intake (3 steps).
 *
 * Rules from the PRD:
 *   • progress bar + auto-save (§6.5) — drafts survive a dropped connection,
 *     a closed tab or a phone that ran out of data mid-form
 *   • chip groups for must-haves, budget sliders with live readouts
 *   • the retainer card carries the SLA; the SLA the visitor picks is what the
 *     server stores as sla_due_at
 *
 * No framework, no build step. If this file never loads, the markup is still a
 * real form with real fields — it just loses the step-by-step guidance.
 */

import { track, utm } from './events.js';
import { post, renderSuccess } from './service-forms.js';

const PHONE_RE = /^[+()\d\s-]{7,20}$/;

function stateFrom(form) {
  const data = {};
  form.querySelectorAll('input, select, textarea').forEach((field) => {
    if (!field.name) return;
    if (field.type === 'checkbox') {
      if (!Array.isArray(data[field.name])) data[field.name] = [];
      if (field.checked) data[field.name].push(field.value);
    } else if (field.type === 'radio') {
      if (field.checked) data[field.name] = field.value;
    } else {
      data[field.name] = field.value;
    }
  });
  form.querySelectorAll('[data-chip-group]').forEach((group) => {
    data[group.dataset.chipGroup] = [...group.querySelectorAll('[data-chip][aria-pressed="true"]')].map((chip) => chip.dataset.chip);
  });
  return data;
}

function applyState(form, state) {
  if (!state) return;
  form.querySelectorAll('input, select, textarea').forEach((field) => {
    if (!field.name || !(field.name in state)) return;
    const value = state[field.name];
    if (field.type === 'checkbox') {
      field.checked = Array.isArray(value) ? value.includes(field.value) : Boolean(value);
    } else if (field.type === 'radio') {
      field.checked = field.value === value;
    } else field.value = value;
  });
  form.querySelectorAll('[data-chip-group]').forEach((group) => {
    const picked = state[group.dataset.chipGroup] || [];
    group.querySelectorAll('[data-chip]').forEach((chip) => {
      chip.setAttribute('aria-pressed', picked.includes(chip.dataset.chip) ? 'true' : 'false');
    });
  });
}

function syncRangeReadouts(root) {
  root.querySelectorAll('[data-range-sync]').forEach((slider) => {
    const input = root.querySelector(`#${slider.dataset.rangeSync}`);
    const mirror = () => {
      if (input) input.value = slider.value;
      updateBudgetReadout(root);
    };
    slider.addEventListener('input', mirror);
    if (input) input.addEventListener('input', () => { slider.value = input.value; updateBudgetReadout(root); });
  });
}

function updateBudgetReadout(root) {
  const readout = root.querySelector('[data-budget-readout]');
  const min = root.querySelector('[name="budget_min"]');
  const max = root.querySelector('[name="budget_max"]');
  if (!readout || !min || !max) return;
  const money = (value) => `₦${Number(value || 0).toLocaleString('en-NG')}`;
  readout.textContent = `${money(min.value)} – ${money(max.value)}`;
}

function validateStep(panel) {
  const missing = [];
  panel.querySelectorAll('input[required], select[required], textarea[required]').forEach((field) => {
    const visible = field.offsetParent !== null;
    if (!visible) return;
    if (field.type === 'checkbox' && !field.checked) missing.push(field);
    else if (!String(field.value || '').trim()) missing.push(field);
  });
  if (missing.length) {
    const first = missing[0];
    first.focus({ preventScroll: false });
    return 'Please fill in the highlighted field before continuing.';
  }
  return null;
}

export function initFlows(root = document) {
  root.querySelectorAll('[data-flow]').forEach((flow) => {
    const form = flow.querySelector('[data-flow-form]');
    if (!form) return;
    const panels = [...flow.querySelectorAll('[data-step]')];
    const bars = [...flow.querySelectorAll('.flow__bar span')];
    const labels = [...flow.querySelectorAll('.flow__steps span')];
    const saved = flow.querySelector('[data-flow-saved]');
    const success = flow.querySelector('[data-flow-success]');
    const errorEl = flow.querySelector('[data-form-error]');
    const storageKey = flow.dataset.storageKey;
    const kind = flow.dataset.flow || 'concierge';
    const endpoint = flow.dataset.endpoint || '/api/service-requests';
    let current = 1;
    let started = false;

    const loadDraft = () => {
      if (!storageKey) return null;
      try {
        return JSON.parse(localStorage.getItem(storageKey) || 'null');
      } catch {
        return null;
      }
    };

    const saveDraft = () => {
      if (!storageKey) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(stateFrom(form)));
        if (saved) {
          saved.textContent = 'Saved on this device — you can close the tab and come back.';
          window.clearTimeout(saveDraft.timer);
          saveDraft.timer = window.setTimeout(() => { saved.textContent = ''; }, 4000);
        }
      } catch {
        /* private mode: the flow still works, it just will not resume */
      }
    };

    const show = (step) => {
      current = Math.min(panels.length, Math.max(1, step));
      panels.forEach((panel) => { panel.hidden = Number(panel.dataset.step) !== current; });
      bars.forEach((bar, index) => {
        const n = index + 1;
        bar.dataset.state = n < current ? 'done' : n === current ? 'current' : 'todo';
      });
      labels.forEach((label, index) => {
        const n = index + 1;
        label.dataset.state = n < current ? 'done' : n === current ? 'current' : 'todo';
      });
      if (current === panels.length) renderSummary();
      const heading = panels[current - 1].querySelector('h2');
      if (heading) heading.setAttribute('tabindex', '-1');
      flow.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };

    const renderSummary = () => {
      const target = flow.querySelector('[data-flow-summary]');
      if (!target) return;
      const state = stateFrom(form);
      const rows = [];
      if (state.budget_min || state.budget_max) {
        const money = (value) => `₦${Number(value || 0).toLocaleString('en-NG')}`;
        rows.push(['Budget', `${money(state.budget_min)} – ${money(state.budget_max)}`]);
      }
      if (state.makes && state.makes.length) rows.push(['Make', state.makes.join(', ')]);
      if (state.body_types && state.body_types.length) rows.push(['Body type', state.body_types.join(', ')]);
      if (state.must_haves && state.must_haves.length) rows.push(['Must-haves', state.must_haves.join(', ')]);
      if (state.intended_use) rows.push(['Use', state.intended_use.replace(/_/g, ' ')]);
      if (state.addons && state.addons.length) rows.push(['Add-ons', state.addons.join(', ')]);
      if (state.timeline) rows.push(['Timeline', String(state.timeline).replace(/_/g, ' ')]);

      target.innerHTML = rows.length
        ? rows.map(([key, value]) => `<div class="summary-list__row"><dt>${key}</dt><dd>${value}</dd></div>`).join('')
        : '<div class="summary-list__row"><dd>Nothing captured yet — step back and fill the brief.</dd></div>';
    };

    form.addEventListener('input', () => {
      if (!started) {
        started = true;
        if (kind === 'concierge') track('concierge_started', { source: 'find_my_car' });
      }
      saveDraft();
    });
    form.addEventListener('change', saveDraft);

    form.querySelectorAll('[data-chip-group]').forEach((group) => {
      group.querySelectorAll('[data-chip]').forEach((chip) => {
        chip.addEventListener('click', () => {
          const pressed = chip.getAttribute('aria-pressed') === 'true';
          chip.setAttribute('aria-pressed', pressed ? 'false' : 'true');
          saveDraft();
        });
      });
    });

    flow.querySelectorAll('[data-flow-next]').forEach((button) => {
      button.addEventListener('click', () => {
        const panel = panels[current - 1];
        const problem = validateStep(panel);
        if (problem) {
          if (errorEl) {
            errorEl.textContent = problem;
            errorEl.classList.remove('hidden');
          }
          return;
        }
        if (errorEl) errorEl.classList.add('hidden');
        track(kind === 'concierge' ? 'concierge_step_completed' : 'sell_swap_submitted', {
          step: String(current),
          type: kind,
        });
        saveDraft();
        show(current + 1);
      });
    });

    flow.querySelectorAll('[data-flow-back]').forEach((button) => {
      button.addEventListener('click', () => {
        if (errorEl) errorEl.classList.add('hidden');
        show(current - 1);
      });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (errorEl) errorEl.classList.add('hidden');

      const state = stateFrom(form);
      const name = String(state.name || '').trim();
      const phone = String(state.phone || '').trim();
      if (name.length < 2) return fail('Please tell us your name.');
      if (!PHONE_RE.test(phone)) return fail('That phone number does not look right — please check it.');
      if (!state.consent) return fail('Tick the WhatsApp box so we can reply to you.');

      const submit = form.querySelector('[data-submit]');
      if (submit) {
        submit.disabled = true;
        submit.dataset.label = submit.textContent;
        submit.textContent = 'Sending…';
      }

      const slaInput = form.querySelector('[name="sla"]:checked');
      const brief = buildBrief(kind, state);
      const result = await post(endpoint, {
        kind,
        name,
        phone,
        brief,
        // The key, not the price: the server prices the retainer from its own
        // SLA card (services/concierge.js), so the two can never disagree.
        sla: slaInput ? slaInput.value : undefined,
        slaHours: slaInput ? Number(slaInput.dataset.slaHours) : undefined,
        sourcePath: location.pathname,
        utm: utm() || null,
      });

      if (submit) {
        submit.disabled = false;
        submit.textContent = submit.dataset.label || 'Send';
      }
      if (!result.ok) return fail(result.error || 'That did not send — please try again.');

      try { if (storageKey) localStorage.removeItem(storageKey); } catch { /* ignore */ }
      renderSuccess(success, { kind, serviceSlug: kind, result });
      form.classList.add('hidden');
      const progress = flow.querySelector('.flow__progress');
      if (progress) progress.classList.add('hidden');
    });

    function fail(message) {
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
        errorEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    // Restore an in-progress draft (§13.2 “resume where you left off”).
    applyState(form, loadDraft());
    syncRangeReadouts(flow);
    updateBudgetReadout(flow);
    if (saved && loadDraft()) saved.textContent = 'We restored your saved brief from this device.';
  });

  // /concierge/lookup — a plain GET form would need a route per id, so redirect.
  root.querySelectorAll('[data-tracking-lookup]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = form.querySelector('input[name="id"]');
      const id = String(input && input.value ? input.value : '').trim().toUpperCase();
      if (!/^HC-\\d{3,6}$/.test(id)) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      location.href = `/concierge/${id}`;
    });
  });
}

function buildBrief(kind, state) {
  if (kind === 'sell') {
    return {
      make: state.make,
      model: state.model,
      year: state.year,
      mileage_km: state.mileage_km,
      trim: state.trim,
      area: state.area,
      condition: state.condition,
      documents: state.documents,
      notes: state.notes,
      want_inspection: state.want_inspection,
    };
  }
  return {
    budget_min: state.budget_min,
    budget_max: state.budget_max,
    makes: state.makes,
    body_types: state.body_types,
    transmission: state.transmission,
    fuel: state.fuel,
    must_haves: state.must_haves,
    intended_use: state.intended_use,
    addons: state.addons,
    timeline: state.timeline,
    financing: state.financing,
    sla: state.sla,
  };
}
