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
  agreement_signed  DATE             NULL,
  created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dealers_slug (slug)
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
  url           VARCHAR(400)  NOT NULL,
  alt_text      VARCHAR(300)  NOT NULL,                      -- auto-composed (§14.2), editable
  position      TINYINT       NOT NULL DEFAULT 0,
  width         SMALLINT      NULL,
  height        SMALLINT      NULL,
  PRIMARY KEY (id),
  KEY idx_media_listing (listing_id, position),
  CONSTRAINT fk_media_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  listing_id INT UNSIGNED NOT NULL,
  note       VARCHAR(200) NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  page_type         ENUM('make','model','body_budget','tag') NOT NULL,
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
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_blog_slug (slug),
  KEY idx_blog_publish (status, published_at)
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

CREATE TABLE IF NOT EXISTS subscriptions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id       INT UNSIGNED NULL,
  product_id     INT UNSIGNED NULL,
  customer_name  VARCHAR(120) NULL,
  customer_phone VARCHAR(40)  NULL,
  device_state   ENUM('ordered','installed','activated','renewal_due','lapsed','cancelled')
                               NOT NULL DEFAULT 'ordered',
  installed_at   DATETIME     NULL,
  activated_at   DATETIME     NULL,
  renewal_at     DATETIME     NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_subscription_renewal (device_state, renewal_at),
  CONSTRAINT fk_subscription_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_subscription_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
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
-- bookings — inspections, installs and consultations (§6.7, §7.3 dispatch).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  reference      VARCHAR(24)   NOT NULL,                -- HC-BK-0001
  type           ENUM('inspection','install','consultation') NOT NULL,
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
