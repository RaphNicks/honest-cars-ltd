/**
 * §12.2 — the second factor on staff accounts.
 *
 * What this suite is for, in the order the acceptance criteria were written:
 *
 *   1. the arithmetic is RFC 6238's, checked against the published vectors;
 *   2. a code that has been spent cannot be spent again, ever;
 *   3. a half-finished enrolment protects nothing;
 *   4. recovery codes work once and only once;
 *   5. a session for a required role cannot reach a console page without it.
 *
 * The important checks run over HTTP, because "can this session open the
 * console" is a question about middleware, not about a function.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { dbAvailable, startTestServer, enrolMfa } = require('./helpers');
const db = require('../src/db');
const auth = require('../src/services/auth');
const roles = require('../src/services/roles');
const mfa = require('../src/services/mfa');
const totp = require('../src/lib/totp');

const maybe = dbAvailable ? test : test.skip;
const ctx = { baseUrl: null, close: null };
const made = { users: [], sessions: [] };

// The RFC 6238 appendix B secret: the ASCII string "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

const run = (Number(process.pid) * 7919 + (Date.now() % 100000)) % 1_000_000;
let seq = 0;
// `+234` + ten digits, the shape the seeded staff numbers use.
const nextPhone = () => `+23480${String((run * 53 + (seq += 1) * 613) % 100_000_000).padStart(8, '0')}`;

function newClient() {
  let cookie = null;
  const client = {
    cookie: () => cookie,
    async request(path, { method = 'GET', body, form, headers = {} } = {}) {
      const init = { method, redirect: 'manual', headers: { ...headers } };
      if (cookie) init.headers.Cookie = cookie;
      if (form) {
        init.body = new URLSearchParams(form).toString();
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(`${ctx.baseUrl}${path}`, init);
      for (const value of response.headers.getSetCookie?.() || []) {
        const [pair] = value.split(';');
        if (pair.split('=')[0] === 'hc_session') cookie = pair;
      }
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, headers: response.headers, text, json };
    },
    post: (path, payload) => client.request(path, { method: 'POST', body: payload, headers: { Origin: ctx.baseUrl } }),
    form: (path, fields) => client.request(path, { method: 'POST', form: fields, headers: { Origin: ctx.baseUrl } }),
  };
  return client;
}

async function makeUser(role, label = 'Fixture') {
  const phone = nextPhone();
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    phone,
    `${label} (mfa test)`,
    role,
    'active',
  ]);
  const user = await db.queryOne('SELECT id, phone FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  made.users.push(user.id);
  return { id: user.id, phone, role };
}

/** Sign in with the phone step only, and report what the server said. */
async function signIn(user) {
  const client = newClient();
  const otp = await client.request('/api/auth/otp', { method: 'POST', body: { phone: user.phone } });
  assert.equal(otp.status, 200, `OTP failed: ${otp.text}`);
  const verify = await client.request('/api/auth/verify', {
    method: 'POST',
    body: { phone: user.phone, code: otp.json.devCode },
    headers: { Origin: ctx.baseUrl },
  });
  assert.equal(verify.status, 200, `sign-in failed: ${verify.text}`);
  return { client, verify };
}

/** The code for the step *after* the one already spent, which is the only kind
 *  a spent-step check will accept. */
const nextCode = (secret) => totp.code(secret, { time: Date.now() + totp.STEP_SECONDS * 1000 });

test.before(async () => {
  if (!dbAvailable) return;
  const server = await startTestServer();
  ctx.baseUrl = server.baseUrl;
  ctx.close = server.close;
});

test.after(async () => {
  if (ctx.close) await ctx.close();
  if (!dbAvailable) return;
  if (made.sessions.length) {
    await db.query(`DELETE FROM sessions WHERE id IN (${made.sessions.map(() => '?').join(',')})`, made.sessions);
  }
  if (made.users.length) {
    await db.query(`DELETE FROM \`users\` WHERE id IN (${made.users.map(() => '?').join(',')})`, made.users);
  }
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// 1. The arithmetic
// ---------------------------------------------------------------------------

maybe('the six-digit code is RFC 6238 to the digit', () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    assert.equal(
      totp.code(RFC_SECRET, { time: seconds * 1000, digits: 8 }),
      expected,
      `time ${seconds} must produce ${expected}`,
    );
    assert.equal(
      totp.code(RFC_SECRET, { time: seconds * 1000, digits: 6 }),
      expected.slice(-6),
      `the site uses six digits: ${expected} truncated`,
    );
  }
});

maybe('the base32 codec round-trips, and a secret is written the way a person types it', () => {
  const bytes = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(totp.base32Encode(bytes), RFC_SECRET);
  assert.deepEqual(Array.from(totp.base32Decode(RFC_SECRET)), Array.from(bytes));
  assert.match(totp.formatSecret(RFC_SECRET), /^[A-Z2-7]{4}( [A-Z2-7]{4})+$/, 'grouped in fours');
});

maybe('a code counts in its own step, one step either side, and nowhere else', () => {
  const secret = totp.generateSecret();
  const now = 1_700_000_000_000;
  const mine = totp.code(secret, { time: now });
  assert.equal(totp.verify(secret, mine, { time: now }), totp.stepAt(now), 'its own step');
  assert.equal(totp.verify(secret, mine, { time: now + 30_000 }), totp.stepAt(now), 'one step late: still fine');
  assert.equal(totp.verify(secret, mine, { time: now + 90_000 }), null, 'two steps late: no');
  assert.equal(totp.verify(secret, mine, { time: now - 30_000 }), totp.stepAt(now), 'one step early: fine');
  assert.equal(totp.verify(secret, '', { time: now }), null, 'an empty code is not a code');
  assert.equal(totp.verify(secret, 'abcdef', { time: now }), null, 'and neither are letters');
});

maybe('the otpauth URI carries the issuer, the digits and the period', () => {
  const uri = totp.otpauthUrl({ secret: RFC_SECRET, account: 'staff@honestcarsltd.com', issuer: mfa.ISSUER });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /issuer=HonestCars/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
  assert.match(uri, /secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
});

// ---------------------------------------------------------------------------
// 2. Replay
// ---------------------------------------------------------------------------

maybe('a code that has been spent can never be spent again', async () => {
  const user = await makeUser('admin', 'Replay');
  const secret = await enrolMfa(user.id);
  const code = totp.code(secret);

  const first = await mfa.check(user, code);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.via, 'totp');

  const replay = await mfa.check(user, code);
  assert.equal(replay.ok, false, 'the same code, a second time');
  assert.match(replay.error, /already been used/i);

  const row = await db.mfa.state(user.id);
  assert.equal(row.lastStep, totp.stepAt(Date.now()), 'and the spent step is the one recorded');
});

maybe('the code that switched the factor on cannot be the code that signs in with it', async () => {
  const user = await makeUser('admin', 'Setup code');
  const secret = await enrolMfa(user.id, { confirm: false });
  const setupCode = totp.code(secret);
  const confirmed = await mfa.confirmEnrolment(user, setupCode);
  assert.equal(confirmed.ok, true, confirmed.error);

  const { client } = await signIn(user);
  const reuse = await client.post('/api/auth/mfa', { code: setupCode });
  assert.equal(reuse.status, 422, 'the enrolment code is spent');
  assert.match(reuse.json.error, /already been used/i);

  const fresh = await client.post('/api/auth/mfa', { code: nextCode(secret), next: '/admin' });
  assert.equal(fresh.status, 200, fresh.text);
  assert.equal((await client.request('/admin')).status, 200, 'and the next code walks in');
});

maybe('a session that has already passed the challenge says so instead of counting a failure', async () => {
  const user = await makeUser('admin', 'Twice');
  const secret = await enrolMfa(user.id);
  const { client } = await signIn(user);

  const ok = await client.post('/api/auth/mfa', { code: totp.code(secret) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.via, 'totp');

  const again = await client.post('/api/auth/mfa', { code: nextCode(secret) });
  assert.equal(again.status, 200, 'not an error — there is nothing left to prove');
  assert.equal(again.json.alreadyVerified, true);
  assert.equal(again.json.ok, true);
});

maybe('wrong codes are counted on the session, and the fifth kills it', async () => {
  const user = await makeUser('admin', 'Lockout');
  const secret = await enrolMfa(user.id);
  const { client } = await signIn(user);

  let last = null;
  for (let attempt = 1; attempt <= db.mfa.MAX_ATTEMPTS; attempt += 1) {
    last = await client.post('/api/auth/mfa', { code: '000000' });
    if (attempt < db.mfa.MAX_ATTEMPTS) {
      assert.equal(last.status, 422, `attempt ${attempt}: ${last.text}`);
      assert.equal(last.json.attemptsLeft, db.mfa.MAX_ATTEMPTS - attempt);
    }
  }
  assert.equal(last.status, 401, 'the last wrong code ends the session');
  assert.match(last.json.error, /sign in again/i);
  assert.equal(client.cookie(), 'hc_session=', 'and the cookie is cleared');

  // The right code is no help now: that session is gone on purpose.
  const late = await client.post('/api/auth/mfa', { code: totp.code(secret) });
  assert.equal(late.status, 401);
  assert.equal(late.json.ok, false);
});

// ---------------------------------------------------------------------------
// 3. Half-finished enrolment protects nothing
// ---------------------------------------------------------------------------

maybe('an enrolment nobody confirmed leaves the account unprotected', async () => {
  const user = await makeUser('admin', 'Half done');
  const secret = totp.generateSecret();
  await db.mfa.beginEnrolment(user.id, secret);

  const state = await db.mfa.state(user.id);
  assert.equal(state.pending, true, 'a secret is sitting there');
  assert.equal(state.enrolled, false, 'but a secret nobody has proved is not a factor');
  assert.equal((await db.mfa.secretFor(user.id)).confirmed, false);

  // Sign-in must not stop for a second factor, and must not open the console.
  const { client, verify } = await signIn(user);
  assert.equal(verify.json.mfa, null, 'no challenge is raised for an unproved secret');

  const console_ = await client.request('/admin');
  assert.equal(console_.status, 302, 'the console still refuses');
  assert.match(console_.headers.get('location'), /^\/admin\/security\?err=/);

  const page = await client.request('/admin/security');
  assert.equal(page.status, 200, 'and the one page that can finish the job is open');
  assert.match(page.text, /never confirmed/, 'it says the setup is unfinished');

  const followed = await client.request(console_.headers.get('location'));
  assert.equal(followed.status, 200);
  assert.match(followed.text, /asks for a second factor/, 'and why it is asking');

  // The unproved secret is not a way in: nobody is even asked for it, because
  // there is nothing on this account to ask about.
  const noChallenge = await client.post('/api/auth/mfa', { code: totp.code(secret) });
  assert.equal(noChallenge.json.alreadyVerified, true, 'no challenge was ever started');
  assert.equal((await client.request('/admin')).status, 302, 'and the console still refuses');

  // A console page it can never reach, whichever way it asks.
  assert.equal((await client.request('/admin/intel')).status, 302);
  const api = await client.request('/api/admin/audit');
  assert.equal(api.status, 403);
  assert.equal(api.json.mfaEnrolmentRequired, true);
  assert.match(api.json.error, /two-step sign-in/i);
});

maybe('confirming an enrolment needs the code, and issues recovery codes', async () => {
  const user = await makeUser('ops', 'Voluntary');
  const secret = await enrolMfa(user.id, { confirm: false });

  const wrong = await mfa.confirmEnrolment(user, '000000');
  assert.equal(wrong.ok, false, 'a wrong code confirms nothing');
  assert.equal((await db.mfa.state(user.id)).enrolled, false);

  const result = await mfa.confirmEnrolment(user, totp.code(secret));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.count, db.mfa.RECOVERY_CODE_COUNT);
  assert.equal(new Set(result.recoveryCodes).size, result.count, 'codes are distinct');
  for (const code of result.recoveryCodes) assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const after = await db.mfa.state(user.id);
  assert.equal(after.enrolled, true);
  assert.equal(after.spareCodes, result.count);

  // The codes are stored as hashes. Nothing in the table is usable as a code.
  const rows = await db.query('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ?', [user.id]);
  assert.equal(rows.length, result.count);
  for (const row of rows) {
    assert.equal(row.code_hash.length, 64);
    assert.equal(result.recoveryCodes.includes(row.code_hash), false);
  }
});

maybe('the setup screen shows a key to type, and never a QR code', async () => {
  const user = await makeUser('admin', 'Setup screen');
  const { client } = await signIn(user);
  assert.equal((await client.form('/admin/security/begin', {})).status, 303);

  const page = await client.request('/admin/security?setup=1');
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.match(page.text, /class="setup-secret/, 'the key is on the page');
  assert.match(page.text, /otpauth:\/\/totp\//, 'as a URI to copy into a password manager');
  const secret = await db.mfa.secretFor(user.id);
  const flat = page.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, '');
  assert.ok(flat.includes(secret.secret), 'and it is the key the server stored');
  assert.ok(!/<img[^>]+(qr|chart)/i.test(page.text), 'no QR image anywhere');
});

// ---------------------------------------------------------------------------
// 4. Recovery codes
// ---------------------------------------------------------------------------

maybe('a recovery code works once, and the count of what is left drops', async () => {
  const user = await makeUser('admin', 'Recovery');
  const secret = await enrolMfa(user.id, { confirm: false });
  const confirmed = await mfa.confirmEnrolment(user, totp.code(secret));
  const [code, spare] = confirmed.recoveryCodes;

  const { client } = await signIn(user);
  const used = await client.post('/api/auth/mfa', { code });
  assert.equal(used.status, 200, used.text);
  assert.equal(used.json.via, 'recovery');

  const view = await mfa.view(await db.users.findById(user.id));
  assert.equal(view.codes.remaining, confirmed.count - 1);
  assert.equal(view.codes.used, 1);
  assert.equal(view.recoveryWeek, true, 'and the console offers to issue a new sheet');

  // Same string, fresh session: refused, and refused as a *recovery* code.
  const second = await signIn(user);
  const again = await second.client.post('/api/auth/mfa', { code });
  assert.equal(again.status, 422, again.text);
  assert.match(again.json.error, /recovery code has already been used/i);

  // A different code from the same batch still works, so one spent code does
  // not lock the person out.
  const third = await signIn(user);
  const next = await third.client.post('/api/auth/mfa', { code: spare });
  assert.equal(next.status, 200, next.text);
  assert.equal(next.json.via, 'recovery');
});

maybe('a recovery code is accepted whatever case and dashes it arrives in', async () => {
  const user = await makeUser('admin', 'Loose typing');
  const secret = await enrolMfa(user.id, { confirm: false });
  const confirmed = await mfa.confirmEnrolment(user, totp.code(secret));
  const [code] = confirmed.recoveryCodes;
  const typed = code.replace(/-/g, '').toLowerCase();

  const { client } = await signIn(user);
  const sloppy = await client.post('/api/auth/mfa', { code: typed });
  assert.equal(sloppy.status, 200, `“${typed}” should be accepted: ${sloppy.text}`);
  assert.equal(sloppy.json.via, 'recovery');
});

maybe('a fresh sheet replaces the old one, so an old printout stops working', async () => {
  const user = await makeUser('ops', 'New sheet');
  const secret = await enrolMfa(user.id, { confirm: false });
  const first = await mfa.confirmEnrolment(user, totp.code(secret));
  const [oldCode] = first.recoveryCodes;

  // Re-read the row: the service asks the account, not a fixture literal,
  // whether a factor is on.
  const regenerated = await mfa.regenerateRecoveryCodes(await db.users.findById(user.id), nextCode(secret));
  assert.equal(regenerated.ok, true, regenerated.error);
  assert.equal(regenerated.count, db.mfa.RECOVERY_CODE_COUNT);
  assert.equal(regenerated.codes.includes(oldCode), false, 'the new sheet shares nothing with the old');

  const { client } = await signIn(user);
  const stale = await client.post('/api/auth/mfa', { code: oldCode });
  assert.equal(stale.status, 422, 'the old printout is dead');
  const fresh = await client.post('/api/auth/mfa', { code: regenerated.codes[0] });
  assert.equal(fresh.status, 200, fresh.text);
});

maybe('a new sheet issued from the console is shown once, and only the last one works', async () => {
  const user = await makeUser('admin', 'New sheet on screen');
  const secret = await enrolMfa(user.id);
  const { client } = await signIn(user);
  assert.equal((await client.post('/api/auth/mfa', { code: totp.code(secret) })).status, 200);

  const first = await client.request('/admin/security');
  assert.match(first.text, /Recovery codes/, 'the page shows the state of the sheet');

  const issued = await client.form('/admin/security/recovery', { code: nextCode(secret) });
  assert.equal(issued.status, 200, issued.text.slice(0, 200));
  const fresh = [...issued.text.matchAll(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g)].map((match) => match[0]);
  assert.equal(fresh.length, db.mfa.RECOVERY_CODE_COUNT);
  assert.match(issued.text, /only time they are shown/i);

  // Fetched again: the sheet is not repeated.
  const again = await client.request('/admin/security');
  for (const code of fresh) assert.ok(!again.text.includes(code), `${code} must not come back`);

  // And a fresh code from it signs in — from a new session, on a newer step.
  const later = await signIn(user);
  const used = await later.client.post('/api/auth/mfa', { code: fresh[0] });
  assert.equal(used.status, 200, used.text);
  assert.equal(used.json.via, 'recovery');
});

maybe('the service refuses anything that is not a code, with a sentence and not a crash', async () => {
  const user = await makeUser('admin', 'Nonsense');
  await enrolMfa(user.id);
  const { client } = await signIn(user);

  // Four attempts, not five: the fifth wrong code is *supposed* to end the
  // session, and that behaviour has its own test above.
  for (const code of ['', 'hello', '12345', '000000000000000']) {
    const response = await client.post('/api/auth/mfa', { code });
    assert.equal(response.status, 422, `“${code}” must be refused with a message`);
    assert.equal(typeof response.json.error, 'string');
    assert.ok(response.json.error.length > 10);
  }
});

// ---------------------------------------------------------------------------
// 5. The gate
// ---------------------------------------------------------------------------

maybe('a half-signed-in session opens nothing but the challenge — and the static shell', async () => {
  const user = await makeUser('admin', 'Gate');
  await enrolMfa(user.id);
  const { client, verify } = await signIn(user);

  assert.equal(verify.json.mfa.required, true, 'the sign-in says a factor is next');
  assert.match(verify.json.mfa.next, /^\/login\/mfa\?next=/);
  assert.equal(verify.json.user.firstName, 'Gate', 'and still greets them');

  const blocked = await client.request('/admin');
  assert.equal(blocked.status, 302, 'a browser is sent to the challenge');
  assert.match(blocked.headers.get('location'), /^\/login\/mfa\?next=/);
  assert.match(blocked.headers.get('cache-control'), /no-store/);

  const api = await client.request('/api/account/saved-cars');
  assert.equal(api.status, 401, 'an API call gets an answer, not a redirect to HTML');
  assert.equal(api.json.mfa, true);

  const post = await client.post('/api/account/saved-cars', { listingId: 1, action: 'add' });
  assert.equal(post.status, 401, 'and a write is refused the same way');

  for (const path of ['/login/mfa', '/css/tokens.css', '/js/main.js', '/favicon.png']) {
    const allowed = await client.request(path);
    assert.equal(allowed.status, 200, `${path} must stay reachable while half signed in`);
  }
});

maybe('the challenge page is a plain form that works with no JavaScript at all', async () => {
  const user = await makeUser('admin', 'No JS');
  const secret = await enrolMfa(user.id);
  const { client } = await signIn(user);

  const page = await client.request('/login/mfa?next=%2Fadmin');
  assert.equal(page.status, 200);
  assert.match(page.text, /<form[^>]+data-mfa-form/);
  assert.match(page.text, /<input[^>]+name="code"/, 'one named field');
  assert.match(page.text, /noindex/i, 'never indexed');

  // Posted the way a browser posts it, with no script involved.
  const posted = await client.form('/api/auth/mfa', { code: totp.code(secret), next: '/admin' });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json.ok, true);
  const admin = await client.request('/admin');
  assert.equal(admin.status, 200, 'and the console opens');
  assert.match(admin.text, /data-admin/, 'the real console, not a placeholder');
});

maybe('the challenge page bounces anyone who is not half signed in', async () => {
  const stranger = newClient();
  const page = await stranger.request('/login/mfa');
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/login\?next=/);

  // Someone who already cleared it and hits Back should be sent on, not asked
  // for a code that has already been given.
  const user = await makeUser('admin', 'Cleared already');
  const secret = await enrolMfa(user.id);
  const { client } = await signIn(user);
  assert.equal((await client.post('/api/auth/mfa', { code: totp.code(secret) })).status, 200);

  const back = await client.request('/login/mfa?next=%2Fadmin');
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/admin');
});

maybe('the second factor is required of admin and finance, and optional for everyone else', async () => {
  assert.deepEqual(roles.MFA_ROLES, ['admin', 'finance']);
  assert.equal(mfa.requiresMfa('admin'), true);
  assert.equal(mfa.requiresMfa('finance'), true);
  assert.equal(mfa.requiresMfa('ops'), false);
  assert.equal(mfa.requiresMfa('marketing'), false);
  assert.equal(mfa.requiresMfa('dealer'), false);

  const customer = await db.users.findById((await makeUser('customer', 'Policy')).id);
  assert.equal(await mfa.mustEnrol(customer), false, 'a buyer is never asked');

  const ops = await db.users.findById((await makeUser('ops', 'Policy ops')).id);
  assert.equal(await mfa.mustEnrol(ops), false, 'a voluntary role can work un-enrolled');
  assert.equal(await mfa.mustChallenge(ops), false);

  const finance = await db.users.findById((await makeUser('finance', 'Policy finance')).id);
  assert.equal(await mfa.mustEnrol(finance), true, 'an un-enrolled required role must finish setup');

  const secret = await enrolMfa(finance.id);
  const enrolled = await db.users.findById(finance.id);
  assert.equal(await mfa.mustEnrol(enrolled), false, 'the obligation is met by enrolling');
  assert.equal(await mfa.mustChallenge(enrolled), true, 'and the challenge starts applying');
  assert.ok(secret);
});

maybe('a required role cannot turn its own factor off, and is told why', async () => {
  const finance = await makeUser('finance', 'Stuck with it');
  const secret = await enrolMfa(finance.id);
  const { client } = await signIn(finance);
  assert.equal((await client.post('/api/auth/mfa', { code: nextCode(secret) })).status, 200);

  const refused = await client.form('/admin/security/disable', { code: nextCode(secret) });
  assert.equal(refused.status, 303);
  const flash = await client.request(refused.headers.get('location'));
  assert.match(flash.text, /keeps a second factor on it/, 'the refusal explains itself');
  assert.equal((await db.mfa.state(finance.id)).enrolled, true, 'and nothing changed');
});

maybe('a voluntary role can turn its own factor off, with a live code', async () => {
  const marketing = await makeUser('marketing', 'Optional');
  const secret = await enrolMfa(marketing.id);
  const { client } = await signIn(marketing);
  // Enrolling is not the same as challenging: the sign-in still stops for the
  // factor, voluntary role or not. Clear it with this step's code, which leaves
  // the next step free for the code that turns the factor off — codes are spent
  // as they are used, so the second one has to be newer than the first.
  assert.equal((await client.post('/api/auth/mfa', { code: totp.code(secret) })).status, 200);

  const refused = await client.form('/admin/security/disable', { code: '000000' });
  assert.equal(refused.status, 303);
  assert.equal((await db.mfa.state(marketing.id)).enrolled, true, 'a wrong code turns nothing off');

  const off = await client.form('/admin/security/disable', { code: nextCode(secret) });
  assert.equal(off.status, 303, off.text);
  assert.equal(off.status, 303);
  const flash = await client.request(off.headers.get('location'));
  assert.match(flash.text, /Two-step sign-in is off/i);
  assert.equal((await db.mfa.state(marketing.id)).enrolled, false);
  assert.equal(await db.mfa.secretFor(marketing.id), null, 'the secret goes with it');
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ?', [marketing.id]))[0].n, 0);
});

maybe('the lost-phone reset is an admin act, revokes the sessions and is audited', async () => {
  const helper = await makeUser('ops', 'Reset helper');
  const admin = await makeUser('admin', 'Reset actor');
  const adminSecret = await enrolMfa(admin.id);
  const adminSession = await signIn(admin);
  assert.equal((await adminSession.client.post('/api/auth/mfa', { code: nextCode(adminSecret) })).status, 200);

  await enrolMfa(helper.id);
  const stuck = await signIn(helper);
  const token = stuck.client.cookie().split('=')[1];
  const session = await db.queryOne('SELECT id FROM sessions WHERE token_hash = ?', [auth.hashToken(token)]);
  made.sessions.push(session.id);

  const reset = await adminSession.client.form(`/admin/staff/${helper.id}/mfa/off`, { reason: 'lost phone (mfa test)' });
  assert.equal(reset.status, 303, reset.text);

  assert.equal((await db.mfa.state(helper.id)).enrolled, false, 'the old phone is worthless now');
  const revoked = await db.queryOne('SELECT revoked_at FROM sessions WHERE id = ?', [session.id]);
  assert.ok(revoked && revoked.revoked_at, 'and the session it was holding is revoked, not merely gated');
  assert.equal((await stuck.client.request('/admin/security')).status, 302, 'so the phone itself is out');

  const [entry] = await db.query(
    'SELECT action, detail FROM admin_audit WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1',
    ['user', helper.id],
  );
  assert.equal(entry.action, 'mfa.reset_for_user');
  assert.match(JSON.stringify(entry.detail), /lost phone \(mfa test\)/);
});

maybe('the enrolment an admin performs is audited, and the codes are shown exactly once', async () => {
  const admin = await makeUser('admin', 'Enrol myself');
  await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['user', admin.id]);
  const { client } = await signIn(admin);

  assert.equal((await client.form('/admin/security/begin', {})).status, 303);
  const secret = await db.mfa.secretFor(admin.id);
  const confirm = await client.form('/admin/security/confirm', { code: totp.code(secret.secret) });
  assert.equal(confirm.status, 200, confirm.text.slice(0, 300));
  assert.match(confirm.text, /class="recovery-codes"/, 'the codes are on the confirming response');
  assert.match(confirm.text, /only time they are shown/i);

  const codes = [...confirm.text.matchAll(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g)].map((match) => match[0]);
  assert.equal(codes.length, db.mfa.RECOVERY_CODE_COUNT);

  // The same page, fetched again: the codes are not there, because they only
  // ever existed in that one response.
  const again = await client.request('/admin/security');
  assert.equal(again.status, 200);
  for (const code of codes) assert.ok(!again.text.includes(code), `${code} must not come back`);

  const [entry] = await db.query(
    'SELECT action, actor_id, detail FROM admin_audit WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1',
    ['user', admin.id],
  );
  assert.equal(entry.action, 'mfa.enrolled');
  assert.equal(Number(entry.actor_id), admin.id);
  assert.equal(JSON.parse(JSON.stringify(entry.detail)).recovery_codes, db.mfa.RECOVERY_CODE_COUNT);
  assert.equal(JSON.parse(JSON.stringify(entry.detail)).other_sessions_revoked, true);

  // Enrolling signed every other device out — including the one that was half
  // signed in — and handed this one a working cookie.
  const after = await client.request('/admin');
  assert.equal(after.status, 200, 'the person who enrolled stays signed in');
  const mobile = await client.request('/login/mfa');
  assert.equal(mobile.status, 302, 'and a session that was pending is sent on, not challenged');
});

maybe('a customer never meets the second factor, and never sees the enrolment', async () => {
  const user = await makeUser('customer', 'Buyer');
  const { client, verify } = await signIn(user);
  assert.equal(verify.json.mfa, null);
  assert.equal((await client.request('/account')).status, 200);
  const security = await client.request('/admin/security');
  assert.equal([302, 403].includes(security.status), true, `a customer is not staff (${security.status})`);
});

maybe('the console shows the team coverage, and names the role that is missing one', async () => {
  const admin = await makeUser('admin', 'Coverage');
  const secret = await enrolMfa(admin.id);
  const { client } = await signIn(admin);
  assert.equal((await client.post('/api/auth/mfa', { code: nextCode(secret) })).status, 200);

  const coverage = await mfa.coverage();
  assert.deepEqual(coverage.requiredRoles, ['admin', 'finance']);
  assert.equal(typeof coverage.byRole.admin.staff, 'number');
  assert.equal(coverage.byRole.admin.required, true);
  assert.equal(coverage.byRole.marketing.required, false, 'marketing is never marked as owing a factor');

  const page = await client.request('/admin/security');
  assert.equal(page.status, 200);
  assert.match(page.text, /Who is protected/);
  assert.match(page.text, /Every account that requires one has one\.|still do not have it\./);
  assert.match(page.text, /Second-factor coverage by role/);
});
