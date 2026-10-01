# honestcarsltd.com — vanilla HTML/CSS/JS · Node.js · MySQL

The Honest Cars LTD storefront, ported from the approved specification
(`Honest_Cars_LTD_Website_Specifications_Final.pdf`) into the approved stack:
**vanilla HTML, CSS and JavaScript on the front end, Node.js + Express on the
server, MySQL for data.** No React, no Tailwind, no frontend build step.

The **whole public storefront is ported and running** — the design system, the
homepage, `/cars` with the curated facet pages, the VDP and the sold-archive
rule, the nine service pages, the concierge and sell/swap funnels, the blog, the
shop, the trust and legal pages — plus **phone-first customer accounts (§7.1)**:
OTP sign-in, the `/account` dashboard, saved cars and saved searches. The
remaining PRD work is the authenticated back office (§7.3 admin console), the PSP
integration and the notification layer; see *What is built, and what comes
next*.

---

## Quick start

### 1. Against the bundled sandbox MySQL (already running here)

```bash
npm install
npm run db:setup     # creates the database, applies db/schema.sql, loads db/seed.sql
npm start            # http://localhost:3000
```

### 2. Against MySQL on your own laptop

```bash
cp .env.example .env
# edit DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
npm install
npm run db:setup     # needs an account with CREATE privileges (DB_ADMIN_USER)
npm start
```

Everything the app knows about persistence lives behind one module —
`src/db/index.js`. Nothing else in the codebase opens a connection, so pointing
at a different MySQL is a `.env` change and nothing more.

```js
const db = require('../db');
const listing = await db.listings.findBySlug('2010-toyota-camry-le-hc-ph-0032');
const facets  = await db.facets.allIndexable();
const leads   = await db.leads.createLead({ type: 'viewing', name: '…', phone: '…' });
```

---

## How the rendering works (PRD §12.4)

> *"Server-rendered or statically generated public pages — no client-only
> content."*

Both halves are implemented, and every page is decided by the registry, not by
whichever route happens to be convenient:

| Route | Strategy | Why |
|---|---|---|
| `/` | **Built to disk**, served static | Same for everyone; only changes when inventory changes |
| `/cars/{facet}` — `/cars/toyota`, `/cars/toyota/camry`, `/cars/suv-under-15m` | **Built to disk** | Curated, hand-written intro copy, stable |
| `/cars` | **Server-rendered per request** | Filters, sort, pagination, counts |
| `/cars/{slug}` (VDP) | **Server-rendered per request** | Stock, price and badges move during the day |
| `/cars/sold/{slug}` | Server-rendered, cached like static | Day 7 → 90 archive window |

`npm run build:static` writes real HTML files into `dist/` plus
`.static-manifest.json`, and records each page in the `static_pages` table. The
server loads that manifest at boot and serves those files from disk
(`X-HonestCars-Render: static`); anything without a prebuilt file falls through
to request-time rendering (`X-HonestCars-Render: dynamic`). No build is
required to run the site — without a manifest, everything renders dynamically.

Vanilla ES modules under `public/js/` only *upgrade* the HTML: the filters form
is a working GET form before JavaScript touches it, the accordions are real
disclosure elements, and every page is complete and readable with JS disabled.

---

## The three things that were finished but lost — rebuilt

**1. Six-step type scale, enforced.**
`public/css/tokens.css` defines exactly one ladder — 12 / 14 / 16 / 20 / 24 / 32 —
and headings clamp *between adjacent steps* so no rendered size leaves the
ladder. `npm run lint:type` fails the build on a seventh size, on a `clamp()`
endpoint that is not a ladder step, on 12px reaching a prose selector, on a
second font family, or on a weight outside 400/500/600/700.
`test/type-scale.test.js` proves the audit both passes and catches violations.

**2. Curated facet pages.**
`/cars/toyota`, `/cars/toyota/camry`, `/cars/suv-under-15m` and seven more live
as rows in the `facets` table — each with its own H1, intro copy, meta and
canonical, parent/child links and optional FAQs. Facets are indexable; **raw
filter combinations never are.** `/cars?make=Toyota&body=suv&max=20000000`
renders `noindex,follow` with a canonical back to `/cars`, which is what keeps
a market this size out of thin-page bloat (§14.1).

**3. Sold-archive rule.**
Implemented once in `src/db/listings.js` and asserted in `test/routes.test.js`:

| Age of sale | Behaviour |
|---|---|
| 0–7 days | VDP stays live with a "Sold in N days" badge (social proof), `noindex,follow` |
| 7–90 days | `/cars/{slug}` **301s** to `/cars/sold/{slug}` — an indexable archive page with the final price and similar live cars |
| >90 days | `/cars/sold/{slug}` **301s** to the listing's curated facet (e.g. `/cars/honda`) |
| Expired live stock | 14-day expiry with a refresh flow, per Appendix B; excluded from browse |

---

## Customer accounts and sign-in (PRD §7.1)

Phone-number-first, no passwords. `/login` is two steps on one page — number
(plus an explicit consent tick, §12.2 NDPA) then the six-digit code — and
`/account` is the dashboard, one card per §7.1 line item: **requests** (with
stage and SLA), **hire bookings**, **bookings**, **orders** and tracker
subscriptions, **documents** (receipts now, report PDFs when dispatch lands),
**saved cars**, **saved searches** with separate price-drop and new-match
switches, **your details**, and **referrals** (personal link, sign-ups and
orders credited to it). Data export and account deletion sit at the bottom.

```
POST /api/auth/otp      { phone }                → { ok, maskedPhone, channel, delivered, devCode? }
POST /api/auth/verify   { phone, code, next }    → sets hc_session, returns the user + redirect
POST /api/auth/logout                            → revokes the session
GET  /account                                    -> dashboard (302 to /login?next=… when signed out)
GET  /account/export                             → every row keyed to the number, as JSON
POST /api/account/saved-cars                     → add / remove, idempotent
POST /api/account/saved-searches                 → add / toggle price-drop & new-match / delete
POST /api/account/profile                        → name, email, marketing consent
POST /api/account/delete                         → anonymise ops records, delete the person
```

How it is put together:

* **One number, one account.** `src/lib/phone.js` normalises `0803…`, `803…`
  and `+234 803…` to `+234XXXXXXXXXX`. Every public form writes the normalised
  number, and every account lookup matches the shapes that might already be in
  the table, so a concierge request made before signing in still appears on the
  dashboard afterwards.
* **Codes are never stored or logged in clear.** HMAC-SHA256 with a pepper
  (`AUTH_PEPPER`), compared with `timingSafeEqual`, single-use, 10 minutes,
  five attempts, five per number per hour. The masked number is all that
  reaches a log line or an analytics event.
* **Sessions** are 32 random bytes in an `HttpOnly; SameSite=Lax; Secure`-in-
  production `hc_session` cookie; the database stores only the SHA-256 hash,
  with expiry and revocation. Signed-in HTML is always `Cache-Control: no-store`
  and is rendered per request — the prebuilt files in `dist/` are the signed-out
  view.
* **CSRF** is SameSite=Lax plus a same-origin check (`Origin` /
  `Sec-Fetch-Site`) on every state-changing account endpoint (§12.2).
* **OTP delivery is a seam.** `AUTH_OTP_PROVIDER=console|whatsapp|sms`. With
  `console` (the development default) the code is logged masked and — outside
  production only — returned as `devCode` so the flow can be driven without a
  phone. Wiring the real provider is one function in `src/services/auth.js`.
* **Deleting an account is honest.** The person, sessions, saved cars and saved
  searches go; requests, bookings and orders stay for finance and warranty with
  the name and number replaced by `Deleted account` / `DELETED-<id>`.
* **Referrals** are a code on the account (`HC0001`, then random readable
  codes). `/login?ref=CODE` is recorded once, at account creation, and never as
  a self-referral; the dashboard shows how many people joined and how many
  orders they placed. Reward amounts are deliberately *not* invented — the ops
  desk sets those, and the card says so.
* **Blocked accounts lose access immediately**: the next request revokes every
  live session and clears the cookie. Expired and revoked session rows are
  pruned on each successful sign-in, so the table cannot grow forever.

---

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Same, with `node --watch` |
| `npm run db:setup` | Create database, apply `db/schema.sql`, load `db/seed.sql` |
| `npm run db:seed` | Regenerate the seed from `scripts/generate-seed.js`, then load it |
| `npm run build:static` | Render stable pages + `sitemap.xml` + `robots.txt` into `dist/` |
| `npm run images` | Normalise photos to 1200×900 + 600×450 siblings (`scripts/prepare-images.js`) |
| `npm run images:check` | Fail if any photo still needs preparing (CI gate) |
| `npm run lint:type` | Six-step type-scale audit (fails the build on a violation) |
| `npm run lint:js` | ES-module parse check + every event name against the §15.1 plan |
| `npm test` | 90 tests: routes, sold-archive windows, facet rules, SEO schemas, filter safety, form validation, concierge/SLA rules, shop commerce, OTP auth, referrals and the account dashboard |
| `npm run check` | lint + test |
| `npm run artifacts` | Build the static pages and re-run the type audit |

`node scripts/check-links.js` walks the built slice, follows every internal
link, and fails if a built route breaks or a backlog route stops returning its
honest 404.

---

## What is built, and what comes next

**Built and testable now (the whole public storefront):**

| Area | Routes |
|---|---|
| Find a car | `/`, `/cars`, 10 curated facet pages, the VDP, `/cars/sold/{slug}`, `/cars/compare` |
| Services | `/services` + 9 service pages (`inspection`, `documents`, `concierge`, `tracking`, `research`, `consultation`, `parts`, `sell-swap`, `dealer-services`), `/hire` |
| Funnels | `/find-my-car` (4-step concierge + `/concierge/{trackingId}` status), `/sell-swap` (3-step, free valuation < 24h) |
| Content | `/blog`, `/blog/{slug}`, `/blog/rss.xml`, `/guide` |
| Shop | `/shop`, `/shop/{slug}`, `/cart`, `/checkout`, `/order/{orderNo}` (guest checkout, tracker SKUs create a subscription row) |
| Trust & company | `/verification`, `/how-it-works`, `/about`, `/faq`, `/contact`, `/partner` |
| Accounts (§7.1) | `/login` (OTP), `/account` (dashboard), `/account/export`, `/api/auth/*`, `/api/account/*` — dealer and admin remain phase-2 entry pages |
| Legal | `/terms`, `/privacy`, `/refunds`, `/disclaimer` (placeholder wording, flagged in the DB) |
| Machine | `/sitemap.xml`, `/robots.txt`, `/api/listings`, `/api/posts`, `/api/leads`, `/api/events`, `/api/orders`, `/api/bookings`, `/api/service-requests`, `/api/contact`, `/api/og/listing/{slug}.png`, `/api/health` |

**Phase 2 — the back office** (§7.2–§7.4: dealer portal, admin console, plus the
payments and notification integrations the customer account already has seams
for). The public site already writes every record
these screens read — `service_requests`, `bookings`, `orders`, `subscriptions`,
`leads`, `analytics_events` — so this is UI, auth and workflow only. Until a
route is ported it returns a 404 that says so, shows the slice map and links
back into live stock — `src/services/slice.js` holds that list, so "not built
yet" never looks like a broken link.

---

## Layout

```
db/                 schema.sql · seed.sql (generated) · README.md
docs/               PRD-extracted.txt · PORTING.md
scripts/            db-setup · generate-seed · build-static · lint-type-scale · lint-js · check-links
src/
  config.js         every env var in one place
  app.js            Express wiring, CSP, static assets, redirect map
  server.js         entry point
  db/               THE data-access layer: pool, listings, facets, content,
                    requests, commerce, users, ids, leads, analytics, redirects,
                    static-pages
  lib/              render (hybrid HTML pipeline) · locals · respond · rate-limit · phone
  services/         seo · og · icons · nav · events · sitemap · listing-query ·
                    validate · concierge · auth · slice
  routes/           public · services · flow · blog · shop · pages · auth ·
                    account · api · registry (static build)
views/
  layouts/base      partials/ (header, drawer, footer, cards, filters, forms, …)
  pages/            home · cars · facet · vdp · sold-archive · services · service ·
                    find-my-car · concierge-status · sell-swap · hire · blog ·
                    post · guide · shop · product · cart · checkout · order ·
                    compare · verification · how-it-works · faq · contact ·
                    about · partner · page (CMS/legal) · portal-stub · 404 · 500
public/
  css/              tokens · base · components · pages · sections · account
                    (the design system)
  js/               main · header · filters · leads · ui · events · flow ·
                    service-forms · blog · cart · account (vanilla ES modules)
  fonts/            Inter 400/500/600/700, self-hosted
  img/seed/         42 placeholder media files
assets/fonts/       Inter variable TTF, used only to render OG cards
```

---

## Known gaps and decisions for you

1. **Design source.** The referenced Next.js build (`c765c8a` with
   `globals.css`) is not in the GitHub repo — `main` is at `7982665` and holds
   only the README and the spec PDF. This port therefore takes its design from
   the PDF: §3.2 colour tokens, §3.3 type scale, §3.4 layout/component rules,
   Appendix A wireframes and Appendix D microcopy. **If the Next.js build turns
   up, drop it somewhere I can read and I will diff the tokens and markup
   against it.**
2. **Photography is real, but representative.** Listings carry real
   photographs (`public/img/cars/`), each taken through the same preparation
   step — 4:3, 1200×900, plus a 600×450 sibling for cards and thumbnails. The
   resolver in `scripts/seed-media.js` matches a listing to a photo by model,
   then body type, so a Camry listing leads with the Camry photo and an SUV with
   an SUV photo. Two honest caveats: (a) a model we have no photo for borrows a
   same-body-type photo — replace it by dropping the right file in
   `public/img/cars/` and adding one line to `scripts/seed-media.js`; (b) the
   dealer media pipeline (S3 + CDN + WebP/AVIF variants + per-listing upload,
   §11) is still to build — the schema, `listing_media` shape and the
   `-600` variant convention are ready for it. `public/img/seed/*.svg` remains
   only as the fallback for a row with no photo at all.
3. **Prices, phone number and legal copy are placeholders.** The business phone
   is `+2348000000000` and the CAC line is a stub — send me the real values
   (§19 open questions) and I will update `.env` and the copy.
4. **The integrations are seams, not services.** Checkout writes a
   `pending_payment` order with a `HC-ORD-` number and hands off to WhatsApp;
   the PSP call, webhook and `payment_ref` column are stubbed (§11). The same is
   true of the WhatsApp Cloud API, SMS and email: `AUTH_OTP_PROVIDER` selects
   the delivery channel and the `console` provider is the development default.
   Every record the real services will read already exists.
5. **Referral rewards and report PDFs are the two honest blanks.** The referral
   *link* and the counts behind it are real; the reward amount and payout are a
   business decision, so the page states the counts and leaves the promise to
   the ops desk. Inspection report PDFs are listed as documents only when they
   exist — today that means shop receipts; the generator arrives with the
   dispatch module (§7.3).
6. **No CI and no container.** The gates exist as scripts
   (`npm run check`, `check-links`, `images:check`) but nothing runs them on
   push yet; there is no Dockerfile or compose file (§17). Worth adding before
   the first deploy.
7. **Visual QA was structural, not visual.** There is no browser or headless
   renderer in this sandbox — it is verified by rendered HTML, computed
   markup checks, CORS-free link crawling and OG-card renders. Your eyes on the
   live preview are the visual sign-off.
8. **`npm run db:seed` is destructive by design** (it truncates and reloads).
   It is for development and for the pilot seed; production loads get an
   importer instead.
