-- ============================================================================
-- 032 — customer email identities and optional contact phone
--
-- Customers may authenticate with a verified email (OTP) or Google. Existing
-- phone-based accounts remain intact for staff authentication and for customers
-- who have not linked an email yet. A contact phone is not a login identity.
-- Verified email identities live separately so legacy, unverified profile emails
-- do not become credentials or block a safe account link.
--
-- DOWN (only after all email-only users have been migrated or removed):
--   DROP TABLE `email_auth_codes`;
--   DROP TABLE `user_email_identities`;
--   ALTER TABLE `users` DROP COLUMN `contact_phone`;
--   ALTER TABLE `users` MODIFY COLUMN `phone` VARCHAR(40) NOT NULL;
-- ============================================================================

ALTER TABLE `users` MODIFY COLUMN `phone` VARCHAR(40) NULL;
ALTER TABLE `users` ADD COLUMN `contact_phone` VARCHAR(40) NULL AFTER `phone`;

CREATE TABLE IF NOT EXISTS `user_email_identities` (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,
  email          VARCHAR(160) NOT NULL,
  google_subject  VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  verified_at    DATETIME     NOT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_email_identity_email (email),
  UNIQUE KEY uq_user_email_identity_google (google_subject),
  KEY idx_user_email_identity_user (user_id, created_at),
  CONSTRAINT fk_user_email_identity_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `email_auth_codes` (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email        VARCHAR(160) NOT NULL,
  purpose      ENUM('sign_in','link') NOT NULL DEFAULT 'sign_in',
  code_hash    CHAR(64)     NOT NULL,
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
  expires_at   DATETIME     NOT NULL,
  consumed_at  DATETIME     NULL,
  ip           VARCHAR(45)  NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email_auth_code (email, purpose, created_at),
  KEY idx_email_auth_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
