# What is left to build — PRD gap analysis

Audited against `Honest_Cars_LTD_Website_Specifications_Final.pdf` (FR register §9,
integrations §11, NFRs §12, sitemap §5.1, acceptance §18.3).

Line references below point at the code that exists. Where an item is missing, the
note says what "done" would mean, so the work can be scoped without re-reading the PRD.

**Status at this commit:** §12.2's second factor is built — the last row that was
both buildable and provable here. The list is now **17 rows: 1 buildable (not
provable without Cloudflare keys), 9 blocked on an account, 7 with no home in
this sandbox**.

- **The arithmetic is RFC 6238's.** `src/lib/totp.js` is SHA-1, six digits, 30
  seconds, ±1 step, base32 without padding — and `test/mfa.test.js` checks it
  against the appendix-B vectors rather than against itself.
- **A code works once.** `totp_last_step` is compared inside the `UPDATE` that
  sets it, so a second request racing with the same code loses; a replay is
  refused with a sentence that says the code was *used*, not that it was wrong,
  because that difference is the whole reason someone is stuck.
- **A half-finished enrolment protects nothing.** The factor counts only once a
  code from it has been proved, and the setup screen says so. A required role
  with an unfinished setup is sent to `/admin/security` and nowhere else — the
  gate and the route guard read one function between them, so the page that
  fixes the problem is always reachable and nothing else is.
- **Recovery codes are single-use, stored as hashes, shown once.** The
  confirming response is the only place they ever exist in plaintext: they are
  rendered, never handed over in a query string (browser history, access log and
  the next request's Referer all read those). The unit of the code — the
  alphanumerics — is what is hashed, so `K7QM-3XRX` and `k7qm3xrx` are one code.
- **Losing a phone is an admin act, recorded.** `/admin/staff` switches the
  factor off for someone else with a reason, revokes every session that account
  held, and writes it to the audit log. Turning it off needs a live code, and a
  role that must have one cannot turn off its own.
- **§7.4:** `admin` and `finance` are the two roles that can move money or grant
  a role, so they are the two that must carry a factor (`roles.MFA_ROLES`); every
  other console role may enrol voluntarily — `staff.security` — and
  `/admin/security` tells a colleague who has not. Coverage is on the screen, not
  in a spreadsheet.

- **The request log exists, and the self-service paths file themselves.**
  `/account/export` and account closure used to discharge the duty and leave no
  trace. Now both write a row the moment they happen (`self_service`,
  `completed`, with the act recorded), deduplicated to one per person per day so
  a refresh is not a second request. Anything that arrives by WhatsApp or over
  the counter is logged by hand from `/admin/privacy`, and the 30-day clock runs
  from the day the person asked rather than the day the row was typed.
- **A closure needs a sentence.** `completed` or `refused` with nothing written
  down is refused in the data layer — "completed" with nothing behind it is what
  a log of this kind looks like when it is theatre. Reopening a request clears
  the handler and the closing stamp, so a row cannot claim to be open and closed.
- **Consent is events, not a flag.** `consent_records` is append-only: the box
  that was ticked, the radio card that was chosen, the switch that was turned
  off, each carrying the wording the person was reading. Withdrawing is a second
  row, never an edit. The register of wording lives in `src/services/privacy.js`
  and the suite greps the views for every sentence — so a record cannot quote a
  sentence the site no longer shows, and every consent checkbox on the site
  belongs to a notice.
- **The screen says what each list is right now.** "How many people are on the
  deal-alert list?" is answered from where the flag actually lives (`users`,
  `saved_cars`, `saved_searches`), never re-derived by counting log rows
  backwards; the log answers a different question — what changed lately.
- **The record keeps who asked.** `data_requests.user_id` is `ON DELETE SET
  NULL`: closing an account erases the person and leaves the evidence that they
  asked us to, which is the record the duty is discharged against.
- **§7.4:** admin and ops hold the desk (`privacy.view` / `privacy.manage`) —
  a list of people who asked us to delete their data is not a list to hand
  around, so finance, marketing, inspectors and customers are refused it, and
  `scripts/smoke-roles.mjs` probes exactly that.

What is still missing from the NDPA row is the **cookie/analytics banner**, which
is blocked with GA4/Meta on measurement IDs, and consent *withdrawal* for a
guest who has no account (they write in; the desk logs the event by hand).

One row leaves the list (§18.3). **The list is now 18 rows: 2 buildable in this
sandbox, 9 blocked on an account, 7 with no home here.**

**Status at `9763e66`:** §5.1's settings screen is finished — the half that
is not the area list. Business facts, limits and windows, fees and retainers, and
the channel each message takes are editable at `/admin/settings`, with the
environment as their default and no deploy in the loop.

- **The registry is the screen.** `src/lib/settings-schema.js` declares every
  setting: its type, its range, the built-in default and the one sentence an
  operator needs. The form is drawn from that registry, so a field cannot appear
  without a definition — and `test/settings.test.js` greps the source tree for
  every key, so a setting with **no consumer fails the suite** rather than
  shipping as a button that does nothing. Forty-two keys across four groups.
- **A default is written down once.** An override is a row in `settings`
  (migration 027); resetting is a DELETE, and the value that comes back is the
  registry's default — never a second copy stored in the table where it can
  drift. A fresh install has an empty table and behaves exactly as it did before
  this screen existed.
- **A group is applied whole or not at all.** Validation — types, ranges, naira
  in and kobo out, plus the pair rules (the sold-car redirect has to come after
  the visible window) — runs over the whole submission before the transaction
  opens, so a retainer cannot land without the hours beside it.
- **It reaches the storefront, including the prebuilt pages.** Editing a setting
  the footer carries makes the build stale, and `respond.js` will not serve a
  page it knows is wrong: it renders on request, says why
  (`X-HonestCars-Stale-Build`), and goes back to the prebuilt file after the next
  `npm run build:static`. The save flash tells ops the same thing.
- **One implementation for a moving number.** `config.js` reads the overrides
  through getters, so `concierge.slaOptions()` — used by the page, the API that
  charges the retainer and the record it writes — moves as one. The channel each
  template takes is a settings row built from `notify.TEMPLATES`, so a new
  message type cannot silently fall back to the general channel.
- **No secrets on the screen, and it says so.** Keys and the DB credentials stay
  in `.env`; the panel names the reason rather than leaving ops hunting.
- Seed: two changed settings (the footer line and the CAC guardrail), so a fresh
  database opens onto a screen with a real "changed" badge and a footer that
  reads like a business rather than a placeholder.

One row left the list (§5.1 settings): 19 rows, 3 of them buildable here. The
§18.3 row has since gone too — see the top of this file.

**Status at `5c28628`:** FR-34 is built — the financing handoff, end to end,
and the whole module is written so that it cannot read like a lender.

- **The arithmetic is ours; the terms are not.** `POST /api/financing/plan` takes
  the price (or the budget), the down payment, the monthly and the tenor, and
  answers with three things it can stand behind: the gap that has to be financed,
  what the principal alone costs per month, and what that payment becomes —
  "their figure, not ours". There is **no rate, no APR, no approval and no "you
  qualify" anywhere in the service, the page, the messages or the console**,
  because a monthly figure we invented is a person planning around a number we
  cannot honour. A payment that does not cover the principal says the plan does
  not add up and names the three levers instead of inventing a repayment; paying
  the whole price is answered with "you do not need financing".
- **Capture.** `POST /api/financing` writes the enquiry (`HC-FIN-######`) with the
  arithmetic the customer actually saw, and an ops **inbox lead** of type
  `financing` alongside it (§7.3) — so an enquiry that fails downstream still
  exists where a human will see it. A named car is priced **from the database**;
  the amount in the request body is ignored (§11).
- **§6.5 step 3 is a real answer now.** The concierge brief's "do you need
  financing?" was previously a dead end: the answer only sat in the brief. A
  brief that says `financing: 'yes'` now creates the financing lead itself,
  linked to the `service_request`, using the brief's own budget as the amount,
  and the success screen shows the reference. The customer does not fill in a
  second form.
- **The handoff is a handoff.** `/admin/financing` (capabilities `financing.view`
  / `financing.manage`) keeps the partner book (add, activate, switch off) and
  the queue, with the two states that need acting on stated separately: *waiting
  on us* (no partner yet) and *routed, no answer yet*. Routing records the
  partner and the date; an outcome (`contacted`/`approved`/`declined`/
  `withdrawn`) records what the lender said **and never our own verdict** — every
  change is audited with the staff id, so "who told this customer they were
  approved?" has an answer.
- **Nothing is reported as delivered when it was not.** The handoff message and
  both customer messages go through `notify` with `mustDeliver`, so with no
  provider configured they are recorded `skipped` **with the text intact** and
  handed to ops as a WhatsApp deep link — the console says *"recorded as routed
  to X, but nothing was delivered"* rather than *"they have the details"*. A
  switched-off partner cannot be routed to at all. This is a small honesty fix in
  `notify.send` that the module now relies on.
- **The account page shows the customer their own enquiry** — reference, the car,
  the figures, who it went to, and a sentence for the current state that never
  says a lender has answered when they have not.
- Seed: two lenders (one switched off) and four enquiries — one per state, one
  linked to the concierge flow, one owned by the demo customer — so every
  renderer opens onto real data. The seed also resolves listing stock numbers
  through the generator's own list (`stockAt()`), which closes a latent trap:
  city prefixes move with the market cycle (FR-32), and a literal stock number
  silently attaches a lead to nothing the moment they do.
- `POST /api/financing` is rate-limited, and `financing_*` messages follow their
  own `NOTIFY_CHANNEL_FINANCING` knob.

One row left the list here (FR-34): 20 rows, 4 of them buildable in this
sandbox. The §5.1 settings row has since gone too — see the top of this file.

**Status at `485bf04`:** FR-30 is built — the installable, offline-tolerant
half of the PWA.

What shipped: a generated icon set, a real web app manifest, a service worker
with an honest cache policy, an `/offline` fallback that says what still works,
and an install control that stays hidden until the browser itself offers the
install (no nagging, and never a button that does nothing).

What it deliberately does **not** do: cache anything the server marked `private`
or `no-store`, touch `/api/`, the console, the portal or checkout — or hold a
second copy of a queued enquiry. `public/js/drafts.js` has held failed sends
since §13.2, and a second invisible queue is a second place for a lead to go
missing.

**Push moves to the blocked table below.** FR-30 also names "push via web
notifications"; that half needs VAPID keys, a push service and a consented
reason to send. It cannot be honestly built here, so the row stays in the list,
in the bucket where every other account-dependent seam lives. The list stood at
**21 rows** when FR-30 shipped; FR-34 has since taken it to 20.

**Status at `c680d51`:** FR-29 is built — the instant estimate on /sell-swap.
§6.6 asks for "a rough band from pricing DB with 'confirm with free human
valuation' CTA", so that is exactly what it is, and the honesty is in the
answer's shape:

- The band comes from `price_bands` (§7.3) by the **same matching rule the price
  badge on a listing uses** — exact condition beats `any`, most evidence wins a
  tie — so the widget and the VDP cannot describe the same model differently.
- Every answer carries its **sample size and its age**. A band past §7.3's
  weekly refresh renders in amber with the caveat beside it rather than reading
  as current.
- **Mileage is described, never applied.** We have no mileage curve, so the
  widget prints the median mileage of the live comparable stock beside the
  seller's figure, says which way that usually moves the price, and states that
  the human valuation is what decides.
- **No band is a real answer**, not a guess: the reply names the year range we do
  cover, or the models of that make we hold, and hands over to the free human
  valuation.
- `GET /api/valuation` (rate-limited, name-shape validated) is the whole
  contract; the page's three-step intake still works with JavaScript off, and
  the widget's CTA carries what was typed into the intake form below.

One row left the list there. That took it to 21 rows (6 buildable, 8 blocked,
7 with no home).

**Status at `d1b1da0`:** FR-28 is built — the referral module, end to end.
The link and the attribution have existed since migration 007 (`users.referral_code`
/ `referred_by`, the card on /account); what was missing was the **reward
status** §7.1 asks for. Migration 025 adds `users.referral_qualified_at` and a
`referral_rewards` row per referred account, so a referral can be *counted*
without the site ever promising a figure:

- **Counting is automatic.** `npm run referrals` (or the button on
  `/admin/referrals`) finds referred accounts that have bought something
  (`users.referral_qualified_at IS NULL` + a paid order) and queues a pending
  reward. Running it twice does nothing the second time — the guard is the SQL
  predicate plus the unique (referrer, referred) key, not a flag in memory.
- **Paying is never automatic.** `pending → approved → paid`, or `void` with a
  reason, each step typed by a human on `/admin/referrals` (capability
  `referrals.view` for admin/ops/finance, `referrals.reward` for admin/ops),
  each step audited (`referral.qualified|approved|paid|voided|restored`) and
  announced to the referrer through the channel-honest `notify` layer.
- **The customer sees the honest state of each person their link brought in** —
  signed up, not counted yet, with the desk, approved (with the amount), paid
  (with the date), or voided with the reason. Nothing shows a figure before the
  desk enters one; the form pre-fills the configured suggestion
  (`REFERRAL_REWARD_KOBO`, ₦2,000) and the desk can change it per referral.
- The seed carries all four states (pending, paid, uncounted, and a link nobody
  used), so every renderer is exercised on a fresh database.

One row left the list there. That took it to 22 rows (7 buildable here, 8
blocked on an account, 7 with no home in this sandbox).

**Status at `c974792`:** FR-32 is built — the network covers four markets
(Port Harcourt, Owerri, Aba and Benin City). Cities and their areas are tables
(`service_cities`, `service_areas`, migration 024) rather than a hard-coded list,
because the PRD's data model says the area list is admin-managed: ops adds,
renames, retires, restores and reorders areas at `/admin/settings`, which is also
the §5.1 **settings** screen. Stock carries its market, each market has its own
stock-number series (`HC-PH-`, `HC-OW-`, `HC-AB-`, `HC-BN-`; a lot's listings
inherit its market and can never be filed in a city its lot is not in), the filter
rail is scoped to the market in view, each market has a curated indexable page
(`/cars/owerri` and friends) in the sitemap, and the header carries an area
switcher whose choice is remembered in an `hc_city` cookie — applied server-side
on /cars, labelled client-side on the prebuilt static pages. A city URL with
nothing else canonicalises onto the market's curated page; a page filtered only by
the remembered market is private and noindex. Two rows leave the list: FR-32, and
the §5.1 "settings has no screen" row, keeping only the area manager — the rest
of §5.1 was scoped in that row and has since been built. That took the list to 23
rows at the time (8 buildable here, 8 blocked on an account, 7 with no home in
this sandbox).

**Status at `e78fd4c`:** FR-33 is built — the dealer portal imports a
spreadsheet. `/dealer/imports` takes CSV (picked or pasted, read in the browser)
and always shows the dry run first: line by line, what would be created, what
was refused and which column was wrong, with warnings rather than silence for a
car the lot already has or two identical rows in one file. Applying creates
**drafts** — live is still ops' decision (§7.3) — and a partly-good file imports
the rows that passed. The template is generated from the same column table the
validator uses, so a downloaded template always imports. Each lot can issue
itself API keys (hashed at rest, shown once, revocable) and drive the same
validation from its own tooling at `POST /api/dealer/listings`, where the
default is a dry run; the desk can revoke a key from `/admin/dealers/:id`
(§7.4 gains `dealers.manage`, admin/ops). The row count below drops to 25.

**Status at `9d1b4d8`:** FR-18 is built — §7.2's Orders & Billing is real on
both sides of the desk. A lot buys a media shoot, a featured placement or the
monthly intelligence report from `/dealer/addons`; each purchase raises its own
payment (purpose `addon`) and, while no PSP keys exist, says how to pay it by
transfer. The money landing *is* the delivery: `applyPurchase` runs inside the
transaction that marks the payment paid, so a placement sets `featured_rank`, a
shoot becomes a `bookings` row on the dispatch calendar, and intelligence becomes
a subscription the FR-20 renewal queue collects. Statements are per month per lot
(`/dealer/billing/statements/{month}`, plus a PDF) and they tie: opening balance +
the month's entries = closing, which is checked against the ledger and said out
loud on the page when it does not. `/admin/dealers` is the §5.1 dealers screen —
every lot's stock, commission and paid add-ons, with the same statement PDFs.
Only the **settings** screen was still missing from the §5.1 sitemap (FR-32 has
since built it — see the top of this file).

**Status at `9cd3b66`:** FR-35 is built — a byline is now a person with a page
(`/blog/author/{slug}`) and a bio written once, tags are a governed list with
their own shelves (`/blog/tag/{slug}`), the related-posts engine ranks a shared
tag above a shared category, `[listing:slug]` puts one named car into a post and
drops it silently if that car has since sold, and the CMS has the editorial
calendar §6.9 asks for. 53 static pages → 68.

**Status at `0f424bc`:** FR-22 is built — the hire pool is a registry of
real units with their papers and trackers, availability is computed per unit per
day (a car with no insurance is *there* and not available), the booking lifecycle
runs quote → accept → pay → out → back with every out-of-order step refused in a
sentence, the incident log costs and charges separately, and a hire's invoice is
a PDF that bills what was quoted. §7.4 gains two rows (`hire.view` for
admin/ops/finance, `hire.manage` for admin/ops) and the smoke test proves them.

**Status at `3f01527`:** FR-20 is built — tracker subscriptions run a real
lifecycle (derived state, activation checklist, online renewals paid by transfer
until a PSP exists) with a 30/7/1-day reminder sweep that is safe to run every
morning, and dealer retainers share the same queue. **Status at `6a2e989`:** §13.2 is built — blur-up placeholders, adaptive quality on
the `Save-Data` header, video strictly tap-to-load with a measured duration/size
label, and forms that keep a draft and hold a send that the network dropped — and
FR-24/§16 ships with it: eight posts, four clips, a video block in three of them
and a clip in two listings' galleries (see the commit). §15.2 and FR-19 are
built. FR-01 – FR-27 are otherwise built and verified except the items noted
below. Everything remaining falls into three buckets: buildable here, blocked
on a third-party account, and infrastructure that has no home in this sandbox.

---

## 1. Not built — and buildable here today

One row left. It needs no *account*, but it cannot be **proved** in this sandbox:
a bot challenge with no keys is a bot challenge nobody has seen work.

| ID | Requirement | What is actually there | What "done" means |
|---|---|---|---|
| §11 | Turnstile/reCAPTCHA on public forms | Rate limits per route (`src/lib/rate-limit.js`) and server-side validation; no bot challenge. | A site-key-gated invisible challenge, degrading to the current behaviour when unset. |

## 2. Built, but blocked on a third-party account

The seam exists and behaves honestly without credentials — it does not pretend
to have done anything. Each needs an account, keys and (usually) webhook config.

| ID | Item | State today | Needs |
|---|---|---|---|
| FR-08 | Paystack/Flutterwave checkout, webhooks, refunds | Full flow: `/checkout`, `paymentService.initiate`, webhook routes with signature verification and idempotent `event_id`, pending/abandoned/paid/refunded states, refunds with partials. Default provider is `manual` (bank transfer), which really works. | PSP keys + webhook secrets; then the hosted path can be switched on per provider. |
| §11 | OTP/SMS provider (Termii/Twilio) | `AUTH_OTP_PROVIDER=console`: the code is returned in the dev API response. Real SMS is refused, not faked. | Provider account + sender ID. |
| §11 | Transactional email (SendGrid/Resend) | Notifications are recorded per channel; an unconfigured channel is stored `skipped` **with its text intact** and shown to ops at `/admin/alerts` with a WhatsApp deep link to send by hand. No email channel at all. | Provider account, verified domain, SPF/DKIM. |
| §11 | GA4 + Meta Pixel | Tags are wired in `views/partials/analytics.ejs`, gated on `site.analytics.ga4Id` / `metaPixelId`; nothing loads while they are empty. Server-side events are already recorded in `analytics_events`. | Measurement IDs — **and** the consent banner below. |
| §11 | Consent banner (NDPA) | Form-level consent checkboxes and `marketing_opt_in` exist. There is no cookie/analytics banner. | A banner gating the analytics partial, with the choice recorded. |
| §11 | Storage + CDN (S3-compatible) | Images are prepared locally by `scripts/prepare-images.js` (sharp, WebP variants) and served from `/public`. | Bucket + CDN; the media pipeline becomes an upload path rather than a build step. |
| §11 | Telematics partner portal (P2) | Subscription rows carry `device_state`; nothing connects to a partner. | Partner API or a manual-sync screen. |
| §11 | Google Maps/Places (P2) | Delivery areas and inspection locations are curated lists, which works offline and on low data. | Places autocomplete + map pins for inspection meets. |
| FR-30 | Web push notifications (the push half of the PWA) | Installable app, offline shell and install prompt are built; there is no push subscription, no VAPID key pair and no consent record for one. | VAPID keys, a push service and a consented reason to send — the consent banner row above is a prerequisite, not a nicety. |

## 3. Infrastructure with no home in this sandbox

| Item | PRD line | Note |
|---|---|---|
| CI (test + lint on every push) | §12.3 | All gates exist as npm scripts and pass; nothing runs them automatically. A GitHub Actions workflow is a few lines. |
| Dockerfile / compose | §12.3 | The MySQL runtime here is a sandbox shim (`scripts/sandbox/`); a real deploy wants a container or a managed database. |
| Staging environment | §12.3 | This sandbox is the closest thing; the PRD asks for a separate one. |
| Uptime + error monitoring (Sentry-class) | §12.3 | `/api/health` exists for a monitor to poll; nothing polls it. |
| Backups + quarterly restore test | §12.2 | `db/schema.sql` is idempotent and `db/seed.sql` rebuilds the demo; no backup job. |
| Feature flags for portal release | §12.3 | Not present. |
| Core Web Vitals on throttled profile | §12.1, §18.3 | Budgets are respected in the build (image sizes, JS budget lint, static pages), but no headless browser is available here to measure CWV. |

## 4. Acceptance items that need a real environment

§18.3 samples, and where they stand:

- 2-tap test home → car / concierge / booking / shop / WhatsApp — **passes**; covered by the route and smoke suites.
- J1–J7 end-to-end with **real PSP test cards** and **real WhatsApp numbers** — blocked on §2.
- Dealer submits a listing from a mid-range Android over 3G — the wizard is mobile-first with autosaving drafts; the device test needs a device.
- Checklist → client PDF ≤ 4h SLA — **built**; the SLA path is the concierge one, not an inspection one.
- CWV green on throttled profile — see §3.
- Payment states: success, failed, abandoned, webhook-retry, refund — **built** for `manual`; the PSP half is untested without keys.
- Dealer contact info not public — **holds**; dealer name shown, contact routes through Honest Cars.
- Admin RBAC per §7.4 + audit log — **built**; every cell is probed by `scripts/smoke-roles.mjs`.
- Sold/expired behaviour + SEO facet rules — **built** (90-day archive, curated facets indexable, raw combos noindex, sitemap curated).
- NDPA consent records for deal alerts — **built**. Saving a car files the
  signup, taking the last one back off records the withdrawal, and the console
  shows both with the wording the person saw; the cookie/analytics *banner*
  remains blocked with §2's measurement IDs.

## 5. Deliberate divergences (not gaps)

- **No frontend build step.** Vanilla ES modules and hand-written CSS by instruction; the "bundle" is a handful of files the lint budgets.
- **`manual` payments as the default.** Without PSP keys the honest default is bank transfer with a human confirmation step, rather than a checkout that fails at the last tap.
- **Notifications record `skipped` rather than silently dropping.** An unsent message keeps its text and is visible to ops — the opposite of a silent failure.

---

*Maintained by hand. When something here gets built, delete its row rather than
annotating it.*
