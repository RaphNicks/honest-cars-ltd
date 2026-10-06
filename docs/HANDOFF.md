# Handoff — where this build is, and how to continue it

**Written 2026-10-06, updated for FR-28, on branch `arena/01a0f7df-honest-cars-ltd`.**
If you are picking this up (a person or an agent in a new session), read this file
first, then `docs/GAPS.md` for the row-by-row list of what is left.

---

## 1. What this is

honestcarsltd.com rebuilt as a **Node + Express + EJS + vanilla JS + MySQL** site,
to the specification in `Honest_Cars_LTD_Website_Specifications_Final.pdf`
(extracted to text at `docs/PRD-extracted.txt`).

The rules that shape every decision:

- **PRD §3 design tokens are the source of truth** — the original Next.js repo this
  was meant to mirror does not exist (see §7 below). Palette, Inter self-hosted,
  8px grid, 1200px container, 12px radius, the type ladder.
- **No React, no Tailwind, no frontend build step.** Vanilla ES modules for
  interactivity only. CSS is hand-written.
- **Hybrid rendering (§12.4):** stable pages are generated to `dist/` at build
  time; `/cars`, the VDP, the concierge flow and the shop render per request.
- **All data access goes through ONE module:** `src/db/index.js`. Nothing else
  opens a connection. `db.query` / `db.queryOne` / `db.transaction`.
- **Honesty is a feature.** No PSP credentials ⇒ bank transfer, recorded as such.
  A channel that cannot deliver records the message as `skipped` and keeps the
  text — never silently dropped. No invented numbers, ever.

Run it:

```bash
bash scripts/sandbox/recover.sh     # after a sandbox wipe: deps, MySQL, .env, head
npm run db:seed                     # 79 listings across 4 markets, 8 posts, staff + customer accounts
npm run build:static                # 72 static pages into dist/
npm start                           # http://localhost:3000
```

MySQL runs from `/home/user/mysql-runtime` on **port 3307** (see `.env`). Start it
with `bash scripts/sandbox/mysql-start.sh` in a background process — never
backgrounded from a plain shell command, it will be killed.

---

## 2. What is built and verified

Every **§9 MUST is built.** The commit trail, most recent first:

| Commit | What it delivered |
|---|---|
| *this commit* | **FR-28** referrals: who came from whom, and the reward status behind it |
| `c974792` | **FR-32** multi-city inventory + area switcher + `/admin/settings` area manager |
| `e78fd4c` | **FR-33** dealer CSV/API import + API keys |
| `9d1b4d8` | **FR-18** dealer add-ons + commission statements |
| `9cd3b66` | **FR-35** blog: author pages, governed tags, listing embeds, editorial calendar |
| `b809f8c` / `be55e36` | FR-35 groundwork — migration 021, `content.js`, tag/author routes |
| `f4f0a01` / `f1fbba4` / `c51946a` / `0f424bc` | **FR-22** hire management + docs |
| `a6ba608` | `docs/GAPS.md` retired FR-20 (27 left) |
| `0f424bc` | **FR-22** hire management: pool, availability, bookings, incidents, invoice PDF |
| `3f01527` | **FR-20** tracker subscriptions: renewals, reminders, dealer retainers |
| `a834c71` | `docs/HANDOFF.md` (this file) |
| `8c53572` | FR-20 groundwork — migration 019, `src/db/subscriptions.js`, `src/services/renewals.js` |
| `88a2882` | `docs/GAPS.md` retired §13.2 + FR-24 rows (28 left) |
| `6a2e989` | §13.2 low-bandwidth set + FR-24/§16 video |
| `eeb409e` | `docs/GAPS.md` retired the §15.2 row |
| `1c960a4` | §15.2 marketing dashboard (`/admin/marketing`, CAC guardrail, UTM capture) |
| `406f87a` | FR-19 concierge shortlist + options PDF |
| `de9485b` | §6.4 comparison (≤3) |
| `e104991` / `9456905` | §7.3 reports (pillar/inspector/dealer/UTM) + fixtures |
| `feaff5b` `a496a9b` `bdf6bc4` | §7.3 price-intel bands + staleness |
| `ecc0bbd` | FR-05 concierge retainer |
| `3db5694` | FR-25 alerts + §7.2 dealer portal |
| `d3957a9` | FR-24 CMS |
| `f76fbf4` `5bd9b0a` `5357649` `8a960c5` | role smoke, payments/escrow/report PDF, admin console + §7.4 matrix, FR-01–FR-15 vertical slice |

Two full acceptance passes are recorded in the PR comments: **§7.2 dealer portal**
(dashboard → listings → wizard → leads → scorecard → orders & billing → profile,
admin approval before Live) and **FR-25 alerts** (per-user switches driving a real
watcher, deduped by baselines/watermarks).

**§13.2 low-bandwidth, closed out in `6a2e989`** — the four PRD asks plus the
resilience ask:

- 42 photos each have a 20px inline WebP placeholder (`src/lib/image-blur.json`,
  ~200 B each) and a 600×450 sibling; the frame paints from the placeholder.
- `Save-Data: on` ⇒ server sends the 600px file and **no srcset**, with
  `Vary: Save-Data`. Static pages read `navigator.connection.saveData` themselves.
- Video is strictly tap-to-load, labelled with its **measured** duration and size
  (`0:12 · 244 KB`) from `src/lib/video-manifest.json`; nothing is fetched before
  the press.
- Forms keep a draft and offer it back; a send that fails on the **network** is
  held in an outbox and sent when the connection returns. A 4xx is never queued.

**FR-24/§16 in the same commit** — migration 018 (`duration_seconds`,
`size_bytes`, `poster_url` on `listing_media`), a `video` content block with a
`[clip:…]` directive, clips on two listings' galleries, and 8 blog posts with 3
embedded videos. All four clips total 726 KB.

---

## 3. Just finished: FR-28 referrals

**Built in this commit.** §7.1 asked for *"Referrals (personal link + reward
status)"*. The link and the attribution have existed since migration 007 — the
card on `/account` shows the code, the count and the orders. The **status** was
the missing half: a referral that counted was a number with no answer to "and
then what?".

What it does:

- **Two columns and one table** (migration **025**): `users.referral_qualified_at`
  is the permanent moment a referral started to count, `users.referral_note` is
  the desk's line on it, and `referral_rewards` carries the decision —
  `pending → approved → paid`, or `void` with a reason. The unique key
  `(referrer_id, referred_user_id)` is the honesty constraint: a person counts
  once, and a sweep that runs twice cannot inflate the queue.
- **Counting is automatic, paying never is.** `sweep()` finds referred accounts
  with a paid order and no qualification (the threshold is
  `REFERRAL_QUALIFY_ORDERS`, default one) and queues a **pending** row with
  `amount_kobo = 0`. Nothing is promised until a human types an amount on
  `/admin/referrals`. `npm run referrals [-- --dry-run]` is the cron entry point
  and prints who would count without writing anything; the button on the console
  runs the same function.
- **The desk's page** (capability `referrals.view` = admin/ops/finance,
  `referrals.reward` = admin/ops) shows the queue, the totals (waiting, approved
  but unpaid, paid, voided) and the links that worked. Approve / mark paid / void
  / restore — every transition audited (`referral.*`) with the actor's name, and
  every customer-facing step announced through `notify` (so an unconfigured
  channel is recorded `skipped` with its text intact, never dropped).
- **The customer's card** now says what happened to each person their link
  brought in: *not counted yet*, *with the desk*, *approved · ₦2,000*, *paid ·
  ₦2,000 on 12 Oct*, or *voided — reason*. No figure appears until the desk sets
  one, which is why the reward amount is a form field and not a constant.
- **The seed exercises every state**: Ngozi (qualified, pending), Emeka (signed
  up, no order), Ifeoma (qualified, approved and paid), all under Ada's code —
  and two real paid orders with their payment rows behind them, because a paid
  order with no payment row is the thing the console flags.

Where the code is: `db/migrations/025-referral-rewards.sql`, `src/db/referrals.js`,
`src/services/referrals.js`, `scripts/referrals.js`, `src/routes/admin.js`
(`/admin/referrals` + its POSTs), `views/pages/admin/referrals.ejs`, the
Referrals card in `views/pages/account.ejs`, and `test/referrals.test.js`
(11 tests).

**A note on the time it saves:** `sweep()` is idempotent by SQL rather than by
state in memory, so a cron job, the console button and a manual run can all
happen in the same minute and the queue still gains one row per person.

---

## 3b. FR-32 multi-city inventory

**Built in this commit.** FR-32 is *"Multi-city inventory structure (Owerri/Aba/
Benin) with area switcher"*, COULD/P3 — but the PRD's data model already decided
the important part: *"city / area enum/str ✓ Default Port Harcourt; area list
admin-managed"*. So this is two things: a city dimension through the inventory,
and an area list ops owns.

What it does:

- **Markets are rows, not strings.** `service_cities` (slug, name, state,
  `stock_prefix`, blurb, position, active) and `service_areas` (city, name,
  position, active), migration **024**. A retired area is `is_active = 0`; the
  listings that mention it keep mentioning it.
- **Seeded to be real, not a token listing.** 79 cars now split 43 / 7 / 6 / 7
  (Port Harcourt / Owerri / Aba / Benin City) across 18 lots — two new lots per
  expansion market, and the new-city cars are filed under that city's own
  neighbourhoods. Each market has 10 areas.
- **Stock numbers run per market:** `HC-PH-0079`, `HC-OW-0080`, `HC-AB-0072`,
  `HC-BN-0073`. A listing inherits its lot's market (`db.dealers.marketFor`), so
  a lot can never file a car in a city it does not sit in, and an area-less car
  falls back to its market, not to Port Harcourt.
- **The city is governed, never free text.** `?city=owerri` is parsed as a slug,
  resolved against `service_cities` (`db.areas.cityByToken`) and only then used
  as a filter; anything else is dropped — `?city=lagoos` is the whole network
  again, and a hand-edited `<script>` value never reaches SQL.
- **The rail follows the market.** `db.listings.filterFacets({city})` scopes
  makes, areas, budget range and counts to the market in view; areas render
  grouped under a market caption when the whole network is on screen.
- **Four indexable market pages** (`/cars/port-harcourt`, `/cars/owerri`,
  `/cars/aba`, `/cars/benin-city`) are curated facets (`page_type = 'city'`,
  added to the enum), statically built and in the sitemap at priority 0.8. A
  `?city=owerri` URL with nothing else canonicalises onto `/cars/owerri`.
- **The switcher** is in the header on every page (drawer copy for phones), with
  live counts per market. Picking one writes the `hc_city` cookie: the server
  applies it on /cars when no `?city=` is given (private cache, `Vary: Cookie`,
  noindex — a preference-shaped page is not the page we index), and
  `public/js/area.js` labels the control on prebuilt static pages, where Node
  never runs. No cookie-parser in this build — it is hand-read like
  `auth.readSessionToken`.
- **Ops owns the list** at `/admin/settings` (§5.1's settings screen, capability
  `settings.manage`, admin/ops): add, rename, retire, restore and reorder areas
  per market, every change audited. A rename is **not** retroactive — the cars
  keep the old spelling and the desk is told how many — and a separate panel
  lists cars filed under areas the list does not know about, with a one-click
  "add to <market>".
- **Dealer side:** the wizard and edit form suggest the lot's own market's
  areas, and FR-33's CSV import leaves the area blank rather than assuming Port
  Harcourt — and warns when a row's area is not on the lot's market list.

Where the code is: `db/migrations/024-service-areas.sql`, `src/db/areas.js`,
`src/services/area-pref.js`, `views/partials/area-switcher.ejs`,
`views/pages/admin/settings.ejs`, `public/js/area.js`, plus `city` in
`src/db/listings.js`, `src/services/listing-query.js`, `src/db/dealers.js`,
`src/services/imports.js`, `src/routes/{public,api,admin,dealer}.js`,
`test/areas.test.js` (15 tests) and three route tests in `test/routes.test.js`.

**A latent bug found on the way:** `db.listings.filterFacets` interpolated
`buildWhere().sql` into eight queries but never passed `buildWhere().params` —
harmless while every filter in it was empty, and a 1210 the moment a real filter
(city) arrived. It now takes the WHERE fragment and its params together.

---

## 3c. FR-35 blog enhancements

**Built in this commit.** §6.9 asked for five things on top of the blog that
existed — author pages, a governed tag taxonomy, a smarter related-posts
engine, dynamic listing embeds, and an editorial calendar in the CMS.

What it does:

- **A byline is a person.** `blog_authors` is an entity with one bio, so a role
  change is one edit rather than one per post, and `/blog/author/{slug}` exists
  to link to. Deleting an author never deletes their work — the FK is ON DELETE
  SET NULL and the post keeps the printed byline it was published with.
- **Tags are governed, not free text.** `blog_tags` + `blog_post_tags` sit
  beside (not on top of) `make_tags`: make tags pull live listings into an
  article, tags say what the article is *about*. `/blog/tag/{slug}` is a real
  shelf, and an unused tag is still listed in the console — it is a decision
  that was made, not a gap.
- **Related posts rank by what they share** — a shared tag beats a shared
  category, a shared make beats recency, recency breaks the tie.
- **`[listing:slug]`** puts one named car into the body as a real card, and
  renders nothing at all when that car has sold. A dead card is worse than no
  card.
- **The editorial calendar** (`/admin/cms/calendar`) is a month at a glance:
  every post on the day it is due, in its workflow colour, one click into the
  editor. Publishing twice on a Monday morning is the mistake it prevents.
- **Saving rebuilds the shelves.** A post that moves between tags or changes
  author changes three or four pages; `publish.TOUCHES.post` takes
  `{slug, tagSlugs, authorSlug}` and the console passes all three.
- **The shelves are static.** Tag and author pages are collections of published
  posts, so they are exactly as stable as the posts: 53 pages → 68. An empty
  shelf is skipped, and so is an empty author page in the sitemap.

Where the code is: `db/migrations/021-blog-authors-tags.sql`, `src/db/content.js`,
`src/db/cms.js`, `src/routes/blog.js`, `src/routes/admin-cms.js`,
`src/services/blocks.js`, `src/services/sitemap.js`, `src/services/publish.js`,
`views/pages/blog-tag.ejs`, `views/pages/blog-author.ejs`,
`views/pages/admin/cms-calendar.ejs`, `test/blog-tags.test.js` (12 tests).

**Also fixed, found by building a database from empty for the first time:**
`db/schema.sql` created `hire_bookings` before `service_requests` and
`hire_incidents` before `payments`, so a fresh `npm run db:setup` failed with
`ER_CANNOT_ADD_FOREIGN`. Every existing database was unaffected because
migration 020 adds the same objects after the targets exist — which is exactly
why nobody had seen it.

**Next in order:** FR-29 instant valuation → FR-30 PWA → FR-34 financing
handoff, then the rest of the `/admin/settings` groups (§18.3 privacy requests
and §12.2 admin MFA are the other buildable rows).
`docs/GAPS.md` is canonical: 22 rows, each with what “done” means.

## 4. Conventions that are not negotiable

- **Money** in kobo, integer, through `src/lib/money.js`. Phones through
  `src/lib/phone.js` (`variants()` for lookups — never a raw `0808…` match).
- **Listing identity** is `seo_slug`; `vehicle_listings` has no `slug` column.
- **No locals key named `page`**; `defaultPage()` owns title/robots/og/jsonLd.
- **Admin chrome:** `done(res, path, msg, { error, params })` → 303 with `?ok`/`?err`.
  Role gates come from `src/services/roles.js` — never a role string inline.
- **§15.1 event names verbatim.** `EVENT_NAMES` is a `Set`; the client payload
  allowlist in `src/services/events.js` silently drops anything not listed
  (`save_data`, `video_duration`, `video_size`, `blur_up` were added for §13.2).
- **`src/**` and `views/**` do not hot-reload.** Restart the site process after
  editing them, then re-verify — a stale process once produced a 500 that did not
  exist on disk.
- **`node --check` cannot parse `public/js/*.js`** (they are ES modules) — use
  `npm run lint`. Backticks inside `scripts/generate-seed.js` break its template
  literal; escape them and re-check.
- **Tests** (`node:test`) skip themselves when MySQL is unreachable. They must not
  read `dist/`. Mint sessions directly rather than signing in via OTP — OTP tests
  leak `auth_codes` and `otp_*` rows nothing can clean up.

## 5. Gates before any commit

```bash
npm test          # 379/379 (15 areas, 16 imports, 12 blog-tags, 11 referrals …)
npm run lint      # type ladder + 15 ES modules / 75 event references
npm run build:static && npm run crawl && npm run audit:pages
npm run smoke && npm run smoke:cms      # role matrix + CMS round trip
npm run images:check && npm run videos:check
```

`crawl` must report 0 broken links; `audit:pages` 0 findings.

Two cron-style sweeps run outside the request path, and both are also buttons in
the console: `npm run alerts` (FR-25 price/new-match alerts) and `npm run
referrals` (FR-28 — counts referrals that have earned it; `-- --dry-run` prints
who would count and writes nothing).

## 6. Housekeeping

- **PR #1** is open on purpose — the user tests from it. **Do not merge** until they
  sign off. Comment substantive changes there.
- Regenerating media: images `generate_image` → `npm run images` → `db:seed`;
  video needs `npm i --no-save @ffmpeg-installer/ffmpeg` after a wipe, then
  `node scripts/generate-videos.js`. The committed media works without ffmpeg.
- The sandbox wipes between sessions: HEAD resets, `node_modules`, `.env` and MySQL
  go. `bash scripts/sandbox/recover.sh` restores all of it from the pushed branch —
  which is why every green step is committed and pushed immediately.

## 7. Dead ends — do not retry

- The referenced Next.js repo (`RaphNicks/honest-cars-ltd` @ `c765c8a`,
  `src/app/globals.css`) **does not exist**; the PDF is the design source of truth.
- `honestcarsltd.com` does not resolve; no headless browser is available.
- Two consecutive pushes to this branch can non-fast-forward:
  `git fetch origin arena/01a0f7df-honest-cars-ltd` + `git reset --mixed FETCH_HEAD`,
  keep the tree, re-commit.
- In this sandbox only the npm registry is reachable, and MySQL 5.7 is built from
  the `mysql-server-5.7-lin-x64` tarball by `scripts/sandbox/`.
