-- ---------------------------------------------------------------------------
-- 019 — FR-20: tracking subscriptions, renewals and dealer retainers
--
-- The `subscriptions` table has existed since the shop shipped: a tracker SKU
-- creates a row with `device_state = 'ordered'` and a renewal date a year out,
-- and §7.3 asks for the rest of the lifecycle —
--
--   “Tracking subscriptions (unit, client, plan, renewal date, status);
--    renewal queue + auto reminders (30/7/1 day); dealer retainer/subs
--    management.”
--
-- Nothing above could be answered before this migration. A row knew which
-- order created it, not which *car* the unit is in, not what the plan is
-- called, and not what a renewal costs — so a renewal could not be quoted, and
-- a dealer on a monthly retainer had nowhere to live at all.
--
--   kind           tracker | dealer_retainer. Default 'tracker' so every
--                  existing row keeps its meaning.
--   dealer_id      the lot on a retainer plan (NULL for a tracker).
--   unit_label     the device's home: “2010 Toyota Camry · ABC-123-PH”. This
--                  is the “unit” §7.3 lists first, and the thing a customer
--                  says on the phone.
--   plan_name      “Tracker + SIM, 12 months”, “Dealer retainer, monthly”.
--   amount_kobo    what a renewal costs. Trackers default from the product
--                  price at creation; a retainer is set by the desk. NULL means
--                  “quote from the product”, so nothing is invented here.
--   period_months  how much time a payment buys. 12 for trackers, 1 for a
--                  monthly retainer.
--
-- `subscription_reminders` is the dedupe record for the 30/7/1-day sweep
-- (FR-20). The unique key is what makes a reminder fire **once per window**:
-- running the sweep twice in a day is a no-op, the same trick the alert
-- baselines use (FR-25). Without it, “run it every morning” would message the
-- customer every morning.
--
-- `payments.subscription_id` links a renewal payment to the subscription it
-- extends, the same way order_id and booking_id already link theirs. The
-- extension itself happens in the same transaction that marks the money paid,
-- so no code path can take a renewal payment without granting the year.
--
-- DOWN
--   ALTER TABLE payments DROP FOREIGN KEY fk_payment_subscription;
--   ALTER TABLE payments DROP COLUMN subscription_id;
--   DROP TABLE subscription_reminders;
--   ALTER TABLE subscriptions
--     DROP COLUMN kind, DROP COLUMN dealer_id, DROP COLUMN unit_label,
--     DROP COLUMN plan_name, DROP COLUMN amount_kobo, DROP COLUMN period_months;
-- ---------------------------------------------------------------------------

ALTER TABLE `subscriptions`
  ADD COLUMN kind          ENUM('tracker','dealer_retainer') NOT NULL DEFAULT 'tracker' AFTER id,
  ADD COLUMN dealer_id     INT UNSIGNED NULL AFTER order_id,
  ADD COLUMN unit_label    VARCHAR(80)  NULL AFTER customer_phone,
  ADD COLUMN plan_name     VARCHAR(80)  NULL AFTER unit_label,
  ADD COLUMN amount_kobo   BIGINT       NULL AFTER plan_name,
  ADD COLUMN period_months TINYINT      NOT NULL DEFAULT 12 AFTER renewal_at;

ALTER TABLE `subscriptions`
  ADD KEY idx_subscription_kind (kind, device_state, renewal_at);

CREATE TABLE IF NOT EXISTS `subscription_reminders` (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_id INT UNSIGNED NOT NULL,
  window_days     SMALLINT     NOT NULL,               -- 30 | 7 | 1
  sent_at         DATETIME     NOT NULL,
  notification_id INT UNSIGNED NULL,
  channel         VARCHAR(24)  NULL,
  status          VARCHAR(24)  NOT NULL DEFAULT 'sent',-- sent | skipped
  detail          VARCHAR(200) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_reminder_window (subscription_id, window_days),
  KEY idx_reminder_sent (sent_at),
  CONSTRAINT fk_reminder_subscription FOREIGN KEY (subscription_id)
    REFERENCES subscriptions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `payments`
  ADD COLUMN subscription_id INT UNSIGNED NULL AFTER request_id,
  ADD KEY idx_payment_subscription (subscription_id),
  ADD CONSTRAINT fk_payment_subscription FOREIGN KEY (subscription_id)
    REFERENCES subscriptions (id) ON DELETE SET NULL;
