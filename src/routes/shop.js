'use strict';

/**
 * Products shop — §6.8.
 *
 *   GET /shop                 categories, product cards, FAQ, delivery rules
 *   GET /shop/:slug           product page: specs, install toggle, warranty,
 *                             delivery options, add-to-cart
 *   GET /cart                 cart shell (the lines are rendered from
 *                             localStorage by cart.js; the page is honest about
 *                             that and still works with the checkout form)
 *   GET /checkout             guest checkout: name, phone, delivery area
 *   GET /order/:orderNo       confirmation + what happens next
 *
 * Parts are service-led and route to /services/parts, never to self-checkout.
 * Trackers create a subscription record at purchase (§6.8).
 */

const express = require('express');
const db = require('../db');
const config = require('../config');
const seo = require('../services/seo');
const { sendPrebuiltOrRender, sendPage, CACHE } = require('../lib/respond');

const router = express.Router();

// ---------------------------------------------------------------------------
// /shop
// ---------------------------------------------------------------------------
async function buildShopLocals(category = null) {
  const [products, categories, faqs, counters, delivery] = await Promise.all([
    db.content.products({ category: category || null }),
    db.content.productCategories(),
    db.content.faqsForScope('page:shop'),
    db.listings.networkCounters(),
    db.commerce.deliveryAreas(),
  ]);

  const validCategory = categories.some((entry) => entry.key === category) ? category : null;
  const trail = [{ label: 'Shop' }];

  return {
    view: 'shop',
    page: {
      title: 'Shop — trackers, diagnostics and care kits',
      metaTitle: 'Shop — trackers, diagnostics, care kits',
      titleSuffix: true,
      description:
        'Trackers and security, OBD2 diagnostics and care kits — with installation included where it matters, delivery across Port Harcourt, and guest checkout.',
      canonical: '/shop',
      robots: validCategory ? 'index,follow' : 'index,follow',
      breadcrumbs: trail,
      bodyClass: 'page-shop',
      jsonLd: [
        seo.breadcrumbSchema([{ label: 'Home', href: '/' }, { label: 'Shop', href: '/shop' }]),
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: 'HonestCars shop',
          itemListElement: products.map((product, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: product.name,
            url: seo.absolute(product.url),
          })),
        },
        seo.faqSchema(faqs),
      ],
    },
    data: { products, categories, faqs, counters, delivery, category: validCategory, trail },
  };
}

router.get('/shop', async (req, res, next) => {
  try {
    const locals = await buildShopLocals(req.query.category ? String(req.query.category).slice(0, 40) : null);
    return await sendPrebuiltOrRender(req, res, { routePath: '/shop', ...locals });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /cart — §6.8. Rendered client-side from localStorage; the server still hands
// the page a complete shell plus the delivery table so nothing is invisible
// without JavaScript.
// ---------------------------------------------------------------------------
router.get('/cart', async (req, res, next) => {
  try {
    const [delivery, counters] = await Promise.all([db.commerce.deliveryAreas(), db.listings.networkCounters()]);
    return await sendPage(req, res, {
      routePath: '/cart',
      view: 'cart',
      cache: CACHE.ssr,
      page: {
        title: 'Your cart',
        metaTitle: 'Your cart',
        titleSuffix: true,
        description: 'Review your HonestCars shop order before checkout.',
        canonical: '/cart',
        robots: 'noindex,follow',
        breadcrumbs: [{ label: 'Shop', href: '/shop' }, { label: 'Cart' }],
        bodyClass: 'page-cart',
        jsonLd: [],
      },
      data: { delivery, counters, trail: [{ label: 'Cart' }] },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /checkout — guest checkout (§6.8). Delivery fees come from the DB table.
// ---------------------------------------------------------------------------
router.get('/checkout', async (req, res, next) => {
  try {
    const [delivery, counters] = await Promise.all([db.commerce.deliveryAreas(), db.listings.networkCounters()]);
    return await sendPage(req, res, {
      routePath: '/checkout',
      view: 'checkout',
      cache: CACHE.ssr,
      page: {
        title: 'Checkout',
        metaTitle: 'Checkout',
        titleSuffix: true,
        description: 'Guest checkout for the HonestCars shop — no account needed.',
        canonical: '/checkout',
        robots: 'noindex,follow',
        breadcrumbs: [{ label: 'Shop', href: '/shop' }, { label: 'Checkout' }],
        bodyClass: 'page-checkout',
        jsonLd: [],
      },
      data: { delivery, counters, trail: [{ label: 'Checkout' }] },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /order/:orderNo — confirmation. Private: it contains the buyer's details.
// ---------------------------------------------------------------------------
router.get('/order/:orderNo', async (req, res, next) => {
  try {
    const order = await db.commerce.findByOrderNo(req.params.orderNo);
    if (!order) return next();

    const subscriptions = await db.commerce.subscriptionsForOrder(order.orderNo);
    const delivery = await db.commerce.deliveryAreas();
    // The payment rows behind this order, newest first — the pending one is what
    // the confirmation page turns into transfer instructions (no PSP keys yet).
    const ledger = await db.payments.orderByNo(order.orderNo);
    const payments = ledger ? ledger.payments : [];
    const pendingPayment = payments.find((row) => row.status === 'pending') || null;

    return await sendPage(req, res, {
      routePath: `/order/${order.orderNo}`,
      view: 'order',
      cache: CACHE.private,
      page: {
        title: `Order ${order.orderNo}`,
        metaTitle: `Order ${order.orderNo}`,
        titleSuffix: false,
        description: 'Your HonestCars shop order and what happens next.',
        canonical: `/order/${order.orderNo}`,
        robots: 'noindex,nofollow',
        breadcrumbs: [{ label: 'Shop', href: '/shop' }, { label: order.orderNo }],
        bodyClass: 'page-order',
        jsonLd: [],
      },
      data: {
        order,
        subscriptions,
        delivery,
        payments,
        pendingPayment,
        bank: {
          name: config.business.bankAccountName,
          account: config.business.bankAccount,
          bank: config.business.bankName,
          note: 'Use the payment reference as the transfer narration so we can match it in seconds.',
        },
        paymentNotice: req.query.payment || null,
        trail: [{ label: order.orderNo }],
      },
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// /shop/:slug — product page
// ---------------------------------------------------------------------------
async function buildProductLocals(slug) {
  const product = await db.content.productBySlug(slug);
  if (!product) return null;

  const [related, faqs, delivery, counters] = await Promise.all([
    db.content.products({ category: product.category, limit: 5 }).then((rows) => rows.filter((row) => row.slug !== slug).slice(0, 3)),
    db.content.faqsForScope(`shop:${product.category}`),
    db.commerce.deliveryAreas(),
    db.listings.networkCounters(),
  ]);

  const trail = [{ label: 'Shop', href: '/shop' }, { label: product.categoryLabel, href: `/shop?category=${product.category}` }, { label: product.name }];
  const meta = {
    title: `${product.name} — ₦${(product.priceKobo / 100).toLocaleString('en-NG')} | HonestCars shop`,
    description: seo.truncate(`${product.summary} ${product.installIncluded ? 'Installation included in Port Harcourt. ' : ''}${product.warrantyText || ''}`, 158),
  };

  return {
    view: 'product',
    page: {
      title: seo.truncate(meta.title, 62),
      metaTitle: seo.truncate(meta.title, 62),
      titleSuffix: false,
      description: meta.description,
      canonical: product.url,
      breadcrumbs: trail,
      bodyClass: `page-product page-product--${product.category}`,
      jsonLd: [
        seo.breadcrumbSchema(trail.map((crumb) => ({ label: crumb.label, href: crumb.href }))),
        seo.productSchema(product),
        seo.faqSchema(faqs),
      ].filter(Boolean),
    },
    data: { product, related, faqs, delivery, counters, trail },
  };
}

router.get('/shop/:slug', async (req, res, next) => {
  try {
    const locals = await buildProductLocals(req.params.slug);
    if (!locals) return next();
    return await sendPrebuiltOrRender(req, res, { routePath: `/shop/${req.params.slug}`, ...locals });
  } catch (error) {
    return next(error);
  }
});

module.exports = { router, buildShopLocals, buildProductLocals };
