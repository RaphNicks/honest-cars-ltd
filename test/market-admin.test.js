'use strict';

/**
 * FR-32 — opening a market from the console.
 *
 * The city picker offers forty-eight Nigerian cities, and four of them are
 * markets we operate. That gap used to be SQL-only: a city became a market by
 * somebody inserting a `service_cities` row, which meant the one action the
 * picker's whole design depends on was invisible to the desk that owns it.
 *
 * `/admin/settings` now has the form. What it promises, and what is tested here:
 *
 *   • **It offers the country, not a text box.** The select is the national
 *     catalogue minus the markets that already exist, grouped by state — so the
 *     picker and the country list are the same list, and a typo cannot open a
 *     market nobody can find.
 *   • **A market owns a stock series.** The series is how a stock number
 *     identifies the market that issued it, so two markets cannot share one, and
 *     something that is not a series is refused rather than stored.
 *   • **A name is not a label.** Two markets cannot share a name, because the
 *     name is what `/cars` filters by; and a market cannot be *renamed* here,
 *     because its listings carry it. Both are refusals, not oversights.
 *   • **Closing a market with cars in it is refused**, with the count — a closed
 *     market leaves the picker, and answering "we are not there yet" over a grid
 *     of forty cars is the lie this project does not ship.
 *   • **A closed market does not lose its city.** The row stays (its areas are
 *     still filed under it) and the picker falls back to the catalogue entry, so
 *     buyers keep the honest empty state instead of a 404.
 *   • **The change reaches the pages that carry the list.** The market list is in
 *     the header of every stable page, so opening or closing one re-renders the
 *     build — `TOUCHES.market` is `'*'`, and the flash says how many pages moved.
 *
 * Fixtures: markets this suite opens, deleted by id, plus its own staff account
 * and its own build directory (`.test-static/market`, so no other suite's build
 * is written to or read). The seeded markets are only ever read — bar one
 * deliberate attempt to close Port Harcourt, which must fail.
 */

// Before `./helpers` is required: it points STATIC_DIR at the test build, and
// this suite wants a directory of its own rather than one shared with the other
// suites that build or delete theirs.
process.env.TEST_STATIC_DIR = '.test-static/market';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, dbAvailable, startTestServer, runScript, enrolMfa } = require('./helpers');

let available = false;
let ctx;
let db;
let directory;
let publish;
let config;
let render;

/** Markets this suite opened, removed by id in `test.after`. */
const opened = [];

/** Staff accounts this suite created (with their sessions). */
const accounts = [];

let accountSeq = 0;

const maybe = (name, fn) =>
  test(name, async (t) => {
    if (!available) return t.skip('MySQL not reachable — run `npm run db:setup`');
    return fn(t);
  });

test.before(async () => {
  available = await dbAvailable();
  if (!available) return;
  db = require('../src/db');
  config = require('../src/config');
  render = require('../src/lib/render');
  directory = require('../src/services/city-directory');
  publish = require('../src/services/publish');
  ctx = await startTestServer();
});

test.after(async () => {
  if (!available) return;
  if (ctx) await ctx.close();
  for (const id of new Set(opened)) {
    await db.query('DELETE FROM service_areas WHERE city_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM admin_audit WHERE entity = ? AND entity_id = ?', ['service_city', id]).catch(() => {});
    await db.query('DELETE FROM service_cities WHERE id = ?', [id]).catch(() => {});
  }
  for (const account of accounts) {
    await db.query('DELETE FROM sessions WHERE user_id = ?', [account.userId]).catch(() => {});
    await db.query('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [account.userId]).catch(() => {});
    await db.query('DELETE FROM admin_audit WHERE actor_id = ?', [account.userId]).catch(() => {});
    await db.query('DELETE FROM `users` WHERE id = ?', [account.userId]).catch(() => {});
  }
  // The fixture build goes with the fixture markets: `.test-static` is ignored
  // by Git, but a suite should leave the tree as it found it anyway.
  fs.rmSync(config.features.staticPath, { recursive: true, force: true });
  await db.pool.end();
});

/**
 * A staff account with a session minted directly — the same fixture
 * `settings.test.js` uses, and for the same reason: signing in through the OTP
 * route rate-limits the phone, so a suite that borrows the seeded admin's number
 * breaks the next suite to run.
 */
async function staffSession(role = 'admin') {
  const auth = require('../src/services/auth');
  const roles = require('../src/services/roles');
  const { canonical } = require('../src/lib/phone');
  accountSeq += 1;
  const phone = canonical(`+2348098${String(Date.now()).slice(-6)}${accountSeq}`);
  await db.query('INSERT INTO `users` (phone, name, role, status) VALUES (?, ?, ?, ?)', [
    phone,
    'Market Test (market test)',
    role,
    'active',
  ]);
  const user = await db.queryOne('SELECT id FROM `users` WHERE phone = ? LIMIT 1', [phone]);
  if (roles.MFA_ROLES.includes(role)) await enrolMfa(user.id);
  const token = auth.newSessionToken();
  await db.query('INSERT INTO sessions (user_id, token_hash, expires_at, user_agent) VALUES (?, ?, ?, ?)', [
    user.id,
    auth.hashToken(token),
    new Date(Date.now() + 86_400_000),
    'market test',
  ]);
  accounts.push({ userId: user.id, phone });

  const cookie = `hc_session=${token}`;
  return {
    userId: user.id,
    async get(routePath) {
      return fetch(`${ctx.baseUrl}${routePath}`, { redirect: 'manual', headers: { Cookie: cookie } });
    },
    async post(routePath, form) {
      return fetch(`${ctx.baseUrl}${routePath}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    },
  };
}

/** The flash a form POST left behind, read off the 303 it redirected with. */
function flash(response, key = 'ok') {
  const location = response.headers.get('location') || '';
  return new URL(location, 'http://example.test').searchParams.get(key) || '';
}

/** Open a market through the console, and hand back what it did. */
async function openMarket(staff, slug, stockPrefix = '') {
  const response = await staff.post('/admin/settings/markets', { slug, stock_prefix: stockPrefix });
  assert.equal(response.status, 303, 'a form POST redirects back to the screen');
  const city = await db.areas.cityBySlug(slug);
  if (city) opened.push(city.id);
  return { response, city, message: flash(response) };
}

/** Close or re-open a market, or save its series, through the screen. */
async function saveMarket(staff, id, form) {
  const response = await staff.post(`/admin/settings/markets/${id}`, form);
  assert.equal(response.status, 303);
  return { response, ok: flash(response), err: flash(response, 'err') };
}

// ---------------------------------------------------------------------------
// The form — the country, minus the markets that already exist
// ---------------------------------------------------------------------------

maybe('the screen offers every city in the national list that is not a market yet', async () => {
  const staff = await staffSession();
  const response = await staff.get('/admin/settings');
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /Open a new market/);
  assert.match(html, /Choose a city/);

  // Just the select: the header's own market links are on this page too, so a
  // document-wide grep for a slug would prove nothing.
  const start = html.indexOf('id="open-market-slug"');
  assert.ok(start > 0, 'the select is on the screen');
  const select = html.slice(start, html.indexOf('</select>', start));

  assert.match(select, /value="lagos"/, 'a catalogue city we do not operate in is offered');
  assert.match(select, /value="kano"/);
  assert.doesNotMatch(select, /value="port-harcourt"/, 'a city that is already a market is not offered again');
  assert.doesNotMatch(select, /value="owerri"/);
  // Grouped by state, and the FCT reads as the FCT rather than “FCT State”.
  assert.match(select, /<optgroup label="Lagos State">/);
  assert.match(select, /<optgroup label="FCT">[\s\S]*value="abuja"/);

  // The markets themselves carry their controls: a series box and the decision.
  assert.match(html, /Rivers State/);
  assert.doesNotMatch(html, /Rivers State State/, 'the label rule is shared, not re-spelled');
  assert.match(html, /Save series/);
  assert.match(html, /Close market/, 'every market here is open, so every card offers the decision');
});

maybe('a city that is not in the national list cannot become a market', async () => {
  const staff = await staffSession();
  const response = await staff.post('/admin/settings/markets', { slug: 'atlantis', stock_prefix: '' });
  assert.equal(response.status, 303);
  assert.match(flash(response, 'err'), /not in the national catalogue/i);
  assert.equal(await db.areas.cityBySlug('atlantis'), null, 'nothing was written');
});

// ---------------------------------------------------------------------------
// Opening — the promotion itself
// ---------------------------------------------------------------------------

maybe('opening a market makes it a market everywhere the site asks', async () => {
  const staff = await staffSession();

  const { city, message } = await openMarket(staff, 'lagos');
  assert.match(message, /Lagos is open\./, `the flash should confirm the market: ${message}`);

  // The row: named and stat-ed from the catalogue, with its own series.
  assert.ok(city, 'the market exists');
  assert.equal(city.active, true);
  assert.equal(city.name, 'Lagos');
  assert.equal(city.state, 'Lagos');
  assert.equal(city.stockPrefix, 'HC-LG', 'the catalogue’s series is the default');

  // One row, not two, and listed as a market the site operates in.
  const cities = await db.areas.cities({ includeInactive: true });
  assert.equal(cities.filter((row) => row.slug === 'lagos').length, 1);

  const list = await directory.directory();
  const lagos = list.find((row) => row.slug === 'lagos');
  assert.equal(lagos.served, true, 'the picker now treats Lagos as a market');
  assert.equal(lagos.live, 0, 'and tells the truth about the empty shelf');
  assert.equal(list.length, 48, 'the picker still lists the country — it did not grow a second Lagos');

  // The storefront remembers it now: `?city=` on a market is a market, and the
  // visitor's choice is worth keeping. (A catalogue city is deliberately never
  // remembered — being sent to an empty grid on every visit is not a kindness.)
  const cars = await fetch(`${ctx.baseUrl}/cars?city=lagos`, { redirect: 'manual' });
  assert.equal(cars.status, 200);
  assert.match(cars.headers.get('set-cookie') || '', /hc_city=lagos/, 'a market is remembered');
});

maybe('a market needs a series of its own', async () => {
  const staff = await staffSession();
  assert.ok(await db.areas.cityBySlug('lagos'), 'the previous test opened it');

  const taken = await openMarket(staff, 'lagos', 'HC-PH');
  assert.match(flash(taken.response, 'err'), /stock series already/i, 'a series identifies its market');

  const nonsense = await openMarket(staff, 'lagos', 'nope');
  assert.match(flash(nonsense.response, 'err'), /HC-OW/);

  const again = await openMarket(staff, 'lagos');
  assert.match(flash(again.response, 'err'), /already a market/i);

  assert.equal((await db.areas.cityBySlug('lagos')).stockPrefix, 'HC-LG', 'none of that touched the row');
  assert.equal((await db.areas.cities({ includeInactive: true })).filter((row) => row.slug === 'lagos').length, 1);
});

// ---------------------------------------------------------------------------
// Closing, and the guards around it
// ---------------------------------------------------------------------------

maybe('closing a market with cars in it is refused, with the count', async () => {
  const staff = await staffSession();
  const portHarcourt = (await db.areas.cities({ includeInactive: true })).find((row) => row.slug === 'port-harcourt');
  assert.ok(portHarcourt.live > 0, 'the seeded market has stock to protect');

  const { err } = await saveMarket(staff, portHarcourt.id, { active: '' });
  assert.match(err, /still has \d+ live car/i);
  assert.match(err, /sell, move or expire/i, 'and it says what to do about it');

  const after = await db.areas.cityBySlug('port-harcourt');
  assert.equal(after.active, true, 'the market is still open');
});

maybe('a market with an empty shelf closes, and its city stays in the picker', async () => {
  const staff = await staffSession();
  const lagos = await db.areas.cityBySlug('lagos');

  const { ok } = await saveMarket(staff, lagos.id, { active: '' });
  assert.match(ok, /Lagos is closed\./);

  const closed = await db.areas.cityBySlug('lagos');
  assert.equal(closed.active, false, 'the row stays — its areas and its history are filed under it');

  // And the screen says so, in the card rather than in a place ops has to guess.
  const screen = await (await staff.get('/admin/settings')).text();
  assert.match(screen, /Re-open market/, 'a closed market offers the way back');
  assert.match(screen, /tag--muted">closed/);
  assert.equal((await db.areas.cities()).some((row) => row.slug === 'lagos'), false, 'it leaves the markets we operate');

  // But the country list still has the city: a buyer in Lagos keeps the honest
  // empty state rather than being told Lagos does not exist.
  const list = await directory.directory();
  const city = list.find((row) => row.slug === 'lagos');
  assert.equal(city.served, false, 'the catalogue entry takes over again');
  assert.equal(city.prefix, 'HC-LG', 'and it comes back with the catalogue’s own details');

  // Re-opening is a correction rather than a duplicate, and it takes the details
  // just entered — the same rule `addArea` follows for a retired area.
  const reopened = await openMarket(staff, 'lagos', 'HC-LD');
  assert.match(reopened.message, /Lagos is open again\./);
  assert.equal(reopened.city.id, lagos.id, 'the same row, not a second one');
  assert.equal(reopened.city.stockPrefix, 'HC-LD');
  assert.equal((await db.areas.cityBySlug('lagos')).active, true);
});

maybe('a series is saved, upper-cased, and one market cannot take another’s', async () => {
  const staff = await staffSession();
  const lagos = await db.areas.cityBySlug('lagos');

  const clash = await saveMarket(staff, lagos.id, { stock_prefix: 'HC-OW' });
  assert.match(clash.err, /stock series already/i);

  const nonsense = await saveMarket(staff, lagos.id, { stock_prefix: 'lagos' });
  assert.match(nonsense.err, /HC-OW/);

  const saved = await saveMarket(staff, lagos.id, { stock_prefix: 'hc-lg' });
  assert.match(saved.ok, /stock series is HC-LG/);
  assert.equal((await db.areas.cityBySlug('lagos')).stockPrefix, 'HC-LG', 'stored upper-case');

  const missing = await saveMarket(staff, 999_999_999, { active: '' });
  assert.match(missing.err, /does not exist/i);
});

// ---------------------------------------------------------------------------
// The revalidation underneath — the list is in every page, so every page moves
// ---------------------------------------------------------------------------

test('a change that touches every page re-renders the build, and invents no route', () => {
  assert.deepEqual(publish.TOUCHES.market(), ['*'], 'the market list is in every stable page');
});

maybe('opening a market re-renders the pages that carry the list', async () => {
  // The suite has its own build directory, so this fixture is a build rather
  // than an assertion about whatever happens to be in a developer's `dist/`.
  runScript('scripts/build-static.js', ['--quiet']);
  const staticDir = config.features.staticPath;
  const indexPath = path.join(staticDir, 'index.html');
  const index = () => fs.readFileSync(indexPath, 'utf8');
  assert.equal(fs.existsSync(indexPath), true, 'the fixture build exists');
  assert.doesNotMatch(index(), /href="\/cars\?city=kano"/, 'Kano is not a market to begin with');

  const staff = await staffSession();
  const { message } = await openMarket(staff, 'kano');
  assert.match(message, /Kano is open\./);
  assert.match(message, /rebuilt/i, `the flash reports the rebuild: ${message}`);
  assert.match(index(), /href="\/cars\?city=kano"/, 'the built header carries the new market');

  // And the mechanism: '*' re-renders the build as it stands, page for page.
  const manifest = render.loadManifest(staticDir);
  const all = await publish.revalidate(['*']);
  assert.equal(all.ok, true);
  assert.equal(all.rebuilt.length, manifest.routes.size, 'every page in the build, no more');

  // A path that is not in the build is skipped rather than written: this is a
  // re-render, not a second build, and publishing must never invent a URL.
  const invented = await publish.revalidate(['/a-page-nobody-built']);
  assert.deepEqual(invented.rebuilt, []);
  assert.deepEqual(invented.skipped, ['/a-page-nobody-built']);
  assert.equal(fs.existsSync(path.join(staticDir, 'a-page-nobody-built.html')), false);

  const nothing = await publish.revalidate([]);
  assert.deepEqual(nothing.rebuilt, [], 'nothing to do is not an error');
});
