-- ============================================================================
-- 026 — FR-34: financing-lead partner handoff
--
-- FR-34 ("Financing-lead partner handoff module", COULD/P3) has exactly one
-- place in the PRD where a customer can even ask: §6.5's concierge step 3,
-- "financing needed? Y/N (routes to partner note)". Appendix D keeps the
-- partner itself as an open question — "any bank/MFB partner … or defer".
--
-- So this migration builds the *module* and leaves the partner as data:
--
--   finance_partners   the lenders/MFBs the desk actually works with. Empty on
--                      a fresh install, which is the truth — there is no partner
--                      account behind this site yet, and the console says so
--                      rather than inventing one.
--   financing_leads    one row per enquiry: what the customer wants to finance,
--                      what they can put down and pay monthly, the arithmetic
--                      they were shown, and then the handoff — the partner it
--                      went to, when, and what came back.
--
-- Two honesty constraints are in the schema rather than in a comment:
--
--   * `amount_kobo`, `down_kobo` and `monthly_kobo` are the customer's figures,
--     stored as they were given. Nothing here computes a rate, an approval or
--     an interest charge, because we are not the lender.
--   * `partner_id` stays NULL until a human routes it. A financing lead that
--     nobody has picked up is visibly unassigned rather than quietly "shared".
--
-- `leads.type` gains 'financing' so the enquiry also lands in the ops inbox
-- (§7.3) — the same place every other public enquiry goes. MODIFY is
-- idempotent, so re-running against a database built from schema.sql is safe.
--
-- DOWN
--   ALTER TABLE `leads` MODIFY COLUMN `type`
--     ENUM('viewing','concierge','sell_swap','hire','service','parts','b2b','deal_alert') NOT NULL;
--   DROP TABLE IF EXISTS `financing_leads`;
--   DROP TABLE IF EXISTS `finance_partners`;
-- ----------------------------------------------------------------------------

ALTER TABLE `leads`
  MODIFY COLUMN `type`
    ENUM('viewing','concierge','sell_swap','hire','service','parts','b2b','deal_alert','financing') NOT NULL;

CREATE TABLE IF NOT EXISTS `finance_partners` (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  kind       ENUM('bank','mfb','fintech','cooperative','other') NOT NULL DEFAULT 'other',
  channel    ENUM('whatsapp','email','phone','manual') NOT NULL DEFAULT 'manual',
  contact    VARCHAR(160) NULL,                     -- phone, email or a desk name
  note       VARCHAR(240) NULL,                     -- what they will and will not fund
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_partner (name),
  CONSTRAINT fk_finance_partner_creator FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `financing_leads` (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference    VARCHAR(20)  NOT NULL,               -- HC-FIN-000123, quoted back by the customer
  name         VARCHAR(120) NOT NULL,
  phone        VARCHAR(40)  NOT NULL,
  email        VARCHAR(160) NULL,
  lead_id      INT UNSIGNED NULL,                   -- the §7.3 inbox row for the same enquiry
  listing_id   INT UNSIGNED NULL,                   -- the car, when the enquiry is about one
  request_id   INT UNSIGNED NULL,                   -- the §6.5 concierge request it came from
  amount_kobo  BIGINT       NOT NULL DEFAULT 0,     -- the car's price, or the budget
  down_kobo    BIGINT       NOT NULL DEFAULT 0,     -- what the customer can put down
  monthly_kobo BIGINT       NOT NULL DEFAULT 0,     -- what they can pay a month
  tenor_months SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  employment   ENUM('salaried','self_employed','business_owner','civil_servant','retired','other') NULL,
  timeline     ENUM('asap','two_weeks','month','researching') NULL,
  plan         JSON         NULL,                   -- the arithmetic the customer was shown
  partner_id   INT UNSIGNED NULL,                   -- NULL = nobody has picked it up yet
  status       ENUM('new','shared','contacted','approved','declined','withdrawn') NOT NULL DEFAULT 'new',
  shared_at    DATETIME     NULL,
  outcome_note VARCHAR(240) NULL,
  acted_by     INT UNSIGNED NULL,
  source_path  VARCHAR(200) NOT NULL,
  utm          JSON         NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_financing_reference (reference),
  KEY idx_financing_status (status, created_at),
  KEY idx_financing_phone (phone, created_at),
  KEY idx_financing_partner (partner_id, status),
  CONSTRAINT fk_financing_lead    FOREIGN KEY (lead_id)    REFERENCES `leads` (id) ON DELETE SET NULL,
  CONSTRAINT fk_financing_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE SET NULL,
  CONSTRAINT fk_financing_request FOREIGN KEY (request_id) REFERENCES service_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_financing_partner FOREIGN KEY (partner_id) REFERENCES finance_partners (id) ON DELETE SET NULL,
  CONSTRAINT fk_financing_actor   FOREIGN KEY (acted_by)   REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
