-- 038 · Password as the first factor for staff + dealer sign-in (self-set).
--
-- Staff (admin, ops, inspector, finance, marketing) sign in with:
--   password -> email code -> authenticator (TOTP).
-- Dealers sign in with:
--   password -> email code.
-- Customers are unchanged: email code only, no password ever.
--
-- The password is self-set on a person's first sign-in. The account first proves
-- its email with a one-time code, then chooses a password. That in-between is a
-- `password_pending` session -- the same "passed one factor, not the rest" shape
-- as the MFA-pending session. Once the password is stored, a staff account that
-- already has a confirmed authenticator moves straight on to the TOTP step.
--
-- Hashing is scrypt (hashPassword / verifyPassword in src/services/auth.js). The
-- raw password is never stored, and the hash is never exposed: shapeUser does not
-- carry it, so no account display or API surface can leak it.

ALTER TABLE `users`
  ADD COLUMN `password_hash` VARCHAR(255) NULL AFTER `email`;

ALTER TABLE `sessions`
  ADD COLUMN `password_pending` TINYINT(1) NOT NULL DEFAULT 0 AFTER `mfa_attempts`;
