# Handoff — where this build is, and how to continue it

**Written 2026-10-05 at commit `8c53572` on branch `arena/01a0f7df-honest-cars-ltd`.**
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
npm run db:seed                     # 79 listings, 8 posts, staff + customer accounts
npm run build:static                # 53 static pages into dist/
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
| `8c53572` | **WIP** FR-20 — migration 019, `src/db/subscriptions.js`, `src/services/renewals.js` (see §3) |
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

## 3. In flight: FR-20 tracking subscriptions (the next thing to finish)

Parked deliberately mid-way, **with nothing broken on the site** — the renew
action on `/account` renders as plain text until its route exists.

Done (`8c53572`):

- **`db/migrations/019-subscriptions-renewals.sql`** — adds `kind`
  (`tracker` | `dealer_retainer`), `dealer_id`, `unit_label`, `plan_name`,
  `amount_kobo`, `period_months` to `subscriptions`; creates
  `subscription_reminders` with `UNIQUE (subscription_id, window_days)`; adds
  `payments.subscription_id`. Mirrored in `db/schema.sql`. Applied.
- **`src/db/subscriptions.js`** — the whole lifecycle. State is *derived*
  (`effectiveState`): `lapsed` past a 7-day grace window, `renewal_due` inside the
  30-day window, otherwise the checklist. Reads (`byId`, `forPhone`, `queue`,
  `summary`, `dueForReminders`, `sentWindows`), writes (`setChecklist`,
  `cancel`, `createRetainer`, `renewalQuote`, `recordReminder`, `sweepLapsed`),
  and `applyRenewal(conn, payment)`.
- **`src/services/renewals.js`** — `queue()`, `register()`, `runReminders()`
  with the 30/7/1-day wording and per-window dedupe (re-running is a no-op).
- **`src/db/payments.js`** — `subscription_id` plumbed through `createPayment`
  and `shapePayment`; `markPaid` calls `applyRenewal` **inside its transaction**,
  so money and entitlement cannot come apart on any path (webhook, console, manual).
- **`notify.js`** — `subscription_renewal` template; **`config.js`** — its channel.
- **`account.ejs`** — the tracked-vehicles block now shows plan, unit, days to go,
  derived state pill and the renewal price.

Still to do:

1. `POST /account/subscriptions/:id/renew` — quote via `renewalQuote()`, then
   `payments.initiate({ purpose: 'subscription', subscriptionId })`, then show the
   bank-transfer instructions (the same honest path `/order/:orderNo` uses).
2. A way to *finish* paying that renewal — a mirror of `/order/:orderNo`'s pending
   payment block, or reuse it.
3. `/admin/subscriptions` — the renewal queue + register + activation checklist
   POSTs + `createRetainer` for a dealer, plus a "run reminders now" button and the
   sweep report. Capability `payments.view` (queue) / `payments.approve` (checklist).
4. `npm run renewals` script (`scripts/renewals.js`) — cron entry point.
5. Seed: three tracker subscriptions (one activating, one renewing in 9 days, one
   lapsed) and two dealer retainers, plus a pending renewal payment.
6. Tests (`test/subscriptions.test.js`): derived state at the window edges, the
   sweep firing each window once and not twice, `applyRenewal` extending from the
   future date when early and from today when lapsed, reminder rows written even
   when delivery is `skipped`.
7. Retire the FR-20 row in `docs/GAPS.md`.

**Then in order:** FR-22 (hire management: pool registry, availability calendar,
dispatch board, incident log) → FR-35 (blog extras) → FR-18 (add-on purchases)
→ FR-28/29/30/31/32/33/34 (P3). The full list, with "what done means" per row,
is `docs/GAPS.md` — that file is canonical, keep it updated with each retirement.

---

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
npm test          # 254/254 at 6a2e989
npm run lint      # type ladder + 14 ES modules / 75 event references
npm run build:static && npm run crawl && npm run audit:pages
npm run smoke && npm run smoke:cms      # role matrix + CMS round trip
npm run images:check && npm run videos:check
```

`crawl` must report 0 broken links; `audit:pages` 0 findings.

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
