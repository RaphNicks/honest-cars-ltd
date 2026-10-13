# Porting the remaining routes

How the slice was built, and the recipe for every route that follows. Follow it
and a new page inherits the design system, SEO scaffolding, cache headers,
sitemap entry, static-build support and link checking for free.

---

## The contract a page has to satisfy

Every public page must:

1. **Render complete HTML.** No client-only content (§12.4). If JavaScript is
   off, the page still reads, filters and links.
2. **Use the six-step type ladder.** Only `--text-12/14/16/20/24/32`; 12px only
   for micro labels, never prose. `npm run lint:type` enforces it.
3. **Use the palette.** Only the tokens in `tokens.css`. Cards are white with a
   1px `--line` border and a 12px radius; hover elevation on desktop only;
   three button kinds and one primary action per screen area (§3.4).
4. **Emit metadata.** Title (≤62 chars), description (≤158), canonical, robots,
   OG card (1200×630) and the relevant JSON-LD.
5. **Be honest about data.** Prices in ₦ with tabular figures, mileage in km,
   the verification grade on any card that shows a car, and the dealer never
   named with contact details — "Partner dealer · PH — verified by HonestCars".
6. **Route every dead end somewhere useful.** Empty states go to the concierge
   (§6.2, Appendix D).

---

## Recipe: adding a static page

Say it is `/services/inspection`.

**1 — write the view.** `views/pages/service.ejs`, using the shared partials
(`breadcrumbs`, `car-card`, `service-card`, `accordion`, `empty-state`). No new
CSS unless the page genuinely needs it; if it does, add it to `pages.css` and
re-run `npm run lint:type`.

**2 — add a builder.** In `src/routes/registry.js`:

```js
{
  path: '/services/inspection',
  view: 'service',
  async build({ db }) {
    const service = (await db.content.serviceSuite()).find((s) => s.slug === 'inspection');
    const faqs = await db.content.faqsForScope('service:inspection');
    return {
      view: 'service',
      page: {
        title: service.name,
        titleSuffix: false,               // if the title already ends with “| HonestCars”
        metaTitle: seo.serviceMeta(service).fullTitle,
        description: seo.serviceMeta(service).description,
        canonical: `/services/${service.slug}`,
        robots: 'index,follow',
        jsonLd: [
          seo.breadcrumbSchema([{ label: 'Services', href: '/services' }, { label: service.name }]),
          seo.faqSchema(faqs),
        ],
      },
      data: { service, faqs, trail: [...] },
    };
  },
}
```

**3 — serve it at request time too**, in `src/routes/public.js`, so the page
works even before a static build has run. Use `sendPrebuiltOrRender` and the
sixth criterion is automatic: served from `dist/` when built, rendered when not.

**4 — remove the route from `PENDING`** in `src/services/slice.js`. The link
checker immediately starts requiring a 200 from it.

**5 — build and check.**

```bash
npm run build:static && npm test && node scripts/check-links.js
```

---

## Recipe: adding a curated facet

Facets are data, not code. Insert a row into `facets` (see the seed for the
shape) and re-run `npm run db:seed` or an INSERT:

| Column | Notes |
|---|---|
| `slug` | URL after `/cars/` — `toyota`, `toyota/camry`, `suv-under-15m` |
| `page_type` | `make` / `model` / `body_budget` / `tag` |
| `parent_slug` | parent facet slug (drives breadcrumbs and sibling links) |
| `h1`, `title`, `intro_copy` | the curated copy — this is the whole point of the page |
| `meta_title`, `meta_description` | search snippet |
| `rules` | filter object: `{make, model, body_type, max_price_kobo, min_price_kobo, condition, grade, year_min, customs_verified}` |
| `canonical_path` | normally `/cars/{slug}` |
| `indexable` | `1` to allow indexing, `0` to keep it out of search |

Then `npm run build:static` — the facet is picked up automatically by
`facetRoutes()` and added to the sitemap.

**The rule that must not be broken:** only curated rows are indexable. Raw
filter combinations stay `noindex,follow` with a canonical to `/cars`, and
`robots.txt` disallows `/cars?*`. `test/routes.test.js` asserts both.

---

## Recipe: adding an AJAX interaction

1. The HTML must work without JavaScript first (a real form, or a real link).
2. The endpoint goes in `src/routes/api.js`, rate-limited, returning either a
   fragment rendered from the *same* partial the SSR page uses, or JSON.
3. The module that upgrades it goes in `public/js/` and exports an `init*`
   function; wire it in `public/js/main.js`.
4. Any new event name must already exist in the §15.1 list
   (`src/services/events.js`). `npm run lint:js` fails the build if a template
   or module references an event that is not in the plan.

`/cars` filters are the reference implementation: `public/js/filters.js` +
`GET /api/listings` + `views/pages/fragment-listing-grid.ejs`.

---

## Rules that are enforced by tests, not by memory

| Rule | Enforced by |
|---|---|
| Six-step ladder, one family, weights 400–700 | `scripts/lint-type-scale.js`, `test/type-scale.test.js` |
| Sold visible 7 days → archive to day 90 → 301 to facet | `test/routes.test.js` (live DB) |
| Curated facets indexable, raw combos noindex | `test/routes.test.js` |
| VDP slug contract + meta patterns | `test/seo.test.js` |
| VIN never public, dealer contact never public | `test/seo.test.js`, `scripts/check-links.js` |
| Event names match §15.1 verbatim | `scripts/lint-js.js` |
| Filters cannot inject SQL | `test/listing-query.test.js` |
| Every internal link resolves | `scripts/check-links.js` |

---

## Performance budget note (§12.1)

Current measured weight, gzipped:

| Asset | Size |
|---|---|
| CSS (4 files, all of them) | ~13.4 kB |
| JS (6 modules, all of them) | ~11.9 kB |
| Homepage HTML | ~15.7 kB |
| `/cars` HTML | ~13.2 kB |

The JS budget is 180 kB gzipped; this build uses under 7% of it. Images are the
only remaining weight, and they are lazy-loaded below the fold with explicit
dimensions to keep CLS at zero.
