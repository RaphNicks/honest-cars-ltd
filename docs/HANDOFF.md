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
npm run build:static                # 68 static pages into dist/
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

## 3. Just finished: FR-35 blog enhancements

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

**Next in order:** FR-28/29/30/31/32/33/34 (P3) → the remaining admin screen
(settings). `docs/GAPS.md` is canonical: 26 rows, each with what “done” means.

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
npm test          # 318/318 (33 hire, 12 blog-tags)
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
