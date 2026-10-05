/**
 * Lead capture — §6.3 Request Viewing, and every other public form.
 *
 * Guest-first: no account, no login wall. The form posts to /api/leads, then
 * offers the WhatsApp hand-off so the buyer can talk to a human immediately.
 * Works without JavaScript too — the markup is a form with a real action.
 */

import { track, utm } from './events.js';

export function initViewingModal(root = document) {
  const modal = root.getElementById('viewing-modal');
  if (!modal) return;

  const panel = modal.querySelector('.modal__panel');
  const form = modal.querySelector('[data-lead-form]');
  const success = modal.querySelector('[data-lead-success]');
  const errorEl = modal.querySelector('[data-form-error]');
  const submit = modal.querySelector('[data-submit]');
  let lastFocused = null;

  const setOpen = (open) => {
    modal.hidden = !open;
    modal.dataset.open = open ? 'true' : 'false';
    document.body.dataset.scrollLocked = open ? 'true' : 'false';
    if (open) {
      lastFocused = document.activeElement;
      panel?.querySelector('input')?.focus({ preventScroll: true });
    } else if (lastFocused) {
      lastFocused.focus({ preventScroll: true });
    }
  };

  root.querySelectorAll('[data-open-viewing]').forEach((button) => {
    button.addEventListener('click', () => {
      track('viewing_requested', {
        source: 'vdp_modal_opened',
        listing_id: Number(button.dataset.listingId || modal.dataset.listingId),
      });
      setOpen(true);
    });
  });

  modal.querySelectorAll('[data-modal-close]').forEach((el) => el.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.dataset.open === 'true') setOpen(false);
  });

  // Simple focus trap so keyboard users stay inside the dialog.
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || modal.dataset.open !== 'true') return;
    const focusable = panel.querySelectorAll('a[href], button, input, select, textarea');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorEl) errorEl.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = 'Sending…';

    const data = new FormData(form);
    const payload = {
      type: form.dataset.leadType || 'viewing',
      listingId: form.dataset.listingId || modal.dataset.listingId || null,
      name: String(data.get('name') || '').trim(),
      phone: String(data.get('phone') || '').trim(),
      preferredDay: data.get('preferred_day') || null,
      message: data.get('message') || null,
      sourcePath: location.pathname,
      utm: utm() || null,
    };

    const result = await postLead(payload);
    submit.disabled = false;
    submit.textContent = 'Request viewing';

    if (!result.ok) {
      if (errorEl) {
        errorEl.textContent = result.error || 'That did not send. Check your number and try again.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    if (form) form.classList.add('hidden');
    if (success) success.classList.remove('hidden');
    window.dispatchEvent(new CustomEvent('hc:lead-created', { detail: result }));
  });
}

/** Inline forms elsewhere on the page (deal alerts, service requests). */
export function initInlineLeadForms(root = document) {
  root.querySelectorAll('[data-lead-form]:not(#viewing-modal [data-lead-form])').forEach((form) => {
    const errorEl = form.querySelector('[data-form-error]');
    const submit = form.querySelector('[data-submit]');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (errorEl) errorEl.classList.add('hidden');
      if (submit) {
        submit.disabled = true;
        submit.dataset.label = submit.textContent;
        submit.textContent = 'Sending…';
      }

      const data = new FormData(form);
      const result = await postLead({
        type: form.dataset.leadType || 'service',
        listingId: form.dataset.listingId || null,
        name: String(data.get('name') || '').trim() || 'Deal-alert subscriber',
        phone: String(data.get('phone') || '').trim(),
        message: data.get('message') || null,
        sourcePath: location.pathname,
      });

      if (submit) {
        submit.disabled = false;
        submit.textContent = submit.dataset.label || 'Send';
      }

      if (!result.ok) {
        if (errorEl) {
          errorEl.textContent = result.error || 'That did not send — please try again.';
          errorEl.classList.remove('hidden');
        }
        return;
      }

      form.reset();
      const { toast } = await import('./ui.js');
      toast('You are on the list. We will WhatsApp you when something matches.', { variant: 'success' });
    });
  });
}

async function postLead(payload) {
  const endpoint = (window.HonestCars?.config?.logEndpoint) || '/api/leads';
  const phone = payload.phone;
  if (!/^[+()\d\s-]{7,20}$/.test(phone)) {
    return { ok: false, error: 'That phone number does not look right — please check it.' };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) return { ok: false, error: body.error };
    return { ok: true, leadId: body.leadId, whatsappUrl: body.whatsappUrl };
  } catch {
    return { ok: false, error: 'Network problem — check your connection and try again.' };
  }
}
