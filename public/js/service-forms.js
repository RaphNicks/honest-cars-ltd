/**
 * Service page forms + booking (§6.7 conversion block), the concierge intake
 * endpoint client (§6.5) and the sell/swap intake (§6.6).
 *
 * One module, three callers: any form with data-service-form posts the same
 * JSON shape and renders the same success panel — tracking id for requests
 * (HC-2481…) or a booking reference (HC-BK-0001…) for scheduled work.
 *
 * Vanilla ES module. The markup is a real form, so nothing here is required for
 * the page to be usable — it only removes the round-trip.
 */

import { track, utm } from './events.js';

const PHONE_RE = /^[+()\d\s-]{7,20}$/;

/** Kobo → "₦50,000". Same shape as the other client modules' local formatter. */
const naira = (kobo) => `₦${(Number(kobo || 0) / 100).toLocaleString('en-NG')}`;

function readForm(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  // Chip groups are buttons, not inputs — read them off their aria-pressed state.
  form.querySelectorAll('[data-chip-group]').forEach((group) => {
    const picked = [...group.querySelectorAll('[data-chip][aria-pressed="true"]')].map((chip) => chip.dataset.chip);
    values[group.dataset.chipGroup] = picked.join(', ');
  });
  return values;
}

function slotToIso(date, window_) {
  if (!date) return null;
  const hours = { morning: '09:00', afternoon: '13:00', evening: '16:00' }[window_] || '10:00';
  const parsed = new Date(`${date}T${hours}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function labelFor(kind) {
  return {
    inspection: 'inspection',
    consultation: 'consultation',
    documents: 'document request',
    tracking: 'tracker install',
    research: 'report request',
    parts: 'parts request',
    request: 'request',
  }[kind] || 'request';
}

export function initServiceForms(root = document) {
  const forms = root.querySelectorAll('[data-service-form]');
  if (!forms.length) return;

  forms.forEach((form) => {
    const kind = form.dataset.kind || 'request';
    const endpoint = form.dataset.endpoint || '/api/service-requests';
    const serviceSlug = form.dataset.serviceSlug || kind;
    const submit = form.querySelector('[data-submit]');
    const errorEl = form.querySelector('[data-form-error]');
    const success = form.parentElement.querySelector('[data-form-success]') || form.nextElementSibling;
    let started = false;

    form.addEventListener('focusin', () => {
      if (started) return;
      started = true;
      track('booking_started', { type: kind, source: `service_form_${serviceSlug}` });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (errorEl) errorEl.classList.add('hidden');

      const values = readForm(form);
      const name = String(values.name || '').trim();
      const phone = String(values.phone || '').trim();

      const fail = (message) => {
        if (errorEl) {
          errorEl.textContent = message;
          errorEl.classList.remove('hidden');
          errorEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      };

      if (name.length < 2) return fail('Please tell us your name.');
      if (!PHONE_RE.test(phone)) return fail('That phone number does not look right — please check it.');
      if (!values.consent) return fail('Tick the WhatsApp box so we can reply to you.');

      const payload = buildPayload({ kind, serviceSlug, values });
      if (payload.error) return fail(payload.error);

      if (submit) {
        submit.disabled = true;
        submit.dataset.label = submit.textContent;
        submit.textContent = 'Sending…';
      }

      const result = await post(endpoint, payload.body);
      if (submit) {
        submit.disabled = false;
        submit.textContent = submit.dataset.label || 'Send';
      }

      if (!result.ok) return fail(result.error || 'That did not send — please try again.');

      renderSuccess(success, { kind, serviceSlug, result });
      form.classList.add('hidden');
      track(kind === 'inspection' || kind === 'consultation' ? 'booking_completed' : 'concierge_step_completed', {
        type: kind,
        step: 'submitted',
        source: `service_form_${serviceSlug}`,
      });
    });
  });
}

function buildPayload({ kind, serviceSlug, values }) {
  const brief = {};
  const body = { kind, serviceSlug, name: String(values.name || '').trim(), phone: String(values.phone || '').trim() };

  if (kind === 'inspection') {
    body.type = 'inspection';
    body.slotAt = slotToIso(values.slot_date, values.slot_window);
    body.location = String(values.location || '').trim();
    body.vehicle = {
      make: String(values.make || '').trim(),
      model: String(values.model || '').trim(),
      year: values.year ? Number(values.year) : null,
    };
    if (!body.slotAt) return { error: 'Pick a day for the inspection.' };
    if (!body.location) return { error: 'Where is the car? We need the area to route an inspector.' };
    if (!body.vehicle.make || !body.vehicle.model) return { error: 'Tell us the make and model of the car.' };
  } else if (kind === 'consultation') {
    body.type = 'consultation';
    body.slotAt = slotToIso(values.slot_date, values.slot_window);
    if (!body.slotAt) return { error: 'Pick a day and a time window.' };
    brief.notes = values.notes || null;
  } else if (kind === 'documents') {
    body.type = 'documents';
    brief.doc_type = values.doc_type || null;
    brief.vehicle_ref = values.vehicle_ref || null;
    brief.notes = values.notes || null;
  } else if (kind === 'tracking') {
    body.type = 'tracking';
    brief.bundle = values.bundle || null;
    brief.vehicle = values.vehicle || null;
    brief.install_area = values.location || null;
    if (!values.vehicle) return { error: 'Which vehicle should the tracker go into?' };
  } else if (kind === 'research') {
    body.type = 'research';
    brief.report = values.report || null;
    brief.notes = values.notes || null;
    if (!values.notes) return { error: 'Describe the car or the question so we can scope the report.' };
  } else if (kind === 'parts') {
    body.type = 'parts';
    brief.vin = values.vin || null;
    brief.part = values.part || null;
    brief.notes = values.notes || null;
    if (!values.vin) return { error: 'Parts are matched by VIN — please paste it (or send it on WhatsApp after).' };
    if (!values.part) return { error: 'Which part do you need?' };
  } else if (kind === 'contact') {
    body.type = 'contact';
    body.message = values.message || '';
    body.topic = values.topic || 'buying';
    if (!String(values.message || '').trim()) return { error: 'Tell us what the message is about — one line is enough.' };
  } else if (kind === 'sell' || kind === 'swap' || kind === 'hire') {
    body.type = kind;
    for (const [key, value] of Object.entries(values)) {
      if (['name', 'phone', 'consent', 'sourcePath'].includes(key)) continue;
      if (value === '' || value === undefined || value === null) continue;
      brief[key] = value;
    }
    if (kind === 'hire' && !body.slotAt) {
      // The hire quote resolves dates into a slot so ops can see it at a glance.
      const from = values.date_from ? new Date(`${values.date_from}T09:00:00`) : null;
      body.slotAt = from && !Number.isNaN(from.getTime()) ? from.toISOString() : null;
      body.location = values.location || null;
    }
    if (kind === 'sell' && !values.make) return { error: 'Tell us the make and model of the car.' };
    if (kind === 'swap' && !values.make) return { error: 'Tell us what you are swapping from.' };
  } else {
    body.type = 'concierge';
    brief.notes = values.notes || null;
  }

  if (Object.keys(brief).length) body.brief = brief;
  return { body };
}

export async function post(endpoint, payload) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, sourcePath: location.pathname, utm: utm() || null }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) return { ok: false, error: body.error };
    return { ok: true, ...body };
  } catch {
    return { ok: false, error: 'Network problem — check your connection and try again.' };
  }
}

export function renderSuccess(container, { kind, serviceSlug, result }) {
  if (!container) return;
  const wa = result.whatsappUrl || null;
  const reference = result.trackingId || result.reference || null;
  const isRequest = Boolean(result.trackingId);

  // §6.5 step 4: the retainer is raised with the brief, so the success screen
  // shows what to pay against — a checkout link when a PSP is configured, bank
  // transfer instructions when it is not. Never "we will send you a link".
  const retainer = result.retainer || null;
  const retainerBlock = retainer
    ? `
      <div class="card card__body mt-2">
        <h4 class="mb-1">Your retainer</h4>
        <p class="mb-1">
          <strong>${naira(retainer.amountKobo)}</strong> — credited against the success fee if you buy
          through us, refunded in full if we find nothing that meets your brief.
        </p>
        <p class="reference-chip">Pay against: <strong>${retainer.reference}</strong></p>
        ${
          retainer.hosted && retainer.checkoutUrl
            ? `<a class="btn btn--primary" href="${retainer.checkoutUrl}" rel="noopener">Pay the retainer</a>`
            : `<p class="field__hint mb-0">No card provider is connected in this build, so pay by bank transfer
                 using the reference above and reply on WhatsApp with the receipt. Ops confirms it and the
                 search starts immediately — nobody waits on the money.</p>`
        }
      </div>`
    : '';

  if (kind === 'contact') {
    container.innerHTML = `
      <h3 class="mb-0">Message received</h3>
      <p class="mb-1">It is in the same queue the ops desk reads — a human replies, usually within working hours.</p>
      <div class="btn-row">
        ${wa ? `<a class="btn btn--primary" href="${wa}" target="_blank" rel="noopener" data-event="whatsapp_click" data-source="contact_success">Continue on WhatsApp</a>` : ''}
        <a class="btn btn--secondary" href="/faq">Browse the FAQ</a>
      </div>
    `;
    container.classList.remove('hidden');
    container.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.dispatchEvent(new CustomEvent('hc:request-created', { detail: { kind, ...result } }));
    return;
  }

  container.innerHTML = `
    <h3 class="mb-0">${isRequest ? 'Brief received' : 'Slot requested'}</h3>
    <p class="mb-1">
      ${isRequest
        ? 'A human reads every brief. Your options land on WhatsApp inside the SLA you picked.'
        : 'We hold the slot and confirm on WhatsApp within working hours.'}
    </p>
    ${reference ? `<p class="reference-chip">Your reference: <strong>${reference}</strong></p>` : ''}
    <ul class="tick-list">
      <li class="tick-list__yes">We reply on WhatsApp — usually within minutes</li>
      ${isRequest ? '<li class="tick-list__yes">Three verified options in 48–72 hours</li>' : '<li class="tick-list__yes">Inspector or rep details sent before the appointment</li>'}
      ${retainer
        ? '<li class="tick-list__yes">Retainer quoted up front — nothing hidden in the success fee</li>'
        : `<li class="tick-list__yes">No payment is taken here${isRequest ? ' — the retainer is settled after the brief is confirmed' : ''}</li>`}
    </ul>
    ${retainerBlock}
    <div class="btn-row">
      ${wa ? `<a class="btn btn--primary" href="${wa}" target="_blank" rel="noopener" data-event="whatsapp_click" data-source="form_success">Continue on WhatsApp</a>` : ''}
      ${isRequest && reference ? `<a class="btn btn--secondary" href="/concierge/${reference}">Track this request</a>` : ''}
    </div>
    <p class="field__hint mb-0">Filed from <code>/services/${serviceSlug}</code>. Keep the reference — it is how we find you without asking for your name again.</p>
  `;
  container.classList.remove('hidden');
  container.scrollIntoView({ block: 'center', behavior: 'smooth' });

  // Tell the rest of the page (toast, analytics) that something real happened.
  window.dispatchEvent(new CustomEvent('hc:request-created', { detail: { kind, ...result } }));
}
