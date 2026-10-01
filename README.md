# honestcarsltd.com — vanilla HTML/CSS/JS · Node.js · MySQL

The Honest Cars LTD storefront, ported from the approved specification
(`Honest_Cars_LTD_Website_Specifications_Final.pdf`) into the approved stack:
**vanilla HTML, CSS and JavaScript on the front end, Node.js + Express on the
server, MySQL for data.** No React, no Tailwind, no frontend build step.

This repository currently contains the **agreed vertical slice**: the design
system, the homepage, `/cars`, the curated facet pages, the VDP and the
sold-archive rule — running on the real stack against a real database. The
remaining ~27 PRD routes are ported next on these same templates.

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
const listing = await db.listings.findBySlug('2015-toyota-camry-le-hc-ph-0001');
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

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Same, with `node --watch` |
| `npm run db:setup` | Create database, apply `db/schema.sql`, load `db/seed.sql` |
| `npm run db:seed` | Regenerate the seed from `scripts/generate-seed.js`, then load it |
| `npm run build:static` | Render stable pages + `sitemap.xml` + `robots.txt` into `dist/` |
| `npm run lint:type` | Six-step type-scale audit (fails the build on a violation) |
| `npm run lint:js` | ES-module parse check + every event name against the §15.1 plan |
| `npm test` | 43 tests: routes, sold-archive windows, facet rules, SEO schemas, filter safety |
| `npm run check` | lint + test |
| `npm run artifacts` | Build the static pages and re-run the type audit |

`node scripts/check-links.js` walks the built slice, follows every internal
link, and fails if a built route breaks or a backlog route stops returning its
honest 404.

---

## What is built, and what comes next

**Built and testable now:** `/`, `/cars`, 10 curated facet pages, the VDP,
`/cars/sold/{slug}`, `/sitemap.xml`, `/robots.txt`, `/api/listings`,
`/api/leads`, `/api/events`, `/api/og/listing/{slug}.png`, `/api/health`.

**Next in the port** (each one is a view + a `build()` function, no new
infrastructure): the services hub and 9 service pages, `/find-my-car`,
`/sell-swap`, `/hire`, `/partner`, `/blog` + posts, `/guide`, `/how-it-works`,
`/about`, `/verification`, `/faq`, `/contact`, `/shop`, `/cars/compare`, the
four legal pages, then the authenticated portals (customer account, dealer
portal, admin console).

Until a route is ported it returns a 404 that says so, shows the slice map and
links back into live stock — `src/services/slice.js` holds that list, so
"not built yet" never looks like a broken link.

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
                    leads, analytics, redirects, static-pages
  lib/              render (hybrid HTML pipeline) · locals · respond · rate-limit
  services/         seo · og · icons · nav · events · sitemap · listing-query · slice
  routes/           public (SSR + static-capable) · api · registry (static build)
views/
  layouts/base      partials/ (header, drawer, footer, cards, filters, …)
  pages/            home · cars · facet · vdp · sold-archive · not-found · error
public/
  css/              tokens · base · components · pages   (the design system)
  js/               main · header · filters · leads · ui · events (vanilla ES modules)
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
2. **Photography is placeholder.** `public/img/seed/` holds 42 generated SVGs
   labelled "Photo pending — media pipeline stub". The media pipeline (S3 + CDN
   + WebP variants, §11) is not built; the schema and `listing_media` shape are
   ready for it.
3. **Prices, phone number and legal copy are placeholders.** The business phone
   is `+2348000000000` and the CAC line is a stub — send me the real values
   (§19 open questions) and I will update `.env` and the copy.
4. **Payments, WhatsApp Cloud API, OTP and email are not wired.** Everything
   that will call them (leads, service requests, analytics events) already
   exists and posts to our own endpoints, so the integration points are ready.
5. **Visual QA was structural, not visual.** There is no browser or headless
   renderer in this sandbox — it is verified by rendered HTML, computed
   markup checks, CORS-free link crawling and OG-card renders. Your eyes on the
   live preview are the visual sign-off.
6. **`npm run db:seed` is destructive by design** (it truncates and reloads).
   It is for development and for the pilot seed; production loads get an
   importer instead.
