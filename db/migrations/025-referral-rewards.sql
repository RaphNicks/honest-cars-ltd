-- ============================================================================
-- 025 — FR-28: the reward half of the referral module
--
-- FR-28 is "Referral module (links, attribution, reward status) (§7.1)",
-- COULD/P3. Migration 007 already gave us the link and the attribution:
-- `users.referral_code` is the personal code, `users.referred_by` is who
-- brought them here, and /account has shown the link and a count since §7.1 was
-- built. What has never existed is the *reward status* — a referral that counts
-- was, until now, a number on a card with no answer to "and then what?".
--
-- So this migration adds exactly two things:
--
--   users.referral_qualified_at   the moment a referral started to count, and
--                                 the record of it, so a qualification can
--                                 never be un-made by a later cancellation of
--                                 the order that caused it. NULL = not yet.
--   users.referral_note           the desk's own line on it ("waiting on the
--                                 order to settle", "customer asked us to hold")
--
--   referral_rewards              one row per referred account, carrying the
--                                 decision: pending → approved → paid, or
--                                 void when the desk says it does not count.
--                                 `amount_kobo` is entered by a human, because
--                                 the PRD sets no amount — a reward is a
--                                 campaign decision, not a constant.
--
-- The unique key (referrer_id, referred_user_id) is the honesty constraint: a
-- person can be brought in once, and counted once. Re-running a sweep, or two
-- sweeps racing, cannot inflate the queue.
--
-- DOWN
--   DROP TABLE IF EXISTS `referral_rewards`;
--   ALTER TABLE `users` DROP COLUMN `referral_note`;
--   ALTER TABLE `users` DROP COLUMN `referral_qualified_at`;
-- ----------------------------------------------------------------------------

ALTER TABLE `users`
  ADD COLUMN referral_qualified_at DATETIME     NULL AFTER referred_by,
  ADD COLUMN referral_note         VARCHAR(200) NULL AFTER referral_qualified_at;

CREATE TABLE IF NOT EXISTS `referral_rewards` (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  referrer_id      INT UNSIGNED NOT NULL,            -- who shared the link
  referred_user_id INT UNSIGNED NOT NULL,            -- who used it
  status           ENUM('pending','approved','paid','void') NOT NULL DEFAULT 'pending',
  basis            ENUM('signup','order') NOT NULL DEFAULT 'order',
  amount_kobo      BIGINT       NOT NULL DEFAULT 0,  -- set by a human at approval
  unit_label       VARCHAR(120) NULL,                -- what the reward was for, in words
  note             VARCHAR(200) NULL,
  approved_at      DATETIME     NULL,
  paid_at          DATETIME     NULL,
  actor_id         INT UNSIGNED NULL,                -- the last person to touch it
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
