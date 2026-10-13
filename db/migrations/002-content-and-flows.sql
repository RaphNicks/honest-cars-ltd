-- ============================================================================
-- Migration 002 — content blocks and operational flows
--
-- Brings an existing database (schema v1: the vertical slice) up to the
-- full schema in db/schema.sql: the §6.7 service-page blocks, §6.9 blog body
-- blocks, CMS pages, hire classes, shop products and the service request /
-- booking / order records from §10.1.
--
-- Applied by `npm run db:migrate`, which tolerates “already exists” errors, so
-- this is safe to re-run and safe on a database created from schema.sql
-- directly.
-- ============================================================================

SET NAMES utf8mb4;

-- --- services: the §6.7 service-page template -------------------------------
ALTER TABLE services
  ADD COLUMN hero_copy    TEXT         NULL AFTER is_active,
  ADD COLUMN deliverables JSON         NULL AFTER hero_copy,
  ADD COLUMN included     JSON         NULL AFTER deliverables,
  ADD COLUMN excluded     JSON         NULL AFTER included,
  ADD COLUMN steps        JSON         NULL AFTER excluded,
  ADD COLUMN pricing      JSON         NULL AFTER steps,
  ADD COLUMN proof        JSON         NULL AFTER pricing,
  ADD COLUMN jobs_done    INT UNSIGNED NOT NULL DEFAULT 0 AFTER proof,
  ADD COLUMN booking_kind VARCHAR(40)  NULL AFTER jobs_done,
  ADD COLUMN sla_copy     VARCHAR(200) NULL AFTER booking_kind;

-- --- blog_posts: body blocks, service CTA, author bio (§6.9) ----------------
ALTER TABLE blog_posts
  ADD COLUMN body       JSON         NULL AFTER make_tags,
  ADD COLUMN service_cta VARCHAR(80) NULL AFTER body,
  ADD COLUMN author_bio VARCHAR(300) NULL AFTER service_cta,
  ADD COLUMN updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER author_bio;
