-- ============================================================================
-- 028 — §18.3: the privacy desk (NDPA data-subject requests + consent records)
--
-- §18.3's acceptance line is one sentence: "NDPA consent records exist for
-- deal-alert signups; privacy requests actionable in admin". Two of the three
-- words in that sentence were already true — a customer can download
-- everything we hold about them (/account/export) and close their account
-- (/api/account/delete) — but nothing recorded that they had asked, and the
-- console had nowhere to work a request that arrived by WhatsApp. This
-- migration gives the duty somewhere to live:
--
--   consent_records   append-only. One row per *event*: a person ticking the
--                     deal-alert box, opting into marketing, giving us
--                     permission to show their details to a lender. The
--                     wording they were shown is stored with the row, so a
--                     record can answer "what exactly did they agree to?"
--                     rather than only "they agreed".
--   data_requests     the request log. Self-service exports and deletions file
--                     themselves here the moment they happen; anything that
--                     arrives by phone or WhatsApp is logged by hand. NDPA
--                     gives 30 days, so `due_at` is stored rather than
--                     computed in a view, and the console can shout about it.
--
-- Three honesty constraints are in the schema, not in a comment:
--
--   * `user_id` is ON DELETE SET NULL. Closing an account erases the person;
--     it does not erase the evidence that they asked us to, which is the
--     record the duty is discharged against.
--   * a request's `requested_at` is when the *person* asked, which may be
--     earlier than the row — a request logged from a WhatsApp message on
--     Monday that reaches the console on Thursday keeps Monday's date and
--     Monday's clock.
--   * `resolution` is free text written by a human. Nothing is auto-filled:
--     "completed" with nothing said about what was done is what a log of this
--     kind looks like when it is theatre.
--
-- DOWN
--   DROP TABLE IF EXISTS `data_requests`;
--   DROP TABLE IF EXISTS `consent_records`;
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `consent_records` (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NULL,                  -- NULL when there is no account yet
  phone        VARCHAR(40)  NULL,                  -- canonical, when we have one
  name         VARCHAR(120) NULL,
  purpose      ENUM('marketing','deal_alerts','lender_share','service_contact') NOT NULL,
  granted      TINYINT(1)   NOT NULL,              -- 1 = permission given, 0 = withdrawn
  source       VARCHAR(40)  NOT NULL,              -- account | saved_car | saved_search | financing | service_form | contact
  path         VARCHAR(200) NULL,                  -- the page they were on
  notice       VARCHAR(400) NOT NULL,              -- the exact wording shown next to the box
  actor        ENUM('self','staff') NOT NULL DEFAULT 'self',
  recorded_by  INT UNSIGNED NULL,                  -- staff member, when actor = 'staff'
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_consent_phone (phone, created_at),
  KEY idx_consent_purpose (purpose, created_at),
  KEY idx_consent_user (user_id, purpose, created_at),
  CONSTRAINT fk_consent_user FOREIGN KEY (user_id)     REFERENCES `users` (id) ON DELETE SET NULL,
  CONSTRAINT fk_consent_actor FOREIGN KEY (recorded_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `data_requests` (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference    VARCHAR(20)  NOT NULL,              -- HC-DSR-000001, quoted back to the person
  request_type ENUM('access','erasure','correction','withdraw_marketing','other') NOT NULL DEFAULT 'other',
  status       ENUM('received','in_progress','completed','refused') NOT NULL DEFAULT 'received',
  channel      ENUM('self_service','contact_form','whatsapp','phone','email','walk_in','other') NOT NULL DEFAULT 'other',
  user_id      INT UNSIGNED NULL,                  -- the account, when there was one
  name         VARCHAR(120) NULL,
  phone        VARCHAR(40)  NULL,
  email        VARCHAR(160) NULL,
  subject      VARCHAR(240) NULL,                  -- what they asked for, in the words used
  resolution   VARCHAR(240) NULL,                  -- what was actually done about it
  requested_at DATETIME     NOT NULL,              -- when the person asked (not when the row appeared)
  due_at       DATETIME     NOT NULL,              -- NDPA: 30 days from requested_at
  completed_at DATETIME     NULL,
  handled_by   INT UNSIGNED NULL,
  source_path  VARCHAR(200) NULL,                  -- where it was filed from
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_data_request_reference (reference),
  KEY idx_data_requests_status (status, due_at),
  KEY idx_data_requests_phone (phone, requested_at),
  KEY idx_data_requests_user (user_id, request_type, requested_at),
  CONSTRAINT fk_data_request_user    FOREIGN KEY (user_id)    REFERENCES `users` (id) ON DELETE SET NULL,
  CONSTRAINT fk_data_request_handler FOREIGN KEY (handled_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
