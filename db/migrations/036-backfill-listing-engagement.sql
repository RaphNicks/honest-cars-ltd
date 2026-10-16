-- 036 · Backfill the listing engagement summary (views + saves).
--
-- vehicle_listings.views and .saves are the fast counters the per-dealer stock
-- page, the dealer dashboard and the moderation queue read. The app only ever
-- wrote the *raw* data — views into analytics_events (the listing_view beacon)
-- and saves into saved_cars — and never rolled it into these columns, so every
-- listing read "0 views · 0 saves". (enquiries was already bumped when a lead
-- is created, so it is left alone.)
--
-- This rolls the existing rows up once, from the raw data, in a single pass per
-- source (one GROUP BY, not a per-listing scan). The running sync — recordView
-- on event ingest and the saves recompute on save/remove — keeps them current
-- from here on. Setting the value (rather than adding) makes the count the true
-- total, so any earlier drift is corrected, not doubled.

UPDATE vehicle_listings AS l
LEFT JOIN (
  SELECT CAST(JSON_EXTRACT(e.payload, '$.listing_id') AS UNSIGNED) AS lid, COUNT(*) AS n
    FROM analytics_events AS e
   WHERE e.event_name = 'listing_view'
   GROUP BY lid
) AS v ON v.lid = l.id
SET l.views = COALESCE(v.n, 0);

UPDATE vehicle_listings AS l
LEFT JOIN (
  SELECT s.listing_id, COUNT(*) AS n
    FROM saved_cars AS s
   GROUP BY s.listing_id
) AS c ON c.listing_id = l.id
SET l.saves = COALESCE(c.n, 0);
