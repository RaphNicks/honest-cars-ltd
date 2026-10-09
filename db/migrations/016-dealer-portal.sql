-- ---------------------------------------------------------------------------
-- 016 — §7.2 dealer partner portal: the lot a signed-in dealer owns
--
--   dealers.user_id        the account that may open /dealer for this lot.
--                          NULL means “nobody has claimed this lot yet”, which
--                          is the honest state for a lot recruited before its
--                          owner signed in.
--   dealers.agreement_ref  the reference on the signed partnership agreement,
--                          so the portal can show the dealer which document is
--                          on file (the file itself lives in ops storage).
--   dealers.agreement_url  optional link to the digital copy.
--   dealers.commission_pct the rate on the agreement, used to label a statement
--                          before any ledger row exists. The ledger stays the
--                          source of truth for money.
--
-- One account owns one lot: user_id is UNIQUE, so a stray double-link cannot
-- let two logins see the same stock.
--
-- DOWN
--   ALTER TABLE dealers DROP COLUMN user_id, DROP COLUMN agreement_ref,
--     DROP COLUMN agreement_url, DROP COLUMN commission_pct;
-- ---------------------------------------------------------------------------

ALTER TABLE dealers
  ADD COLUMN user_id        INT UNSIGNED NULL AFTER verified,
  ADD COLUMN agreement_ref  VARCHAR(80)  NULL AFTER agreement_signed,
  ADD COLUMN agreement_url  VARCHAR(300) NULL AFTER agreement_ref,
  ADD COLUMN commission_pct DECIMAL(4,2) NULL AFTER agreement_url,
  ADD UNIQUE KEY uq_dealer_user (user_id),
  ADD CONSTRAINT fk_dealer_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE SET NULL;

UPDATE dealers SET commission_pct = 5.00 WHERE commission_pct IS NULL;
