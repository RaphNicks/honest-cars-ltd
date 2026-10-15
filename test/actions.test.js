'use strict';

/**
 * The Actions page — everything waiting on you, in one screen.
 *
 * Verifies the console's "Actions" aggregate: it pulls together the blog posts
 * in review, the listings awaiting moderation, and the payments to confirm, and
 * gates each stack by the capability that allows the decision. The super admin
 * sees all three (the capability superset), a marketing person sees only the
 * posts, and someone without reports.view is locked out. A live count badge in
 * the nav reflects how much is waiting.
 *
 * Drives the real routes over HTTP against the real database, creates its own
 * scratch post / listing / payment and throwaway accounts, and removes every
 * one of them in test.after. It never signs in as a seeded demo account.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, sweepOrphanAudit, enrolMfa, completeMfa, makeAccount } = require('./helpers');
const roles = require('../src/services/roles');

let available = false;
let ctx;
let db;

const run = (Number(process.pid) * 6151 + (Date.now() % 100000)) % 1000000;
const stamp = `${run}${Date.now() % 1000}`;

let admin, marketing, inspector;
const created = { posts: [], listings: [], payments: [], paymentRefs: [], emails: new Set() };

function newClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, { method = 'GET', body, headers = {}, form } = {}) {
      const payload = form
        ? new URLSearchParams(form).toString()
        : body
          ? JSON.stringify(body)
          : undefined;
      const response = await fetch(`${ctx.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: payload,
      });
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        if (pair.split('=')[0] === 'hc_session') cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* html */
      }
      return { status: response.status, headers: response.headers, text, json };
    },
  };
}

/** A throwaway account of a given role, signed in (email code, MFA where it applies). */
async function createAccount(role, label) {
  const account = await makeAccount({ role, name: `${label} (actions test)` });
  created.emails.add(account.email);
  if (roles.MFA_ROLES.includes(role)) await enrolMfa(account.id);
  const client = newClient();
  const otp = await client.request('/api/auth/email/otp', { method: 'POST', body: { email: account.email, audience: 'staff' } });
  assert.equal(otp.status, 200, `code request failed for ${label}: ${otp.text}`);
  const verify = await client.request('/api/auth/email/verify', {
    method: 'POST',
    body: { email: account.email, code: otp.json.devCode, audience: 'staff' },
  });
  assert.equal(verify.status, 200, `sign-in failed for ${label}: ${verify.text}`);
  if (roles.MFA_ROLES.includes(role)) {
    const finished = await completeMfa(client, { userId: account.id });
    assert.equal(finished.status, 200, `second factor failed for ${label}: ${finished.text}`);
  }
  return { id: account.id, email: account.email, role, client };
}

async function scratchPost(title) {
  const slug = `actions-test-${stamp}-${created.posts.length}`;
  const result = await db.cms.createPost(
    {
      slug,
      title,
      excerpt: 'A fixture for the Actions test.',
      category: 'honest_buyers_guide',
      body: [['p', 'A short body so the post can be moved into review.']],
      authorName: 'Actions Test',
      authorRole: 'Editorial',
      heroImage: '/img/seed/hero-lot.svg',
      readMinutes: 1,
      makeTags: [],
      serviceCta: null,
      metaTitle: null,
      metaDescription: null,
      isFeatured: false,
    },
    { actorId: admin.id },
  );
  assert.ok(result.ok, `post create failed: ${result.error}`);
  created.posts.push(result.id);
  const moved = await db.cms.movePost(result.id, 'in_review', { actorId: admin.id });
  assert.ok(moved.ok, `post move failed: ${moved.error}`);
}

async function scratchListing(stockNo) {
  const dealer = await db.queryOne('SELECT id FROM dealers ORDER BY id LIMIT 1');
  const result = await db.query(
    `INSERT INTO vehicle_listings
       (stock_no, dealer_id, status, make, model, year, transmission, fuel_type, \`condition\`,
        mileage_km, asking_price_kobo, area, documents, seo_slug, honest_note, created_at, updated_at)
     VALUES (?, ?, 'in_review', 'Toyota', 'Actions Test', 2014, 'manual', 'petrol', 'nigerian_used',
             77000, 620000000, 'Woji',
             '{"customs_verified":true,"registration":true,"duty_sighted":false,"tinted_permit":false}',
             ?, 'A fixture for the Actions test.', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [stockNo, dealer.id, `actions-test-${stamp}`],
  );
  created.listings.push(result.insertId);
}

async function scratchPayment(amountKobo) {
  const result = await db.payments.createPayment({ amountKobo, customerName: 'Actions Fixture', actorId: admin.id });
  assert.ok(result.ok, `payment create failed: ${result.error}`);
  created.payments.push(result.id);
  created.paymentRefs.push(result.reference);
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  ctx = await startTestServer();
  admin = await createAccount('admin', 'Actions admin');
  marketing = await createAccount('marketing', 'Actions marketing');
  inspector = await createAccount('inspector', 'Actions inspector');

  await scratchPost(`The best ways to check a car before you buy, run ${stamp}`);
  await scratchListing(`HC-ACT-${stamp}`.slice(0, 24));
  await scratchPayment(500000000);
});

test.after(async () => {
  if (ctx) await ctx.close();
  if (!available) return;
  try {
    for (const id of created.payments) {
      await db.query('DELETE FROM payment_events WHERE payment_id = ?', [id]);
      await db.query('DELETE FROM payments WHERE id = ?', [id]);
    }
    for (const id of created.listings) await db.query('DELETE FROM vehicle_listings WHERE id = ?', [id]);
    for (const id of created.posts) await db.cms.deletePost(id, { actorId: admin ? admin.id : null }).catch(() => {});
    if (created.emails.size) {
      const emails = [...created.emails];
      const marks = emails.map(() => '?').join(',');
      await db.query(`DELETE FROM email_auth_codes WHERE email IN (${marks})`, emails);
      await db.query(`UPDATE admin_audit SET actor_id = NULL WHERE actor_id IN (SELECT id FROM \`users\` WHERE email IN (${marks}))`, emails);
      await db.query(`DELETE FROM \`users\` WHERE email IN (${marks})`, emails);
    }
    await sweepOrphanAudit(db.query);
  } finally {
    await db.pool.end();
  }
});

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

maybe('the super admin sees every pending stack in one place', async () => {
  const res = await admin.client.request('/admin/actions');
  assert.equal(res.status, 200);
  // All three stacks, because the super admin holds every capability.
  assert.ok(res.text.includes('Blog posts in review'), 'posts stack missing');
  assert.ok(res.text.includes('Listings awaiting moderation'), 'listings stack missing');
  assert.ok(res.text.includes('Payments to confirm'), 'payments stack missing');
  // The specific fixtures we just filed are on the page.
  assert.ok(res.text.includes('The best ways to check a car before you buy'), 'post row missing');
  assert.ok(res.text.includes(`HC-ACT-${stamp}`), 'listing row missing');
  assert.ok(res.text.includes(created.paymentRefs[0]), 'payment row missing');
  // The decision buttons point at the module endpoints they post to.
  assert.ok(res.text.includes('/admin/cms/posts/'));
  assert.ok(res.text.includes('/admin/listings/'));
  assert.ok(res.text.includes('/admin/payments/'));
  // The nav carries the Actions link with a live count of at least the 3 fixtures.
  assert.ok(res.text.includes('href="/admin/actions"'), 'Actions nav item missing');
  const badge = res.text.match(/admin-bar__badge[^>]*>(\d+)</);
  assert.ok(badge, 'the Actions nav badge is missing');
  assert.ok(Number(badge[1]) >= 3, `badge shows ${badge && badge[1]}, expected at least 3`);
});

maybe('a marketing person sees only the posts stack', async () => {
  const res = await marketing.client.request('/admin/actions');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Blog posts in review'));
  assert.ok(!res.text.includes('Listings awaiting moderation'));
  assert.ok(!res.text.includes('Payments to confirm'));
});

maybe('someone without reports.view is locked out of the page', async () => {
  const res = await inspector.client.request('/admin/actions');
  assert.equal(res.status, 403);
  assert.ok(!res.text.includes('Payments to confirm'));
});
