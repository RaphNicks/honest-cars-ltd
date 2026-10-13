/**
 * FR-29 — the instant valuation widget (§6.6).
 *
 * An upgrade, never a requirement: the page it sits on already promises a free
 * human valuation within 24 hours, and the intake form below it works without
 * this file. What the script adds is an answer in seconds.
 *
 * Two habits it keeps, both visible to the visitor:
 *
 *   • **no invented numbers.** Everything it prints came from
 *     `GET /api/valuation`, which reads the price-intel table the VDP badge
 *     reads. When there is no band the widget says so and hands over to the
 *     human valuation rather than guessing.
 *   • **textContent, never innerHTML.** The make and model the visitor typed are
 *     echoed back in the sentence, so they are set as text.
 *
 * There is no §15.1 event for a valuation lookup and this build does not invent
 * event names, so the widget records nothing in analytics — the lead it
 * creates does, when the visitor sends the car for a human valuation.
 */

function readForm(form) {
  const value = (name) => {
    const field = form.querySelector(`[name="${name}"]`);
    return field ? field.value.trim() : '';
  };
  return {
    make: value('make'),
    model: value('model'),
    year: value('year'),
    condition: value('condition') || 'any',
    mileage_km: value('mileage_km'),
  };
}

/** The status line above the result — where a screen reader hears it. */
function setStatus(root, message, tone = 'muted') {
  const status = root.querySelector('[data-valuation-status]');
  if (!status) return;
  status.textContent = message || '';
  status.dataset.tone = tone;
}

function renderEmpty(root, data) {
  const result = root.querySelector('[data-valuation-result]');
  result.hidden = false;
  result.dataset.tone = 'muted';
  result.replaceChildren();

  const headline = document.createElement('p');
  headline.className = 'valuation__headline';
  headline.textContent = data.verdict.headline;
  result.append(headline);

  const detail = document.createElement('p');
  detail.className = 'valuation__detail';
  detail.textContent = data.verdict.detail;
  result.append(detail);

  if (data.alternatives && data.alternatives.length) {
    const label = document.createElement('p');
    label.className = 'valuation__note';
    label.textContent = `Models we do hold bands for: ${data.alternatives.map((alt) => alt.model).join(', ')}.`;
    result.append(label);
  }

  result.append(humanCta(data, root));
}

function humanCta(data, root) {
  const wrap = document.createElement('div');
  wrap.className = 'valuation__cta';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--primary';
  button.textContent = data.humanCta.label;
  button.addEventListener('click', () => {
    // Carry what they typed into the intake form below, so the human valuation
    // starts from the same facts rather than asking twice.
    const form = root.querySelector('[data-valuation-form]');
    const flow = document.querySelector('[data-flow="sell"] form');
    if (flow && form) {
      for (const name of ['make', 'model', 'year', 'mileage_km']) {
        const from = form.querySelector(`[name="${name}"]`);
        const to = flow.querySelector(`[name="${name}"]`);
        if (from && to && from.value.trim()) to.value = from.value.trim();
      }
      // Condition is a radio group in the intake, so it is *selected*, not
      // assigned — setting .value on a radio would look like it worked and
      // change nothing.
      const condition = form.querySelector('[name="condition"]');
      // “Let us assume” is not a condition: leave the intake's own default alone.
      if (condition && condition.value && condition.value !== 'any') {
        for (const radio of flow.querySelectorAll('input[type="radio"][name="condition"]')) {
          radio.checked = radio.value === condition.value;
        }
      }
    }
    const anchor = document.getElementById('sell-intake');
    if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const first = flow && flow.querySelector('[name="make"]');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 400);
  });
  wrap.append(button);

  const detail = document.createElement('span');
  detail.className = 'valuation__note';
  detail.textContent = data.humanCta.detail;
  wrap.append(detail);

  return wrap;
}

function renderBand(root, data) {
  const result = root.querySelector('[data-valuation-result]');
  result.hidden = false;
  result.dataset.tone = data.band.stale ? 'amber' : 'navy';
  result.replaceChildren();

  // The range *is* the headline, and it is the server's sentence verbatim —
  // formatting money in two places is how the page and the API end up quoting
  // different numbers for the same band.
  const range = document.createElement('p');
  range.className = 'valuation__range tabular';
  range.textContent = data.verdict.headline;
  result.append(range);

  const detail = document.createElement('p');
  detail.className = 'valuation__detail';
  detail.textContent = data.verdict.detail;
  result.append(detail);

  if (data.verdict.mileageNote) {
    const note = document.createElement('p');
    note.className = 'valuation__note';
    note.textContent = data.verdict.mileageNote;
    result.append(note);
  }

  if (data.verdict.staleNote) {
    const stale = document.createElement('p');
    stale.className = 'valuation__note valuation__note--warn';
    stale.textContent = data.verdict.staleNote;
    result.append(stale);
  }

  if (data.comparables) {
    const link = document.createElement('a');
    link.className = 'valuation__link';
    link.href = data.comparables.browsePath || `/cars?make=${encodeURIComponent(data.query.make)}&model=${encodeURIComponent(data.query.model)}`;
    link.textContent = `See the ${data.comparables.count} live ${data.query.model}${data.comparables.count === 1 ? '' : 's'} this is checked against`;
    result.append(link);
  }

  result.append(humanCta(data, root));
}

async function ask(root, form) {
  const button = form.querySelector('[type="submit"]');
  const inputs = readForm(form);
  setStatus(root, 'Checking the price-intel table…');
  if (button) button.disabled = true;

  try {
    const params = new URLSearchParams({
      make: inputs.make,
      model: inputs.model,
      year: inputs.year,
      condition: inputs.condition,
    });
    if (inputs.mileage_km) params.set('mileage_km', inputs.mileage_km);

    const response = await fetch(`/api/valuation?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      setStatus(root, data.error || 'We could not read the price table just now.', 'error');
      return;
    }

    setStatus(root, data.found ? 'Estimate ready.' : 'No band for that car yet.');
    if (data.found) renderBand(root, data);
    else renderEmpty(root, data);
  } catch (error) {
    // The honest failure: say what happened and point at the human valuation,
    // which does not depend on this request.
    setStatus(root, 'We could not reach the price table — send the car and a human will value it inside 24 hours.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

export function initValuation() {
  const roots = document.querySelectorAll('[data-valuation]');
  if (!roots.length) return;

  for (const root of roots) {
    const form = root.querySelector('[data-valuation-form]');
    if (!form) continue;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      ask(root, form);
    });
  }
}
