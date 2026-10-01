/**
 * Account + sign-in — §7.1.
 *
 *   • /login: two-step OTP (phone → code), resend, "use a different number",
 *     and the post-login hand-off (including "save this car", which is why the
 *     visitor was sent here in the first place).
 *   • Everywhere: the save / unsave toggle on cards and the VDP. Signed out it
 *     is a link into /login; signed in it posts to /api/account/saved-cars.
 *   • /account: profile form, saved-search alerts, delete confirmation,
 *     sign out.
 *
 * Progressive enhancement: without this file the sign-in page still posts to
 * the API, the save button still follows a real link, and every account form
 * is a normal form.
 */

import { track } from './events.js';
import { toast } from './ui.js';

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: 'We could not reach the server. Check your connection and try again.' };
  }
  return { status: response.status, ...payload };
}

function setMessage(el, text, state) {
  if (!el) return;
  el.textContent = text || '';
  if (state) el.dataset.state = state;
  else delete el.dataset.state;
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
export function initLogin(root = document) {
  const card = root.querySelector('[data-auth-card]');
  if (!card) return;

  const phoneStep = card.querySelector('[data-auth-step="phone"]');
  const codeStep = card.querySelector('[data-auth-step="code"]');
  const phoneInput = card.querySelector('#login-phone');
  const codeInput = card.querySelector('#login-code');
  const consent = phoneStep ? phoneStep.querySelector('input[name="consent"]') : null;
  const phoneLabel = card.querySelector('[data-auth-phone]');

  const next = card.dataset.next || '';
  const referral = card.dataset.ref || '';
  const params = new URLSearchParams(window.location.search);
  const pendingSave = params.get('save');
  let phone = '';

  const showStep = (step) => {
    const codeOn = step === 'code';
    phoneStep.classList.toggle('hidden', codeOn);
    phoneStep.hidden = codeOn;
    codeStep.classList.toggle('hidden', !codeOn);
    codeStep.hidden = !codeOn;
    if (codeOn && codeInput) codeInput.focus();
    else if (phoneInput) phoneInput.focus();
  };

  const requestCode = async (event) => {
    if (event) event.preventDefault();
    const message = phoneStep.querySelector('[data-auth-message]');
    setMessage(message, '');

    if (consent && !consent.checked) {
      return setMessage(message, 'Please tick the box so we know you agreed to be contacted on this number.', 'error');
    }

    const value = (phoneInput.value || '').trim();
    if (value.length < 7) return setMessage(message, 'Please enter a valid phone number.', 'error');

    const button = phoneStep.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    const result = await postJson('/api/auth/otp', { phone: value });
    if (button) button.disabled = false;

    if (!result.ok) return setMessage(message, result.error || 'We could not send a code just now.', 'error');

    phone = result.phone;
    if (phoneLabel) phoneLabel.textContent = result.maskedPhone;
    track('booking_started', { type: 'otp', source: 'login' });
    setMessage(codeStep.querySelector('[data-auth-message]'),
      result.delivered
        ? `Code sent on WhatsApp to ${result.maskedPhone}.`
        : `Code ready for ${result.maskedPhone}. ${result.devCode ? `Development code: ${result.devCode}` : 'Check WhatsApp.'}`,
      'ok');
    showStep('code');
    return undefined;
  };

  const verify = async (event) => {
    if (event) event.preventDefault();
    const message = codeStep.querySelector('[data-auth-message]');
    setMessage(message, '');
    const code = (codeInput.value || '').replace(/\D/g, '');
    if (code.length < 4) return setMessage(message, 'Enter the code we sent you.', 'error');

    const button = codeStep.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    const result = await postJson('/api/auth/verify', { phone, code, next, ref: referral });
    if (button) button.disabled = false;

    if (!result.ok) return setMessage(message, result.error || 'That code did not work.', 'error');

    setMessage(message, 'Signed in. Taking you through…', 'ok');

    // The reason we asked them to sign in: save the car they were looking at.
    if (pendingSave) {
      await postJson('/api/account/saved-cars', { listingId: Number(pendingSave), action: 'add', source: 'login' });
    }

    const target = pendingSave && next ? next : result.redirect || '/account';
    window.location.assign(target);
    return undefined;
  };

  phoneStep.addEventListener('submit', requestCode);
  codeStep.addEventListener('submit', verify);

  const restart = codeStep.querySelector('[data-auth-restart]');
  if (restart) restart.addEventListener('click', () => { showStep('phone'); phoneInput.focus(); });

  const resend = codeStep.querySelector('[data-auth-resend]');
  if (resend) {
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      const result = await postJson('/api/auth/otp', { phone });
      resend.disabled = false;
      setMessage(
        codeStep.querySelector('[data-auth-message]'),
        result.ok
          ? `New code sent to ${result.maskedPhone}.${result.devCode ? ` Development code: ${result.devCode}` : ''}`
          : result.error || 'We could not send another code yet — give it a minute.',
        result.ok ? 'ok' : 'error',
      );
    });
  }

  if (codeInput) {
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.replace(/\D/g, '');
      if (codeInput.value.length >= (Number(codeInput.maxLength) || 6)) verify();
    });
  }
}

// ---------------------------------------------------------------------------
// Save toggle — cards (icon) and the VDP (wide)
// ---------------------------------------------------------------------------
export function initSaveButtons(root = document) {
  const buttons = root.querySelectorAll('[data-save-car][data-listing-id]');
  if (!buttons.length) return;

  buttons.forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const listingId = Number(button.dataset.listingId);
      const removing = button.dataset.action === 'remove';
      button.setAttribute('aria-busy', 'true');

      const result = await postJson('/api/account/saved-cars', {
        listingId,
        action: removing ? 'remove' : 'add',
        source: button.dataset.source || (removing ? 'account' : 'card'),
        sourcePath: window.location.pathname,
      });

      button.removeAttribute('aria-busy');
      if (!result.ok) {
        if (result.status === 401) window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}&save=${listingId}`);
        return;
      }

      const nowSaved = Boolean(result.saved);
      button.dataset.action = nowSaved ? 'remove' : 'add';
      button.dataset.saved = nowSaved ? 'true' : 'false';
      button.classList.toggle('is-saved', nowSaved);
      button.setAttribute('aria-pressed', nowSaved ? 'true' : 'false');
      const label = button.querySelector('[data-save-label]');
      if (label) label.textContent = nowSaved ? 'Saved' : 'Save';

      // On the dashboard the row is a record — removing it should remove the card.
      if (!nowSaved && button.closest('[data-saved-car]')) {
        button.closest('[data-saved-car]').remove();
        if (!document.querySelectorAll('[data-saved-car]').length) window.location.reload();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Dashboard actions
// ---------------------------------------------------------------------------
export function initAccount(root = document) {
  const dashboard = root.querySelector('[data-profile-form]');
  const signOut = root.querySelector('[data-sign-out]');

  if (signOut) {
    signOut.addEventListener('click', async () => {
      const result = await postJson('/api/auth/logout', { source: 'account' });
      window.location.assign(result.redirect || '/');
    });
  }

  if (dashboard) {
    dashboard.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = dashboard.querySelector('[data-profile-message]');
      const data = new FormData(dashboard);
      const result = await postJson('/api/account/profile', {
        name: data.get('name') || '',
        email: data.get('email') || '',
        marketingOptIn: data.get('marketingOptIn') === 'on',
      });
      setMessage(message, result.ok ? 'Saved.' : result.error || 'We could not save that.', result.ok ? 'ok' : 'error');
    });
  }

  // §7.1: price-drop and new-match are separate switches per saved search.
  root.querySelectorAll('[data-search-alerts]').forEach((input) => {
    input.addEventListener('change', async () => {
      const key = input.dataset.searchAlerts === 'new_match' ? 'newMatch' : 'priceDrop';
      input.disabled = true;
      const result = await postJson('/api/account/saved-searches', {
        action: 'toggle',
        id: Number(input.dataset.id),
        [key]: input.checked,
      });
      input.disabled = false;
      if (!result.ok) {
        input.checked = !input.checked;
        toast('That switch did not save — check your connection and try again.', { variant: 'error' });
      }
    });
  });

  root.querySelectorAll('[data-delete-search]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await postJson('/api/account/saved-searches', { action: 'delete', id: Number(button.dataset.id) });
      if (result.ok) {
        const row = button.closest('[data-saved-search]');
        if (row) row.remove();
      }
    });
  });

  const copyReferral = root.querySelector('[data-copy-referral]');
  if (copyReferral) {
    copyReferral.addEventListener('click', async () => {
      const field = root.querySelector('[data-referral-link]');
      if (!field) return;
      field.select();
      try {
        await navigator.clipboard.writeText(field.value);
        copyReferral.textContent = 'Copied';
      } catch {
        // Clipboard blocked (http, or a locked-down browser): leave the field
        // selected so the visitor can copy it by hand.
        copyReferral.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => {
        copyReferral.textContent = 'Copy link';
      }, 2500);
    });
  }

  const deleteStart = root.querySelector('[data-account-delete]');
  const deleteForm = root.querySelector('[data-delete-form]');
  const deleteCancel = root.querySelector('[data-account-delete-cancel]');
  if (deleteStart && deleteForm) {
    deleteStart.addEventListener('click', () => {
      deleteForm.classList.remove('hidden');
      deleteForm.hidden = false;
      const input = deleteForm.querySelector('#delete-confirm');
      if (input) input.focus();
    });
  }
  if (deleteCancel && deleteForm) {
    deleteCancel.addEventListener('click', () => {
      deleteForm.classList.add('hidden');
      deleteForm.hidden = true;
    });
  }
  if (deleteForm) {
    deleteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = deleteForm.querySelector('[data-delete-message]');
      const confirm = (deleteForm.querySelector('#delete-confirm').value || '').trim().toLowerCase();
      if (confirm !== 'delete') return setMessage(message, 'Type “delete” to confirm.', 'error');
      const result = await postJson('/api/account/delete', { confirm });
      if (!result.ok) return setMessage(message, result.error || 'We could not close the account.', 'error');
      setMessage(message, 'Account closed.', 'ok');
      window.location.assign(result.redirect || '/');
      return undefined;
    });
  }
}

/**
 * "Save this search" on /cars — appears only for signed-in visitors, because
 * the server renders it (see partials/filters). Kept here so the button has one
 * behaviour everywhere.
 */
export function initSaveSearch(root = document) {
  const button = root.querySelector('[data-save-search]');
  if (!button) return;

  button.addEventListener('click', async () => {
    const message = root.querySelector('[data-save-search-message]');
    const query = window.location.search.replace(/^\?/, '');
    const result = await postJson('/api/account/saved-searches', {
      action: 'add',
      query,
      label: button.dataset.label || document.title.split('|')[0].trim(),
    });
    setMessage(message, result.ok ? 'Saved — you will find it in your account.' : result.error || 'Could not save that search.', result.ok ? 'ok' : 'error');
  });
}
