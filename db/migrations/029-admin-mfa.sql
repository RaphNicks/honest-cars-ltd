-- ============================================================================
-- 029 — §12.2: a second factor for the roles that can move money
--
-- §12.2 asks for "MFA for admin roles" alongside the §7.4 matrix and the audit
-- log. Sign-in here is phone + one-time code, which is a *single* factor
-- however strong it is: whoever holds the SIM holds the account. This
-- migration adds the second one for the roles where a stolen session is not a
-- nuisance but a loss — `admin` (grants roles, approves payouts) and `finance`
-- (moves money). Ops, inspectors and marketing may enrol voluntarily; the
-- console nags them, the database does not stop them working.
--
-- Four pieces of state, each with a reason:
--
--   users.totp_secret        the shared secret, stored while it is *unconfirmed*
--                            too — enrolment is a two-step conversation (show
--                            the secret, then prove a code from it) and the
--                            half-finished state has to live somewhere.
--   users.totp_confirmed_at  when the first valid code was proved. NULL means
--                            "started, never finished", so a half-enrolled
--                            account is never treated as protected.
--   users.totp_last_step     the time-step of the last code *used*. RFC 6238
--                            codes are valid for their whole 30-second window,
--                            so without this a code read over a shoulder could
--                            be replayed inside that window. Refusing any step
--                            at or below this one makes each code single-use.
--   sessions.mfa_pending +   a session that has passed the first factor only.
--   sessions.mfa_attempts    It opens exactly two things: the challenge page
--                            and nothing else. Attempts is the brute-force
--                            ceiling on a six-digit code (10^6 is not large
--                            enough to leave unthrottled, and a per-IP limiter
--                            is useless against a distributed guess).
--
-- mfa_recovery_codes is the honest way out of a lost phone: ten single-use
-- codes, stored as SHA-256 hashes so the table is not a second set of
-- passwords, each burning on use and each showing when it was used.
--
-- DOWN
--   DROP TABLE IF EXISTS `mfa_recovery_codes`;
--   ALTER TABLE `sessions` DROP COLUMN `mfa_attempts`, DROP COLUMN `mfa_pending`;
--   ALTER TABLE `users` DROP COLUMN `totp_last_step`, DROP COLUMN `totp_confirmed_at`,
--     DROP COLUMN `totp_secret`;
-- ----------------------------------------------------------------------------

ALTER TABLE `users`
  ADD COLUMN `totp_secret`      VARCHAR(64) NULL AFTER `watchlisted`,
  ADD COLUMN `totp_confirmed_at` DATETIME   NULL AFTER `totp_secret`,
  ADD COLUMN `totp_last_step`   BIGINT UNSIGNED NULL AFTER `totp_confirmed_at`;

ALTER TABLE `sessions`
  ADD COLUMN `mfa_pending`  TINYINT(1)      NOT NULL DEFAULT 0 AFTER `revoked_at`,
  ADD COLUMN `mfa_attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `mfa_pending`;

CREATE TABLE IF NOT EXISTS `mfa_recovery_codes` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  code_hash  CHAR(64)     NOT NULL,               -- sha256 of the code, never the code
  used_at    DATETIME     NULL,                   -- NULL until it is spent
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recovery_code (code_hash),
  KEY idx_recovery_user (user_id, used_at),
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
