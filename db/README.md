# Database

MySQL 5.7+ / MariaDB 10.3+. `schema.sql` is idempotent, `seed.sql` is
generated — never edit the seed by hand.

```bash
node scripts/db-setup.js            # schema + migrations + seed (what `npm run db:setup` calls)
node scripts/db-setup.js --schema-only
node scripts/migrate.js             # apply only db/migrations/*.sql
node scripts/generate-seed.js       # regenerate db/seed.sql + public/img/seed/
```

`db-setup.js` needs an account with `CREATE` privileges to make the database
and the app user. Point it at that account with `DB_ADMIN_USER` /
`DB_ADMIN_PASSWORD`; it falls back to the sandbox's passwordless `root`.

---

## Pointing at your own MySQL

Edit `.env`:

```ini
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=honestcars
DB_PASSWORD=whatever
DB_NAME=honestcars
# DB_SOCKET=/var/run/mysqld/mysqld.sock   # takes priority over host/port
```

Nothing else changes. `src/db/pool.js` is the only file that opens a
connection; the rest of the application talks to `src/db/index.js`.

---

## Migrations

`db/schema.sql` is the schema of record and stays idempotent. Anything added
after the first deploy lands in `db/migrations/NNN-name.sql` and is recorded in
`schema_migrations`:

| File | Adds |
|---|---|
| `002-content-and-flows.sql` | `services` template columns, `service_requests`, `bookings`, `products`, `orders`, `order_items`, `pages`, `hire_classes`, service/blog/testimonial extras |
| `003-subscriptions-and-delivery.sql` | `delivery_areas`, `subscriptions` |
| `004-hire-request-type.sql` | `hire` as a `service_requests.type` |
| `005-hire-class-image.sql` | `hire_classes.image_url` |
| `006-accounts.sql` | `users`, `auth_codes`, `sessions`, `saved_cars`, `saved_searches` (§7.1) |
| `007-referrals-and-alert-switches.sql` | `users.referral_code` / `users.referred_by`; `saved_searches.alert_price_drop` / `alert_new_match` |
| `008-referral-code-backfill.sql` | `HC0001`-shaped codes for accounts that predate 007 |

---

## Accounts (§7.1) — the five tables behind `/login` and `/account`

| Table | Holds | Rules |
|---|---|---|
| `users` | one row per person | `phone` is the key, stored `+234XXXXXXXXXX`; `status` is `active` / `blocked` / `deleted` (blocked revokes live sessions on the next request); `marketing_opt_in` is explicit and revocable (NDPA); `referral_code` is unique and `referred_by` points at the inviter — set once, at creation, never to itself |
| `auth_codes` | login codes | only an HMAC-SHA256 hash, never the code; `channel` (`whatsapp` / `sms` / `console`), `expires_at` (10 min), `attempts` / `max_attempts` (5), `consumed_at` for single use |
| `sessions` | signed-in browsers | 32 random bytes hashed with SHA-256; `expires_at` (30 days) and `revoked_at`; cascades with the user |
| `saved_cars` | shortlist | unique on `(user_id, listing_id)`; cascades with the user *and* the listing |
| `saved_searches` | filters worth keeping | `query` is the raw query string; `alert_price_drop` and `alert_new_match` are the two §7.1 switches, and `alerts_enabled` is derived (`priceDrop OR newMatch`) so older reads still mean "any alert" |

Deleting an account deletes the person and everything that belongs to them, but
**keeps the operational paper trail**: `service_requests`, `bookings`, `orders`
and `leads` are anonymised in place (`name` → `Deleted account`, `phone` →
`DELETED-<id>`) rather than deleted, because finance and warranty need them.
`src/db/users.js` is the only writer for any of this.

---

## Conventions

* **All money is an integer number of kobo.** `₦8,650,000` is stored as
  `865000000`. Formats for display through `src/db/shape.js`.
* **Mileage is kilometres.** No miles anywhere.
* **utf8mb4 / InnoDB** everywhere.
* `condition` is a reserved word in MySQL 5.7 — always backticked.
* Statuses: `draft → in_review → live → reserved → sold → expired`.
  Ops moderation and expiry automation move listings between them; only
  `live` and `reserved` are publicly browsable (plus sold within 7 days).

---

## Tables

| Table | Purpose |
|---|---|
| `dealers` | Partner lots. Contact details stay here and are never rendered publicly. |
| `vehicle_listings` | The store. Field-for-field Appendix B, including `documents` JSON and `inspection_summary`. |
| `listing_media` | Ordered photos per listing (`shot_label` follows the §3.4 photo guide). |
| `price_bands` | Make/model/year market bands that drive the price-position indicator and valuations. |
| `facets` | **Curated** facet pages only. Raw filter combinations are never rows here and are never indexable. |
| `leads` | Every public enquiry: viewing, concierge, sell/swap, hire, service, parts, B2B, deal alert, contact. |
| `services` | The service suite shown on the homepage and hub — hero, deliverables, included/excluded, staged process, pricing tiers and proof, all as data. |
| `service_requests` | The concierge / sell / swap / documents / research / parts / tracking intake. Carries the human tracking id (`HC-2481`) the customer watches at `/concierge/{id}`, the SLA due date, and the free-form brief as JSON. |
| `bookings` | Scheduled work: inspections, tracker installs, consultations. Carries `reference` (`HC-BK-0001`), `slot_at`, `location`, `vehicle` JSON and `addons` JSON. |
| `products` | Shop SKUs in three categories — trackers, diagnostics, care kits. `install_included` drives the checkout install toggle. Parts are deliberately **not** products. |
| `orders` | Guest checkout orders (§6.8): name + WhatsApp number + delivery area. `order_no` is `HC-ORD-0001`, `status` starts at `pending_payment` (the PSP is a seam — §11). |
| `order_items` | Line items with the server-recomputed unit price and per-line install flag. |
| `delivery_areas` | Delivery zones and their fee in kobo. A pickup meet-point is the zero-fee default; the checkout total is always recomputed from this table. |
| `subscriptions` | One row per tracker SKU purchased: `device_state` (`ordered → installed → activated → renewal_due → lapsed`) and `renewal_at` 12 months out. This is the record the admin activation checklist and renewal reminders read. |
| `pages` | CMS pages for the trust, company and legal set (`about`, `how-it-works`, `contact`, `verification`, `terms`, `privacy`, `refunds`, `disclaimer`) with block-based `body` JSON. |
| `hire_classes` | Car-hire classes with daily/weekly rates, driver and airport rates, seating and example models. |
| `testimonials` | Social proof with real names and areas. |
| `blog_posts` | Content, with the CMS workflow states from §6.9 and the category / make-tag taxonomy that drives `/blog` and `/guide`. |
| `faqs` | Scoped FAQs; `scope` drives FAQPage schema (`global`, `facet:toyota`, `service:inspection`, `page:verification`, `shop:trackers`). |
| `analytics_events` | Server-side mirror of the §15.1 event plan. Purchase-adjacent events are server-only. |
| `redirects` | 301 map: the 90-day sold hand-off and any legacy URL. |
| `static_pages` | Build bookkeeping — which stable pages were written to disk, when, and from which view. |
| `schema_migrations` | Which files under `db/migrations/` have been applied, so `npm run db:setup` is safe to re-run. |

## Views

| View | Meaning |
|---|---|
| `v_live_listings` | Everything `/cars` shows: live + reserved (unexpired) + sold within 7 days |
| `v_archived_sold` | Sold 7 → 90 days: the indexable sold-archive window |
| `v_expired_sold` | Sold beyond 90 days: must 301 to the listing's facet |

```sql
-- what is browsable right now
SELECT COUNT(*) FROM v_live_listings;

-- what is about to need a 90-day hand-off
SELECT seo_slug, archive_redirect_path FROM v_expired_sold;
```

## Seed data

`db/seed.sql` is generated by `scripts/generate-seed.js` from a fixed PRNG
seed, so it is reproducible byte-for-byte. It contains 79 market-plausible Port
Harcourt listings across 12 partner lots — including deliberate edge cases:

| Case | Rows | Why |
|---|---|---|
| Live | 60 | Normal browsing, facets, pagination |
| Reserved | 3 | Reserved badge and filtering |
| Sold 0–7 days | 6 | "Sold in N days" social proof, `noindex` |
| Sold 7–90 days | 4 | The archive page + 301 from the old VDP URL |
| Sold >90 days | 3 | The 301-to-facet hand-off |
| Draft / in review / expired | 3 | Never public |

`listing_media` rows point at prepared photographs in `public/img/cars/` and
`public/img/details/` (resolved per listing by `scripts/seed-media.js`). Every
prepared photo is 1200×900 with a `-600.jpg` sibling produced by
`npm run images`; `width`/`height` in the row match the full-size file, so the
templates can reserve the right box and avoid layout shift. Rows for listings we
have no photo for fall back to the placeholder SVGs in `public/img/seed/`.

Swap the generator for a real importer when the first lot uploads stock — the
schema is the contract, not the generator.
