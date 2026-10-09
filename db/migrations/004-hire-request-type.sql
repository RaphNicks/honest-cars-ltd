-- ---------------------------------------------------------------------------
-- 004 · Car hire requests land in service_requests too (§6.7: “Request form
-- (dates, vehicle class, with-driver?, airport pickup toggle for Omagwa) →
-- quote workflow; corporate RFQ variant”).
-- ---------------------------------------------------------------------------
ALTER TABLE `service_requests`
  MODIFY COLUMN `type` ENUM('concierge','sell','swap','documents','research','parts','consultation','tracking','hire')
  NOT NULL;
