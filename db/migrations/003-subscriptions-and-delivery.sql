-- ---------------------------------------------------------------------------
-- 003 · Tracker subscriptions (§6.8 “tracker SKUs auto-create a subscription
-- record”) and the admin-managed delivery-fee table (§6.8 “delivery-fee rules
-- by area (admin table)”).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `delivery_areas` (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)  NOT NULL,
  fee_kobo    BIGINT       NOT NULL DEFAULT 0,
  note        VARCHAR(160) NULL,
  position    TINYINT      NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_delivery_area (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `subscriptions` (
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
