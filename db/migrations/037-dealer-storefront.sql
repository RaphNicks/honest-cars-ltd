-- 037 · Dealer storefront branding (public per-dealer mini-site, behind a flag).
--
-- The public storefront (GET /dealers/:slug) shows each lot's own logo and a
-- short tagline alongside its live stock. Both are optional — a lot with no
-- logo falls back to the HonestCars wordmark — so both columns are nullable.
-- See src/routes/dealers.js (public) and src/routes/dealer.js (the portal
-- "Storefront" page that edits them). Gated by config.features.dealerStorefront,
-- which defaults to off.

ALTER TABLE dealers
  ADD COLUMN logo    VARCHAR(400) NULL,
  ADD COLUMN tagline VARCHAR(160) NULL;
