# What is left to build — PRD gap analysis

Audited against `Honest_Cars_LTD_Website_Specifications_Final.pdf` (FR register §9,
integrations §11, NFRs §12, sitemap §5.1, acceptance §18.3).

Line references below point at the code that exists. Where an item is missing, the
note says what "done" would mean, so the work can be scoped without re-reading the PRD.

**Status at this commit:** FR-33 is built — the dealer portal imports a
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
Only the **settings** screen is still missing from the §5.1 sitemap.

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

No external account needed. These are real gaps against the PRD.

| ID | Requirement | What is actually there | What "done" means |
|---|---|---|---|
| FR-28 | Referral module — links, attribution, reward status (§7.1) | `referral_code` + `referred_by` exist (`users`), a link and code render on `/account`, and sign-up records the referrer. | Attribution reporting (who came from whom) and a reward status per referral. |
| FR-29 | Instant valuation widget from price-intel data (§6.6) | `/sell-swap` promises a human valuation within 24h; `price_bands` (FR-23) holds exactly the data a widget needs. | Make/model/year/condition/mileage in, an indicative band out, with the same "sample size" honesty the VDP indicator uses. |
| FR-30 | PWA — installable, offline shell, web push | Mobile-first responsive site; no manifest, no service worker. | Manifest + service worker + install prompt; push is a bigger call (needs VAPID keys). |
| FR-32 | Multi-city inventory (Owerri/Aba/Benin) with area switcher | Single-city: `city` is a column, but there is no area filter or switcher anywhere. | City dimension through inventory, facets, sitemap and the area switcher in the header. |
| FR-34 | Financing-lead partner handoff | Nothing. | A financing enquiry that captures intent and hands off, with the partner recorded on the lead. |
| §5.1 | Admin screen named in the sitemap but absent: **settings** (the **dealers**, **subscriptions** and **hire** screens now exist) | `/admin/dealers` lists every lot with its stock, commission and paid add-ons, and opens each lot's ledger, statements and purchases. Settings has no screen. | A settings screen (business facts, thresholds, channels) — the last of the §5.1 sitemap. |
| §18.3 | "Privacy requests actionable in admin" (NDPA) | Self-service works: `/account/export` and account deletion, with the record anonymised (`DELETED-…`). | An admin view of data-subject requests and their handling, so the duty is discharged, not just offered. |
| §12.2 | MFA for admin roles | Sign-in is phone OTP — one factor, however strong. | TOTP (or WebAuthn) as a second factor for `admin`/`finance`, with recovery codes. |
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
- NDPA consent records for deal alerts — consent is captured per lead; the admin–visible record and banner are missing (§1, §2).

## 5. Deliberate divergences (not gaps)

- **No frontend build step.** Vanilla ES modules and hand-written CSS by instruction; the "bundle" is a handful of files the lint budgets.
- **`manual` payments as the default.** Without PSP keys the honest default is bank transfer with a human confirmation step, rather than a checkout that fails at the last tap.
- **Notifications record `skipped` rather than silently dropping.** An unsent message keeps its text and is visible to ops — the opposite of a silent failure.

---

*Maintained by hand. When something here gets built, delete its row rather than
annotating it.*
