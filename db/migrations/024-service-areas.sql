-- ---------------------------------------------------------------------------
-- 024 — FR-32: multi-city inventory, and the governed area list
--
-- FR-32 is "Multi-city inventory structure (Owerri/Aba/Benin) with area
-- switcher", COULD/P3. The PRD's data model is explicit about the shape:
--
--   "city / area enum/str ✓ Default Port Harcourt; area list admin-managed"
--
-- So the two things this migration adds are the *lists*: which cities we serve,
-- and which areas exist inside each. Until now `vehicle_listings.area` was free
-- text with the seed's 14 Port Harcourt neighbourhoods baked into
-- `scripts/generate-seed.js` — findable, but not something ops could change
-- without a deploy. Areas move into a table, and the listings keep pointing at
-- them by name (a listing's `area` is what the dealer typed; the table is what
-- the site offers, sorts and counts).
--
--   service_cities  the market we cover: name, slug (for /cars/{slug}), state,
--                   and the order the switcher lists them in.
--   service_areas   the neighbourhoods inside a city. `is_active = 0` retires
--                   one without deleting the history that references it.
--
-- Nothing here writes to `vehicle_listings`: the city dimension is already a
-- column, and this fills it rather than reshaping it.
--
-- DOWN
--   ALTER TABLE `facets` MODIFY COLUMN `page_type` ENUM('make','model','body_budget','tag') NOT NULL;
--   ALTER TABLE `service_cities` DROP COLUMN `stock_prefix`;
--   DROP TABLE IF EXISTS `service_areas`;
--   DROP TABLE IF EXISTS `service_cities`;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `service_cities` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(60)  NOT NULL,               -- /cars/aba
  name       VARCHAR(80)  NOT NULL,               -- Aba
  state      VARCHAR(60)  NOT NULL,               -- Abia
  blurb      VARCHAR(200) NULL,
  position   TINYINT      NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_city_slug (slug),
  KEY idx_city_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `service_areas` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  city_id    INT UNSIGNED NOT NULL,
  name       VARCHAR(80)  NOT NULL,               -- Woji
  -- SMALLINT, not TINYINT: a market with fourteen neighbourhoods already
  -- overflows a TINYINT once the list is written in tens.
  position   SMALLINT     NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_area_city_name (city_id, name),
  KEY idx_area_city (city_id, is_active, position),
  CONSTRAINT fk_area_city FOREIGN KEY (city_id) REFERENCES service_cities (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The stock-number series is per market. A car bought in Owerri should not be
-- numbered as if it were sitting in Port Harcourt: HC-PH-0001, HC-OW-0001,
-- HC-AB-0001, HC-BN-0001. `src/db/dealers.js` mints the next number in the
-- lot's own series, so this column is what tells it which series that is.
ALTER TABLE `service_cities`
  ADD COLUMN `stock_prefix` VARCHAR(8) NOT NULL DEFAULT 'HC-PH' AFTER `state`;

-- City pages are curated facet pages, exactly like the make and body/budget
-- ones (§14.1): /cars/owerri is hand-built and indexable, while a raw
-- /cars?city=owerri combination stays noindex. The registry therefore learns
-- the type rather than filing a market under `tag`.
ALTER TABLE `facets`
  MODIFY COLUMN `page_type` ENUM('make','model','body_budget','tag','city') NOT NULL;
