-- ---------------------------------------------------------------------------
-- 018 — FR-24 / §16: video a listing and a post can actually play
--
-- `listing_media.type` has allowed 'video' since the beginning and nothing ever
-- rendered one — a video row would have shown up as a broken <img>. Playing one
-- needs three things the table had nowhere to put:
--
--   duration_seconds  the "0:12" in a tap-to-load label (§13.2). Measured, not
--                     guessed: the whole point is that a data-conscious visitor
--                     knows what the tap costs before spending it.
--   size_bytes        the other half of that label ("0:12 · 268 KB").
--   poster_url        the still that stands in for the video. Without it the
--                     facade would have to load the video to show anything,
--                     which is exactly what tap-to-load exists to avoid.
--
-- Rows keep `url` as the media path, so nothing about the existing gallery
-- contract changes — an image row simply has NULL for the three new columns.
--
-- DOWN
--   ALTER TABLE listing_media
--     DROP COLUMN duration_seconds, DROP COLUMN size_bytes, DROP COLUMN poster_url;
-- ---------------------------------------------------------------------------

ALTER TABLE `listing_media`
  ADD COLUMN duration_seconds SMALLINT UNSIGNED NULL AFTER shot_label,
  ADD COLUMN size_bytes       INT UNSIGNED      NULL AFTER duration_seconds,
  ADD COLUMN poster_url       VARCHAR(400)      NULL AFTER url;
