/**
 * Entry point. Vanilla ES modules, no bundler, no framework (§17.2).
 * Everything imported here is an *upgrade*: the HTML already works without it.
 */

import { bindDeclarativeEvents, observeImpressions, observeReadDepth, track } from './events.js';
import { initHeader } from './header.js';
import {
  initTabs,
  initAccordions,
  initInfoTips,
  initCopyLink,
  initWhatsappFloat,
  initGallery,
  initCompare,
  initRecentlyViewed,
  rememberViewed,
  toast,
} from './ui.js';
import { initFilters } from './filters.js';
import { initViewingModal, initInlineLeadForms } from './leads.js';
import { initServiceForms } from './service-forms.js';
import { initFlows } from './flow.js';
import { initAddToCart, initCartPage, initCheckoutPage, initComparePage } from './cart.js';
import { initLoadMore, initVideoFacades, initTableOfContents, initHelpful } from './blog.js';
import { initLogin, initSaveButtons, initAccount, initSaveSearch } from './account.js';

function boot() {
  bindDeclarativeEvents();
  initHeader();
  initTabs();
  initAccordions();
  initInfoTips();
  initCopyLink();
  initWhatsappFloat();
  initFilters();
  initViewingModal();
  initInlineLeadForms();
  initServiceForms();
  initFlows();
  initAddToCart();
  initCartPage();
  initCheckoutPage();
  initComparePage();
  initLoadMore();
  initVideoFacades();
  initTableOfContents();
  initHelpful();
  initGallery();
  initCompare();
  initLogin();
  initSaveButtons();
  initAccount();
  initSaveSearch();
  observeImpressions();

  // --- page-specific wiring ------------------------------------------------
  const vdp = document.querySelector('[data-listing-view]');
  if (vdp) {
    const listingId = Number(vdp.dataset.listingId);
    track('listing_view', {
      listing_id: listingId,
      grade: vdp.dataset.grade,
      price_position: vdp.dataset.pricePosition,
      source: 'vdp',
    });

    const title = vdp.querySelector('.vdp__title')?.textContent?.trim();
    const price = vdp.querySelector('.vdp-price')?.textContent?.trim();
    if (title) {
      rememberViewed({
        id: listingId,
        title,
        priceFormatted: price || '',
        url: location.pathname,
      });
    }
    initRecentlyViewed(listingId);
  }

  const article = document.querySelector('[data-article]');
  if (article) observeReadDepth(article);

  // Results were swapped in via fetch: rebind the bits that attach per card.
  document.addEventListener('hc:results-updated', () => {
    observeImpressions();
    initCompare();
    initInfoTips();
    initSaveButtons();
  });

  // A lead was created: nudge ops in the background, then be honest about it.
  window.addEventListener('hc:lead-created', (event) => {
    track('viewing_requested', { source: 'lead_confirmed', listing_id: event.detail?.leadId });
    toast('Request received. Our ops team will confirm on WhatsApp.', { variant: 'success' });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
