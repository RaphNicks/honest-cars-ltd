-- ---------------------------------------------------------------------------
-- 015 — FR-25: the watch baselines the alert sweep needs
--
--   saved_cars.last_price_kobo   the price the saver last saw. Set when the car
--                                is saved (so saving never alerts about the
--                                price you just looked at), moved down when a
--                                drop is alerted, and moved up silently when the
--                                dealer raises the price.
--   saved_cars.last_alerted_at   when we last told this person about this car.
--   saved_searches.alert_*       already exist (007). last_alerted_at is reused
--                                as the "new stock since" watermark and only
--                                ever moves to the newest listing actually
--                                alerted on.
--
-- DOWN
--   ALTER TABLE saved_cars DROP COLUMN last_price_kobo, DROP COLUMN last_alerted_at;
-- ---------------------------------------------------------------------------

ALTER TABLE `saved_cars`
  ADD COLUMN last_price_kobo BIGINT   NULL AFTER note,
  ADD COLUMN last_alerted_at DATETIME NULL AFTER last_price_kobo;

UPDATE `saved_cars` s
   JOIN vehicle_listings l ON l.id = s.listing_id
   SET s.last_price_kobo = l.asking_price_kobo
 WHERE s.last_price_kobo IS NULL;
