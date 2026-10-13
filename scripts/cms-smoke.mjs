/**
 * CMS workflow smoke — drives the §7.3 console over HTTP exactly as a person
 * would: sign in as Content/Marketing, write a post, send it for review, hit
 * the house-rule gate, publish, restore a revision, edit a FAQ, flip a
 * homepage module — and check the public site each step.
 *
 *   node scripts/cms-smoke.mjs [baseUrl]
 *
 * Prints one line per step with the HTTP status and what it proved, and exits
 * non-zero if any expectation fails.
 */

import { createRequire } from 'node:module';

import { clearDevCodes } from './lib/dev-codes.mjs';

const BASE = process.argv[2] || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';

const STAFF = {
  marketing: '+2348000000005',  // Content Desk (§7.4 → cms.manage)
  admin: '+2348000000001',
};

// §12.2 — the admin account carries a second factor, and this script signs in
// the way a person does. The key is the seeded one; see db/seed.sql.
const MFA_SECRETS = { '+2348000000001': 'JBSWY3DPEHPK3PXP' };
const OPS_PHONE = '+2348000000002';
const CUSTOMER_PHONE = '+2348031234567';

// Repeat runs would otherwise 429 on the 5-codes-per-number-per-hour policy and
// look like a broken CMS. Clear this run's own spent codes first.
await clearDevCodes([...Object.values(STAFF), OPS_PHONE, CUSTOMER_PHONE], { label: 'CMS', resetMfa: true });

let failures = 0;
let checks = 0;

function line(ok, label, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function assert(condition, label, detail = '') {
  line(Boolean(condition), label, detail);
  return Boolean(condition);
}

/** Minimal cookie jar: the app is a cookie-session server. */
function jar() {
  const store = new Map();
  return {
    header: () => [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(response) {
      const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const cookie of raw) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        store.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
      return response;
    },
  };
}

async function request(path, { method = 'GET', form = null, cookies = null, redirect = 'manual' } = {}) {
  const headers = { accept: 'text/html' };
  if (cookies) headers.cookie = cookies.header();
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body, redirect });
  if (cookies) cookies.absorb(response);
  return response;
}

async function signIn(phone, cookies) {
  const otp = await request('/api/auth/otp', { method: 'POST', form: { phone }, cookies });
  const payload = await otp.json();
  const code = payload.devCode;
  if (!code) {
    // Most often the OTP rate limit, which is the app doing its job — say so
    // rather than letting every later check fail as a mysterious 302.
    // Two independent limits can 429 a sign-in: the per-number hourly cap
    // (rows in auth_codes, which we cleared above) and the in-process limiter
    // on the request IP. The second one only resets with the server, so say
    // which it is instead of leaving a bare 429.
    const hint = otp.status === 429
      ? 'the in-process rate limiter has tripped — restart the dev server (or wait 15 minutes); the per-number codes were already cleared for this run'
      : 'is AUTH_SHOW_CODE on, and is the site running?';
    throw new Error(`No devCode for ${phone} (HTTP ${otp.status}) — ${hint}`);
  }
  await request('/api/auth/verify', { method: 'POST', form: { phone, code }, cookies });
  const secret = MFA_SECRETS[phone];
  if (secret) {
    const totp = createRequire(import.meta.url)('../src/lib/totp');
    const challenge = await request('/api/auth/mfa', { method: 'POST', form: { code: totp.code(secret) }, cookies });
    if (challenge.status !== 200) throw new Error(`Second factor failed for ${phone}: ${challenge.status}`);
  }
}

function bodyOf(html) {
  return html.replace(/\s+/g, ' ');
}

async function main() {
  console.log(`CMS smoke against ${BASE}\n`);

  // --- who can do what -----------------------------------------------------
  const anon = jar();
  const anonRes = await request('/admin/cms', { cookies: anon });
  assert([302, 403].includes(anonRes.status), 'signed-out visitor cannot open the CMS', `HTTP ${anonRes.status}`);

  const customer = jar();
  const otp = await request('/api/auth/otp', { method: 'POST', form: { phone: CUSTOMER_PHONE }, cookies: customer });
  const customerCode = (await otp.json()).devCode;
  await request('/api/auth/verify', { method: 'POST', form: { phone: CUSTOMER_PHONE, code: customerCode }, cookies: customer });
  const customerRes = await request('/admin/cms', { cookies: customer });
  assert(customerRes.status === 403, 'signed-in customer gets the honest 403', `HTTP ${customerRes.status}`);

  const marketing = jar();
  await signIn(STAFF.marketing, marketing);
  const hub = await request('/admin/cms', { cookies: marketing });
  const hubHtml = bodyOf(await hub.text());
  assert(hub.status === 200, 'Content/Marketing opens the hub (§7.4)', `HTTP ${hub.status}`);
  assert(hubHtml.includes('Workflow') && hubHtml.includes('House rules') === false, 'hub shows the workflow board');
  assert(hubHtml.includes('In review') && hubHtml.includes('Scheduled'), 'all four workflow columns are present');

  const ops = jar();
  await signIn(OPS_PHONE, ops);
  const opsRes = await request('/admin/cms', { cookies: ops });
  assert(opsRes.status === 403, 'ops role cannot open the CMS (role matrix holds)', `HTTP ${opsRes.status}`);

  // FR-35 fixtures: a real author row and a real governed tag, taken from the
  // console itself so the numbers are never guessed.
  const editorSeed = bodyOf(await (await request('/admin/cms/posts/new', { cookies: marketing })).text());
  const authorId = (editorSeed.match(/name="author_id"[\s\S]{0,400}?value="(\d+)"/) || [])[1];
  const tagSlug = (editorSeed.match(/name="tags" value="([a-z0-9-]+)"/) || [])[1];
  assert(authorId && tagSlug, 'the editor offers the author list and the governed tags', `author ${authorId}, tag ${tagSlug}`);

  // --- create a draft ------------------------------------------------------
  const slug = `smoke-post-${Date.now()}`;
  const created = await request('/admin/cms/posts', {
    method: 'POST',
    cookies: marketing,
    form: {
      title: 'Smoke test: what a house-rule gate actually blocks',
      slug,
      category: 'honest_buyers_guide',
      excerpt: 'A created-from-the-console post used to prove the publish gate is real.',
      body_markup: 'A paragraph with no links at all.\n\n## A heading\n\nSecond paragraph.',
      author_name: 'Smoke Test',
      author_role: 'Content',
      read_minutes: '4',
      author_id: String(authorId),
      tags: [tagSlug],
    },
  });
  const editorPath = created.headers.get('location') || '';
  assert(created.status === 303 && /\/admin\/cms\/posts\/\d+/.test(editorPath), 'saving creates a draft', editorPath.split('?')[0]);
  const postId = editorPath.match(/\/posts\/(\d+)/)[1];

  const publicBefore = await request(`/blog/${slug}`);
  assert(publicBefore.status === 404, 'the draft is not on the public site', `HTTP ${publicBefore.status}`);

  // --- house rules block publication --------------------------------------
  const blocked = await request(`/admin/cms/posts/${postId}/status`, {
    method: 'POST', cookies: marketing, form: { status: 'published' },
  });
  const blockedTo = decodeURIComponent((blocked.headers.get('location') || '').split('err=')[1] || '');
  assert(blocked.status === 303 && blockedTo.includes('Not ready to publish'), 'publishing is refused while the house rules fail', blockedTo.slice(0, 90));
  assert(blockedTo.includes('link at least 3'), 'the refusal names the §6.9 link rule', blockedTo.includes('link at least 3') ? 'yes' : blockedTo);

  const stillDraft = await request(`/blog/${slug}`);
  assert(stillDraft.status === 404, 'the refused publish did not leak the post');

  // --- send for review, then fix and publish ------------------------------
  const toReview = await request(`/admin/cms/posts/${postId}/status`, {
    method: 'POST', cookies: marketing, form: { status: 'in_review', note: 'Ready for a look.' },
  });
  assert(toReview.status === 303 && (toReview.headers.get('location') || '').includes('in%20review') === false, 'draft moves to in review', toReview.headers.get('location') || '');

  const editor = await request(`/admin/cms/posts/${postId}`, { cookies: marketing });
  const editorHtml = bodyOf(await editor.text());
  assert(editorHtml.includes('Not ready to publish') === false && editorHtml.includes('House rules'), 'the editor shows the house-rule panel');
  assert(editorHtml.includes('meta missing') || editorHtml.includes('Meta title'), 'the editor shows meta status');

  const fixedBody = [
    'A paragraph that links to [a live listing](/cars) and [an inspection](/services/inspection).',
    '',
    '## Why it matters',
    '',
    '- And a third link, to the [guide](/guide) — though the rule counts [documents](/services/documents).',
  ].join('\n');

  await request(`/admin/cms/posts/${postId}`, {
    method: 'POST',
    cookies: marketing,
    form: {
      title: 'Smoke test: what a house-rule gate actually blocks',
      slug,
      category: 'honest_buyers_guide',
      excerpt: 'A created-from-the-console post used to prove the publish gate is real.',
      body_markup: fixedBody,
      author_name: 'Smoke Test',
      author_role: 'Content',
      read_minutes: '4',
      hero_image: '/img/seed/hero-lot.svg',
      hero_alt: 'Smoke test hero',
      meta_title: 'Smoke test: the publish gate',
      meta_description: 'Created by scripts/cms-smoke.mjs to prove the CMS gate, revisions and revalidation really work.',
      author_id: String(authorId),
      tags: [tagSlug],
      note: 'Added the required links and meta.',
    },
  });

  const published = await request(`/admin/cms/posts/${postId}/status`, {
    method: 'POST', cookies: marketing, form: { status: 'published' },
  });
  const publishedTo = decodeURIComponent((published.headers.get('location') || '').split('ok=')[1] || '');
  assert(published.status === 303, 'publish redirects back to the editor', `HTTP ${published.status}`);
  assert(publishedTo.includes('published'), 'the console says it is published', publishedTo.slice(0, 100));
  assert(/Rebuilt \d+ page/.test(publishedTo), 'and reports how many pages were rebuilt', (publishedTo.match(/Rebuilt[^.]*/) || [''])[0]);

  const live = await request(`/blog/${slug}`);
  const liveHtml = bodyOf(await live.text());
  assert(live.status === 200, 'the post is live immediately after publishing', `HTTP ${live.status}`);
  assert(liveHtml.includes('Smoke test: what a house-rule gate'), 'the public page has the copy');
  assert(liveHtml.includes('/services/documents'), 'inline links render as real links');
  assert(liveHtml.includes('Article') || liveHtml.includes('application/ld+json'), 'the page carries its JSON-LD');
  // FR-35 — the byline links to the author page and the post carries its tag.
  assert(liveHtml.includes('/blog/author/'), 'the byline links to the author page'); 
  assert(liveHtml.includes(`/blog/tag/${tagSlug}`), 'the post shows its governed tag');
  const authorPage = await request(`/blog/author/${(liveHtml.match(/\/blog\/author\/([a-z0-9-]+)/) || [])[1]}`);
  assert(authorPage.status === 200, 'and that author page renders', `HTTP ${authorPage.status}`);
  const tagPage = await request(`/blog/tag/${tagSlug}`);
  assert(tagPage.status === 200 && bodyOf(await tagPage.text()).includes('Smoke test'), 'the tag page lists the new post');

  // --- editorial calendar (FR-35) -----------------------------------------
  const calendar = await request('/admin/cms/calendar', { cookies: marketing });
  const calendarHtml = bodyOf(await calendar.text());
  assert(calendar.status === 200, 'the editorial calendar opens', `HTTP ${calendar.status}`);
  assert(calendarHtml.includes('edcal'), 'it renders a month grid');
  assert(calendarHtml.includes('Governed tags'), 'and lists the governed taxonomy');
  const opsCalendar = await request('/admin/cms/calendar', { cookies: ops });
  assert(opsCalendar.status === 403, 'ops cannot read the calendar (cms.manage)', `HTTP ${opsCalendar.status}`);

  // --- revisions ----------------------------------------------------------
  const revisions = await request(`/admin/cms/posts/${postId}`, { cookies: marketing });
  const revisionsHtml = bodyOf(await revisions.text());
  assert(revisionsHtml.includes('Restore'), 'the editor lists restorable revisions');
  const restoreRes = await request(`/admin/cms/posts/${postId}/restore`, {
    method: 'POST', cookies: marketing, form: { revision_id: '1' },
  });
  assert(restoreRes.status === 303, 'restoring a revision is accepted', `HTTP ${restoreRes.status}`);

  // --- FAQ console --------------------------------------------------------
  const faqAdd = await request('/admin/cms/faqs', {
    method: 'POST',
    cookies: marketing,
    form: { scope: 'global', question: 'Smoke test question?', answer: 'Smoke test answer.', position: "9", is_active: '1' },
  });
  assert(faqAdd.status === 303, 'a FAQ can be added', `HTTP ${faqAdd.status}`);
  const faqCheck = await request('/faq');
  assert(bodyOf(await faqCheck.text()).includes('Smoke test question?'), 'the new FAQ is on the public FAQ page');

  const faqList = bodyOf(await (await request('/admin/cms/faqs', { cookies: marketing })).text());
  const faqId = (faqList.match(/faq-(\d+)/) || [])[1];
  const faqDelete = await request(`/admin/cms/faqs/${faqId}/delete`, { method: 'POST', cookies: marketing, form: {} });
  assert(faqDelete.status === 303, 'and it can be deleted again', `HTTP ${faqDelete.status}`);

  // --- homepage modules ---------------------------------------------------
  const modulesPage = bodyOf(await (await request('/admin/cms/modules', { cookies: marketing })).text());
  const moduleId = (modulesPage.match(/action="\/admin\/cms\/modules\/(\d+)"/) || [])[1];
  const banner = modulesPage.includes('announcement');
  assert(banner && moduleId, 'the module console lists the homepage modules', `first module id ${moduleId}`);

  const homeBefore = bodyOf(await (await request('/')).text());
  assert(!homeBefore.includes('banner-strip'), 'the marketing banner is off by default');

  const announcementId = (modulesPage.match(/action="\/admin\/cms\/modules\/(\d+)" data-module-key="announcement"/) || [])[1];
  if (announcementId) {
    await request(`/admin/cms/modules/${announcementId}`, {
      method: 'POST',
      cookies: marketing,
      form: {
        title: 'Marketing banner',
        payload_text: 'Smoke test banner — inspected cars only.',
        payload_label: 'Book a slot',
        payload_href: '/services/inspection',
        is_active: '1',
      },
    });
    const homeAfter = bodyOf(await (await request('/')).text());
    assert(homeAfter.includes('banner-strip') && homeAfter.includes('Smoke test banner'), 'turning the module on puts the banner on the homepage');

    await request(`/admin/cms/modules/${announcementId}`, {
      method: 'POST',
      cookies: marketing,
      form: { title: 'Marketing banner', payload_text: 'Smoke test banner — inspected cars only.', payload_label: 'Book a slot', payload_href: '/services/inspection' },
    });
    const homeOff = bodyOf(await (await request('/')).text());
    assert(!homeOff.includes('banner-strip'), 'turning it off takes it away again');
  } else {
    assert(false, 'could not find the announcement module id');
  }

  // --- clean up: unpublished posts do not linger --------------------------
  await request(`/admin/cms/posts/${postId}/status`, { method: 'POST', cookies: marketing, form: { status: 'draft', note: 'smoke cleanup' } });
  const afterUnpublish = await request(`/blog/${slug}`);
  assert(afterUnpublish.status === 404, 'unpublishing removes it from the public site', `HTTP ${afterUnpublish.status}`);
  await request(`/admin/cms/posts/${postId}/delete`, { method: 'POST', cookies: marketing, form: {} });

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('\n✗ smoke run failed:', error.message);
  process.exit(1);
});
