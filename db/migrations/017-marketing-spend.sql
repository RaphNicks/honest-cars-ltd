-- ---------------------------------------------------------------------------
-- 017 — §15.2: what the advertising cost
--
-- The marketing dashboard asks for "CAC guardrails". A cost per acquisition
-- cannot be derived from anything the site already stores — spend happens at
-- Meta/Google and comes back as an invoice — so the honest shape is a small
-- table a person fills in, one row per channel per period, and a dashboard that
-- divides it by the conversions it can prove.
--
-- Deliberately not per-campaign yet: the channels we can attribute today are the
-- UTMs that arrive, and pretending to a campaign-level CAC would mean inventing
-- the split.
--
-- DOWN
--   DROP TABLE marketing_spend;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing_spend (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel      VARCHAR(80)  NOT NULL,              -- matches utm_source ('instagram', 'google'…)
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,              -- inclusive, like the reports window
  amount_kobo  BIGINT       NOT NULL,
  note         VARCHAR(200) NULL,
  created_by   INT UNSIGNED NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_spend_channel (channel, period_start),
  KEY idx_spend_window (period_start, period_end),
  CONSTRAINT fk_spend_actor FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
