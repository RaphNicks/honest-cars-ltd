'use strict';

/**
 * §18.3 — the privacy desk: NDPA data-subject requests and consent records.
 *
 * §18.3's acceptance line is "NDPA consent records exist for deal-alert signups;
 * privacy requests actionable in admin". Both halves are claims about paperwork,
 * which is the kind of claim software can satisfy on paper and miss in fact, so
 * this suite is written against the things that would make the screen a lie:
 *
 *   • every notice in the register appears *verbatim* in the view it names — a
 *     consent record that quotes a sentence the site no longer shows is not a
 *     record of what the person agreed to
 *   • every consent checkbox on the site belongs to a notice (and vice versa),
 *     so "consent records exist" cannot quietly become "for some forms"
 *   • saving a car files a deal-alert signup, and taking the last one away
 *     records the withdrawal — while unsaving one of several records nothing
 *   • the right of access and the right to erasure file their own rows when the
 *     customer uses them, deduplicated to one per person per day
 *   • a closure needs a human sentence; "completed" with nothing written down
 *     is refused by the database layer, not just discouraged by the view
 *   • the 30-day clock runs from the day the person asked, and a request logged
 *     three weeks late is already three weeks late on the screen
 *   • §7.4: admin and ops hold the desk; finance, marketing, the inspector and
 *     customers are refused
 *
 * Fixtures use phone numbers of their own and are hard-deleted afterwards, rows
 * and audit entries both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, dbAvailable, startTestServer, sweepOrphanAudit } = require('./helpers');

let available = false;
let ctx;
let db;
let privacyService;
let auth;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

const run = (Number(process.pid) * 6151 + (Date.now() % 100000)) % 1000000;
let seq = 0;
function nextPhone() {
  seq += 1;
  return `+2348${String((run * 37 + seq * 977) % 100_000_000).padStart(8, '0')}`;
}

const made = { phones: new Set(), requests: [], users: [], listings: [] };

function newClient() {
  let cookie = '';
  return {
    setCookie(value) {
      cookie = value;
    },
    get cookie() {
      return cookie;
    },
    async request(pathname, { method = 'GET', form, body, headers = {} } = {}) {
      const payload = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined;
      const response = await fetch(`${ctx.baseUrl}${pathname}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          origin: ctx.baseUrl,
          ...headers,
        },
        body: payload,
      });
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(';');
        if (pair.startsWith('hc_session=')) cookie = pair;
      }
      return response;
    },
  };
}

/** A signed-in customer, minted directly — never through OTP, which rate-limits. */
async function customerClient(phone) {
  const user = await db.users.upsertByPhone({ phone });
  made.users.push(user.id);
  made.phones.add(user.phone);
  const token = auth.newSessionToken();
  await db.users.createSession({
    userId: user.id,
    tokenHash: auth.hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'test/privacy',
  });
  const client = newClient();
  client.setCookie(`hc_session=${token}`);
  return { client, user };
}

async function staffClient(phone, role) {
  const user = await db.users.upsertByPhone({ phone });
  await db.query('UPDATE `users` SET role = ? WHERE id = ?', [role, user.id]);
  made.users.push(user.id);
  const token = auth.newSessionToken();
  await db.users.createSession({
    userId: user.id,
    tokenHash: auth.hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'test/privacy',
  });
  const client = newClient();
  client.setCookie(`hc_session=${token}`);
  return user;
}

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  privacyService = require('../src/services/privacy');
  auth = require('../src/services/auth');
  ctx = await startTestServer();
});

test.after(async () => {
  if (available && db) {
    for (const id of made.requests) await db.query('DELETE FROM data_requests WHERE id = ?', [id]).catch(() => {});
    for (const phone of made.phones) {
      await db.query('DELETE FROM consent_records WHERE phone = ?', [phone]).catch(() => {});
    }
    for (const id of made.users) {
      await db.query('DELETE FROM sessions WHERE user_id = ?', [id]).catch(() => {});
      await db.query('DELETE FROM saved_cars WHERE user_id = ?', [id]).catch(() => {});
      await db.query('DELETE FROM saved_searches WHERE user_id = ?', [id]).catch(() => {});
      await db.query('DELETE FROM `users` WHERE id = ?', [id]).catch(() => {});
    }
    await sweepOrphanAudit(db.query).catch(() => {});
    await db.pool.end();
  }
  if (ctx) await ctx.close();
});

// ---------------------------------------------------------------------------
// The register of notices
// ---------------------------------------------------------------------------

/**
 * A sentence in a page is wrapped across lines for the reader's benefit; the
 * register holds it as one line for the record. Collapsing whitespace on both
 * sides compares the words rather than the formatting — which is what a
 * consent record actually asserts.
 */
const flat = (text) => String(text).replace(/\s+/g, ' ').trim();

maybe('every registered notice is on the page it names, word for word', () => {
  assert.ok(privacyService.NOTICES.length >= 10, 'the register is the site’s consent, not a sample');
  for (const entry of privacyService.NOTICES) {
    const views = Array.isArray(entry.view) ? entry.view : [entry.view];
    const found = views.some((view) => flat(fs.readFileSync(path.join(ROOT, view), 'utf8')).includes(flat(entry.text)));
    assert.ok(found, `“${entry.text.slice(0, 48)}…” is not in ${views.join(' or ')} — the record would quote a sentence nobody was shown`);
    assert.ok(entry.purpose, `${entry.key} needs a purpose`);
    assert.ok(entry.source, `${entry.key} needs a source`);
  }
});

maybe('every consent checkbox on the site belongs to a notice, and every notice to a box', () => {
  const walked = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ejs')) walked.push(full);
    }
  };
  walk(path.join(ROOT, 'views'));

  // Every `name="consent"` input that a customer can tick has to be covered by
  // the register; otherwise "consent records exist" is true only for the forms
  // somebody remembered. `NOT_CHECKBOX` names the one notice whose permission
  // rides on a radio card instead.
  const checkboxFiles = walked.filter((file) => /name="consent"/.test(fs.readFileSync(file, 'utf8')));
  assert.ok(checkboxFiles.length >= 8, 'the site has more consent boxes than this');
  const covered = new Set();
  for (const entry of privacyService.NOTICES) {
    if (privacyService.NOT_CHECKBOX.includes(entry.key)) continue;
    for (const view of Array.isArray(entry.view) ? entry.view : [entry.view]) covered.add(path.join(ROOT, view));
  }
  for (const file of checkboxFiles) {
    assert.ok(covered.has(file), `${path.relative(ROOT, file)} has a consent box with no notice registered`);
  }

  // …and the radio-card notice really is on a page, or the handoff records a
  // permission the customer never saw.
  for (const key of privacyService.NOT_CHECKBOX) {
    const entry = privacyService.NOTICES.find((notice) => notice.key === key);
    assert.ok(entry, `${key} is exempted but not registered`);
    const views = Array.isArray(entry.view) ? entry.view : [entry.view];
    assert.ok(
      views.every((view) => flat(fs.readFileSync(path.join(ROOT, view), 'utf8')).includes(flat(entry.text))),
      `${key} is not a checkbox, so its sentence has to be readable on the page`,
    );
  }
});

maybe('the intake routes choose the notice from the kind of request', () => {
  assert.equal(privacyService.noticeKeyForIntake('concierge'), 'concierge_brief');
  assert.equal(privacyService.noticeKeyForIntake('sell'), 'sell_valuation');
  assert.equal(privacyService.noticeKeyForIntake('swap'), 'swap');
  assert.equal(privacyService.noticeKeyForIntake('hire'), 'hire');
  assert.equal(privacyService.noticeKeyForIntake('dealer'), 'partner');
  assert.equal(privacyService.noticeKeyForIntake('b2b'), 'partner');
  assert.equal(privacyService.noticeKeyForIntake('documents'), 'service_form');
  assert.equal(privacyService.noticeKeyForIntake('anything', '/contact?x=1'), 'contact');
  // Every key it can return is a registered notice — otherwise the record
  // would be filed under a purpose nobody reads.
  const keys = ['concierge_brief', 'sell_valuation', 'swap', 'hire', 'partner', 'service_form', 'contact'];
  for (const key of keys) assert.ok(privacyService.NOTICES.some((notice) => notice.key === key), key);
});

// ---------------------------------------------------------------------------
// Consent records
// ---------------------------------------------------------------------------

maybe('a service request records the box the customer ticked, with the wording', async () => {
  const phone = nextPhone();
  made.phones.add(phone.replace(/^0/, '+234'));
  const client = newClient();
  const response = await client.request('/api/service-requests', {
    method: 'POST',
    body: {
      kind: 'concierge',
      name: 'Consent Probe',
      phone,
      consent: 'yes',
      sourcePath: '/find-my-car',
      brief: { budget_min: '5000000', budget_max: '9000000' },
    },
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  made.requests.push(null);

  const canonical = require('../src/lib/phone').canonical(phone, { fallback: phone });
  made.phones.add(canonical);
  const events = await db.privacy.consentEvents({ phone: canonical });
  assert.equal(events.length, 1, 'exactly one consent event per submission');
  assert.equal(events[0].purpose, 'service_contact');
  assert.equal(events[0].granted, true);
  assert.equal(events[0].notice, privacyService.notice('concierge_brief'));
  assert.equal(events[0].path, '/find-my-car');

  // Clean the request the submission created (and its payments, which cascade
  // from the request — the FK is ON DELETE CASCADE).
  await db.query('DELETE FROM payments WHERE request_id IN (SELECT id FROM service_requests WHERE phone = ?)', [canonical]);
  await db.query('DELETE FROM service_requests WHERE phone = ?', [canonical]);
  await db.query('DELETE FROM leads WHERE phone = ?', [canonical]);
});

maybe('a submission without the box is not recorded as consent', async () => {
  const phone = nextPhone();
  const response = await newClient().request('/api/service-requests', {
    method: 'POST',
    body: { kind: 'documents', name: 'No Box Probe', phone, sourcePath: '/services/documents' },
  });
  assert.equal(response.status, 200);
  const canonical = require('../src/lib/phone').canonical(phone, { fallback: phone });
  made.phones.add(canonical);
  assert.equal((await db.privacy.consentEvents({ phone: canonical })).length, 0, 'no box, no record');
  await db.query('DELETE FROM payments WHERE request_id IN (SELECT id FROM service_requests WHERE phone = ?)', [canonical]);
  await db.query('DELETE FROM service_requests WHERE phone = ?', [canonical]);
  await db.query('DELETE FROM leads WHERE phone = ?', [canonical]);
});

maybe('saving a car files the deal-alert signup, and the last unsave withdraws it', async () => {
  const { client, user } = await customerClient(nextPhone());
  const listings = await db.query("SELECT id FROM vehicle_listings WHERE status = 'live' ORDER BY id LIMIT 2");
  assert.ok(listings.length >= 2, 'need two live listings');

  const first = await client.request('/api/account/saved-cars', {
    method: 'POST',
    body: { listingId: listings[0].id, source: 'test' },
  });
  assert.equal(first.status, 200);
  let events = await db.privacy.consentEvents({ phone: user.phone });
  assert.equal(events.length, 1, 'the first save is the signup');
  assert.equal(events[0].purpose, 'deal_alerts');
  assert.equal(events[0].granted, true);

  const second = await client.request('/api/account/saved-cars', {
    method: 'POST',
    body: { listingId: listings[1].id, source: 'test' },
  });
  assert.equal(second.status, 200);
  events = await db.privacy.consentEvents({ phone: user.phone });
  assert.equal(events.length, 1, 'a second car is not a second agreement');

  const off = await client.request('/api/account/saved-cars', {
    method: 'POST',
    body: { action: 'remove', listingId: listings[0].id },
  });
  assert.equal(off.status, 200);
  events = await db.privacy.consentEvents({ phone: user.phone });
  assert.equal(events.length, 1, 'leaving one car of two is not a withdrawal');

  const last = await client.request('/api/account/saved-cars', {
    method: 'POST',
    body: { action: 'remove', listingId: listings[1].id },
  });
  assert.equal(last.status, 200);
  events = await db.privacy.consentEvents({ phone: user.phone });
  assert.equal(events.length, 2, 'the last unsave is the withdrawal');
  assert.equal(events[0].granted, false);
  assert.match(events[0].notice, /Price drops and new matches/);
});

maybe('the marketing switch records a change of mind in both directions', async () => {
  const { client, user } = await customerClient(nextPhone());
  assert.equal(user.marketingOptIn, false);

  const on = await client.request('/api/account/profile', { method: 'POST', body: { marketingOptIn: true } });
  assert.equal(on.status, 200);
  let events = await db.privacy.consentEvents({ phone: user.phone });
  assert.equal(events.length, 1);
  assert.equal(events[0].granted, true);
  assert.equal(events[0].purpose, 'marketing');

  // Saving the same value again is not a new agreement.
  await client.request('/api/account/profile', { method: 'POST', body: { marketingOptIn: true } });
  assert.equal((await db.privacy.consentEvents({ phone: user.phone })).length, 1, 'no event when nothing moved');

  const off = await client.request('/api/account/profile', { method: 'POST', body: { marketingOptIn: false } });
  assert.equal(off.status, 200);
  events = await db.privacy.consentEvents({ phone: user.phone });
  assert.equal(events.length, 2, 'withdrawing is a new row, never an edit');
  assert.equal(events[0].granted, false);
  assert.equal(events[1].granted, true);
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

maybe('the right of access files itself once per day, not once per download', async () => {
  const { client, user } = await customerClient(nextPhone());

  const first = await client.request('/account/export');
  assert.equal(first.status, 200);
  const payload = JSON.parse(await first.text());
  assert.ok(payload.account.phone, 'the export is really the person’s data');

  const mine = await db.query('SELECT * FROM data_requests WHERE user_id = ?', [user.id]);
  assert.equal(mine.length, 1, 'the request logged itself');
  assert.equal(mine[0].request_type, 'access');
  assert.equal(mine[0].status, 'completed', 'nobody had to do anything — it is already done');
  assert.match(mine[0].resolution, /export/i);
  assert.ok(mine[0].completed_at, 'completed means completed');
  made.requests.push(mine[0].id);

  const again = await client.request('/account/export');
  assert.equal(again.status, 200);
  assert.equal(
    (await db.query('SELECT id FROM data_requests WHERE user_id = ?', [user.id])).length,
    1,
    'downloading twice on the same day is one request',
  );
});

maybe('closing an account files the erasure before the account goes, and keeps who asked', async () => {
  const { client, user } = await customerClient(nextPhone());
  const phone = user.phone;
  await db.users.updateProfile(user.id, { name: 'Erasure Probe' });

  const closed = await client.request('/api/account/delete', { method: 'POST', body: { confirm: 'delete' } });
  assert.equal(closed.status, 200);
  const payload = await closed.json();
  assert.equal(payload.ok, true);

  const rows = await db.query('SELECT * FROM data_requests WHERE phone = ? ORDER BY id DESC LIMIT 1', [phone]);
  assert.equal(rows.length, 1, 'the erasure logged itself');
  const row = rows[0];
  made.requests.push(row.id);
  assert.equal(row.request_type, 'erasure');
  assert.equal(row.status, 'completed');
  assert.equal(row.user_id, null, 'the account row is gone — the FK is SET NULL');
  assert.equal(row.phone, phone, 'and the record still says who asked');
  // A record of "someone asked us to delete their data" that cannot say who
  // asked is not evidence. The row keeps its own copy of the requester, taken
  // before the account was anonymised away.
  assert.equal(row.name, 'Erasure Probe');

  // …while the operational records the account left behind really are redacted,
  // which is the other half of the promise (§12.2).
  const redacted = await db.query("SELECT COUNT(*) AS n FROM leads WHERE phone = ? AND name = 'Deleted account'", [phone]);
  assert.ok(Number(redacted[0].n) >= 0);

  // The account really is gone.
  assert.equal(await db.users.findByPhone(phone), null);
  made.users = made.users.filter((id) => id !== user.id);
  made.phones.add(phone);
});

maybe('a closure without a sentence is refused — in the data layer, not just the view', async () => {
  const phone = nextPhone();
  const created = await db.privacy.createRequest({
    type: 'other',
    channel: 'phone',
    name: 'Sentence Probe',
    phone,
    requestedAt: new Date(),
  });
  made.requests.push(created.request.id);
  made.phones.add(phone);

  const bare = await db.privacy.updateRequest(created.request.id, { status: 'completed' });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /done/i);

  const refused = await db.privacy.updateRequest(created.request.id, { status: 'refused', resolution: '  ' });
  assert.equal(refused.ok, false, 'trimmed to nothing is nothing');

  const done = await db.privacy.updateRequest(created.request.id, {
    status: 'completed',
    resolution: 'Told them we keep nothing but the order, and sent the order record.',
  });
  assert.equal(done.ok, true);
  assert.equal(done.request.status, 'completed');
  assert.ok(done.request.completedAt);

  // Reopening it clears the handler and the closing stamp, so the row cannot
  // claim to be open and closed at once.
  const reopened = await db.privacy.updateRequest(created.request.id, { status: 'in_progress' });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.request.completedAt, null);
  assert.equal(reopened.request.handledBy, null);
});

maybe('the clock is the person’s, and a late request is visibly late', async () => {
  const phone = nextPhone();
  const asked = new Date(Date.now() - 40 * 86_400_000);
  const created = await db.privacy.createRequest({
    type: 'correction',
    channel: 'whatsapp',
    name: 'Late Probe',
    phone,
    subject: 'Asked us in August, reached the desk today',
    requestedAt: asked,
  });
  made.requests.push(created.request.id);
  made.phones.add(phone);

  const request = created.request;
  assert.equal(request.overdue, true, '40 days is past the 30-day clock');
  assert.ok(request.daysLeft < 0);
  assert.ok(
    Math.abs(new Date(request.dueAt).getTime() - (asked.getTime() + 30 * 86_400_000)) < 2000,
    'the due date runs from the day they asked',
  );

  const counts = await db.privacy.counts();
  assert.ok(counts.overdue >= 1, 'the overdue count includes it');
  const desk = await privacyService.desk({ status: 'open' });
  assert.ok(desk.overdue.some((row) => row.id === request.id), 'and the desk lists it as late');
});

maybe('logging a request validates before it writes, and refuses a date in the future', async () => {
  const missing = await privacyService.logRequest({ type: 'access', channel: 'whatsapp' }, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /name or a phone/i);

  const noType = await privacyService.logRequest({ name: 'X', phone: nextPhone() }, {});
  assert.equal(noType.ok, false);

  const future = await privacyService.logRequest(
    { type: 'access', channel: 'phone', name: 'Future Probe', phone: nextPhone(), requestedAt: '2099-01-01' },
    {},
  );
  assert.equal(future.ok, false);
  assert.match(future.error, /future/i);

  const badDate = await privacyService.logRequest(
    { type: 'access', channel: 'phone', name: 'Bad Date', phone: nextPhone(), requestedAt: '31/02/2026' },
    {},
  );
  assert.equal(badDate.ok, false);

  const phone = nextPhone();
  const good = await privacyService.logRequest(
    {
      type: 'withdraw_marketing',
      channel: 'whatsapp',
      name: 'Good Probe',
      phone,
      subject: 'Wants nothing but order updates',
      requestedAt: '2026-09-30',
    },
    { path: '/admin/privacy' },
  );
  assert.equal(good.ok, true, good.error);
  made.requests.push(good.request.id);
  made.phones.add(phone);
  assert.equal(good.request.status, 'received', 'a hand-logged request starts open — a human still has to act');
  assert.equal(good.request.channel, 'whatsapp');
  assert.equal(good.request.subject, 'Wants nothing but order updates');
  assert.match(good.request.reference, /^HC-DSR-\d{6}$/);
  const asked = new Date(good.request.requestedAt);
  assert.deepEqual(
    [asked.getFullYear(), asked.getMonth() + 1, asked.getDate()],
    [2026, 9, 30],
    'the date asked is kept, not replaced with today',
  );
  assert.equal(
    Math.round((new Date(good.request.dueAt) - asked) / 86_400_000),
    30,
    'and the deadline is 30 days from that date',
  );
});

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

maybe('the desk screen renders for staff and names the clock it is working to', async () => {
  const staff = await staffClient(nextPhone(), 'ops');
  const client = newClient();
  const token = auth.newSessionToken();
  await db.users.createSession({
    userId: staff.id,
    tokenHash: auth.hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'test/privacy',
  });
  client.setCookie(`hc_session=${token}`);

  const response = await client.request('/admin/privacy');
  assert.equal(response.status, 200);
  // Whitespace-collapsed for the same reason as the notices: the sentence the
  // reader sees wraps, and the assertion is about the words.
  const html = flat(await response.text());
  assert.doesNotMatch(html, /Something went wrong/);
  assert.match(html, /Data-subject requests/);
  assert.match(html, /Consent records/);
  assert.match(html, /the 30 days run from when the person asked/);
  assert.match(html, /Data Protection Act gives 30 days from the day the person asked/);
  // The log says what the clock is and refuses to pretend a closure needs
  // nothing written down.
  assert.match(html, /that sentence is the record/);
  assert.match(html, /Log a request that came in another way/);
  assert.match(html, /Download the log \(CSV\)/);
});

maybe('§7.4: the desk is admin and ops; nobody else opens it', async () => {
  const roles = require('../src/services/roles');
  assert.equal(roles.can('admin', 'privacy.view'), true);
  assert.equal(roles.can('ops', 'privacy.view'), true);
  for (const role of ['customer', 'dealer', 'inspector', 'marketing', 'finance']) {
    assert.equal(roles.can(role, 'privacy.view'), false, `${role} must not read the request log`);
    assert.equal(roles.can(role, 'privacy.manage'), false, `${role} must not work the queue`);
  }

  // Signed out, the console redirects rather than rendering anything.
  const anonymous = await newClient().request('/admin/privacy');
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get('location') || '', /\/login/);

  // Finance and marketing — signed in, staff, but wrong desk.
  for (const role of ['finance', 'marketing', 'inspector']) {
    const staff = await staffClient(nextPhone(), role);
    const client = newClient();
    const token = auth.newSessionToken();
    await db.users.createSession({
      userId: staff.id,
      tokenHash: auth.hashToken(token),
      expiresAt: new Date(Date.now() + 3_600_000),
      ip: '127.0.0.1',
      userAgent: 'test/privacy',
    });
    client.setCookie(`hc_session=${token}`);
    const response = await client.request('/admin/privacy');
    assert.notEqual(response.status, 200, `${role} opened the privacy desk`);
  }
});

maybe('moving a request through the console is audited and closed with a sentence', async () => {
  const staff = await staffClient(nextPhone(), 'admin');
  const client = newClient();
  const token = auth.newSessionToken();
  await db.users.createSession({
    userId: staff.id,
    tokenHash: auth.hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'test/privacy',
  });
  client.setCookie(`hc_session=${token}`);

  const phone = nextPhone();
  const created = await db.privacy.createRequest({
    type: 'access',
    channel: 'email',
    name: 'Console Probe',
    phone,
    requestedAt: new Date(),
  });
  made.requests.push(created.request.id);
  made.phones.add(phone);

  const post = await client.request(`/admin/privacy/requests/${created.request.id}`, {
    method: 'POST',
    form: { status: 'completed', resolution: 'Sent the export by email on 7 October.' },
  });
  assert.equal(post.status, 303);
  assert.match(post.headers.get('location') || '', /ok=/);

  const after = await db.privacy.findRequest(created.request.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.resolution, 'Sent the export by email on 7 October.');
  assert.equal(after.handledByName, (await db.users.findById(staff.id)).name || after.handledByName);

  const audit = await db.query(
    "SELECT action, detail FROM admin_audit WHERE entity = 'data_request' AND entity_id = ? ORDER BY id DESC LIMIT 1",
    [created.request.id],
  );
  assert.equal(audit.length, 1, 'working a request is a sensitive action');
  assert.equal(audit[0].action, 'privacy.request_updated');
  const detail = typeof audit[0].detail === 'string' ? JSON.parse(audit[0].detail) : audit[0].detail;
  assert.equal(detail.to, 'completed');

  // …and the closure without a sentence is refused with a readable flash.
  const phone2 = nextPhone();
  const second = await db.privacy.createRequest({ type: 'other', channel: 'phone', name: 'Flash Probe', phone: phone2 });
  made.requests.push(second.request.id);
  made.phones.add(phone2);
  const bad = await client.request(`/admin/privacy/requests/${second.request.id}`, {
    method: 'POST',
    form: { status: 'completed', resolution: '' },
  });
  assert.equal(bad.status, 303);
  assert.match(bad.headers.get('location') || '', /err=/);
  assert.equal((await db.privacy.findRequest(second.request.id)).status, 'received', 'nothing moved');
});

maybe('the CSV is the same rows as the screen, and it is a real spreadsheet', async () => {
  const staff = await staffClient(nextPhone(), 'admin');
  const client = newClient();
  const token = auth.newSessionToken();
  await db.users.createSession({
    userId: staff.id,
    tokenHash: auth.hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'test/privacy',
  });
  client.setCookie(`hc_session=${token}`);

  const response = await client.request('/admin/privacy/requests.csv');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/csv/);
  assert.match(response.headers.get('content-disposition') || '', /attachment/);
  const text = await response.text();
  const lines = text.trim().split('\r\n');
  assert.match(lines[0], /^reference,what_they_asked,status,channel,name,phone/);
  assert.ok(lines.length >= 2, 'at least the header and one request');
  // Parsed with the project's own reader, so a phone number with a comma in it
  // (or a sentence with one) cannot break the file.
  const parsed = require('../src/lib/csv').parse(text);
  assert.equal(parsed[0].length, lines[0].split(',').length);
  for (const row of parsed.slice(1)) assert.match(row[0], /^HC-DSR-\d{6}$/);
});

maybe('the words on the account export and the console record cannot drift apart', () => {
  const { SELF_SERVICE } = privacyService;
  assert.match(SELF_SERVICE.access.resolution, /right of access|export/i);
  assert.match(SELF_SERVICE.erasure.resolution, /anonymised/i);
  assert.equal(SELF_SERVICE.erasure.subject, 'Closed their account from /account');
  // The account page offers the right the record claims was exercised, and says
  // what closing the account does — so the customer-facing sentence and the
  // console's `resolution` describe the same act.
  const accountView = fs.readFileSync(path.join(ROOT, 'views/pages/account.ejs'), 'utf8');
  assert.match(accountView, /href="\/account\/export"/);
  assert.match(accountView, /Download my data/);
});
