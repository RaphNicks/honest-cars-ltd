-- ============================================================================
-- Honest Cars LTD — honestcarsltd.com
-- MySQL 5.7+ / MariaDB 10.3+ schema
-- Source of truth: docs/PRD-extracted.txt §10 (Data & Content Model)
--                   + Appendix B (Vehicle Listing Field Schema, full)
--
-- Conventions
--   * All money is stored as INTEGER KOBO (₦1 = 100 kobo) — §10.2
--   * utf8mb4 everywhere; InnoDB; explicit timestamps
--   * Idempotent: safe to re-run on a fresh database
-- ============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- users — created first on purpose: `dealers.user_id` (the one account that
-- runs a lot, §7.2) carries a foreign key into this table, and MySQL will not
-- add a constraint against a table that does not exist yet.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- users · auth_codes · sessions — phone-first accounts (§7.1)
--
-- OTP login: the code is stored HMAC-SHA256 hashed and single-use; sessions are
-- server-side and revoked by hash lookup, so a stolen cookie can be killed from
-- the database. Saved cars/searches hang off the user; dashboard reads (requests,
-- bookings, orders, subscriptions) are keyed by phone — the account key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone            VARCHAR(40)   NOT NULL,              -- normalised +234…
  name             VARCHAR(120)  NULL,
  email            VARCHAR(160)  NULL,
  marketing_opt_in TINYINT(1)    NOT NULL DEFAULT 0,    -- NDPA: explicit, revocable
  status           ENUM('active','blocked','deleted') NOT NULL DEFAULT 'active',
  role             ENUM('customer','dealer','ops','inspector','marketing','finance','admin')
                                 NOT NULL DEFAULT 'customer',   -- §7.4 role matrix
  watchlisted      TINYINT(1)    NOT NULL DEFAULT 0,            -- admin flag (§7.3)
  referral_code    VARCHAR(16)   NULL,              -- the holder's personal link code
  referred_by      INT UNSIGNED  NULL,              -- who brought them here (§7.1 referrals)
  referral_qualified_at DATETIME NULL,              -- FR-28: when it started to count
  referral_note    VARCHAR(200)  NULL,              -- the desk's own line on it
  last_seen_at     DATETIME      NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_phone (phone),
  UNIQUE KEY uq_user_referral_code (referral_code),
  KEY idx_user_role (role),
  KEY idx_user_email (email),
  KEY idx_user_referred_by (referred_by),
  CONSTRAINT fk_user_referrer FOREIGN KEY (referred_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- dealers — partner lots. Contact details are NEVER rendered publicly (§6.3,
-- §18.3 "Dealer contact info does not appear anywhere public").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dealers (
  id                INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  name              VARCHAR(160)     NOT NULL,
  slug              VARCHAR(160)     NOT NULL,
  lot_area          VARCHAR(80)      NOT NULL,             -- e.g. 'Aba Road, PH'
  city              VARCHAR(80)      NOT NULL DEFAULT 'Port Harcourt',
  tier              ENUM('pilot','standard','premium') NOT NULL DEFAULT 'standard',
  verified          TINYINT(1)       NOT NULL DEFAULT 0,
  user_id           INT UNSIGNED     NULL,                  -- §7.2 the account that owns this lot
  agreement_signed  DATE             NULL,
  agreement_ref     VARCHAR(80)      NULL,                  -- reference on the signed agreement
  agreement_url     VARCHAR(300)     NULL,                  -- digital copy, if ops has one
  commission_pct    DECIMAL(4,2)     NULL,                  -- the rate on the agreement
  created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dealers_slug (slug),
  UNIQUE KEY uq_dealer_user (user_id),
  CONSTRAINT fk_dealer_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- price_bands — market price intelligence per make/model/year/condition.
-- Drives the price-position indicator and the valuation band (§3.5, §7.3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_bands (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  make             VARCHAR(60)   NOT NULL,
  model            VARCHAR(80)   NOT NULL,
  year_from        SMALLINT      NOT NULL,
  year_to          SMALLINT      NOT NULL,
  `condition`      ENUM('tokunbo','nigerian_used','new','any') NOT NULL DEFAULT 'any',
  band_min_kobo    BIGINT        NOT NULL,
  band_max_kobo    BIGINT        NOT NULL,
  sample_size      SMALLINT      NOT NULL DEFAULT 0,
  refreshed_at     DATE          NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_price_band (make, model, year_from, year_to, `condition`),
  KEY idx_price_band_lookup (make, model, year_from, year_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- vehicle_listings — the store. Field-for-field Appendix B.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_listings (
  id                      INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  stock_no                VARCHAR(24)    NOT NULL,           -- HC-PH-0001
  dealer_id               INT UNSIGNED   NOT NULL,
  status                  ENUM('draft','in_review','live','reserved','sold','expired')
                                         NOT NULL DEFAULT 'draft',
  moderated_by            INT UNSIGNED   NULL,                -- who let it live (§7.3)
  moderated_at            DATETIME       NULL,
  verification_grade      ENUM('network_listed','field_checked','certified')
                                         NOT NULL DEFAULT 'network_listed',
  grade_checklist         JSON           NULL,                -- evidence behind the grade
  grade_set_by            INT UNSIGNED   NULL,
  grade_set_at            DATETIME       NULL,

  -- Vehicle
  make                    VARCHAR(60)    NOT NULL,
  model                   VARCHAR(80)    NOT NULL,
  year                    SMALLINT       NOT NULL,
  trim                    VARCHAR(80)    NULL,
  vin                     VARBINARY(255) NULL,               -- ops-only, §10.2
  body_type               ENUM('sedan','suv','hatchback','pickup','bus','coupe','wagon','van')
                                         NOT NULL,
  transmission            ENUM('automatic','manual') NOT NULL,
  fuel_type               ENUM('petrol','diesel','hybrid','electric','cng') NOT NULL,
  engine_size             VARCHAR(20)    NULL,
  drivetrain              ENUM('fwd','rwd','awd','4wd') NULL,
  ext_colour              VARCHAR(40)    NULL,
  int_colour              VARCHAR(40)    NULL,
  `condition`             ENUM('tokunbo','nigerian_used','new') NOT NULL,
  mileage_km              INT UNSIGNED   NOT NULL,
  mileage_verified        TINYINT(1)     NOT NULL DEFAULT 0,
  features                JSON           NULL,               -- string[]

  -- Commercial
  asking_price_kobo       BIGINT         NOT NULL,
  negotiable              TINYINT(1)     NOT NULL DEFAULT 1,
  price_position          ENUM('below','within','premium','no_data') NOT NULL DEFAULT 'no_data',
  commission_terms_ref    VARCHAR(60)    NULL,

  -- Location & documents
  city                    VARCHAR(80)    NOT NULL DEFAULT 'Port Harcourt',
  area                    VARCHAR(80)    NOT NULL,
  documents               JSON           NOT NULL,           -- {customs_verified,registration,duty_sighted,tinted_permit}
  flood_check             ENUM('none','pass','suspect') NOT NULL DEFAULT 'none',
  accident_flag           ENUM('none','yes','repaired') NOT NULL DEFAULT 'none',

  -- Content
  description             TEXT           NULL,
  honest_note             TEXT           NULL,               -- required when certified (§3.5)
  inspection_report_id    INT UNSIGNED   NULL,
  inspection_summary      JSON           NULL,               -- {grade, obd2_codes, verdict, checked_on, photos[]}
  seo_slug                VARCHAR(200)   NOT NULL,

  -- Metrics (Appendix B: views / enquiries / saves)
  views                   INT UNSIGNED   NOT NULL DEFAULT 0,
  enquiries               INT UNSIGNED   NOT NULL DEFAULT 0,
  saves                   INT UNSIGNED   NOT NULL DEFAULT 0,

  -- Lifecycle — powers §6.2 sold state + §14.1 sold-archive 301 rule
  created_at              TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at            DATETIME       NULL,
  refresh_requested_at    DATETIME       NULL,   -- 14-day stale → ask the dealer to refresh
  stale_flagged_at        DATETIME       NULL,
  refreshed_at            DATETIME       NULL,   -- dealer/ops confirmed it is still current
  unlisted_at             DATETIME       NULL,   -- auto-unlisted on the second pass
  updated_at              TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at              DATETIME       NULL,
  sold_at                 DATETIME       NULL,
  archive_redirect_path   VARCHAR(200)   NULL,               -- populated at 90-day hand-off
  featured_rank           TINYINT        NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  UNIQUE KEY uq_listing_stock (stock_no),
  UNIQUE KEY uq_listing_slug (seo_slug),
  KEY idx_listing_dealer (dealer_id),
  KEY idx_listing_moderation (status, created_at),
  KEY idx_listing_stale (status, refreshed_at, updated_at),
  KEY idx_listing_browse (status, published_at),
  KEY idx_listing_facet_make (status, make, model),
  KEY idx_listing_facet_body (status, body_type, asking_price_kobo),
  KEY idx_listing_facet_price (status, asking_price_kobo),
  KEY idx_listing_sold_window (status, sold_at),
  KEY idx_listing_year (status, year),
  KEY idx_listing_mileage (status, mileage_km),
  CONSTRAINT fk_listing_dealer FOREIGN KEY (dealer_id) REFERENCES dealers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- listing_media — shot-ordered photos/video/360 (photo guide §3.4, §13.3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listing_media (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  listing_id    INT UNSIGNED  NOT NULL,
  type          ENUM('image','video','360') NOT NULL DEFAULT 'image',
  shot_label    VARCHAR(60)   NOT NULL,                      -- 'Front three-quarter'
  -- Video only (§13.2): the tap-to-load label states what the tap costs, so
  -- duration and size are stored rather than estimated at render time.
  duration_seconds SMALLINT UNSIGNED NULL,
  size_bytes       INT UNSIGNED      NULL,
  url           VARCHAR(400)  NOT NULL,
  poster_url    VARCHAR(400)  NULL,                          -- video only: the still behind the play button
  alt_text      VARCHAR(300)  NOT NULL,                      -- auto-composed (§14.2), editable
  position      TINYINT       NOT NULL DEFAULT 0,
  width         SMALLINT      NULL,
  height        SMALLINT      NULL,
  PRIMARY KEY (id),
  KEY idx_media_listing (listing_id, position),
  CONSTRAINT fk_media_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS `auth_codes` (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone        VARCHAR(40)   NOT NULL,
  code_hash    CHAR(64)      NOT NULL,
  channel      ENUM('whatsapp','sms','console') NOT NULL DEFAULT 'console',
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
  expires_at   DATETIME      NOT NULL,
  consumed_at  DATETIME      NULL,
  ip           VARCHAR(45)   NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_code_phone (phone, created_at),
  KEY idx_code_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sessions` (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  token_hash CHAR(64)      NOT NULL,
  user_id    INT UNSIGNED  NOT NULL,
  user_agent VARCHAR(200)  NULL,
  ip         VARCHAR(45)   NULL,
  expires_at DATETIME      NOT NULL,
  revoked_at DATETIME      NULL,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token (token_hash),
  KEY idx_session_user (user_id, expires_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `saved_cars` (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NOT NULL,
  listing_id       INT UNSIGNED NOT NULL,
  note             VARCHAR(200) NULL,
  -- FR-25: the price the saver last saw, so a sweep can tell a drop from a
  -- rise, and alert once per price rather than once per run.
  last_price_kobo  BIGINT       NULL,
  last_alerted_at  DATETIME     NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saved_car (user_id, listing_id),
  CONSTRAINT fk_saved_car_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_car_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `saved_searches` (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  label           VARCHAR(120) NOT NULL,
  query           TEXT         NOT NULL,
  alerts_enabled  TINYINT(1)   NOT NULL DEFAULT 1,   -- master: any alert at all
  alert_price_drop TINYINT(1)  NOT NULL DEFAULT 1,   -- §7.1 price-drop toggle
  alert_new_match  TINYINT(1)  NOT NULL DEFAULT 1,   -- §7.1 new-match toggle
  last_alerted_at DATETIME     NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_saved_search_user (user_id, created_at),
  CONSTRAINT fk_saved_search_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- facets — CURATED indexable facet pages (§14.1). Raw filter combinations are
-- never stored here and stay noindex; only hand-curated rows may be indexed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS facets (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  slug              VARCHAR(160)  NOT NULL,                  -- 'toyota' | 'toyota/camry' | 'suv-under-15m'
  page_type         ENUM('make','model','body_budget','tag','city') NOT NULL,
  parent_slug       VARCHAR(160)  NULL,
  h1                VARCHAR(200)  NOT NULL,
  title             VARCHAR(200)  NOT NULL,
  intro_copy        TEXT          NOT NULL,
  meta_title        VARCHAR(200)  NOT NULL,
  meta_description  VARCHAR(320)  NOT NULL,
  rules             JSON          NOT NULL,                  -- {make, model, body_type, max_price_kobo, min_price_kobo, condition, verification_grade}
  canonical_path    VARCHAR(200)  NOT NULL,
  indexable         TINYINT(1)    NOT NULL DEFAULT 1,
  position          SMALLINT      NOT NULL DEFAULT 0,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_facet_slug (slug),
  KEY idx_facet_indexable (indexable, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- leads — every public enquiry (§6.3 Request Viewing → admin CRM inbox)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  type          ENUM('viewing','concierge','sell_swap','hire','service','parts','b2b','deal_alert')
                                NOT NULL,
  listing_id    INT UNSIGNED  NULL,
  name          VARCHAR(120)  NOT NULL,
  phone         VARCHAR(40)   NOT NULL,
  message       TEXT          NULL,
  preferred_day DATE          NULL,
  source_path   VARCHAR(200)  NOT NULL,                      -- attribution (§11 WhatsApp source tags)
  utm           JSON          NULL,
  status        ENUM('new','assigned','contacted','viewing','closed','lost') NOT NULL DEFAULT 'new',
  assigned_to   INT UNSIGNED  NULL,                          -- CRM-lite owner (§7.3)
  assigned_at   DATETIME      NULL,
  last_contacted_at DATETIME  NULL,
  lost_reason   VARCHAR(160)  NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_leads_pipeline (status, created_at),
  KEY idx_leads_listing (listing_id),
  KEY idx_leads_assignee (assigned_to, status),
  CONSTRAINT fk_leads_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE SET NULL,
  CONSTRAINT fk_lead_assignee FOREIGN KEY (assigned_to) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- services — the 8-service suite shown on the hub + homepage grid (§6.7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(80)   NOT NULL,
  name          VARCHAR(120)  NOT NULL,
  promise       VARCHAR(240)  NOT NULL,
  icon          VARCHAR(40)   NOT NULL,
  from_price_kobo BIGINT      NULL,
  cta_label     VARCHAR(60)   NOT NULL DEFAULT 'Book',
  position      TINYINT       NOT NULL DEFAULT 0,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,

  -- §6.7 service-page template: the five content blocks below the hero.
  hero_copy     TEXT          NULL,
  deliverables  JSON          NULL,   -- [{title, copy}]  “What you get”
  included      JSON          NULL,   -- string[]         included / not included
  excluded      JSON          NULL,
  steps         JSON          NULL,   -- [{title, copy, timeline}]  “How it works”
  pricing       JSON          NULL,   -- [{tier, price_kobo, includes[]}]  price cards
  proof         JSON          NULL,   -- [{name, area, quote}]
  jobs_done     INT UNSIGNED  NOT NULL DEFAULT 0,
  booking_kind  VARCHAR(40)   NULL,   -- inspection|documents|consultation|install|request…
  sla_copy      VARCHAR(200)  NULL,   -- “Report within 4 hours of the check”

  PRIMARY KEY (id),
  UNIQUE KEY uq_services_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- testimonials — social proof with real names/areas (§6.1 module 7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS testimonials (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  customer_name VARCHAR(120) NOT NULL,
  area         VARCHAR(80)   NOT NULL,
  quote        TEXT          NOT NULL,
  service_tag  VARCHAR(60)   NULL,
  rating       TINYINT       NOT NULL DEFAULT 5,
  position     TINYINT       NOT NULL DEFAULT 0,
  is_published TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- blog_authors · blog_tags · blog_post_tags — FR-35
--
-- §6.9 asks for an author card (“name, role, short bio — E-E-A-T”) and for
-- “tags governed”, a fixed taxonomy. The author is an entity so it can have a
-- page (/blog/author/{slug}) and one bio; the post keeps its byline columns as
-- the CMS writes them, with author_id as the link.
--
-- Tags are a governed list, separate from `blog_posts.make_tags`: make_tags
-- pulls live listings (“Cars mentioned in this article”), tags are what a post
-- is *about* (/blog/tag/{slug}).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blog_authors (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(80)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  role       VARCHAR(120) NOT NULL,
  bio        VARCHAR(300) NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_author_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blog_tags (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug        VARCHAR(80)  NOT NULL,
  label       VARCHAR(80)  NOT NULL,
  kind        ENUM('topic','make','format') NOT NULL DEFAULT 'topic',
  description VARCHAR(200) NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tag_slug (slug),
  KEY idx_tag_kind (kind, label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------------
-- blog_posts — "Home of the Honest Buyer's Guide" (§6.9)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blog_posts (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  slug           VARCHAR(200)  NOT NULL,
  title          VARCHAR(240)  NOT NULL,
  category       ENUM('honest_buyers_guide','ownership_maintenance','market_intel','company_news','video')
                                NOT NULL,
  excerpt        VARCHAR(400)  NOT NULL,
  hero_image     VARCHAR(400)  NOT NULL,
  hero_alt       VARCHAR(300)  NOT NULL,
  author_name    VARCHAR(120)  NOT NULL,
  author_role    VARCHAR(120)  NOT NULL,
  read_minutes   TINYINT       NOT NULL DEFAULT 6,
  status         ENUM('draft','in_review','scheduled','published') NOT NULL DEFAULT 'draft',
  published_at   DATETIME      NULL,
  is_featured    TINYINT(1)    NOT NULL DEFAULT 0,
  make_tags      JSON          NULL,                          -- auto-pulls live listings (§6.9)
  body           JSON          NULL,                          -- block list: paragraph|heading|callout|checklist|table|quote|youtube|listing
  service_cta    VARCHAR(80)   NULL,                          -- contextual service footer (§6.9)
  author_bio     VARCHAR(300)  NULL,                          -- E-E-A-T author card
  author_id      INT UNSIGNED  NULL,                          -- FR-35 author page (/blog/author/{slug})
  meta_title     VARCHAR(200)  NULL,                          -- §14.3 search-result title
  meta_description VARCHAR(320) NULL,                          -- §14.3 search-result description
  review_note    VARCHAR(300)  NULL,                          -- why it was sent back to draft
  published_by   INT UNSIGNED  NULL,
  updated_by     INT UNSIGNED  NULL,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_blog_slug (slug),
  KEY idx_blog_publish (status, published_at),
  KEY idx_blog_author (author_id, status, published_at),
  CONSTRAINT fk_blog_author        FOREIGN KEY (author_id)     REFERENCES blog_authors (id) ON DELETE SET NULL,
  CONSTRAINT fk_blog_published_by FOREIGN KEY (published_by) REFERENCES `users` (id) ON DELETE SET NULL,
  CONSTRAINT fk_blog_updated_by   FOREIGN KEY (updated_by)   REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blog_post_tags (
  post_id INT UNSIGNED NOT NULL,
  tag_id  INT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  KEY idx_post_tag_tag (tag_id),
  CONSTRAINT fk_post_tag_post FOREIGN KEY (post_id) REFERENCES blog_posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_post_tag_tag  FOREIGN KEY (tag_id)  REFERENCES blog_tags  (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- faqs — grouped FAQ content; drives FAQPage schema (§12.4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faqs (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  scope       VARCHAR(80)   NOT NULL DEFAULT 'global',       -- 'global' | 'facet:toyota' | 'vdp'
  question    VARCHAR(300)  NOT NULL,
  answer      TEXT          NOT NULL,
  position    TINYINT       NOT NULL DEFAULT 0,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_faq_scope (scope, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- analytics_events — server-side mirror of the §15.1 event plan (verbatim
-- snake_case names). Client batches POST /api/events; purchases/payments are
-- recorded server-side only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_name  VARCHAR(80)     NOT NULL,
  payload     JSON            NULL,
  source_path VARCHAR(200)    NULL,
  session_id  VARCHAR(64)     NULL,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_events_name (event_name, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Redirects — 301 map used by the sold-archive hand-off (§14.1) and any
-- legacy URL. Resolved before routing so it stays edge-cacheable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS redirects (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  from_path   VARCHAR(200)  NOT NULL,
  to_path     VARCHAR(200)  NOT NULL,
  status_code SMALLINT      NOT NULL DEFAULT 301,
  reason      VARCHAR(120)  NOT NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_redirect_from (from_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- static_pages — build bookkeeping for the hybrid renderer (§12.4): which
-- stable pages were generated to disk, from which view, and how big they are.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS static_pages (
  path          VARCHAR(200)  NOT NULL,
  view          VARCHAR(120)  NOT NULL,
  content_hash  CHAR(40)      NOT NULL,
  bytes         INT UNSIGNED  NOT NULL,
  rendered_at   DATETIME      NOT NULL,
  status        ENUM('ok','stale') NOT NULL DEFAULT 'ok',
  PRIMARY KEY (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- pages — CMS-editable static pages: company, trust and legal copy (§6.10).
-- Legal wording is supplied by the client's counsel; these rows are the
-- editable envelope around it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pages (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  slug              VARCHAR(120)  NOT NULL,               -- 'about' | 'privacy' | …
  title             VARCHAR(200)  NOT NULL,
  h1                VARCHAR(200)  NOT NULL,
  hero_copy         TEXT          NULL,
  meta_title        VARCHAR(200)  NOT NULL,
  meta_description  VARCHAR(320)  NOT NULL,
  body              JSON          NULL,                   -- same block list as blog bodies
  indexable         TINYINT(1)    NOT NULL DEFAULT 1,
  legal_review      TINYINT(1)    NOT NULL DEFAULT 0,     -- 1 = placeholder awaiting counsel
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pages_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- hire_classes — the vehicle classes quoted on /hire (§6.7: “vehicle class…
-- quote workflow; corporate RFQ variant”).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hire_classes (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  slug             VARCHAR(60)   NOT NULL,
  name             VARCHAR(120)  NOT NULL,
  seats            TINYINT       NOT NULL,
  examples         VARCHAR(200)  NOT NULL,
  image            VARCHAR(200)  NULL,                     -- /img/hire/{slug}.jpg
  daily_rate_kobo  BIGINT        NOT NULL,
  weekly_rate_kobo BIGINT        NULL,
  with_driver_kobo BIGINT        NULL,     -- per day, on top of the class rate
  airport_pickup   TINYINT(1)    NOT NULL DEFAULT 1,
  corporate        TINYINT(1)    NOT NULL DEFAULT 0,
  position         TINYINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hire_class_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- products + orders — the shop (§6.8). Categories are fixed: trackers &
-- security, OBD2 & diagnostics, care kits. Parts are service-led and route to
-- /services/parts, never to self-checkout.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  slug             VARCHAR(120)  NOT NULL,
  category         ENUM('trackers','diagnostics','care_kits') NOT NULL,
  name             VARCHAR(160)  NOT NULL,
  summary          VARCHAR(300)  NOT NULL,
  description      TEXT          NULL,
  price_kobo       BIGINT        NOT NULL,
  specs            JSON          NULL,
  install_included TINYINT(1)    NOT NULL DEFAULT 0,   -- tracker install = booking at checkout
  warranty_text    VARCHAR(200)  NULL,
  stock_status     ENUM('in_stock','low_stock','out_of_stock') NOT NULL DEFAULT 'in_stock',
  delivery_options JSON          NULL,                 -- ['pickup_meet_point','ph_delivery']
  image            VARCHAR(400)  NULL,
  position         TINYINT       NOT NULL DEFAULT 0,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_slug (slug),
  KEY idx_products_category (category, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_no          VARCHAR(24)   NOT NULL,             -- HC-ORD-0001
  name              VARCHAR(120)  NOT NULL,
  phone             VARCHAR(40)   NOT NULL,
  delivery_area     VARCHAR(80)   NOT NULL,
  delivery_fee_kobo BIGINT        NOT NULL DEFAULT 0,
  subtotal_kobo     BIGINT        NOT NULL,
  total_kobo        BIGINT        NOT NULL,
  status            ENUM('pending_payment','paid','processing','fulfilled','cancelled')
                                  NOT NULL DEFAULT 'pending_payment',
  payment_ref       VARCHAR(80)   NULL,                 -- PSP reference (§11)
  notes             VARCHAR(400)  NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_no (order_no),
  KEY idx_order_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  order_id         INT UNSIGNED  NOT NULL,
  product_id       INT UNSIGNED  NULL,
  name             VARCHAR(160)  NOT NULL,
  qty              SMALLINT      NOT NULL DEFAULT 1,
  unit_price_kobo  BIGINT        NOT NULL,
  install_requested TINYINT(1)   NOT NULL DEFAULT 0,    -- creates the install booking
  PRIMARY KEY (id),
  KEY idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- delivery_areas + subscriptions — §6.8 delivery-fee rules by area, and the
-- subscription record a tracker SKU creates at checkout (activation checklist
-- lives in the admin order manager, §7.3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_areas (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)  NOT NULL,
  fee_kobo    BIGINT       NOT NULL DEFAULT 0,
  note        VARCHAR(160) NULL,
  position    TINYINT      NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_area (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- kind / dealer_id / unit_label / plan_name / amount_kobo / period_months are
-- migration 019 (FR-20): a tracker row and a dealer retainer share the table so
-- one renewal queue and one reminder sweep serve both (§7.3).
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind           ENUM('tracker','dealer_retainer','intelligence') NOT NULL DEFAULT 'tracker',
  order_id       INT UNSIGNED NULL,
  dealer_id      INT UNSIGNED NULL,
  product_id     INT UNSIGNED NULL,
  customer_name  VARCHAR(120) NULL,
  customer_phone VARCHAR(40)  NULL,
  unit_label     VARCHAR(80)  NULL,
  plan_name      VARCHAR(80)  NULL,
  amount_kobo    BIGINT       NULL,
  device_state   ENUM('ordered','installed','activated','renewal_due','lapsed','cancelled')
                               NOT NULL DEFAULT 'ordered',
  installed_at   DATETIME     NULL,
  activated_at   DATETIME     NULL,
  renewal_at     DATETIME     NULL,
  period_months  TINYINT      NOT NULL DEFAULT 12,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_subscription_renewal (device_state, renewal_at),
  KEY idx_subscription_kind (kind, device_state, renewal_at),
  CONSTRAINT fk_subscription_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_subscription_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL,
  CONSTRAINT fk_subscription_dealer FOREIGN KEY (dealer_id) REFERENCES dealers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (subscription, window) — the unique key is what makes the
-- 30/7/1-day sweep safe to run every morning (§7.3, FR-20).
CREATE TABLE IF NOT EXISTS subscription_reminders (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_id INT UNSIGNED NOT NULL,
  window_days     SMALLINT     NOT NULL,
  sent_at         DATETIME     NOT NULL,
  notification_id INT UNSIGNED NULL,
  channel         VARCHAR(24)  NULL,
  status          VARCHAR(24)  NOT NULL DEFAULT 'sent',
  detail          VARCHAR(200) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_reminder_window (subscription_id, window_days),
  KEY idx_reminder_sent (sent_at),
  CONSTRAINT fk_reminder_subscription FOREIGN KEY (subscription_id)
    REFERENCES subscriptions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- service_requests — §10.1: “User has many ServiceRequest (types: concierge,
-- sell, swap, documents, research, parts, consultation)”. One table, a JSON
-- brief, and a tracking id that the customer can watch at /concierge/{id}.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_requests (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  tracking_id   VARCHAR(16)   NOT NULL,                 -- HC-2481
  type          ENUM('concierge','sell','swap','documents','research','parts','consultation','tracking','hire')
                              NOT NULL,
  status        ENUM('new','searching','options_ready','viewings','closed','lost')
                              NOT NULL DEFAULT 'new',
  name          VARCHAR(120)  NOT NULL,
  phone         VARCHAR(40)   NOT NULL,
  brief         JSON          NULL,                     -- step answers, must-haves, timeline…
  listing_id    INT UNSIGNED  NULL,                     -- parts/documents requests may point at a car
  sla_due_at    DATETIME      NULL,                     -- 48–72h for concierge (§6.5)
  source_path   VARCHAR(200)  NOT NULL,
  notes         VARCHAR(500)  NULL,
  assigned_to   INT UNSIGNED  NULL,                     -- CRM owner (§7.3)
  assigned_at   DATETIME      NULL,
  last_contacted_at DATETIME  NULL,
  lost_reason   VARCHAR(160)  NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_request_tracking (tracking_id),
  KEY idx_request_pipeline (type, status, created_at),
  KEY idx_request_assignee (assigned_to, status),
  CONSTRAINT fk_request_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE SET NULL,
  CONSTRAINT fk_request_assignee FOREIGN KEY (assigned_to) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- hire_vehicles / hire_bookings / hire_incidents — FR-22, §7.3 “Hire Management
-- (vehicle pool registry, availability calendar, booking records, incident log)”.
-- Migration 020. Kept out of `bookings` on purpose: an inspection booking is a
-- job for an inspector on a slot; a hire is a vehicle occupied over a range of
-- days.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hire_vehicles (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  plate            VARCHAR(20)  NOT NULL,
  class_slug       VARCHAR(40)  NOT NULL,
  make             VARCHAR(40)  NULL,
  model            VARCHAR(60)  NULL,
  year             SMALLINT     NULL,
  colour           VARCHAR(30)  NULL,
  seats            TINYINT      NULL,
  owner            ENUM('honestcars','partner') NOT NULL DEFAULT 'honestcars',
  partner_name     VARCHAR(120) NULL,
  driver_available TINYINT(1)   NOT NULL DEFAULT 1,
  documents_state  ENUM('current','expiring','missing') NOT NULL DEFAULT 'missing',
  documents_due    DATE         NULL,
  tracker_state    ENUM('fitted','on_order','none') NOT NULL DEFAULT 'none',
  status           ENUM('available','on_hire','service','retired') NOT NULL DEFAULT 'available',
  location         VARCHAR(80)  NULL,
  notes            VARCHAR(300) NULL,
  image            VARCHAR(300) NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hire_vehicle_plate (plate),
  KEY idx_hire_vehicle_class (class_slug, status),
  KEY idx_hire_vehicle_docs (documents_state, documents_due)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hire_bookings (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference      VARCHAR(24)  NOT NULL,
  request_id     INT UNSIGNED NULL,
  vehicle_id     INT UNSIGNED NULL,
  class_slug     VARCHAR(40)  NOT NULL,
  client_name    VARCHAR(120) NOT NULL,
  client_phone   VARCHAR(40)  NOT NULL,
  company        VARCHAR(120) NULL,
  phone2         VARCHAR(40)  NULL,
  pickup_at      DATE         NOT NULL,
  dropoff_at     DATE         NOT NULL,
  pickup_point   VARCHAR(80)  NULL,
  dropoff_point  VARCHAR(80)  NULL,
  days           SMALLINT     NOT NULL DEFAULT 1,
  with_driver    TINYINT(1)   NOT NULL DEFAULT 0,
  driver_name    VARCHAR(80)  NULL,
  airport_pickup TINYINT(1)   NOT NULL DEFAULT 0,
  day_rate_kobo  BIGINT       NOT NULL DEFAULT 0,
  driver_kobo    BIGINT       NOT NULL DEFAULT 0,
  extras_kobo    BIGINT       NOT NULL DEFAULT 0,
  deposit_kobo   BIGINT       NOT NULL DEFAULT 0,
  total_kobo     BIGINT       NOT NULL DEFAULT 0,
  currency       CHAR(3)      NOT NULL DEFAULT 'NGN',
  status         ENUM('requested','quoted','accepted','confirmed','on_hire','completed','cancelled')
                              NOT NULL DEFAULT 'requested',
  quote_sent_at  DATETIME     NULL,
  accepted_at    DATETIME     NULL,
  completed_at   DATETIME     NULL,
  cancelled_at   DATETIME     NULL,
  cancel_reason  VARCHAR(200) NULL,
  notes          VARCHAR(400) NULL,
  fuel_out       TINYINT      NULL,
  fuel_in        TINYINT      NULL,
  odometer_out   INT UNSIGNED NULL,
  odometer_in    INT UNSIGNED NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hire_reference (reference),
  KEY idx_hire_booking_dates (pickup_at, dropoff_at),
  KEY idx_hire_booking_status (status, pickup_at),
  KEY idx_hire_booking_phone (client_phone, created_at),
  KEY idx_hire_booking_vehicle (vehicle_id, pickup_at),
  CONSTRAINT fk_hire_booking_request FOREIGN KEY (request_id) REFERENCES service_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_hire_booking_vehicle FOREIGN KEY (vehicle_id) REFERENCES hire_vehicles (id) ON DELETE SET NULL,
  CONSTRAINT fk_hire_booking_actor FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



-- ---------------------------------------------------------------------------
-- bookings — inspections, installs and consultations (§6.7, §7.3 dispatch).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  reference      VARCHAR(24)   NOT NULL,                -- HC-BK-0001
  type           ENUM('inspection','install','consultation','media_shoot') NOT NULL,
  service_slug   VARCHAR(80)   NULL,
  slot_at        DATETIME      NULL,
  location       VARCHAR(200)  NULL,
  vehicle        JSON          NULL,                    -- {make, model, year, vin, mileage_km}
  addons         JSON          NULL,
  name           VARCHAR(120)  NOT NULL,
  phone          VARCHAR(40)   NOT NULL,
  amount_kobo    BIGINT        NULL,
  payment_status ENUM('unpaid','pending','paid','refunded') NOT NULL DEFAULT 'unpaid',
  status         ENUM('requested','confirmed','dispatched','completed','cancelled')
                                NOT NULL DEFAULT 'requested',
  request_id     INT UNSIGNED  NULL,
  inspector_id   INT UNSIGNED  NULL,                    -- assigned by dispatch (§7.3)
  dispatched_at  DATETIME      NULL,
  completed_at   DATETIME      NULL,
  checklist      JSON          NULL,                    -- {obd2_codes, sections{}, photos[]}
  verdict        ENUM('pass','pass_with_advisory','fail') NULL,
  report_notes   TEXT          NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_booking_reference (reference),
  KEY idx_booking_dispatch (status, slot_at),
  KEY idx_booking_inspector (inspector_id, slot_at),
  CONSTRAINT fk_booking_request FOREIGN KEY (request_id) REFERENCES service_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_booking_inspector FOREIGN KEY (inspector_id) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- payments + payment_events + payment_milestones + notifications — money and
-- messages (§7.3 “Orders & Payments”, §10.1, §11, FR-08). Payments are
-- polymorphic (order / booking / retainer / subscription / milestone) and
-- never hold card data; (provider, event_id) is the webhook idempotency key.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- dealer_addons · dealer_purchases — FR-18, §7.2 “pay for add-on services
-- (media shoot, featured placement, intelligence subscription)”
--
-- A purchase is a thing with a life: raised unpaid → paid → in effect →
-- expired. `effect` is what the purchase does when the money lands, applied in
-- the same transaction that marks the payment paid.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dealer_addons (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(60)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  tagline       VARCHAR(160) NOT NULL,
  description   VARCHAR(600) NULL,
  price_kobo    BIGINT       NOT NULL,
  `interval`    ENUM('one_off','monthly') NOT NULL DEFAULT 'one_off',   -- reserved word, hence the quotes
  effect        ENUM('media_shoot','featured_placement','intelligence') NOT NULL,
  -- NULL duration = the benefit runs until it is cancelled
  duration_days SMALLINT     NULL,
  needs_listing TINYINT(1)   NOT NULL DEFAULT 0,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  position      TINYINT      NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_addon_slug (slug),
  KEY idx_addon_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dealer_purchases (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference  VARCHAR(24)  NOT NULL,
  dealer_id  INT UNSIGNED NOT NULL,
  addon_id   INT UNSIGNED NOT NULL,
  listing_id INT UNSIGNED NULL,
  payment_id INT UNSIGNED NULL,
  amount_kobo BIGINT      NOT NULL,
  status     ENUM('pending','active','expired','cancelled') NOT NULL DEFAULT 'pending',
  starts_at  DATETIME     NULL,
  ends_at    DATETIME     NULL,
  detail     VARCHAR(200) NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_reference (reference),
  KEY idx_purchase_dealer (dealer_id, status, created_at),
  KEY idx_purchase_addon (addon_id),
  KEY idx_purchase_listing (listing_id),
  KEY idx_purchase_expiry (status, ends_at),
  CONSTRAINT fk_purchase_dealer  FOREIGN KEY (dealer_id)  REFERENCES dealers (id) ON DELETE CASCADE,
  CONSTRAINT fk_purchase_addon   FOREIGN KEY (addon_id)   REFERENCES dealer_addons (id),
  CONSTRAINT fk_purchase_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE SET NULL,
  CONSTRAINT fk_purchase_actor   FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `payments` (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference      VARCHAR(32)  NOT NULL,              -- HC-PAY-000123
  provider       ENUM('manual','paystack','flutterwave','bank_transfer','cash')
                              NOT NULL DEFAULT 'manual',
  provider_ref   VARCHAR(80)  NULL,                  -- PSP transaction reference
  purpose        ENUM('order','booking','retainer','subscription','milestone','other','hire','addon')
                              NOT NULL DEFAULT 'other',
  order_id       INT UNSIGNED NULL,
  booking_id     INT UNSIGNED NULL,
  request_id     INT UNSIGNED NULL,
  subscription_id INT UNSIGNED NULL,                    -- a renewal extends this (FR-20)
  hire_booking_id INT UNSIGNED NULL,                    -- paying this confirms a hire (FR-22)
  dealer_purchase_id INT UNSIGNED NULL,                 -- paying this delivers an add-on (FR-18)
  customer_name  VARCHAR(120) NULL,
  customer_phone VARCHAR(40)  NULL,
  amount_kobo    BIGINT       NOT NULL,
  currency       CHAR(3)      NOT NULL DEFAULT 'NGN',
  status         ENUM('pending','paid','failed','abandoned','refunded','partially_refunded')
                              NOT NULL DEFAULT 'pending',
  checkout_url   VARCHAR(400) NULL,                  -- PSP-hosted page — we never see the card
  paid_at        DATETIME     NULL,
  refunded_at    DATETIME     NULL,
  refund_kobo    BIGINT       NOT NULL DEFAULT 0,
  refund_reason  VARCHAR(200) NULL,
  raw            JSON         NULL,                  -- last provider payload (no card data)
  created_by     INT UNSIGNED NULL,                  -- staff member for manual entries
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_reference (reference),
  KEY idx_payment_status (status, created_at),
  KEY idx_payment_order (order_id),
  KEY idx_payment_booking (booking_id),
  KEY idx_payment_phone (customer_phone, created_at),
  KEY idx_payment_subscription (subscription_id),
  KEY idx_payment_hire (hire_booking_id),
  KEY idx_payment_dealer_purchase (dealer_purchase_id),
  CONSTRAINT fk_payment_order   FOREIGN KEY (order_id)   REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_request FOREIGN KEY (request_id) REFERENCES service_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_dealer_purchase FOREIGN KEY (dealer_purchase_id) REFERENCES dealer_purchases (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_hire FOREIGN KEY (hire_booking_id) REFERENCES hire_bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_actor   FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- hire_incidents — FR-22, §7.3 “incident log”. Below `payments` because an
-- incident can charge a payment (`payment_id`), and below `hire_bookings`
-- because it belongs to one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hire_incidents (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id     INT UNSIGNED NULL,
  vehicle_id     INT UNSIGNED NULL,
  kind           ENUM('damage','late_return','fine','breakdown','fuel','theft','other') NOT NULL DEFAULT 'other',
  severity       ENUM('minor','major','write_off') NOT NULL DEFAULT 'minor',
  detail         VARCHAR(500) NOT NULL,
  cost_kobo      BIGINT       NOT NULL DEFAULT 0,
  charged_kobo   BIGINT       NOT NULL DEFAULT 0,
  status         ENUM('open','resolved','written_off') NOT NULL DEFAULT 'open',
  occurred_at    DATETIME     NULL,
  resolved_at    DATETIME     NULL,
  resolution     VARCHAR(400) NULL,
  payment_id     INT UNSIGNED NULL,
  reported_by    INT UNSIGNED NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incident_booking (booking_id),
  KEY idx_incident_status (status, created_at),
  CONSTRAINT fk_incident_booking FOREIGN KEY (booking_id) REFERENCES hire_bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_vehicle FOREIGN KEY (vehicle_id) REFERENCES hire_vehicles (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_actor FOREIGN KEY (reported_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Every webhook and every manual state change, with the signature verdict.
-- (provider, event_id) is unique: that is the idempotency key.
CREATE TABLE IF NOT EXISTS `payment_events` (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id   INT UNSIGNED NULL,
  provider     ENUM('manual','paystack','flutterwave','bank_transfer','cash')
                            NOT NULL DEFAULT 'manual',
  event_id     VARCHAR(120) NOT NULL,               -- provider event id, or a hash for manual writes
  type         VARCHAR(60)  NOT NULL,               -- charge.success, refund.processed, manual.paid…
  signature_ok TINYINT(1)   NULL,                   -- NULL for events we generated ourselves
  payload      JSON         NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_event (provider, event_id),
  KEY idx_payment_event_payment (payment_id, created_at),
  CONSTRAINT fk_event_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- §7.3: “milestone tracker for protected purchases & parts escrow (stage: funds
-- received → inspection pass → documents verified → released — manual approvals
-- with audit log)”. The four public stages are exactly those; `cancelled` is the
-- way out when a deal dies before release.
CREATE TABLE IF NOT EXISTS `payment_milestones` (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference     VARCHAR(32)  NOT NULL,              -- HC-ML-0001
  kind          ENUM('protected_purchase','parts_escrow') NOT NULL DEFAULT 'protected_purchase',
  subject       VARCHAR(200) NOT NULL,              -- what the money is protecting
  listing_id    INT UNSIGNED NULL,
  booking_id    INT UNSIGNED NULL,                  -- the inspection that clears stage 2
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(40) NOT NULL,
  amount_kobo   BIGINT       NOT NULL,
  stage         ENUM('funds_received','inspection_passed','documents_verified','released','cancelled')
                             NOT NULL DEFAULT 'funds_received',
  stage_note    VARCHAR(200) NULL,
  released_by   INT UNSIGNED NULL,
  released_at   DATETIME     NULL,
  created_by    INT UNSIGNED NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_milestone_reference (reference),
  KEY idx_milestone_stage (stage, created_at),
  CONSTRAINT fk_milestone_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE SET NULL,
  CONSTRAINT fk_milestone_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_milestone_releaser FOREIGN KEY (released_by) REFERENCES `users` (id) ON DELETE SET NULL,
  CONSTRAINT fk_milestone_actor FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- §11 notifications. Delivery is a seam (console in development, WhatsApp/SMS/
-- email when the provider is wired); what is recorded here is the message, the
-- recipient and whether it went, so ops can see what the customer was told.
CREATE TABLE IF NOT EXISTS `notifications` (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel      ENUM('whatsapp','sms','email','console') NOT NULL DEFAULT 'console',
  template     VARCHAR(60)  NOT NULL,               -- payment_receipt, booking_dispatched…
  recipient    VARCHAR(160) NOT NULL,               -- masked number is NOT stored — ops needs the real one to send
  subject      VARCHAR(160) NULL,
  body         TEXT         NOT NULL,
  status       ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
  provider_ref VARCHAR(120) NULL,
  error        VARCHAR(300) NULL,
  entity       VARCHAR(40)  NULL,
  entity_id    INT UNSIGNED NULL,
  created_by   INT UNSIGNED NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at      DATETIME     NULL,
  PRIMARY KEY (id),
  KEY idx_notification_entity (entity, entity_id, created_at),
  KEY idx_notification_status (status, created_at),
  CONSTRAINT fk_notification_actor FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- dealer_ledger — append-only commission and payout ledger per dealer (012).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dealer_ledger (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  dealer_id   INT UNSIGNED NOT NULL,
  listing_id  INT UNSIGNED NULL,
  payment_id  INT UNSIGNED NULL,
  entry_type  ENUM('sale_commission','payout','adjustment','clawback') NOT NULL,
  amount_kobo BIGINT       NOT NULL,                   -- signed, see header
  currency    CHAR(3)      NOT NULL DEFAULT 'NGN',
  reference   VARCHAR(40)  NULL,                       -- statement or payout ref
  detail      VARCHAR(200) NULL,
  created_by  INT UNSIGNED NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ledger_dealer (dealer_id, created_at),
  KEY idx_ledger_type (entry_type, created_at),
  KEY idx_ledger_listing (listing_id),
  CONSTRAINT fk_ledger_dealer  FOREIGN KEY (dealer_id)  REFERENCES dealers (id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE SET NULL,
  CONSTRAINT fk_ledger_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE SET NULL,
  CONSTRAINT fk_ledger_actor   FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- service_cities · service_areas — FR-32: the markets we cover, and the
-- neighbourhoods inside them. "city / area enum/str ✓ Default Port Harcourt;
-- area list admin-managed" (§ data model). Listings keep their own city/area
-- text; these tables are what the site offers, sorts and counts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `service_cities` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(60)  NOT NULL,
  name       VARCHAR(80)  NOT NULL,
  state      VARCHAR(60)  NOT NULL,
  stock_prefix VARCHAR(8) NOT NULL DEFAULT 'HC-PH',
  blurb      VARCHAR(200) NULL,
  position   TINYINT      NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_city_slug (slug),
  KEY idx_city_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- referral_rewards — FR-28: the reward status behind a referral (§7.1)
--
-- One row per referred account. `status` is the whole story — pending →
-- approved → paid, or void when the desk says it does not count — and
-- `amount_kobo` is entered by a human, because the PRD sets no amount: a reward
-- is a campaign decision. The unique key means a person is counted once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `referral_rewards` (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  referrer_id      INT UNSIGNED NOT NULL,
  referred_user_id INT UNSIGNED NOT NULL,
  status           ENUM('pending','approved','paid','void') NOT NULL DEFAULT 'pending',
  basis            ENUM('signup','order') NOT NULL DEFAULT 'order',
  amount_kobo      BIGINT       NOT NULL DEFAULT 0,
  unit_label       VARCHAR(120) NULL,
  note             VARCHAR(200) NULL,
  approved_at      DATETIME     NULL,
  paid_at          DATETIME     NULL,
  actor_id         INT UNSIGNED NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referral_pair (referrer_id, referred_user_id),
  KEY idx_referral_status (status, created_at),
  KEY idx_referral_referrer (referrer_id, status),
  CONSTRAINT fk_referral_referrer FOREIGN KEY (referrer_id)      REFERENCES `users` (id) ON DELETE CASCADE,
  CONSTRAINT fk_referral_referred FOREIGN KEY (referred_user_id) REFERENCES `users` (id) ON DELETE CASCADE,
  CONSTRAINT fk_referral_actor    FOREIGN KEY (actor_id)         REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `service_areas` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  city_id    INT UNSIGNED NOT NULL,
  name       VARCHAR(80)  NOT NULL,
  position   SMALLINT     NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_area_city_name (city_id, name),
  KEY idx_area_city (city_id, is_active, position),
  CONSTRAINT fk_area_city FOREIGN KEY (city_id) REFERENCES service_cities (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- dealer_api_keys — FR-33: the credential a lot's own tooling imports with
--
-- Only the SHA-256 hash is stored; `prefix` is the twelve clear characters the
-- console shows so a key can be identified without being usable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `dealer_api_keys` (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  dealer_id     INT UNSIGNED NOT NULL,
  label         VARCHAR(80)  NOT NULL,
  `prefix`      VARCHAR(16)  NOT NULL,
  hash          CHAR(64)     NOT NULL,
  last_used_at  DATETIME     NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  revoked_at    DATETIME     NULL,
  revoked_by    INT UNSIGNED NULL,
  created_by    INT UNSIGNED NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_key_hash (hash),
  KEY idx_api_key_dealer (dealer_id, revoked_at),
  CONSTRAINT fk_api_key_dealer  FOREIGN KEY (dealer_id)  REFERENCES dealers (id) ON DELETE CASCADE,
  CONSTRAINT fk_api_key_actor   FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL,
  CONSTRAINT fk_api_key_revoker FOREIGN KEY (revoked_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- CMS workflow (013): content_revisions + homepage_modules
-- (the blog_posts columns from 013 are merged into its CREATE above)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Convenience views
--   v_live_listings  : everything /cars shows — live + reserved + sold ≤ 7 days
--   v_archived_sold  : sold 7→90 days — the SEO sold-archive window
--   v_expired_sold   : sold > 90 days — must 301 to the listing's facet
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_live_listings AS
SELECT l.*, d.name AS dealer_name, d.lot_area AS dealer_area, d.verified AS dealer_verified
FROM vehicle_listings l
JOIN dealers d ON d.id = l.dealer_id
WHERE
  (l.status IN ('live','reserved') AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP()))
  OR (l.status = 'sold' AND l.sold_at IS NOT NULL AND l.sold_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY));

CREATE OR REPLACE VIEW v_archived_sold AS
SELECT l.*, d.name AS dealer_name
FROM vehicle_listings l
JOIN dealers d ON d.id = l.dealer_id
WHERE l.status = 'sold'
  AND l.sold_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)
  AND l.sold_at >  DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY);

CREATE OR REPLACE VIEW v_expired_sold AS
SELECT l.id, l.stock_no, l.seo_slug, l.make, l.model, l.sold_at, l.archive_redirect_path
FROM vehicle_listings l
WHERE l.status = 'sold'
  AND l.sold_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY);

-- ---------------------------------------------------------------------------
-- request_candidates — cars ops attached to a concierge request (§7.3 pipeline;
-- the buyer's comparison is rendered from exactly these rows).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_candidates (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  listing_id INT UNSIGNED NOT NULL,
  note       VARCHAR(200) NULL,
  rank_no    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  added_by   INT UNSIGNED NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_candidate (request_id, listing_id),
  KEY idx_candidate_request (request_id, rank_no),
  CONSTRAINT fk_candidate_request FOREIGN KEY (request_id) REFERENCES service_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_candidate_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE CASCADE,
  CONSTRAINT fk_candidate_actor   FOREIGN KEY (added_by)   REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- marketing_spend — §15.2: what the advertising cost, per channel and period.
-- Filled in by hand (an invoice arrives from Meta/Google), divided by the
-- conversions the site can attribute to get a cost per acquisition.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_spend (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel      VARCHAR(80)  NOT NULL,
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  amount_kobo  BIGINT       NOT NULL,
  note         VARCHAR(200) NULL,
  created_by   INT UNSIGNED NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_spend_channel (channel, period_start),
  KEY idx_spend_window (period_start, period_end),
  CONSTRAINT fk_spend_actor FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- admin_audit — sensitive actions, with the actor (§7.3 “audit log of sensitive
-- actions (price overrides, payment releases, grade changes)”).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id   INT UNSIGNED NULL,
  action     VARCHAR(60)  NOT NULL,
  entity     VARCHAR(40)  NOT NULL,
  entity_id  INT UNSIGNED NULL,
  detail     JSON         NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity, entity_id, created_at),
  KEY idx_audit_actor (actor_id, created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
