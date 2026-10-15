-- 035 — dealer applications: the self-serve "become a partner" pipeline.
--
-- A dealership applies (or an existing partner proposes a change to their lot)
-- and the row lands in the console's Applications queue for approval. `type`
-- splits the two flows:
--   · 'new'    — a not-yet-partner account applying to open a lot. On approval
--                a dealers row is created, the account's role becomes 'dealer'
--                and the lot is linked to it (user_id).
--   · 'update' — an existing partner editing their own lot; `dealer_id` points
--                at the current lot and the proposed fields mirror dealers.
--                On approval the proposed fields are written to that lot.
--
-- `status` is the queue state; `decline_reason` is quoted back to the dealer.

CREATE TABLE IF NOT EXISTS `dealer_applications` (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,             -- the applying account
  type           ENUM('new','update') NOT NULL DEFAULT 'new',
  dealer_id      INT UNSIGNED NULL,                 -- type='update': the existing lot
  lot_name       VARCHAR(160) NOT NULL,
  city           VARCHAR(80)  NOT NULL DEFAULT 'Port Harcourt',
  lot_area       VARCHAR(80)  NOT NULL,
  tier           ENUM('pilot','standard','premium') NOT NULL DEFAULT 'standard',
  commission_pct DECIMAL(4,2) NULL,                 -- the rate settled when it was approved
  contact_name   VARCHAR(120) NULL,
  phone          VARCHAR(40)  NULL,
  email          VARCHAR(160) NULL,
  website        VARCHAR(300) NULL,
  notes          VARCHAR(400) NULL,
  status         ENUM('pending','approved','declined') NOT NULL DEFAULT 'pending',
  reviewed_by    INT UNSIGNED NULL,
  reviewed_at    DATETIME NULL,
  decline_reason VARCHAR(400) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_applications_status (status, created_at),
  KEY idx_applications_user (user_id, created_at),
  CONSTRAINT fk_application_user     FOREIGN KEY (user_id)     REFERENCES `users` (id) ON DELETE CASCADE,
  CONSTRAINT fk_application_dealer   FOREIGN KEY (dealer_id)   REFERENCES `dealers` (id) ON DELETE CASCADE,
  CONSTRAINT fk_application_reviewer FOREIGN KEY (reviewed_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DOWN (manual):
-- DROP TABLE IF EXISTS `dealer_applications`;
