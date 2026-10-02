-- ============================================================================
-- 013 — CMS workflow (§7.3 “CMS Blog posts & media, pages, FAQs, testimonials,
-- homepage modules”, §6.9 “Publishing & governance”).
--
-- Three things this adds:
--
--   1. The blog post fields a publishing workflow needs that the original
--      table did not carry: an editor-owned meta title/description (§14
--      patterns are a fallback, not the law once a human writes one), the
--      reason a post came back from review, and who last touched it.
--
--   2. content_revisions — one immutable snapshot per save. “Revision
--      history” in §6.9 means a marketing editor can see what changed, when,
--      and by whom, and put an older version back. Snapshots are JSON, not
--      diffs, because a diff you cannot restore from is decoration.
--
--   3. homepage_modules — the §7.3 module list (featured cars, trust
--      counters, banners) as data the homepage reads, instead of copy that
--      only exists inside a template.
--
-- Deliberately no semicolons inside comments: both SQL runners split on “;”.
-- ============================================================================

USE honestcars;

ALTER TABLE blog_posts
  ADD COLUMN meta_title       VARCHAR(200) NULL,
  ADD COLUMN meta_description VARCHAR(320) NULL,
  ADD COLUMN review_note      VARCHAR(300) NULL,
  ADD COLUMN published_by     INT UNSIGNED NULL,
  ADD COLUMN updated_by       INT UNSIGNED NULL,
  ADD CONSTRAINT fk_blog_published_by FOREIGN KEY (published_by) REFERENCES `users` (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_blog_updated_by   FOREIGN KEY (updated_by)   REFERENCES `users` (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS content_revisions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity     ENUM('post','page','faq','testimonial','homepage','service') NOT NULL,
  entity_id  INT UNSIGNED NOT NULL,
  slug       VARCHAR(200) NULL,                  -- as it was at that revision
  title      VARCHAR(240) NULL,
  status     VARCHAR(40)  NULL,                  -- workflow state at that revision
  snapshot   JSON         NOT NULL,
  note       VARCHAR(240) NULL,                  -- “requested changes: figure in para 3”
  actor_id   INT UNSIGNED NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_revision_entity (entity, entity_id, id),
  CONSTRAINT fk_revision_actor FOREIGN KEY (actor_id) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS homepage_modules (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `key`      VARCHAR(40)  NOT NULL,              -- banner | trust_figures | featured_cars
  title      VARCHAR(160) NULL,
  payload    JSON         NULL,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  position   TINYINT      NOT NULL DEFAULT 0,
  updated_by INT UNSIGNED NULL,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_module_key (`key`),
  CONSTRAINT fk_module_actor FOREIGN KEY (updated_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- DOWN (for a rollback, run by hand):
--   ALTER TABLE blog_posts
--     DROP FOREIGN KEY fk_blog_published_by,
--     DROP FOREIGN KEY fk_blog_updated_by,
--     DROP COLUMN meta_title,
--     DROP COLUMN meta_description,
--     DROP COLUMN review_note,
--     DROP COLUMN published_by,
--     DROP COLUMN updated_by;
--   DROP TABLE content_revisions;
--   DROP TABLE homepage_modules;
-- ---------------------------------------------------------------------------
