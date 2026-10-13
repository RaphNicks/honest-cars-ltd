-- ============================================================================
-- 031 — house dealer lot so the console can list cars itself
--
-- Owner direction (2026-10-12): admins are not limited to moderating dealer
-- stock — the console gets its own lot ("house stock") to publish cars the
-- business holds directly. The lot is owned by the admin account so it
-- survives the demo purge, which keeps account-less lots only.
--
-- DOWN:
--   DELETE FROM dealers WHERE slug = 'honest-cars-house';
-- ============================================================================
INSERT INTO dealers (name, slug, lot_area, city, tier, verified, user_id)
SELECT 'Honest Cars Ltd — house stock', 'honest-cars-house', 'Head office', 'Port Harcourt', 'premium', 1, u.id
  FROM `users` u
 WHERE u.phone = '+2348000000001'
   AND NOT EXISTS (SELECT 1 FROM dealers d WHERE d.slug = 'honest-cars-house');
