# Honest Cars LTD — full-site redesign: audit, inventory, batches

Companion to `docs/PRD-extracted.txt` (functional authority) and the 2026
master redesign prompt (visual authority). The codebase is the implementation
foundation; nothing here replaces it.

Central rule from the master prompt: **the site must read as hand-built, not
generated.** Cards only where they earn their border; Inter only; ≤200ms
motion; white-dominant canvas; navy for depth; green for action; amber for
warning; real data and real photography everywhere.

---

## 1. Audit findings (what exists)

- **Stack:** Node + Express + EJS, vanilla CSS with a token file
  (`public/css/tokens.css`), vanilla ES modules (`public/js/*`), MySQL behind
  one data layer (`src/db/*`). Stable pages prebuilt to `dist/`; `/cars`,
  VDPs, concierge, shop render per request.
- **Design system:** PRD §3 tokens ported verbatim — navy `#0E2A47`, green
  `#12A150`, amber `#E8A13D`, six-step type ladder (enforced by
  `scripts/lint-type-scale.js`, which also enforces *Inter as the only
  family*), 8px grid, 1200px container, 12px house radius, ≤200ms motion
  tokens, global `:focus-visible`, global reduced-motion collapse, skip link,
  CLS guards (`img[width][height]`), tabular numerals.
- **Experiences:** four, deliberately distinct — public storefront (white,
  photographic), customer account (light, list/table), dealer portal (dense
  operational), admin console (dense, tables + sidebars). They share tokens
  but not templates.
- **Existing card usage:** vehicle cards, product cards, post cards and
  service cards are legitimate (independent scannable items). The 2026 home
  refresh added category cards and plaques; §2.1 review happens per batch —
  anything that is a card only by habit gets demoted to typography/spacing.
- **Known gaps:** `docs/GAPS.md` (18 rows; only §11 Turnstile is buildable
  with third-party keys). Nothing in this redesign closes those; they remain
  tracked there.

## 2. Route & feature inventory (discovered from `src/routes/*`, not assumed)

Batch column = the batch that redesigns it. "—" = shared foundation (Batch A).

### Public — discovery
| Route | Role | Purpose | Batch |
|---|---|---|---|
| `/` | anon | Homepage: hero, search, live feed, grades, services, proof, blog, bands | B |
| `/cars` | anon | Browse: filters, sort, pagination, URL state | B |
| `/cars/compare` | anon | Side-by-side ≤3 | B |
| `/cars/{slug}` · `/cars/sold/{slug}` | anon | VDP + sold archive | B |
| `/cars/{facet…}` curated + raw combos | anon | SEO facets (indexable curated, noindex raw) | B |
| `/find-my-car` + `/concierge/*` | anon | Concierge brief → tracking → options PDF | B |

### Public — transactions & services
| Route | Role | Purpose | Batch |
|---|---|---|---|
| `/sell-swap` | anon | Seller journey, valuation, uploads | C |
| `/hire` + booking flow | anon | Hire fleet, dates, availability, payment | C |
| `/services` + 8× `/services/{slug}` | anon | Service suite + forms | C |
| `/shop`, `/shop/{slug}`, `/cart`, `/checkout`, `/order/{no}` | anon | Products, cart, checkout, order status | C |
| `/financing` | anon | Calculator + application | C |

### Public — content & trust
| Route | Role | Purpose | Batch |
|---|---|---|---|
| `/blog`, `/blog/{slug}`, `/author/{slug}`, `/tag/{slug}` | anon | Editorial index, article, author, tag | D |
| `/guide` | anon | Buyer/seller knowledge resource | D |
| `/how-it-works`, `/verification` | anon | Process + grades explained | D |
| `/about`, `/contact`, `/partner`, `/faq` | anon | Trust + communication | D |
| `/{privacy,terms,…}` legal slugs | anon | Policy text, readability-first | D |
| `/offline` | anon | PWA fallback (plain by design — stays plain) | — |

### Auth & customer account
| Route | Role | Purpose | Batch |
|---|---|---|---|
| `/login`, `/login/mfa`, `/api/auth/*` (otp/verify/mfa/logout) | anon/user | Sign-in, OTP, MFA, sessions | E |
| `/account` (+ saved, bookings, orders, enquiries, submissions, notifications, security) | user | Customer dashboard & subviews | E |
| `/account/export`, receipts, renewals, reports (+PDF), hire invoice | user | Documents | E |
| `/api/account/*` (profile, saved-cars, saved-searches, delete) | user | Account mutations | E |

### Dealer portal (`/dealer`)
| Route | Role | Purpose | Batch |
|---|---|---|---|
| `/dealer/dashboard`, `/listings`(+new/edit/photos/status/fresh) | dealer | Inventory operations | F |
| `/dealer/leads`, `/performance` | dealer | Leads + reporting | F |
| `/dealer/billing`(+statements PDF), `/addons` | dealer | Subscription + add-ons | F |
| `/dealer/profile`, `/imports`(+CSV template, API keys) | dealer | Business profile + bulk import | F |

### Admin console (`/admin`, `/admin/cms`)
| Route | Role | Purpose | Batch |
|---|---|---|---|
| `/admin` overview, `/listings`, `/jobs`(+report PDF) | staff | Verification pipeline | G |
| `/dealers`(+statements, keys), `/staff`, `/security` (MFA) | staff | People + access | G |
| `/bookings`, `/hire`, `/orders`, `/payments`, `/financing` | staff | Transaction operations | G |
| `/leads`, `/concierge`, `/referrals`, `/alerts`, `/intel`, `/reports`, `/milestones`, `/audit` | staff | CRM + ops intelligence | G |
| `/settings`(+markets), `/marketing`, `/privacy` | staff | Configuration | G |
| `/admin/cms` posts/faqs/testimonials/modules/pages/calendar | staff | Content desk | G |

### APIs & feeds (presentation-agnostic; unchanged by design batches)
`/api/*` (listings, compare, posts, valuation, events, bookings, contact,
leads, orders, service-requests, financing, payment webhooks, OG images,
health), `/sitemap.xml`, `/rss.xml`, `/robots.txt`, `/sw.js`.

Discrepancies vs the PRD: none new — `docs/GAPS.md` remains the ledger.

## 3. Batches (approval-gated)

- **A — Shared foundations.** Tokens, global type/layout, navigation &
  footer, buttons & forms, responsive + a11y primitives. *(This batch.)*
- **B — Homepage & discovery** (`/`, `/cars*`, compare, VDP, concierge).
- **C — Transactions & services** (sell/swap, hire, services ×9, shop ×5, financing).
- **D — Content & trust** (blog ×4, guide, how-it-works, about, verification, faq, contact, partner, legal).
- **E — Auth & customer account.**
- **F — Dealer portal.**
- **G — Admin console + CMS.**
- **H — Consistency, responsive, a11y, regression pass.**

## 4. Batch A — completed in this change

1. **Tokens:** cinematic surface family documented (`--navy-deep`,
   `--green-bright`, glass tints, scrim gradients, `--chip-glass`) — same
   hues as the brand navy/green, darker cuts reserved for photographic bands;
   green-bright restricted to dark surfaces (contrast).
2. **Navigation:** home header now floats transparent over the photographic
   hero and turns solid `--navy-deep` on scroll (existing `data-scrolled`
   mechanism) or when a CMS announcement occupies the top (`:has(.banner-strip)`
   fallback); other pages keep the white bar. Focus states stay global.
3. **Motion discipline:** the 2026 refresh's enter-view fade and hover zooms
   were reined to the house `--motion` (200ms) and smaller offsets/scales —
   the master prompt's §3.6 applies site-wide, not just to new batches.
4. **Buttons/forms/tables:** audited against §9 — existing `:focus-visible`,
   labelled fields, `field__error` alerts, 44px targets and real admin tables
   already comply; no gratuitous pills or gradients introduced. One attempted
   decorative *second font family* for the hero annotation was rejected by
   the type-scale lint (§3.3 Inter-only) and restyled as an Inter-italic
   annotation instead — the lint is the guardrail, and it stayed.
5. **Footer:** audited against the reference — deep navy, link columns,
   contact block, socials, tagline and payment marks already match; left
   structurally untouched (composition changes belong to the pages that
   surround it, Batches B/D).

Verification: `npm run lint` exit 0 (19 modules, type-scale clean) ·
`npm test` 556/556 · `npm run build:static` 74 pages · `npm run audit:pages`
147 pages, 0 findings · browser-level DOM check on `/`: both city pickers
hydrate 48 cities, "kano" matches Kano.

Also folded in here (completing the interrupted hero request, not part of
Batch A's scope): the hero now uses the recreated golden-hour inspection
photograph full-bleed, the reference headline "Quality Cars. Real People.
Honest Deals." (CMS override still wins), the trust pill, two-line live
stat plaques, and the "Drive with Confidence" annotation. The exact uploaded
file did not survive a sandbox reset; dropping it over
`public/img/site/hero-cinema.jpg` and running `npm run images` swaps it in
with zero code changes.

## 5. Batch B — completed (`6169f8d`)

Homepage card diet, per §2.1:

- Grades: three boxes → three annotated columns (left colour rule carries the
  meaning; no background, no border).
- Services grid → numbered editorial index (hairline rows: name, promise,
  from-price, hover arrow). Same links and data.
- Testimonials on navy: one large editorial quotation + hairline columns for
  the rest; attributions and ratings untouched.
- Blog strip: featured story in a side-by-side composition + two compact
  cards, replacing the uniform trio.
- Category tiles: outer border removed; the photograph is the tile.

Discovery surfaces audited against §5.2–5.5 and left structurally as-is
because they already comply: `/cars` uses a plain filter panel (dialog on
mobile) with result bar and removable pills; the VDP presents specs as a
hairline `dl` with no boxing; comparison is a real aligned table with
best-value highlighting; `/find-my-car` is a stepped flow with a progress
bar. Their remaining polish (rail typography, gallery rhythm) is queued for
Batch H's consistency pass rather than risking churn now.

Verification: lint exit 0 (type-scale caught and fixed a 12px attribution) ·
556/556 tests · 147 pages audited, 0 findings · live page carries all new
strips.

## 6. Batch C — completed (`aaec82a`)

- `/services` hub: eight identical cards → two-column numbered editorial
  index; the promise trio → hairline columns.
- Service pages: `.deliverable` boxes → open checklist rows.
- `/hire` and `/shop` fine-print trios → hairline columns; the shop's
  delivery-fee panel stays boxed (functional data the checkout uses).
- `/sell-swap` aside → two open editorial notes; forms stay single calm
  containers.
- Audited, unchanged: pricing/`table--split` tables, hire fleet and shop
  product cards (legitimate scannable records), financing's form + arithmetic
  panel.

Verification: 556/556 tests · lint 0 · 147 pages audited, 0 findings · live
spot-checks on `/services`, `/hire`, `/shop`, `/sell-swap` and a service page
confirm the only remaining boxes are functional forms and data panels.

## 7. Batch D — completed (`0a3d701`)

- `/blog`: page one leads with a featured story (side-by-side media), the
  rest in a two-column shelf; filtered/paginated views keep the plain grid so
  load-more keeps appending unchanged.
- `/how-it-works`: boxed trio → hairline columns.
- `/about`: team cards → columns with a green role line; testimonial cards →
  one large light quotation + hairline follow-ups.
- `/contact`: five-box stack → open channel list; service card wall → numbered
  index; the form stays one calm container.
- `/blog/{slug}`: boxed aside widgets → open notes; author block kept (E-E-A-T).
- `/faq`, `/guide`, `/verification`, legal pages: audited, already editorial
  (accordions, narrow prose column, integrity band) — unchanged.
- Bug caught by the live audit and fixed: the post-card featured test used
  truthiness while EJS includes inherit parent locals (a *list* named
  `featured` on several pages) — every card turned "featured" and a closing
  quote was lost. Now `locals.featured === true`; verified one featured card
  per page on `/blog` and `/`.

Verification: 556/556 tests · lint 0 · 147 pages audited, 0 findings.

**Next: Batch E, on your approval.**
