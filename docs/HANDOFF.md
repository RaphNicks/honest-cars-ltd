# Handoff — where this build is, and how to continue it

**Written 2026-10-06 at commit `a6ba608` on branch `arena/01a0f7df-honest-cars-ltd`.**
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

## 3. Just finished: FR-22 hire management

**Built in this commit.** §7.3 asks for three things — a vehicle pool registry
with documents and tracker state, an availability calendar, and booking records
with an incident log — and acceptance scenario J6 asks for the corporate path
end to end: RFQ → quote → client accepts and pays → the car is on the calendar →
completion and an invoice PDF.

What it does:

- **The pool is real cars, not classes.** `hire_vehicles` is a row per plate with
  `owner` (ours or a partner's), `documents_state` + `documents_due`, and
  `tracker_state`. Two Corollas are two rows; `hire_classes` still supplies the
  price.
- **Availability is computed, per unit per day.** `db.hire.availability()`
  returns `free` / `out` / `held` / `service` / `invalid` / `retired` for every
  day in a window. A unit is not available if it is in the workshop, already
  booked on overlapping dates, or if its papers are missing or lapsed — *and the
  label follows the date, not the column*, so a row that says “current” with an
  expiry three months gone reads `Lapsed` and cannot be allocated.
- **The lifecycle runs one way**, and every out-of-order step is refused in a
  sentence: a car cannot go out on an unpaid hire, a hire that is out cannot be
  cancelled, a hire that never left cannot be completed, a closed hire cannot be
  reopened.
- **Allocation has three guards**: the unit must be free on those dates
  (overlap is `pickup_at <= dropoff AND dropoff_at >= pickup`, inclusive both
  ends), must have valid papers, and must be *of the class that was quoted* —
  putting a sedan on an SUV quote would bill the client for a car they are not
  getting.
- **Paying a hire confirms it** — `hire.confirmFromPayment(conn, payment)` runs
  inside the transaction that marks the money paid, the same shape as FR-20's
  renewals. `payments.purpose` gained `'hire'` in migration 020 so the receipt
  says what it is.
- **The incident log separates cost from charge** (`cost_kobo` vs
  `charged_kobo`; the difference is what the desk argues about). Anything above
  minor parks the unit until the incident is closed; a hire's incident takes its
  vehicle from the booking, never from the form.
- **The invoice bills what was quoted**, never the current rate card, adds any
  incident charges, and releases the deposit at handover. `services/invoice.js`
  builds one object and both renders it twice — the page and a real A4 PDF.
- **§7.4** — two new rows: `hire.view` (admin, ops, finance — finance needs the
  hire revenue and the invoices) and `hire.manage` (admin, ops — the same desk
  that runs bookings and dispatch). Marketing holds neither, and `npm run smoke`
  asserts all of it.

Where the code is: `db/migrations/020-hire-management.sql`, `src/db/hire.js`,
`src/services/hire.js`, `src/services/invoice.js`, `views/pages/admin/hire.ejs`,
`views/pages/admin/hire-invoice.ejs`, `views/pages/hire-booking.ejs`,
`test/hire.test.js` (33 tests). The demo pool is ten units (two partner-owned,
one with no papers, one expiring, one tracker on order, one in the workshop) and
the hire book holds every state the lifecycle can be in.

**Next in order:** FR-35 (blog extras) → FR-18 (add-on purchases) →
FR-28/29/30/31/32/33/34 (P3) → the remaining admin screens (dealers, settings).
`docs/GAPS.md` is canonical: 27 rows, each with what “done” means.

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
npm test          # 306/306 (33 of them hire, in test/hire.test.js)
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
