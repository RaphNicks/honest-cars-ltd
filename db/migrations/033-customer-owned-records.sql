-- ============================================================================
-- 033 — bind verified email-link codes and new contact-required records to accounts
--
-- A contact phone collected on a request is not an account lookup key. New
-- records instead carry the authenticated customer id. Legacy rows stay NULL and
-- remain visible only through the original phone sign-in account, never by a
-- newly typed contact number.
--
-- DOWN:
--   ALTER TABLE `email_auth_codes` DROP FOREIGN KEY `fk_email_auth_code_user`, DROP KEY `idx_email_auth_code_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `leads` DROP FOREIGN KEY `fk_leads_user`, DROP KEY `idx_leads_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_user`, DROP KEY `idx_orders_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `subscriptions` DROP FOREIGN KEY `fk_subscriptions_user`, DROP KEY `idx_subscriptions_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `service_requests` DROP FOREIGN KEY `fk_service_requests_user`, DROP KEY `idx_service_requests_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `hire_bookings` DROP FOREIGN KEY `fk_hire_bookings_user`, DROP KEY `idx_hire_bookings_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `bookings` DROP FOREIGN KEY `fk_bookings_user`, DROP KEY `idx_bookings_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `payments` DROP FOREIGN KEY `fk_payments_user`, DROP KEY `idx_payments_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `payment_milestones` DROP FOREIGN KEY `fk_payment_milestones_user`, DROP KEY `idx_payment_milestones_user`, DROP COLUMN `user_id`;
--   ALTER TABLE `financing_leads` DROP FOREIGN KEY `fk_financing_leads_user`, DROP KEY `idx_financing_leads_user`, DROP COLUMN `user_id`;
-- ============================================================================

ALTER TABLE `email_auth_codes`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `purpose`,
  ADD KEY `idx_email_auth_code_user` (`user_id`, `email`, `purpose`, `created_at`),
  ADD CONSTRAINT `fk_email_auth_code_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

ALTER TABLE `leads`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `listing_id`,
  ADD KEY `idx_leads_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_leads_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `orders`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `order_no`,
  ADD KEY `idx_orders_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `subscriptions`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `order_id`,
  ADD KEY `idx_subscriptions_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_subscriptions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `service_requests`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `tracking_id`,
  ADD KEY `idx_service_requests_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_service_requests_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `hire_bookings`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `request_id`,
  ADD KEY `idx_hire_bookings_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_hire_bookings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `bookings`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `request_id`,
  ADD KEY `idx_bookings_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_bookings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `payments`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `purpose`,
  ADD KEY `idx_payments_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_payments_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `payment_milestones`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `reference`,
  ADD KEY `idx_payment_milestones_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_payment_milestones_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;

ALTER TABLE `financing_leads`
  ADD COLUMN `user_id` INT UNSIGNED NULL AFTER `reference`,
  ADD KEY `idx_financing_leads_user` (`user_id`, `created_at`),
  ADD CONSTRAINT `fk_financing_leads_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;
