-- ---------------------------------------------------------------------------
-- 022 — FR-18: dealer add-on purchases, and the two homes they need
--
-- §7.2 “Orders & Billing” asks for two things beyond the commission ledger:
--
--   “Commission statements per closed deal; pay for add-on services (media
--    shoot, featured placement, intelligence subscription) via PSP”
--
-- The ledger half already existed (`dealer_ledger`, migration 012, and a
-- summary on /dealer/billing). Statements as *documents* did not — the desk
-- could see a list of rows and nothing it could send a dealer at month end.
-- That is a service-layer job and needs no schema.
--
-- Buying an add-on needs a schema, because a purchase is a thing with a life:
-- it is raised unpaid, it is paid, it takes effect, and a monthly one expires.
--
--   dealer_addons     the catalogue the portal sells from. `effect` is what
--                     the purchase *does* when the money lands, so the console
--                     cannot promise a benefit no code delivers.
--   dealer_purchases  one row per purchase: who, which add-on, which car (a
--                     media shoot or featured placement is for one listing;
--                     intelligence is for the lot), what it cost, and when it
--                     runs out.
--
-- `payments.purpose` gains 'addon' and `payments.dealer_purchase_id` links a
-- payment to the purchase it pays for, the same seam order_id, booking_id,
-- subscription_id and hire_booking_id already use: the benefit is granted in
-- the transaction that marks the money paid, so no path can take the money
-- without delivering, and none delivers twice.
--
-- `bookings.type` gains 'media_shoot' (a shoot is a job for a crew on a slot,
-- exactly like an install) and `subscriptions.kind` gains 'intelligence' (a
-- monthly market-intel subscription is the same renewals queue as everything
-- else, which is the point of having built it).
--
-- DOWN
--   ALTER TABLE payments DROP FOREIGN KEY fk_payment_dealer_purchase;
--   ALTER TABLE payments DROP COLUMN dealer_purchase_id;
--   ALTER TABLE payments MODIFY COLUMN purpose
--     ENUM('order','booking','retainer','subscription','milestone','other','hire');
--   DROP TABLE dealer_purchases;
--   DROP TABLE dealer_addons;
--   ALTER TABLE bookings MODIFY COLUMN type ENUM('inspection','install','consultation');
--   ALTER TABLE subscriptions MODIFY COLUMN kind ENUM('tracker','dealer_retainer');
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `dealer_addons` (
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
  needs_listing TINYINT(1)   NOT NULL DEFAULT 0,      -- the dealer must name a car to buy it
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  position      TINYINT      NOT NULL DEFAULT 0,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_addon_slug (slug),
  KEY idx_addon_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `dealer_purchases` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference  VARCHAR(24)  NOT NULL,                   -- HC-ADD-0001
  dealer_id  INT UNSIGNED NOT NULL,
  addon_id   INT UNSIGNED NOT NULL,
  listing_id INT UNSIGNED NULL,
  payment_id INT UNSIGNED NULL,
  amount_kobo BIGINT      NOT NULL,
  status     ENUM('pending','active','expired','cancelled') NOT NULL DEFAULT 'pending',
  starts_at  DATETIME     NULL,
  ends_at    DATETIME     NULL,                       -- NULL = runs until cancelled
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

ALTER TABLE `payments`
  ADD COLUMN dealer_purchase_id INT UNSIGNED NULL AFTER subscription_id,
  ADD KEY idx_payment_dealer_purchase (dealer_purchase_id),
  ADD CONSTRAINT fk_payment_dealer_purchase FOREIGN KEY (dealer_purchase_id)
    REFERENCES dealer_purchases (id) ON DELETE SET NULL;

ALTER TABLE `payments`
  MODIFY COLUMN purpose
    ENUM('order','booking','retainer','subscription','milestone','other','hire','addon') NOT NULL DEFAULT 'other';

ALTER TABLE `bookings`
  MODIFY COLUMN type ENUM('inspection','install','consultation','media_shoot') NOT NULL;

ALTER TABLE `subscriptions`
  MODIFY COLUMN kind ENUM('tracker','dealer_retainer','intelligence') NOT NULL DEFAULT 'tracker';
