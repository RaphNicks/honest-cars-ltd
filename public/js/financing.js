/**
 * FR-34 — the financing calculator and enquiry, client side.
 *
 * The calculator is the interesting part. It posts what the visitor typed to
 * `/api/financing/plan` and prints the server's own sentences back verbatim.
 * Recomputing the arithmetic here would mean two implementations of the one
 * piece of this page that must not drift — and the version in the browser would
 * be the one nobody tested.
 *
 * Debounced, because someone typing a price should not fire a request per
 * keystroke, and §13.2 asks us to be careful with people's data.
 *
 * Nothing is sent until they press the button. A plan request carries the
 * numbers and nothing else: no name, no number, no identifier.
 */

import { post } from './service-forms.js';

const DEBOUNCE_MS = 450;

function money(value) {
  return `₦${Number(value || 0).toLocaleString('en-NG')}`;
}

function text(node, value) {
  if (node) node.textContent = value;
}

export function initFinancing() {
  const form = document.querySelector('[data-financing-form]');
  if (!form) return;

  const status = form.querySelector('[data-financing-status]');
  const placeholder = document.querySelector('[data-financing-placeholder]');
  const summary = document.querySelector('[data-financing-summary]');
  const headline = document.querySelector('[data-financing-headline]');
  const detail = document.querySelector('[data-financing-detail]');
  const caveat = document.querySelector('[data-financing-caveat]');
  const receipt = document.querySelector('[data-financing-receipt]');
  const reference = document.querySelector('[data-financing-reference]');
  const next = document.querySelector('[data-financing-next]');
  const whatsappNote = document.querySelector('[data-financing-whatsapp]');

  const planEndpoint = form.dataset.planEndpoint || '/api/financing/plan';
  const submitEndpoint = form.dataset.endpoint || '/api/financing';

  const reading = () => ({
    listingSlug: form.querySelector('[name="listingSlug"]')?.value || '',
    amount: form.querySelector('[name="amount"]')?.value || '',
    down: form.querySelector('[name="down"]')?.value || '',
    monthly: form.querySelector('[name="monthly"]')?.value || '',
    tenor: form.querySelector('[name="tenor"]')?.value || '36',
  });

  let timer = null;

  function showPlan(plan) {
    if (placeholder) placeholder.hidden = true;
    if (summary) summary.hidden = false;
    if (receipt) receipt.hidden = true;
    text(headline, plan.headline);
    text(detail, plan.detail);
    text(caveat, plan.caveat || 'This is arithmetic, not an offer.');
  }

  function clearPlan(message) {
    if (placeholder) {
      placeholder.hidden = false;
      if (message) placeholder.textContent = message;
    }
    if (summary) summary.hidden = true;
  }

  async function fetchPlan() {
    const values = reading();
    if (!values.listingSlug && !String(values.amount).replace(/\D/g, '')) {
      clearPlan();
      return;
    }
    try {
      const response = await fetch(planEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const payload = await response.json().catch(() => null);
      if (!payload || !payload.ok) {
        clearPlan(payload && payload.error ? payload.error : undefined);
        return;
      }
      showPlan(payload.plan);
    } catch {
      // Offline or the request died: say nothing rather than something wrong.
      clearPlan('We could not reach the server for the arithmetic — the enquiry below still works, and a human will do the sums.');
    }
  }

  for (const field of ['amount', 'down', 'monthly', 'tenor']) {
    const input = form.querySelector(`[name="${field}"]`);
    if (!input) continue;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(fetchPlan, DEBOUNCE_MS);
    });
  }

  // A car in the URL is already priced by the server; show its arithmetic on
  // arrival so the visitor does not have to touch anything to see it.
  if (form.querySelector('[name="listingSlug"]')?.value) fetchPlan();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = reading();
    const payload = {
      ...values,
      name: form.querySelector('[name="name"]')?.value || '',
      phone: form.querySelector('[name="phone"]')?.value || '',
      email: form.querySelector('[name="email"]')?.value || '',
      employment: form.querySelector('[name="employment"]')?.value || '',
      timeline: form.querySelector('[name="timeline"]')?.value || '',
      consent: form.querySelector('[name="consent"]')?.checked ? 'yes' : '',
    };

    if (!payload.name.trim() || !payload.phone.trim()) {
      text(status, 'Please add your name and a WhatsApp number.');
      return;
    }
    if (!payload.consent) {
      text(status, 'Please tick the box that lets us share these details with a lender.');
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    text(status, 'Sending…');

    try {
      // `post` carries sourcePath and utm, and holds the send if the connection
      // dropped (§13.2) — the same path every other enquiry on the site uses.
      const result = await post(submitEndpoint, payload);
      if (!result || !result.ok) {
        text(status, (result && result.error) || 'We could not send that just now — please try again.');
        if (button) button.disabled = false;
        return;
      }

      const plan = result.plan || {};
      text(
        status,
        `Sent. Your reference is ${result.reference}. A human reads it today.`,
      );
      if (placeholder) placeholder.hidden = true;
      if (summary) summary.hidden = true;
      if (receipt) receipt.hidden = false;
      text(reference, `Reference ${result.reference}`);
      text(
        next,
        plan.headline
          ? `${plan.headline} We will come back to you with which lender we are routing it to — or tell you plainly if we cannot help.`
          : 'We will come back to you with which lender we are routing it to — or tell you plainly if we cannot help.',
      );
      if (whatsappNote && result.whatsappUrl) {
        const link = document.createElement('a');
        link.className = 'text-green';
        link.href = result.whatsappUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Send the same details to our desk on WhatsApp';
        whatsappNote.replaceChildren(link);
        whatsappNote.hidden = false;
      }
      // The form has done its job; leaving it filled in invites a second send.
      for (const input of form.querySelectorAll('input, select')) {
        if (input.type !== 'checkbox') input.disabled = true;
      }
      if (button) button.textContent = 'Enquiry sent';
    } catch {
      text(status, 'We could not send that just now — your details are safe on this device, try again in a moment.');
      if (button) button.disabled = false;
    }
  });
}
