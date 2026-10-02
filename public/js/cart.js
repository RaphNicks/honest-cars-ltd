/**
 * Shop cart — §6.8.
 *
 * Guest checkout, no account: the cart lives in localStorage on the visitor's
 * device and is only turned into an order when they submit /checkout. Prices are
 * shown for convenience and recomputed on the server at checkout — a tampered
 * cart can never change what an order costs.
 *
 * Storefront rules encoded here:
 *   • trackers can request installation (creates the install booking / sub record)
 *   • parts never enter the cart — those links go to /services/parts
 *   • delivery fees are quoted by area at checkout, from the admin table
 */

import { track } from './events.js';

const CART_KEY = 'hc_cart';

export function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((line) => line && line.slug && line.qty > 0) : [];
  } catch {
    return [];
  }
}

function writeCart(lines) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
  } catch {
    /* private mode: the cart simply will not persist */
  }
  updateBadges(lines.length);
  return lines;
}

function updateBadges(count) {
  document.querySelectorAll('[data-cart-count]').forEach((el) => {
    el.textContent = String(count);
    el.hidden = count === 0;
  });
}

export function addToCart(product, quantity = 1) {
  const lines = readCart();
  const existing = lines.find((line) => line.slug === product.slug);
  if (existing) existing.qty = Math.min(10, existing.qty + quantity);
  else lines.push({ ...product, qty: Math.min(10, quantity) });
  writeCart(lines);
  return lines;
}

export function updateQty(slug, qty) {
  const lines = readCart()
    .map((line) => (line.slug === slug ? { ...line, qty: Math.max(1, Math.min(10, qty)) } : line));
  return writeCart(lines);
}

export function removeFromCart(slug) {
  return writeCart(readCart().filter((line) => line.slug !== slug));
}

function money(kobo) {
  return `₦${(Number(kobo) / 100).toLocaleString('en-NG')}`;
}

/* ------------------------------------------------------------ storefront */
export function initAddToCart(root = document) {
  updateBadges(readCart().length);

  root.querySelectorAll('[data-add-to-cart]').forEach((button) => {
    button.addEventListener('click', () => {
      const product = {
        slug: button.dataset.slug,
        name: button.dataset.name,
        priceKobo: Number(button.dataset.price || 0),
        image: button.dataset.image || '',
        category: button.dataset.category || '',
        installIncluded: button.dataset.install === 'yes',
      };
      addToCart(product, 1);
      track('add_to_cart', { item_id: product.slug, item_name: product.name, category: product.category, value: product.priceKobo / 100, currency: 'NGN' });
      button.textContent = 'Added ✓';
      window.setTimeout(() => { button.textContent = button.dataset.label || 'Add to cart'; }, 1600);
    });
  });

  root.querySelectorAll('[data-buy-now]').forEach((button) => {
    button.addEventListener('click', () => {
      addToCart({
        slug: button.dataset.slug,
        name: button.dataset.name,
        priceKobo: Number(button.dataset.price || 0),
        image: button.dataset.image || '',
        category: button.dataset.category || '',
      });
      const install = root.querySelector('[data-install-toggle]');
      if (install && install.checked) updateQty(button.dataset.slug, 1);
      location.href = '/checkout';
    });
  });
}

/* ------------------------------------------------------------------ cart */
export function initCartPage(root = document) {
  const container = root.querySelector('[data-cart-lines]');
  if (!container) return;
  const tally = root.querySelector('[data-cart-tally]');
  const checkoutButton = root.querySelector('[data-cart-checkout]');
  const emptyState = root.querySelector('[data-cart-empty]');

  const render = () => {
    const lines = readCart();
    const subtotal = lines.reduce((sum, line) => sum + Number(line.priceKobo) * line.qty, 0);

    if (!lines.length) {
      container.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      if (tally) tally.textContent = money(0);
      if (checkoutButton) checkoutButton.setAttribute('aria-disabled', 'true');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    container.innerHTML = lines
      .map(
        (line) => `
        <div class="cart-line" data-line="${line.slug}">
          <div class="cart-line__media">${line.image ? `<img src="${line.image}" alt="" width="120" height="90" loading="lazy">` : ''}</div>
          <div>
            <p class="cart-line__name mb-0"><strong>${line.name}</strong></p>
            <p class="mb-0 page-hero__meta">${money(line.priceKobo)} each${line.category === 'trackers' ? ' · tracker install available' : ''}</p>
          </div>
          <div>
            <div class="qty-control">
              <button class="btn btn--ghost" type="button" data-qty-down aria-label="One fewer ${line.name}">−</button>
              <span class="tabular" data-qty-value>${line.qty}</span>
              <button class="btn btn--ghost" type="button" data-qty-up aria-label="One more ${line.name}">+</button>
            </div>
            <p class="mb-0 mt-1"><button class="btn btn--sm btn--ghost" type="button" data-remove>Remove</button></p>
          </div>
        </div>`,
      )
      .join('');

    if (tally) tally.textContent = money(subtotal);
    if (checkoutButton) checkoutButton.removeAttribute('aria-disabled');

    container.querySelectorAll('[data-line]').forEach((row) => {
      const slug = row.dataset.line;
      const line = lines.find((item) => item.slug === slug);
      row.querySelector('[data-qty-up]')?.addEventListener('click', () => { updateQty(slug, line.qty + 1); render(); });
      row.querySelector('[data-qty-down]')?.addEventListener('click', () => {
        if (line.qty <= 1) removeFromCart(slug);
        else updateQty(slug, line.qty - 1);
        render();
      });
      row.querySelector('[data-remove]')?.addEventListener('click', () => { removeFromCart(slug); render(); });
    });
  };

  render();
  window.addEventListener('hc:cart-updated', render);
}

/* -------------------------------------------------------------- checkout */
export function initCheckoutPage(root = document) {
  const form = root.querySelector('[data-checkout-form]');
  if (!form) return;

  const summary = root.querySelector('[data-checkout-summary]');
  const areaSelect = form.querySelector('[name="deliveryArea"]');
  const errorEl = form.querySelector('[data-form-error]');
  const submit = form.querySelector('[data-submit]');

  const renderSummary = () => {
    const lines = readCart();
    if (!summary) return;
    const subtotal = lines.reduce((sum, line) => sum + Number(line.priceKobo) * line.qty, 0);
    const fee = Number((areaSelect && areaSelect.selectedOptions[0] && areaSelect.selectedOptions[0].dataset.fee) || 0);
    summary.innerHTML = `
      <div class="cart-summary__row"><span>${lines.length} item${lines.length === 1 ? '' : 's'}</span><span>${money(subtotal)}</span></div>
      <div class="cart-summary__row"><span>Delivery — ${areaSelect && areaSelect.value ? areaSelect.value : 'pickup'}</span><span>${fee ? money(fee) : 'Free'}</span></div>
      <div class="cart-summary__row cart-summary__row--total"><span>Total</span><span>${money(subtotal + fee)}</span></div>
      <p class="field__hint mb-0">Payment is arranged with ops after the order is confirmed — card checkout is not wired in this build.</p>
    `;
  };

  renderSummary();
  areaSelect?.addEventListener('change', renderSummary);
  if (!readCart().length) {
    form.classList.add('hidden');
    const empty = root.querySelector('[data-checkout-empty]');
    if (empty) empty.classList.remove('hidden');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorEl) errorEl.classList.add('hidden');

    const lines = readCart();
    if (!lines.length) {
      if (errorEl) {
        errorEl.textContent = 'Your cart is empty — add something from the shop first.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    const values = Object.fromEntries(new FormData(form).entries());
    if (!values.name || String(values.name).trim().length < 2) return fail('Please tell us your name.');
    if (!/^[+()\d\s-]{7,20}$/.test(String(values.phone || '').trim())) return fail('That phone number does not look right — please check it.');
    if (!values.consent) return fail('Tick the box so we can confirm the order with you.');

    const installToggle = form.querySelector('[data-install-toggle]');
    const installRequested = Boolean(installToggle && installToggle.checked);

    if (submit) {
      submit.disabled = true;
      submit.dataset.label = submit.textContent;
      submit.textContent = 'Placing order…';
    }

    track('begin_checkout', { value: lines.reduce((sum, line) => sum + Number(line.priceKobo) * line.qty, 0) / 100, currency: 'NGN', items: lines.map((line) => line.name).slice(0, 10) });

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(values.name).trim(),
          phone: String(values.phone).trim(),
          deliveryArea: values.deliveryArea,
          notes: values.notes || null,
          items: lines.map((line) => ({ slug: line.slug, qty: line.qty, installRequested })),
          sourcePath: '/checkout',
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        if (submit) { submit.disabled = false; submit.textContent = submit.dataset.label || 'Place order'; }
        return fail(body.error || 'That did not go through — please try again.');
      }

      // Order placed: the cart is no longer the visitor's problem.
      try { localStorage.removeItem(CART_KEY); } catch { /* ignore */ }
      location.href = body.url;
    } catch {
      if (submit) { submit.disabled = false; submit.textContent = submit.dataset.label || 'Place order'; }
      fail('Network problem — check your connection and try again.');
    }
  });

  function fail(message) {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
      errorEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/* ------------------------------------------------------------ compare page */
export function initComparePage(root = document) {
  const table = root.querySelector('[data-compare-table]');
  if (!table) return;
  const removeButtons = table.querySelectorAll('[data-compare-remove]');
  if (!removeButtons.length) return;

  removeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const ids = String(button.dataset.compareRemove).split(',').filter(Boolean);
      const url = new URL(location.href);
      if (ids.length) url.searchParams.set('ids', ids.join(','));
      else url.searchParams.delete('ids');
      location.href = url.toString();
    });
  });
}
