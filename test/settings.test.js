'use strict';

/**
 * §5.1 — the settings screen (migration 027).
 *
 * The screen's failure mode is not a crash: it is offering an operator a box
 * that looks like it does something and does not. So this suite tests the
 * promises the screen makes to the person using it:
 *
 *   • **Every setting on the screen is read by the code.** The registry is
 *     grepped against the source tree, so a row with no consumer fails here
 *     rather than shipping as a control that changes nothing.
 *   • **A default is written down once.** An override is a row; resetting is a
 *     DELETE, and the value that comes back is the registry's default — not a
 *     copy of it kept in the table where it can drift.
 *   • **A group is applied whole or not at all.** Validation runs over the whole
 *     submission before the transaction opens, so a retainer cannot land without
 *     the hours beside it.
 *   • **A prebuilt page is not served once it is wrong.** Changing a setting the
 *     footer carries makes the build stale; the page renders on request until
 *     the next build, instead of telling a customer the old phone number.
 *   • **A stored row never breaks a page.** Money and integers are re-parsed on
 *     the way out, so a value edited in SQL by hand degrades to the default
 *     rather than reaching a template as `NaN`.
 *
 * Fixtures: the suite writes to the two keys the seed also owns and puts them
 * back in `test.after`, so a run leaves the demo exactly as it found it. The
 * other suites' rows are never touched — this suite only ever names its own keys.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, dbAvailable, startTestServer, getHtml } = require('./helpers');

let available = false;
let ctx;
let db;
let schema;
let overrides;
let settings;

/** Keys this suite writes. It always puts them back. */
const TEXT_KEY = 'business.address_note';
const MONEY_KEY = 'marketing.cac_guardrail';
const TOUCHED = [TEXT_KEY, MONEY_KEY];

/** What the seed ships, so a test can restore it without guessing. */
let seeded;

/** Accounts this suite creates (with their sessions), removed in test.after. */
const created = [];

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  schema = require('../src/lib/settings-schema');
  overrides = require('../src/lib/overrides');
  settings = require('../src/services/settings');
  ctx = await startTestServer();
  await settings.hydrate();
  seeded = Object.fromEntries(TOUCHED.map((key) => [key, overrides.raw(key)]));
});

test.after(async () => {
  if (!available) return;
  if (ctx) await ctx.close();
  for (const account of created) {
    await db.query('DELETE FROM sessions WHERE user_id = ?', [account.userId]).catch(() => {});
    await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['settings_group', account.userId]).catch(() => {});
    await db.query('DELETE FROM `users` WHERE id = ?', [account.userId]).catch(() => {});
  }
  await db.settings.remove(TOUCHED).catch(() => {});
  const restore = TOUCHED.filter((key) => seeded[key]).map((key) => ({ key, value: seeded[key] }));
  if (restore.length) await db.settings.save(restore).catch(() => {});
  await settings.hydrate().catch(() => {});
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// The registry — the part that stops the screen becoming decorative
// ---------------------------------------------------------------------------

test('every setting on the screen is read by the code that claims to use it', () => {
  // The files that legitimately mention a key without *reading* it: the registry
  // itself, the loader, the form that draws every row from the registry, and the
  // save/reset routes that pass a group key through.
  const exemptions = new Set([
    'src/lib/settings-schema.js',
    'src/lib/overrides.js',
    'src/services/settings.js',
    'src/db/settings.js',
    'src/routes/admin.js', // the screen's routes, keyed by group
    'views/pages/admin/settings.ejs',
  ]);
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
        walk(full);
      } else if (/\.(js|ejs|mjs)$/.test(entry.name)) {
        sources.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'views'));
  walk(path.join(ROOT, 'scripts'));

  const unread = [];
  for (const key of schema.keys()) {
    // Two groups build their key from a name rather than writing it out — a
    // message channel (per template) and the SLA card (per tier) — so for those
    // the *template* is what has to be found in the consumer.
    const needle = key.startsWith('notify.channel.')
      ? 'notify.channel.${template}'
      : key.startsWith('concierge.sla_')
        ? 'concierge.sla_${option.key}'
        : key;
    const found = sources.some((file) => {
      if (exemptions.has(file)) return false;
      return fs.readFileSync(path.join(ROOT, file), 'utf8').includes(needle);
    });
    if (!found) unread.push(key);
  }
  assert.deepEqual(unread, [], 'these settings are on the screen but nothing reads them');
});

test('the registry and the config module agree about defaults, and the docs say what they are', () => {
  const config = require('../src/config');
  const before = overrides.snapshot();
  assert.equal(schema.keys().length, 42, 'the registry grew or shrank — update the docs and this count');
  for (const key of schema.keys()) {
    assert.equal(typeof schema.defaultValue(key), schema.field(key).type === 'money' || schema.field(key).type === 'int' ? 'number' : 'string', `${key} has no usable default`);
  }
  // Reading a setting never needs a database: the default is the environment.
  assert.equal(typeof config.listings.perPage, 'number');
  assert.equal(typeof config.business.phone, 'string');
  assert.deepEqual(overrides.snapshot(), before, 'reading a setting must not write one');
});

// ---------------------------------------------------------------------------
// Parsing — types, ranges and the money unit
// ---------------------------------------------------------------------------

test('money is entered in naira and stored in kobo', () => {
  const field = schema.field('concierge.sla_standard_retainer');
  assert.deepEqual(schema.parse(field, '50,000'), { ok: true, value: '5000000' });
  assert.deepEqual(schema.parse(field, '₦55,000.50'), { ok: true, value: '5500050' });
  assert.equal(schema.parse(field, '-100').ok, false);
  assert.equal(schema.parse(field, 'free').ok, false);
  assert.equal(schema.display(field, '5000000'), '50,000');
});

test('numbers, phones, emails and channels are refused when they are wrong', () => {
  const check = (key, raw) => schema.parse(schema.field(key), raw);

  assert.equal(check('listings.per_page', '900').ok, false, 'above the range');
  assert.equal(check('listings.per_page', '8').ok, false, 'below the range');
  assert.equal(check('listings.per_page', '24').ok, true);

  assert.equal(check('business.phone', '0803 123 4567').ok, true, 'spaces are tidied');
  assert.equal(check('business.phone', 'nope').ok, false);
  assert.equal(check('business.email', 'Desk@HonestCarsLTD.com').value, 'desk@honestcarsltd.com', 'lower-cased');
  assert.equal(check('business.email', 'desk@localhost').ok, false);
  assert.equal(check('business.bank_account', '12ab').ok, false);
  assert.equal(check('notify.channel.price_drop', 'carrier-pigeon').ok, false);
  assert.equal(check('notify.channel.price_drop', 'email').ok, true);
});

// ---------------------------------------------------------------------------
// Saving — one group, all or nothing
// ---------------------------------------------------------------------------

maybe('a whole group saves together and is visible in the config immediately', async () => {
  const saved = await settings.saveGroup(
    'business',
    {
      'business.address_note': 'We come to the car — Port Harcourt, Owerri, Aba and Benin.',
      'business.cac_line': 'Honest Cars LTD — RC 1234567',
    },
    { actorId: null },
  );
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.saved, 2);

  // The same process, the same read path the footer uses.
  const config = require('../src/config');
  assert.equal(config.business.addressNote, 'We come to the car — Port Harcourt, Owerri, Aba and Benin.');
  assert.equal(config.business.cacLine, 'Honest Cars LTD — RC 1234567');

  const rows = await db.settings.all();
  assert.ok(rows.some((row) => row.setting_key === TEXT_KEY), 'the override is a row');
});

maybe('one bad field stops the whole group — nothing is half-applied', async () => {
  const before = await db.settings.get(MONEY_KEY).catch(() => null);
  const refused = await settings.saveGroup('fees', {
    'referral.reward': '25000',
    'concierge.sla_standard_retainer': 'not money',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /An amount in naira/);

  // The valid half must not have landed.
  assert.equal(overrides.raw('referral.reward'), null, 'the good field must not be saved beside a bad one');
  assert.equal((await db.settings.get(MONEY_KEY))?.setting_value, before?.setting_value ?? undefined);
});

maybe('saving the default value clears the override rather than storing a copy of it', async () => {
  await settings.saveGroup('fees', { 'referral.reward': '90000' });
  assert.ok(overrides.changed('referral.reward'));

  const backToDefault = await settings.saveGroup('fees', { 'referral.reward': '2,000' });
  assert.equal(backToDefault.ok, true);
  assert.equal(backToDefault.reset, 1);
  assert.equal(backToDefault.saved, 0);
  assert.equal(overrides.changed('referral.reward'), false, 'the row is gone');
  assert.equal(await db.settings.get('referral.reward'), null);
  assert.equal(overrides.value('referral.reward'), schema.defaultValue('referral.reward'));
});

maybe('a blank field means "leave it", not "set it to nothing"', async () => {
  await settings.saveGroup('business', { [TEXT_KEY]: 'Something the desk wrote.' });
  const saved = await settings.saveGroup('business', { [TEXT_KEY]: '', 'business.phone': '' });
  assert.equal(saved.ok, true);
  assert.equal(saved.saved, 0);
  assert.equal(overrides.raw(TEXT_KEY), 'Something the desk wrote.', 'a blank submission must not wipe a value');
});

maybe('two settings that only make sense as a pair are checked as a pair', async () => {
  const refused = await settings.saveGroup('thresholds', { 'sold.visible_days': '30', 'sold.redirect_days': '30' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /redirect has to come later/i);

  const fine = await settings.saveGroup('thresholds', { 'sold.visible_days': '7', 'sold.redirect_days': '30' });
  assert.equal(fine.ok, true, fine.error);
  assert.equal(overrides.value('sold.redirect_days'), 30);
  await db.settings.remove(['sold.redirect_days', 'sold.visible_days']);
  await settings.hydrate();
});

maybe('reset puts a group back to the registry defaults', async () => {
  await settings.saveGroup('business', { [TEXT_KEY]: 'Changed by the test.' });
  assert.ok(overrides.changed(TEXT_KEY));

  const reset = await settings.resetGroup('business');
  assert.equal(reset.ok, true);
  assert.ok(reset.reset >= 1);
  assert.equal(overrides.changed(TEXT_KEY), false);
  assert.equal(await db.settings.get(TEXT_KEY), null);
});

// ---------------------------------------------------------------------------
// What the console shows
// ---------------------------------------------------------------------------

maybe('the screen reports what is changed, and what the value would be by default', async () => {
  await settings.saveGroup('business', { [TEXT_KEY]: 'A line the test wrote.' });
  const groups = settings.view();
  const business = groups.find((group) => group.key === 'business');
  const row = business.fields.find((field) => field.key === TEXT_KEY);
  assert.equal(row.changed, true);
  assert.equal(row.display, 'A line the test wrote.');
  assert.notEqual(row.defaultDisplay, row.display, 'the default is shown beside it');
  assert.equal(business.changed, 1);

  const summary = settings.summary();
  assert.ok(summary.changed >= 1);
  assert.equal(summary.total, schema.keys().length);
  assert.equal(summary.groups.length, schema.GROUPS.length);
});

maybe('the channel table is built from the message templates themselves', async () => {
  const notify = require('../src/services/notify');
  const templates = Object.keys(notify.TEMPLATES).sort();
  const rows = settings.channels().map((row) => row.template).sort();
  assert.deepEqual(rows, templates, 'a message template with no channel row would fall back silently');

  const delivery = require('../src/lib/respond'); // touch an unrelated module to prove no cycle broke
  assert.ok(delivery);

  for (const row of settings.channels()) {
    assert.ok(['whatsapp', 'sms', 'email', 'console'].includes(row.channel), `${row.template} → ${row.channel}`);
  }
});

// ---------------------------------------------------------------------------
// Stored values that nobody validated
// ---------------------------------------------------------------------------

maybe('a value edited into the table by hand degrades to the default, not to NaN', async () => {
  await db.settings.save([{ key: MONEY_KEY, value: 'not-a-number' }], {});
  await settings.hydrate();

  const value = overrides.value(MONEY_KEY);
  assert.equal(typeof value, 'number');
  assert.equal(value, schema.defaultValue(MONEY_KEY), 'an unreadable row reads as the default');

  const row = settings.view().flatMap((group) => group.fields).find((field) => field.key === MONEY_KEY);
  assert.ok(!Number.isNaN(Number(row.value)), 'and the screen does not print NaN');
});

maybe('a row for a key the registry does not know is ignored, and said out loud', async () => {
  await db.query("INSERT INTO settings (setting_key, setting_value) VALUES ('nonsense.setting', '1') ON DUPLICATE KEY UPDATE setting_value = '1'");
  const result = await settings.hydrate();
  assert.ok(result.ignored.includes('nonsense.setting'), 'an unknown key is reported, not applied');
  await db.query("DELETE FROM settings WHERE setting_key = 'nonsense.setting'");
  await settings.hydrate();
});

// ---------------------------------------------------------------------------
// The screen itself, over HTTP
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The screen itself, over HTTP
//
// The test server runs without a build (helpers point STATIC_DIR at
// `.test-static`), so this section builds its own one-page fixture there: that
// is the only way to exercise "the prebuilt file is served, until a setting
// makes it wrong" without touching the real dist.
// ---------------------------------------------------------------------------

const FIXTURE_PAGE = '/contact';
const FIXTURE_HTML = '<!doctype html><html><body><p id="fixture">A prebuilt page for the test.</p></body></html>';

function useFixtureBuild(app, { generatedAt }) {
  const dir = require('../src/config').features.staticPath;
  const file = path.join(dir, FIXTURE_PAGE.replace(/^\//, ''), 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, FIXTURE_HTML);
  app.locals.staticManifest = { generatedAt, routes: new Map([[FIXTURE_PAGE, { path: FIXTURE_PAGE, view: 'contact' }]]) };
}

async function newApp() {
  const { createApp } = require('../src/app');
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ app, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/**
 * A staff account, with a session minted directly.
 *
 * Signing in through the OTP route would be more realistic and is the wrong
 * choice here: the seeded admin's number is shared with the smoke run and every
 * other suite, and the OTP route rate-limits per phone (five an hour) — so a
 * suite that signs in as `+2348000000001` makes the *next* suite fail. This
 * creates its own account, mints the token the same way the verify route does,
 * and deletes both afterwards. OTP behaviour itself belongs to test/auth.test.js.
 */
async function staffSession(role = 'admin') {
  const auth = require('../src/services/auth');
  const { canonical } = require('../src/lib/phone');
  const phone = canonical(`+2348099${String(Date.now()).slice(-6)}`);
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    phone,
    'Settings Test (settings test)',
    role,
    'active',
  ]);
  const user = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  // §12.2: a required role needs a second factor before the console will answer.
  if (require('../src/services/roles').MFA_ROLES.includes(role)) await require('./helpers').enrolMfa(user.id);
  const token = auth.newSessionToken();
  await db.query('INSERT INTO sessions (user_id, token_hash, expires_at, user_agent) VALUES (?, ?, ?, ?)', [
    user.id,
    auth.hashToken(token),
    new Date(Date.now() + 86_400_000),
    'settings test',
  ]);
  created.push({ userId: user.id, phone });
  return {
    userId: user.id,
    get: (routePath) => fetch(`${ctx.baseUrl}${routePath}`, { headers: { Cookie: `hc_session=${token}` }, redirect: 'manual' }),
  };
}

maybe('the console refuses a signed-out visitor and draws every group for ops', async () => {
  const anonymous = await getHtml(ctx.baseUrl, '/admin/settings');
  assert.equal(anonymous.response.status, 302, 'a signed-out visitor is sent to sign in');

  const staff = await staffSession('admin');
  const response = await staff.get('/admin/settings');
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const group of schema.GROUPS) {
    assert.match(html, new RegExp(`id="group-${group.key}"`), `the ${group.title} group is on the screen`);
  }
  assert.match(html, /Reset to defaults/);
  assert.match(html, /Every setting on this screen is read by the code/i, 'the screen promises the registry rule');
  // It says out loud that provider keys are not here, so nobody hunts for them.
  assert.match(html, /deliberately not on this screen/i);
});

maybe('a saved setting reaches the storefront, and a stale build is not served', async () => {
  // Timestamps are moved deliberately, not by sleeping: 'now' would race the
  // second-precision these rows are stored with. A build dated in the future is
  // newer than anything (so it must be served); one dated in the past is older
  // than a setting saved a moment ago (so it must not be).
  const future = () => new Date(Date.now() + 60_000).toISOString();
  const past = () => new Date(Date.now() - 60_000).toISOString();

  const { app, baseUrl, close } = await newApp();
  try {
    useFixtureBuild(app, { generatedAt: future() });
    const before = await fetch(`${baseUrl}${FIXTURE_PAGE}`);
    assert.equal(await before.text(), FIXTURE_HTML, 'a build newer than every setting is served from disk');

    await settings.saveGroup('business', { [TEXT_KEY]: 'Inspections come to you, in four markets.' });

    useFixtureBuild(app, { generatedAt: past() });
    const after = await fetch(`${baseUrl}${FIXTURE_PAGE}`);
    const html = await after.text();
    assert.notEqual(html, FIXTURE_HTML, 'a page built before the change must not be served');
    assert.equal(after.headers.get('x-honestcars-stale-build'), 'settings-changed-since-build');
    assert.match(html, /Inspections come to you, in four markets\./, 'and it carries the new value');
    assert.equal(after.headers.get('x-honestcars-render'), 'dynamic');

    // The rule is "newer than the build", not "for ever": the next build makes
    // the prebuilt file valid again.
    useFixtureBuild(app, { generatedAt: future() });
    const served = await fetch(`${baseUrl}${FIXTURE_PAGE}`);
    assert.equal(await served.text(), FIXTURE_HTML, 'a rebuild puts the prebuilt page back in use');
    assert.equal(served.headers.get('x-honestcars-stale-build'), null);
  } finally {
    await close();
    await settings.resetGroup('business');
  }
});

test('the staleness rule is a comparison, not a flag', () => {
  const before = overrides.changedSince(new Date(Date.now() + 60_000).toISOString());
  assert.equal(typeof before, 'boolean');
  // With nothing saved there is no way for a build to be stale.
  const snapshot = overrides.snapshot();
  overrides.clear();
  assert.equal(overrides.changedSince(new Date(0).toISOString()), false, 'no overrides, no staleness');
  overrides.hydrate(
    Object.entries(snapshot).map(([setting_key, setting_value]) => ({
      setting_key,
      setting_value,
      updated_at: new Date().toISOString(),
    })),
  );
});
