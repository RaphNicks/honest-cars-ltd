-- ---------------------------------------------------------------------------
-- 005 · Car hire classes carry a photo (§6.7 hire page pricing cards).
-- ---------------------------------------------------------------------------
ALTER TABLE `hire_classes`
  ADD COLUMN `image` VARCHAR(200) NULL AFTER `examples`;
