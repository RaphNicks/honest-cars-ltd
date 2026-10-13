-- ============================================================================
-- 030 — footer address note: base stated, no coverage claims
--
-- Owner direction (2026-10-12): the footer no longer claims coverage of
-- Owerri, Aba and Benin, and does not say "only Port Harcourt" either —
-- the base is stated, and buyers everywhere are simply welcome.
--
-- DOWN:
--   UPDATE settings
--      SET setting_value = 'We work out of Port Harcourt and cover Owerri, Aba and Benin — the inspection comes to the car, wherever it is.'
--    WHERE setting_key = 'business.address_note';
-- ============================================================================
UPDATE settings
   SET setting_value = 'We work out of Port Harcourt — the inspection comes to the car, wherever it is.'
 WHERE setting_key = 'business.address_note';
