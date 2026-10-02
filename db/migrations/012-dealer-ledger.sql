-- ============================================================================
-- 012 — Dealer ledger (§7.3 “Orders & Payments”: payout/commission ledger per
-- dealer; §7.2 dealer commission ledger & statements).
--
-- One append-only table, because a ledger that can be edited is not a ledger.
-- `amount_kobo` is signed:
--
--     positive → the dealer owes Honest Cars   (commission on a sale)
--     negative → Honest Cars owes the dealer   (payout, or a credit)
--
-- A dealer's balance is therefore SUM(amount_kobo), a statement is the rows in
-- a date window, and nothing has to be recomputed from listings. Corrections
-- are new rows (entry_type 'adjustment' / 'clawback'), never edits — the same
-- rule the audit log follows. The commission rate is not invented here: the
-- amount is entered by a human who read the dealer agreement, and is recorded
-- against whichever listing or payment it came from.
-- ============================================================================

USE honestcars;

CREATE TABLE IF NOT EXISTS dealer_ledger (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  dealer_id   INT UNSIGNED NOT NULL,
  listing_id  INT UNSIGNED NULL,
  payment_id  INT UNSIGNED NULL,
  entry_type  ENUM('sale_commission','payout','adjustment','clawback') NOT NULL,
  amount_kobo BIGINT       NOT NULL,                   -- signed, see header
  currency    CHAR(3)      NOT NULL DEFAULT 'NGN',
  reference   VARCHAR(40)  NULL,                       -- statement or payout ref
  detail      VARCHAR(200) NULL,
  created_by  INT UNSIGNED NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ledger_dealer (dealer_id, created_at),
  KEY idx_ledger_type (entry_type, created_at),
  KEY idx_ledger_listing (listing_id),
  CONSTRAINT fk_ledger_dealer  FOREIGN KEY (dealer_id)  REFERENCES dealers (id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE SET NULL,
  CONSTRAINT fk_ledger_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE SET NULL,
  CONSTRAINT fk_ledger_actor   FOREIGN KEY (created_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
