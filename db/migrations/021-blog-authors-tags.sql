-- ---------------------------------------------------------------------------
-- 021 — FR-35: author pages and a governed tag taxonomy
--
-- §6.9 asks for an author card “(name, role, short bio — E-E-A-T)” and for
-- “tags governed” as a fixed taxonomy. Both were missing a home:
--
--   * The author was three text columns on the post (`author_name`,
--     `author_role`, `author_bio`), repeated on every post that author wrote.
--     That means no author page (there is nothing to group by), and an author
--     who changes roles changes it in as many places as they have posts.
--     `blog_authors` is the entity; the post keeps the three columns as the
--     byline the CMS writes, and `author_id` is the link. ON DELETE SET NULL,
--     so deleting an author never deletes their work — the byline stays.
--
--   * Tags were `make_tags`: a JSON array of makes used to pull live listings
--     (“Cars mentioned in this article”). That is inventory matching, not a
--     taxonomy — it cannot carry “import”, “fuel” or “customs”, and nothing
--     can list “every post about customs”. `blog_tags` + `blog_post_tags` is
--     the governed list; `make_tags` keeps doing its job beside it.
--
-- The tag table carries a `description` because a tag page with one line of
-- intent ranks better than a bare list, and a `kind` so the console can group
-- the governed list (make · topic · format) without a second table. `slug` is
-- the URL: /blog/tag/{slug} and /blog/author/{slug}.
--
-- DOWN
--   ALTER TABLE `blog_posts` DROP FOREIGN KEY fk_blog_author;
--   ALTER TABLE `blog_posts` DROP KEY idx_blog_author, DROP COLUMN author_id;
--   DROP TABLE blog_post_tags;
--   DROP TABLE blog_tags;
--   DROP TABLE blog_authors;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `blog_authors` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(80)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  role       VARCHAR(120) NOT NULL,
  bio        VARCHAR(300) NULL,                     -- E-E-A-T short bio (§6.9)
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_author_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `blog_tags` (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(80)  NOT NULL,
  label       VARCHAR(80)  NOT NULL,
  kind        ENUM('topic','make','format') NOT NULL DEFAULT 'topic',
  description VARCHAR(200) NULL,                    -- one line of intent, for the tag page
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tag_slug (slug),
  KEY idx_tag_kind (kind, label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `blog_post_tags` (
  post_id INT UNSIGNED NOT NULL,
  tag_id  INT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  KEY idx_post_tag_tag (tag_id),
  CONSTRAINT fk_post_tag_post FOREIGN KEY (post_id) REFERENCES blog_posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_post_tag_tag  FOREIGN KEY (tag_id)  REFERENCES blog_tags  (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `blog_posts`
  ADD COLUMN author_id INT UNSIGNED NULL AFTER author_bio,
  ADD KEY idx_blog_author (author_id, status, published_at),
  ADD CONSTRAINT fk_blog_author FOREIGN KEY (author_id)
    REFERENCES blog_authors (id) ON DELETE SET NULL;
