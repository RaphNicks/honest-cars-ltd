-- ============================================================================
-- 011 — payments, the milestone tracker and the notification log (§7.3 “Orders
-- & Payments”, §10.1 “Payment polymorphic”, FR-08, §11).
--
-- One payment table for every money event the product can have — retainer,
-- shop order, inspection booking, subscription renewal, milestone release —
-- because §10.1 defines Payment as polymorphic. The PSP reference lives here;
-- card data never does (§12.2: “never store card data (PSP-hosted fields
-- only)”). Provider webhooks are logged with their signature verdict, and
-- `(provider, event_id)` is unique so a retried webhook cannot pay twice
-- (§12.2 “idempotent order processing”).
--
-- DOWN
--   DROP TABLE IF EXISTS `notifications`;
--   DROP TABLE IF EXISTS `payment_events`;
--   DROP TABLE IF EXISTS `payment_milestones`;
--   DROP TABLE IF EXISTS `payments`;
-- ============================================================================

CREATE TABLE IF NOT EXISTS `payments` (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference      VARCHAR(32)  NOT NULL,              -- HC-PAY-000123
  provider       ENUM('manual','paystack','flutterwave','bank_transfer','cash')
                              NOT NULL DEFAULT 'manual',
  provider_ref   VARCHAR(80)  NULL,                  -- PSP transaction reference
  purpose        ENUM('order','booking','retainer','subscription','milestone','other')
                              NOT NULL DEFAULT 'other',
  order_id       INT UNSIGNED NULL,
  booking_id     INT UNSIGNED NULL,
  request_id     INT UNSIGNED NULL,
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
  CONSTRAINT fk_payment_order   FOREIGN KEY (order_id)   REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_request FOREIGN KEY (request_id) REFERENCES service_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_actor   FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
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
