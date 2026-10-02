-- ============================================================================
-- 007 — the last of the §7.1 dashboard cards: referrals, and the two alert
-- switches a saved search actually needs (price drop · new match).
--
--   users.referral_code  the personal link the account holder shares
--   users.referred_by    who brought them here (never themselves, never twice)
--   saved_searches.alert_price_drop / alert_new_match
--                        what the notification layer will watch for; the
--                        existing alerts_enabled column stays as the master
--                        switch ("any alert at all") for backwards reads.
-- ============================================================================

ALTER TABLE `users`
  ADD COLUMN referral_code VARCHAR(16) NULL AFTER status,
  ADD COLUMN referred_by   INT UNSIGNED NULL AFTER referral_code,
  ADD UNIQUE KEY uq_user_referral_code (referral_code),
  ADD KEY idx_user_referred_by (referred_by),
  ADD CONSTRAINT fk_user_referrer FOREIGN KEY (referred_by) REFERENCES `users` (id) ON DELETE SET NULL;

ALTER TABLE `saved_searches`
  ADD COLUMN alert_price_drop TINYINT(1) NOT NULL DEFAULT 1 AFTER alerts_enabled,
  ADD COLUMN alert_new_match  TINYINT(1) NOT NULL DEFAULT 1 AFTER alert_price_drop;
