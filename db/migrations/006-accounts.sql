-- ============================================================================
-- Migration 006 — phone-first accounts (§7.1)
--
-- Adds the customer account tables: users, one-time login codes, server-side
-- sessions, saved cars and saved searches. Dashboard reads (requests, bookings,
-- orders, subscriptions) reuse the tables the public site already writes — they
-- are keyed by phone, which is the account key per §7.1.
--
-- Safe to re-run: an "already exists" error is tolerated by the migration
-- runner, and db/schema.sql carries the same definitions for fresh databases.
-- ============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `users` (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone            VARCHAR(40)   NOT NULL,              -- normalised +234…
  name             VARCHAR(120)  NULL,
  email            VARCHAR(160)  NULL,
  marketing_opt_in TINYINT(1)    NOT NULL DEFAULT 0,    -- NDPA: explicit, revocable
  status           ENUM('active','blocked','deleted') NOT NULL DEFAULT 'active',
  last_seen_at     DATETIME      NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_phone (phone),
  KEY idx_user_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `auth_codes` (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  phone        VARCHAR(40)   NOT NULL,
  code_hash    CHAR(64)      NOT NULL,                  -- HMAC-SHA256, peppered
  channel      ENUM('whatsapp','sms','console') NOT NULL DEFAULT 'console',
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 5,
  expires_at   DATETIME      NOT NULL,
  consumed_at  DATETIME      NULL,
  ip           VARCHAR(45)   NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_code_phone (phone, created_at),
  KEY idx_code_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sessions` (
  id         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  token_hash CHAR(64)      NOT NULL,
  user_id    INT UNSIGNED  NOT NULL,
  user_agent VARCHAR(200)  NULL,
  ip         VARCHAR(45)   NULL,
  expires_at DATETIME      NOT NULL,
  revoked_at DATETIME      NULL,
  created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token (token_hash),
  KEY idx_session_user (user_id, expires_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `saved_cars` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  listing_id INT UNSIGNED NOT NULL,
  note       VARCHAR(200) NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saved_car (user_id, listing_id),
  CONSTRAINT fk_saved_car_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_car_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `saved_searches` (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  label           VARCHAR(120) NOT NULL,
  query           TEXT         NOT NULL,                -- the filter query string
  alerts_enabled  TINYINT(1)   NOT NULL DEFAULT 1,
  last_alerted_at DATETIME     NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_saved_search_user (user_id, created_at),
  CONSTRAINT fk_saved_search_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
