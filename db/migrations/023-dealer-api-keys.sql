-- ---------------------------------------------------------------------------
-- 023 — FR-33: bulk listing import, and the key that authorises it
--
-- §7.2 and the gap register ask for three things: “a CSV template, a validating
-- importer with a dry-run report, and an API key per lot”.
--
-- The first two need no schema — a template is generated from the same column
-- definitions the validator uses, and the dry-run report is computed in memory.
--
-- The third needs one table, because an API key is a credential and credentials
-- have to be revocable, auditable and never recoverable:
--
--   dealer_api_keys   one row per key a lot has issued. Only the SHA-256 hash
--                     is stored, so the plaintext exists exactly once — in the
--                     response to whoever created it — and a database dump is
--                     not a set of live credentials. `prefix` is stored in the
--                     clear because the console has to *show* which key is
--                     which, and twelve characters of it are useless alone.
--
-- Keys are per lot, not per user: the lot is the tenant, and an integration
-- belongs to the lot's stock, not to whoever set it up. Revoking is soft
-- (`revoked_at`) so the audit trail keeps saying what the key used to do.
--
-- DOWN
--   DROP TABLE IF EXISTS dealer_api_keys;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `dealer_api_keys` (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  dealer_id     INT UNSIGNED NOT NULL,
  label         VARCHAR(80)  NOT NULL,               -- "Stock tool", "Aba Road ops"
  `prefix`      VARCHAR(16)  NOT NULL,               -- hc_live_ab12 — display only
  hash          CHAR(64)     NOT NULL,               -- SHA-256 of the whole key
  last_used_at  DATETIME     NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  revoked_at    DATETIME     NULL,
  revoked_by    INT UNSIGNED NULL,
  created_by    INT UNSIGNED NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_key_hash (hash),
  KEY idx_api_key_dealer (dealer_id, revoked_at),
  CONSTRAINT fk_api_key_dealer  FOREIGN KEY (dealer_id)  REFERENCES dealers (id) ON DELETE CASCADE,
  CONSTRAINT fk_api_key_actor   FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL,
  CONSTRAINT fk_api_key_revoker FOREIGN KEY (revoked_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
