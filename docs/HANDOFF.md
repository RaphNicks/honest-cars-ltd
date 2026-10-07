# Handoff — where this build is, and how to continue it

**Written 2026-10-07, updated for §12.2, on branch `arena/01a0f7df-honest-cars-ltd`.**
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
| *this commit* | **OG cards** — titles wrap and fit instead of clipping; the schema logo stopped 404ing |
| `4aaa1e4` | **§12.2 second factor** — TOTP for admin/finance, recovery codes, the challenge gate |
| `fbfa63b` | **§18.3 privacy desk** — data-subject requests, the 30-day clock, consent records |
| `9763e66` | **§5.1 settings** — the rest of the screen: business facts, limits, fees, channels |
| `b2c08cf` | FR-34 docs — the section, the gates, and the traps it hit |
| `5c28628` | **FR-34** financing enquiries and the lender handoff |
| `485bf04` | **FR-30** installable PWA: manifest, generated icons, service worker, `/offline` |
| `c680d51` | **FR-29** instant valuation widget on /sell-swap, from the price-intel bands |
| `d1b1da0` | **FR-28** referrals: who came from whom, and the reward status behind it |
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

## 3z. Earlier: §5.1 settings — the rest of the screen

**Built in this commit.** FR-32 built the market/area half of §5.1's settings
screen; this is the other half. Business facts, page limits, the sold-car
windows, the concierge SLA card, the referral and CAC figures, and the channel
each message takes are now editable at `/admin/settings` — off `.env`, without a
deploy.

**The registry is the screen**

`src/lib/settings-schema.js` declares all 42 settings: type, range, built-in
default, and one sentence an operator needs. `services/settings.js` draws the
form from it. Two rules make the screen trustworthy rather than decorative:

- **If it is on the screen, the code reads it.** `test/settings.test.js` walks
  `src/`, `views/` and `scripts/` and requires every key to appear in a consumer
  file. A row with no reader fails the suite — which is the failure mode this
  screen actually has: an operator changes a number, believes something
  happened, and nothing did.
- **The default is the environment, and it is written down once.** An override is
  a row in `settings` (migration 027); **resetting is a DELETE**, and what comes
  back is the registry's default. A fresh install has an empty table and behaves
  exactly as the site did before this screen existed.

**How a value travels**

`config.js` reads overrides through getters — `overrides.value('listings.per_page')`
— so nothing has to know whether a value came from `.env` or the console. That
also means the numbers the *same* code path uses move together:
`concierge.slaOptions()` feeds the card on /find-my-car, the price
`POST /api/service-requests` charges, and the amount on the payment record.

**Prebuilt pages and a changed setting**

A static page has the footer's phone number, the CAC line and the retainer prices
baked in. So `respond.js` refuses to serve a build that predates the newest
setting: it renders on request, sets `X-HonestCars-Stale-Build`, and returns to
the prebuilt file after the next `npm run build:static`. Self-healing, visible in
a header and in the save flash — and the alternative (a footer quietly showing
last month's phone number) is exactly the kind of lie this project does not ship.

**What is deliberately absent**

Provider credentials — PSP, SMS, SMTP, GA4, Meta — are not settings and never
appear on the screen; they are deployment secrets and the panel says so. Same for
the DB connection and the auth pepper.

**Files**

- `src/lib/settings-schema.js` — the registry, with `parse`/`coerce`/`display`.
- `src/lib/overrides.js` — the in-memory overrides, `changedSince()` for the
  stale-build rule.
- `src/db/settings.js`, `src/services/settings.js` — load, save a group, reset,
  and the console's view.
- `db/migrations/027-site-settings.sql` + `db/schema.sql` — one table.
- `src/routes/admin.js` — `POST /admin/settings/group/:key` and `.../reset`,
  audited as `settings.updated` / `settings.reset`.
- `views/pages/admin/settings.ejs` — the four groups, drawn from the registry.
- `scripts/generate-seed.js` — two changed settings, so a fresh database shows
  the mechanism.
- `test/settings.test.js` — 17 tests, fixture build and all.

---

## 3z. Just finished: the company number

`0913 562 6182` is the real number. It lives in `src/lib/settings-schema.js` as
the registry default (`business.phone` = `+2349135626182`, `business.whatsapp` =
`2349135626182`), which is the single source every surface reads:

- `tel:` links — footer, `/contact`, `/about`, the report-inspection page;
- every WhatsApp link and button — the floating button, the header, every form's
  success state, `public/js/nav.js`, all built from `config.business.whatsapp`;
- the `AutoDealer` JSON-LD `telephone` in `src/services/seo.js`;
- the letterhead on all four PDFs — `services/{concierge,invoice,report,statement}.js`
  all print `phone.pretty(x.phone)`.

**Stored canonical, displayed grouped.** Links must be `+2349135626182`; eyes
read `+234 913 562 6182`. `src/lib/phone.js` gained `pretty()`, exposed to views
as `helpers.phonePretty` (`src/lib/locals.js`). Anything it cannot parse is
printed exactly as given — never mangled into a wrong number. `/admin/settings`
edits both without a deploy, and `.env.example` carries the real number as the
template.

**The bug worth remembering:** the `require('../lib/phone')` I first added to
`concierge.js` landed *inside* `businessInfo()` (where `config` is required
lazily) instead of at module scope, so the shortlist PDF threw
`ReferenceError: phone is not defined` and 500ed. The file's own test did not
catch it; the full-suite options-PDF test did. Assert your anchors, then read
the whole-suite result — not just the file you touched.

## 3y. The brand mark

The artwork was uploaded twice and destroyed twice — a sandbox restore at the
start of the turn empties `/home/user/uploads/` before the turn runs, and the
bytes are not recoverable from the message. So the *pipeline* is built and the
master is the only thing missing.

`assets/brand/logo.png` is the master. `npm run icons` cuts every size from it:
`public/img/logo.png` (header, drawer, console), `public/favicon.png` (tabs —
`favicon.svg` is retired), `icons/icon-192|512`, `icons/maskable-192|512`,
`icons/apple-touch-icon.png`, and rewrites `public/manifest.webmanifest`.
Derived files are committed; `npm run icons:check` byte-compares them.

Two design facts, both measured rather than assumed:

- The mark was drawn gold on black, so the black is kept — the art is trimmed of
  the upload's margin and centred on its own field. The maskable pair keeps
  every lit pixel inside Android's 80% safe circle; `test/brand.test.js` walks
  the pixels, so a master that would be cropped fails the suite instead of the
  home screen.
- Nothing points at a logo that is not there. `helpers.brandMark`
  (`src/lib/locals.js`) is null exactly when `public/img/logo.png` is absent, and
  each brand block draws the mark when it exists and its inline shield when it
  does not. `views/layouts/admin.ejs` had no favicon at all; it has one now.

Changing the master is one file plus `npm run icons && npm run build:static` —
no template, test or CSS edit. The OG card carries the mark above the eyebrow
line when one exists, and the mark is part of the card's cache key, so a logo
supplied later cannot leave stale cards behind.

## 3. Just finished: the OG cards that were clipping every title

**Found while answering "are images still missing?"** — the pictures were all
fine; two things that *point at* pictures were not.

**The card layout clipped text instead of fitting it.** `cardSvg()` drew one
`<text>` line per field and let librsvg cut whatever ran past the 1200px edge.
Anything past about thirty characters was chopped mid-word — which is nearly
every car in stock ("2018 Toyota Land Cruiser Prado" came out as "…Cruiser
Prad"), and the site-wide fallback card clipped its own headline. A shared link
is the first thing a customer sees, and it was arriving broken.

The fix measures rather than guesses. Each distinct word is rendered once at
100px and trimmed to its ink, and every later decision is arithmetic on that
number — advance widths are linear in font size, and across Inter the error was
under 0.1%, so a wrap costs one render per word instead of one per candidate
layout. Titles take the largest size that fits on one line (keeping the card's
original geometry exactly), then two, then shrink; the subtitle shrinks; the
badge pill is measured to its label rather than `label.length * 15 + 62`. A
title that still will not fit is ellipsised, so a preview never shows half a
word. `test/og.test.js` parses the SVG, measures every `<text>` with the same
renderer, and fails if any run ends past the edge.

**The structured-data logo was a 404.** `src/services/seo.js` pointed
`schema.org/Organization.logo` at `/img/logo.svg`, a file that was never
created — invisible because the visible logo is an inline icon. It now points
at `/icons/icon-512.png`, which is generated, committed and checked by
`npm run icons:check`.

**One subtlety worth keeping:** the fallback card is now re-rendered at boot
rather than only when missing, and the write is skipped when the bytes match.
A cached PNG from the previous layout would otherwise keep showing the clipped
headline forever, which is exactly the kind of fix that looks done and is not.

---

## 3a. Just finished: §12.2 the second factor

**Built in this commit.** §12.2 asks for MFA on the admin roles. The reading
taken here is narrow and deliberate: the two roles that can *move money or grant
a role* — `admin` (holds `users.manage`, so it can hand out capabilities,
including to itself) and `finance` (holds `payments.approve`). Ops, inspectors
and marketing are not locked out of a shift by it; they may enrol voluntarily,
and the console says how many colleagues have.

**What it does.** After the phone step, a session for an enrolled account is
*nothing*: it can open `/login/mfa`, the static shell, and the endpoint that
answers it. Everything else is a 302 to the challenge (or a 401 JSON for the
API). The challenge is a plain form — six digits, or one of ten recovery codes
typed into the same box. Getting it wrong five times kills the session outright
rather than leaving a first-factor foothold open.

**The decisions that took the longest, and why:**

- **No QR code anywhere.** A QR is the secret drawn as pixels, and drawing it
  means either a dependency that writes the secret into a data URL or an outside
  service receiving it. The setup screen prints the key, grouped in fours, with
  the `otpauth://` URI beside it for anything that can take one. Ten seconds of
  typing, and the secret never leaves the server and the phone.
- **Codes are spent where they are compared.** `UPDATE users SET totp_last_step =
  ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)` — the second
  request racing with the same code affects no rows. A replay gets "that code has
  already been used", not "wrong code", because the two send people to different
  places.
- **A half-finished enrolment protects nothing.** `totp_confirmed_at` is what
  counts, and it is set only by a proved code — the same code that then cannot be
  used to sign in.
- **One gate, one door.** A required role without a factor may reach
  `/admin/security` and nothing else; the whole-request gate and the per-route
  guard read the same `mfaEnrolmentOpen(path)`, so the screen that fixes the
  problem can never be closed by the rule it exists to satisfy. (It was, for one
  afternoon, until the suite caught it.)
- **Recovery codes are rendered, never redirected to.** The first cut sent
  `/admin/security?codes=…` — a credential in the browser history, the access log
  and the next request's `Referer`. They appear in exactly one response body.
- **Losing a phone is an admin act with a reason**, revoking every session that
  account held and writing to the audit log. Turning the factor off yourself
  needs a live code; a role that must have one cannot turn off its own at all.
- **Demo accounts carry seeded secrets** (`db/seed.sql`, and the smokes' copy of
  them) because this database has to be sign-in-able by a script. A real install
  has none: everyone enrols their own phone and nobody else holds the key.

**Files**

- `db/migrations/029-admin-mfa.sql` + `db/schema.sql` — `users.totp_secret` /
  `totp_confirmed_at` / `totp_last_step`, `sessions.mfa_pending` /
  `mfa_attempts`, `mfa_recovery_codes` (hashes only).
- `src/lib/totp.js` — RFC 6238, no dependencies, checked against the published
  vectors.
- `src/db/mfa.js` — enrolment, the step claim, recovery codes, coverage.
- `src/services/mfa.js` — policy, the challenge, the console's view.
- `src/services/{auth,roles,events,icons}.js`, `src/app.js` — the gate, the
  matrix (`MFA_ROLES`, `staff.security`), the two server-recorded events.
- `src/routes/auth.js` (`POST /api/auth/mfa`), `src/routes/account.js`
  (`GET /login/mfa`), `src/routes/admin.js` (`/admin/security` + its four posts,
  `/admin/staff/:id/mfa/off`).
- `views/pages/mfa.ejs`, `views/pages/admin/security.ejs`,
  `public/js/account.js` (`initMfaChallenge`), `public/css/components.css`.
- `test/mfa.test.js` — 25 tests; `test/helpers.js` gained `enrolMfa` /
  `completeMfa` for the nine suites that sign in as staff;
  `scripts/{smoke-roles,cms-smoke}.mjs` complete the challenge, and
  `scripts/lib/dev-codes.mjs` clears the spent step for a repeat run (never in
  production).

---

## 3b. Just finished: §18.3 the privacy desk (NDPA)

**Built in this commit.** §18.3's acceptance line — "NDPA consent records exist
for deal-alert signups; privacy requests actionable in admin" — is a claim about
paperwork, which is the kind of claim software can satisfy on paper and miss in
fact. So both halves are built against the way they could be false.

**Requests.** §12.2's self-service rights already worked: `/account/export`
downloads everything and `/api/account/delete` closes the account and anonymises
its records. What was missing was a *record* that someone asked. Both paths now
file themselves as rows the moment they happen — `self_service`, already
`completed`, with the act written down — deduplicated per person per day, so a
refresh is not a second request. Anything that arrived by WhatsApp, on the phone
or over the counter is logged by hand at `/admin/privacy`.

**Two rules live in the data layer, not the view:**

- **A closure carries a human sentence.** `completed` or `refused` with nothing
  written down is refused by `db/privacy.js`. "Completed" with nothing behind it
  is what a log of this kind looks like when it is theatre. Reopening a request
  clears the handler and the closing stamp, so a row cannot be both open and
  closed.
- **The clock is the person's.** `requested_at` is when they asked — which may be
  days before the row exists — and `due_at` is 30 days from *that*, stored rather
  than computed at render time so a request logged late is visibly late.

**Consent is events, not a flag.** `consent_records` is append-only: the box that
was ticked, the radio card that was chosen, the switch that was turned off, each
carrying the wording the person was reading. Withdrawing is a second row, never
an edit, so the history of what somebody agreed to stays intact. The register of
wording lives in `src/services/privacy.js`; `test/privacy.test.js` greps the
views for every sentence and requires every consent checkbox on the site to
belong to a notice — which is how "consent records exist" stays from quietly
becoming "for the forms somebody remembered".

**The screen answers the obvious question from where the flag lives.**
"How many people are on the deal-alert list?" is answered from `users`,
`saved_cars` and `saved_searches`; the log answers a different question — what
changed in the last 30 days. Deriving the first from the second would be a
plausible-looking lie.

**Files**

- `db/migrations/028-privacy-desk.sql` + `db/schema.sql` — `consent_records`
  (with the wording) and `data_requests` (with the clock).
- `src/db/privacy.js` — the requests, the events, the counts, and the refusal to
  close without a sentence.
- `src/services/privacy.js` — the **register of consent notices**, the
  self-service filing, and the desk view.
- `src/routes/admin.js` — `GET /admin/privacy`, `/privacy/requests.csv`,
  `POST /privacy/requests`, `POST /privacy/requests/:id`, audited.
- `views/pages/admin/privacy.ejs` — the queue, the log form, the consent tables.
- Hooks: `src/routes/account.js` (export, erasure, marketing switch, saved cars,
  saved searches), `src/routes/api.js` (every intake form, checkout, financing),
  `src/routes/auth.js` + `src/services/auth.js` (sign-in), `src/services/roles.js`
  (`privacy.view` / `privacy.manage`).
- `scripts/generate-seed.js` — three requests (one open on its 24th day), six
  consent events including a withdrawal.
- `test/privacy.test.js` — 17 tests; `scripts/smoke-roles.mjs` probes the desk
  for every role including the three it must refuse.

---

## 3c. Just finished: FR-34 financing handoff

**Built in this commit.** FR-34 (COULD): *"financing-lead partner handoff"* — the
answer to §6.5 step 3, which until now only ever sat in the brief.

**The honesty rule, first, because everything else follows from it**

There is **no rate, no APR, no approval and no "you qualify" anywhere** in the
service, the page, the messages or the console. What `plan()` does is arithmetic
the customer can check themselves:

```
price − down payment = the gap that has to be financed
gap ÷ months         = what the principal alone costs per month
```

A payment that does not cover the principal says *"this plan does not add up
yet"* and names the three levers (bigger down payment, longer tenor, a monthly
closer to the principal figure). A price fully covered by the down payment is
answered *"you do not need financing"*. Every answer carries the caveat: *"This
is arithmetic, not an offer. No credit decision has been made, and no rate is
implied."* `test/financing.test.js` fails if that ever stops being true.

**What shipped**

- **`db/migrations/026-financing-handoff.sql`** — `finance_partners` (empty by
  design: the list is ops') and `financing_leads`. `leads.type` gains
  `'financing'`, so the enquiry is also an inbox item. Reference
  `HC-FIN-######`, allocated with a retry on the unique key. The `plan` column
  stores the exact sentences the customer was shown, so a later dispute is
  answered from the record rather than from memory.
  **`db/schema.sql` is mirrored — new tables go in both.**
- **`src/services/financing.js`** — `plan()`, `capture()`, `route()`,
  `outcome()`, `accountView()`, `desk()`. `READINESS` is the list of what a
  Nigerian lender usually asks for, phrased as wording rather than a guarantee.
- **`src/routes/financing.js` + `views/pages/financing.ejs`** — the public page.
  It works with JavaScript off (a real form); with JavaScript on,
  `public/js/financing.js` posts to `/api/financing/plan` and prints the
  server's own sentences back, so there is **one** implementation of the
  arithmetic and the page cannot disagree with the record. A named car
  (`?car=`) is priced from the database, gets canonical `/financing` and
  `noindex,follow`, and is served through `sendPrebuiltOrRender('/financing?car=')`
  — the deliberately-different path is what stops the hub's prebuilt HTML being
  handed to a car URL.
- **The §6.5 handoff** (`src/routes/api.js`) — a concierge brief with
  `brief.financing === 'yes'` creates the financing lead itself, linked to the
  `service_request`, using the brief's budget as the amount, and the response
  carries `financing: { reference, status }` for the success screen. The
  customer does not fill in a second form. `public/js/service-forms.js` copies
  the radio's value into the brief — **a radio group contributes nothing to
  `FormData` when unchecked, and a missing key would silently mean "no"**.
- **`/admin/financing`** (`src/routes/admin.js`, `views/pages/admin/financing.ejs`) —
  the partner book (add, activate, switch off) and the queue, with the two
  states that need acting on kept apart: *waiting on us* (no partner yet) and
  *routed, no answer yet*. Capabilities `financing.view` (admin/ops/finance) and
  `financing.manage` (admin/ops); audit actions `financing.partner_added`,
  `financing.routed`, `financing.<status>`.
- **`notify.send` gains `mustDeliver`** (`src/services/notify.js`) — the one
  cross-cutting change. Where the message *is* the handoff, a console sink is not
  a delivery: it prints, records `skipped` **with the text intact**, and returns
  `ok:false`. So the console says *"recorded as routed to X, but nothing was
  delivered"* instead of *"they have the details"*, and the row carries a
  WhatsApp deep link so ops can send it by hand. A switched-off partner cannot be
  routed to at all.
- **`/account`** shows the customer their own enquiry — reference, car, figures,
  who it went to, and one sentence per state (`STATUS_SENTENCE`) that never says a
  lender has answered when they have not. The message and the account page share
  that sentence, so they cannot drift.
- **Seed** — two lenders (one switched off) and four enquiries, one per state,
  one linked to the concierge flow, one owned by the demo customer. The VDP
  carries a link (`/financing?car=<slug>`) with an honest sentence.
- **`scripts/generate-seed.js` gained `stockAt(n)`** — listing lookups now
  resolve from the generator's own list instead of a literal stock number. City
  prefixes move with the market cycle (FR-32), and a literal
  `'HC-PH-0018'` silently attaches a lead to **nothing** the moment they do.
  This closed a live bug: seeded leads were pointing at `NULL` listings.
- **`public/sw.js`** — the module joins the shell; `/js/admin.js` and
  `/js/dealer.js` leave it, because `/admin` and `/dealer` are bypassed by the
  worker and those bytes were paid by every visitor for nothing (the FR-30 test
  already documents them as deliberately absent).

**Config:** `NOTIFY_CHANNEL_FINANCING` in `.env.example` — empty, so it follows
the general channel.

---

## 3d. Just finished: FR-30 installable PWA

**Built in this commit.** FR-30 (COULD/P3): *"PWA (installable, offline shell,
push via web notifications)"* — plus §13.2's *"Offline-tolerant PWA shell COULD:
cached listings shell + queued enquiries that send when back online."*

**What shipped**

- **`scripts/generate-icons.js` → `public/icons/`** — 192/512 "any" icons, a
  maskable pair whose artwork is inset so Android's circular crop cannot eat it,
  a 180×180 apple-touch icon, and `public/favicon.svg`. All drawn from the same
  shield-and-check as `src/services/icons.js`, on the §3.2 navy. `npm run
  icons` builds them, `npm run icons:check` fails if they drift.
- **`public/manifest.webmanifest`** — generated by the same script (name,
  `start_url: /?utm_source=pwa`, scope `/`, standalone, portrait, theme
  `#0e2a47`, shortcuts to `/cars`, `/sell-swap`, `/account`). Generated, not
  hand-kept, because a manifest that names a missing icon is simply not
  installable and nothing tells you.
- **`public/sw.js`** — four caches, all named from one `VERSION`:
  - `shell` (29 URLs: the six public stylesheets, the two fonts the layout
    preloads, the icons, the manifest, every JS module, `/offline`),
  - `pages` (navigations, network-first with a 6 s ceiling, capped at 24),
  - `runtime` (CSS/JS/fonts picked up after install, capped at 40),
  - `assets` (images and video, stale-while-revalidate, capped at 80).
  It refuses anything that is not a same-origin `GET`; it never answers `/api/`,
  `/admin`, `/dealer`, `/account`, `/login`, `/checkout`, `/order/` or `/cart/`;
  and it will not store a response the server marked `private` or `no-store` —
  the header decides, not a hand-kept path list, so a signed-in page can never
  be handed to the next visitor.
- **`views/pages/offline.ejs`** — a real page (buildable, linked, tested,
  noindex) precached at install, listing what still works on the device and what
  needs a connection. It says "you are offline"; it does not say "please check
  your connection", which blames the visitor for our failure to fetch.
- **`public/js/pwa.js`** — registers the worker after `load` (never in front of
  first paint), reveals the footer install button only when the browser fires
  `beforeinstallprompt`, and mentions a newer version once. No auto-reload, no
  nag. §13.3 forbids app-download nagging; a button that does nothing when the
  browser has not offered install would be the dishonest option.
- **No second enquiry queue.** §13.2's queued enquiries are `drafts.js`'s job and
  have been since it shipped. A background-sync queue inside the worker would be
  a second, invisible place for a lead to go missing.

**The bug the harness caught.** `public/sw.js` is untestable in Node the normal
way, so a scratch harness (`/home/user/sw-harness.mjs`, outside the repo) runs it
against the live server with stubbed caches, `self`, and `Response`/`Request`.
It found that assets were read from the write cache only: a visitor who installed
the app and walked out of signal got unstyled pages, because the CSS was in
`shell` while the handler looked in `runtime`. Reads now check `shell` first
(`readFromAny`) and write to `runtime`. 12/12 behaviours verified, including
offline navigation to a cached page, `/offline` for one never opened, offline
CSS and JS, and the 24-page cap.

**Push is not built and is not pretended.** Web push needs VAPID keys, a push
service and a consented reason to send; the `docs/GAPS.md` row moved to the
blocked table rather than being quietly closed. `npm run icons:check` is in the
gate list below so a renamed asset cannot silently break installability.

---

## 3e. Just finished: FR-29 instant valuation

**Built in this commit.** §6.6's last line: *"Instant estimate widget COULD:
rough band from pricing DB with 'confirm with free human valuation' CTA."*

What it does:

- **The band is the one the site already trusts.** `src/services/valuation.js`
  reads `price_bands` (§7.3) through `db.pricing.findBand`, which applies the
  same rule as the VDP price badge in `db/listings.js` — exact condition beats
  `any`, most evidence wins a tie. One band, two screens, no drift.
- **Every answer carries its evidence and its age** — sample size, year range and
  how long since the refresh are all in the sentence. A band past §7.3's weekly
  refresh renders in amber with the caveat beside the number.
- **Mileage is described, never applied.** There is no mileage curve in this
  database, so the widget prints the median mileage of the live comparable stock
  (`db.listings.comparablesFor`) beside the seller's figure, says which way that
  usually moves the price, and says out loud that the human valuation decides.
- **"No band" is a real answer.** The reply names the year range we do cover, or
  the models of that make we hold, then hands over to the human valuation. It
  never invents a number.
- **One endpoint, one page.** `GET /api/valuation` (rate-limited 30/min,
  name-shape validated, JSON only) answers; `public/js/valuation.js` renders it
  with `textContent`; the CTA carries make/model/year/mileage into the intake
  form below and selects the matching condition radio. The three-step intake
  still works with JavaScript off — the widget is an upgrade, not the mechanism.
- **Nothing new is recorded in analytics.** §15.1 has no valuation event and this
  build does not invent event names; the lead the widget produces does record.

Where the code is: `src/services/valuation.js`, `src/db/pricing.js`
(`findBand`/`coverageFor`/`modelsFor`), `src/db/listings.js`
(`comparablesFor`), `src/routes/api.js`, `public/js/valuation.js`,
`views/pages/sell-swap.ejs`, `public/css/sections.css`, and
`test/valuation.test.js` (10 tests, each with its own invented model so a fixture
from one test can never answer another's question).

---

## 3f. Just finished: FR-28 referrals

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

## 3g. FR-32 multi-city inventory

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

## 3h. FR-35 blog enhancements

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

**Next in order:** FR-34 financing handoff, then the rest of the
`/admin/settings` groups (§18.3 privacy requests and §12.2 admin MFA are the
other buildable rows).
`docs/GAPS.md` is canonical: 21 rows — 5 buildable here, 9 blocked on an account
(FR-30's push half is one), 7 with no home in this sandbox.

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
- **The service worker (FR-30)** must never cache what the server marked
  `private`/`no-store`, must never answer `/api/`, `/admin`, `/dealer`,
  `/account` or checkout, and must not grow a second enquiry queue — that is
  `public/js/drafts.js`'s job. A new CSS or JS file belongs in `SHELL_URLS`; if
  you forget, `test/pwa.test.js` fails rather than shipping a page that loads
  unstyled offline. Console assets (`admin.css`, `admin.js`, `dealer.js`) are the
  deliberate exceptions.

## 5. Gates before any commit

```bash
npm test          # 458/458 (17 privacy, 17 settings, 24 financing, 15 areas, 16 imports, 11 referrals, 11 pwa …)
npm run lint      # type ladder + 18 ES modules / 75 event references
npm run build:static && npm run crawl && npm run audit:pages
npm run smoke && npm run smoke:cms      # role matrix + CMS round trip
npm run images:check && npm run videos:check && npm run icons:check
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
- Wipe #9 (2026-10-06) left the working tree intact and only reset HEAD: recover
  with `git fetch origin arena/01a0f7df-honest-cars-ltd && git reset --mixed
  FETCH_HEAD`, then `bash scripts/sandbox/bootstrap.sh`, start MySQL **with a
  process tool** (`bash scripts/sandbox/mysql-start.sh` — run from a one-shot
  shell it dies with the shell), `node scripts/db-setup.js`, `npm run build:static`.
- **Prebuilt pages carry settings.** After changing a business fact in the console
  the build is stale: the server renders on request (`X-HonestCars-Stale-Build`)
  until `npm run build:static` runs again. If a footer looks old in a screenshot,
  that is the reason — rebuild, do not chase the template.
- **A fully clean `db:setup` was verified on 2026-10-06** on a freshly initialised
  data directory: schema, then all 25 migrations in order (including 025's plain
  `ALTER TABLE`, the one that had no `IF NOT EXISTS`), 79 listings, 44 service
  areas, `referral_rewards` present. The migration-ordering risk flagged before
  FR-28 is retired.

## 7. Dead ends — do not retry

- The referenced Next.js repo (`RaphNicks/honest-cars-ltd` @ `c765c8a`,
  `src/app/globals.css`) **does not exist**; the PDF is the design source of truth.
- **`config.js` is getters over the settings registry now** — `config.listings.perPage`
  reads `overrides.value('listings.per_page')`. Do not assign to a config value
  (a test that did got away with it until the getter arrived), and do not read one
  at module load: `const perPage = config.listings.perPage` at the top of a file
  freezes the value before `settings.hydrate()` has run.
- **A consent checkbox that the register does not know about fails the suite.**
  Add the wording to `NOTICES` in `src/services/privacy.js` *and* keep the
  sentence in the view byte-identical — the test compares whitespace-collapsed
  text, so a rewrapped line is fine and a reworded one is not.
- **Renaming a `purpose` value means three files and a re-seed:** the migration,
  `db/schema.sql` (whose mirror has its own copy), `db/privacy.js`, the seed, and
  then `npm run db:seed`. A column that is correct in the schema and wrong in
  `db/seed.sql` fails as `WARN_DATA_TRUNCATED … at row 4`, which reads like an
  enum problem rather than a stale seed.
- **`scripts/generate-seed.js` is one template literal.** Any backtick added
  inside it (`` \`users\` ``, a `` `code` `` sample) must be escaped as `\``, or the
  literal ends early and the next `${...}` becomes a JS syntax error hundreds of
  lines later. This has now bitten twice — once on financing, once on settings.
- **A radio group contributes nothing to `FormData` when unchecked.** The
  concierge's "do you need financing?" is a radio pair, so `buildPayload` has to
  copy `values.financing` across explicitly — a missing key reads as "no" and the
  answer is silently dropped. (Pre-filling one is the same trap from the other
  side: set `checked` per radio, never `.value`.)
- **Seed lookups by stock number must go through `stockAt(n)`.** The city prefix
  follows the market cycle (FR-32), so a literal `'HC-PH-0018'` in a subquery
  returns `NULL` the moment that car moves to Benin — and the lead it was meant to
  attach to is seeded with no car at all, silently.
- **`INSERT … SET ?` is invalid under `pool.execute`** — explicit column list plus
  `COLUMNS.map(() => '?')`. And MySQL 5.7 has no `RETURNING`; `::SIGNED` is
  Postgres.
- `honestcarsltd.com` does not resolve; no headless browser is available. Also
  no PDF rasteriser (`pdftoppm`/`gs`/`mutool` are absent and ImageMagick's PDF
  coder is disabled by policy), so a PDF's *appearance* cannot be verified here
  — only its text and structure. The OG cards are PNGs and can be looked at.
- **Uploads do not survive a sandbox restore.** `/home/user/uploads/` is emptied
  before the next turn runs, and the file cannot be reconstructed from the
  message it arrived in. If an attachment is missing, ask for it again; for the
  logo, ask for it as `logo.png` so it needs no renaming before `npm run icons`.
- Two consecutive pushes to this branch can non-fast-forward:
  `git fetch origin arena/01a0f7df-honest-cars-ltd` + `git reset --mixed FETCH_HEAD`,
  keep the tree, re-commit.
- In this sandbox only the npm registry is reachable, and MySQL 5.7 is built from
  the `mysql-server-5.7-lin-x64` tarball by `scripts/sandbox/`.
