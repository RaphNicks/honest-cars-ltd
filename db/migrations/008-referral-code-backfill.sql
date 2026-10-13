-- ============================================================================
-- 008 — backfill referral codes for accounts created before 007.
--
-- Codes minted in code never contain a zero — the alphabet is
-- 23456789ABCDEFGHJKLMNPQRSTUVWXYZ — so the deterministic 'HC0001' shape used
-- here cannot collide with a generated one. New accounts get a random code.
-- ============================================================================

UPDATE `users`
   SET referral_code = CONCAT('HC', LPAD(id, 4, '0'))
 WHERE referral_code IS NULL;
