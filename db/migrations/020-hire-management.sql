-- ---------------------------------------------------------------------------
-- 020 — FR-22: hire management
--
-- §10.1 names three entities and §7.3 says what they are for:
--
--   “Hire Management — Vehicle pool registry (partner-owned units, docs, tracker
--    status), availability calendar, booking records, incident log”
--
-- None of them existed. `/hire` has always taken a request and `hire_classes`
-- has always held the rate card, so a hire enquiry becomes a lead and then…
-- nothing. There is no car to assign, no way to know whether the car is free on
-- the dates asked for, no record of the hire once it starts, and nowhere to
-- write down that a client kerbed it in Woji.
--
-- Three tables, deliberately separate from `bookings`: an inspection booking is
-- a job for an inspector on a slot, and a hire is a vehicle occupied over a
-- date range. Sharing one table would have meant a shape where half the columns
-- are always null.
--
-- hire_vehicles — the pool
--   The unit is the thing that gets hired, so it is a row per physical car, not
--   per class: two Corollas are two rows, and the class card gives the price.
--   `owner` distinguishes our own units from partner-owned ones (§7.3), and the
--   documents and tracker columns are the two checks that catch a car being
--   hired out while it is uninsured or untracked.
--
-- hire_bookings — one hire
--   Dates as DATE (a hire is sold by the day, not the hour) and a unique key on
--   the printable reference. `request_id` ties it back to the RFQ the client
--   sent, so the quote → accept → pay trail stays on one record.
--
-- hire_incidents — the log
--   Any event worth remembering about a hire: damage, a late return, a fine, a
--   breakdown. `cost_kobo` is what it cost us and `charged_kobo` is what the
--   client agreed to pay, because those two numbers are different and the
--   difference is the argument.
--
-- DOWN
--   DROP TABLE hire_incidents;
--   DROP TABLE hire_bookings;
--   DROP TABLE hire_vehicles;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `hire_vehicles` (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  plate          VARCHAR(20)  NOT NULL,               -- what a person says on the phone
  class_slug     VARCHAR(40)  NOT NULL,               -- → hire_classes.slug
  make           VARCHAR(40)  NULL,
  model          VARCHAR(60)  NULL,
  year           SMALLINT     NULL,
  colour         VARCHAR(30)  NULL,
  seats          TINYINT      NULL,
  owner          ENUM('honestcars','partner') NOT NULL DEFAULT 'honestcars',
  partner_name   VARCHAR(120) NULL,                   -- “Aba Road Autos — 60/40”
  driver_available TINYINT(1) NOT NULL DEFAULT 1,
  -- The two checks §7.3 lists. `documents_state` is deliberately coarse: what
  -- matters at the counter is whether the papers are current, not which ones.
  documents_state ENUM('current','expiring','missing') NOT NULL DEFAULT 'missing',
  documents_due  DATE         NULL,                   -- insurance/roadworthiness expiry
  tracker_state  ENUM('fitted','on_order','none') NOT NULL DEFAULT 'none',
  status         ENUM('available','on_hire','service','retired') NOT NULL DEFAULT 'available',
  location       VARCHAR(80)  NULL,                   -- where it sleeps: “Woji lot”
  notes          VARCHAR(300) NULL,
  image          VARCHAR(300) NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hire_vehicle_plate (plate),
  KEY idx_hire_vehicle_class (class_slug, status),
  KEY idx_hire_vehicle_docs (documents_state, documents_due)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `hire_bookings` (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference      VARCHAR(24)  NOT NULL,               -- HC-HIRE-0001
  request_id     INT UNSIGNED NULL,                   -- the RFQ this answers
  vehicle_id     INT UNSIGNED NULL,                   -- null while unallocated
  class_slug     VARCHAR(40)  NOT NULL,
  client_name    VARCHAR(120) NOT NULL,
  client_phone   VARCHAR(40)  NOT NULL,
  company        VARCHAR(120) NULL,                   -- corporate accounts (§6.7)
  phone2         VARCHAR(40)  NULL,
  pickup_at      DATE         NOT NULL,
  dropoff_at     DATE         NOT NULL,
  pickup_point   VARCHAR(80)  NULL,                   -- “Omagwa arrivals”, “Woji lot”
  dropoff_point  VARCHAR(80)  NULL,
  days           SMALLINT     NOT NULL DEFAULT 1,
  with_driver    TINYINT(1)   NOT NULL DEFAULT 0,
  driver_name    VARCHAR(80)  NULL,
  airport_pickup TINYINT(1)   NOT NULL DEFAULT 0,
  -- Money in kobo, itemised the way the quote showed it to the client. Storing
  -- the lines rather than recomputing them means a repriced class card does not
  -- silently rewrite a hire that has already been agreed and paid for.
  day_rate_kobo  BIGINT       NOT NULL DEFAULT 0,
  driver_kobo    BIGINT       NOT NULL DEFAULT 0,
  extras_kobo    BIGINT       NOT NULL DEFAULT 0,
  deposit_kobo   BIGINT       NOT NULL DEFAULT 0,
  total_kobo     BIGINT       NOT NULL DEFAULT 0,
  currency       CHAR(3)      NOT NULL DEFAULT 'NGN',
  status         ENUM('requested','quoted','accepted','confirmed','on_hire','completed','cancelled')
                              NOT NULL DEFAULT 'requested',
  quote_sent_at  DATETIME     NULL,
  accepted_at    DATETIME     NULL,
  completed_at   DATETIME     NULL,
  cancelled_at   DATETIME     NULL,
  cancel_reason  VARCHAR(200) NULL,
  notes          VARCHAR(400) NULL,                   -- the quote note the client read
  fuel_out       TINYINT      NULL,                   -- percent at handover
  fuel_in        TINYINT      NULL,                   -- percent at return
  odometer_out   INT UNSIGNED NULL,
  odometer_in    INT UNSIGNED NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hire_reference (reference),
  KEY idx_hire_booking_dates (pickup_at, dropoff_at),
  KEY idx_hire_booking_status (status, pickup_at),
  KEY idx_hire_booking_phone (client_phone, created_at),
  KEY idx_hire_booking_vehicle (vehicle_id, pickup_at),
  CONSTRAINT fk_hire_booking_request FOREIGN KEY (request_id)
    REFERENCES service_requests (id) ON DELETE SET NULL,
  CONSTRAINT fk_hire_booking_vehicle FOREIGN KEY (vehicle_id)
    REFERENCES hire_vehicles (id) ON DELETE SET NULL,
  CONSTRAINT fk_hire_booking_actor FOREIGN KEY (created_by)
    REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `hire_incidents` (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id     INT UNSIGNED NULL,
  vehicle_id     INT UNSIGNED NULL,
  kind           ENUM('damage','late_return','fine','breakdown','fuel','theft','other')
                              NOT NULL DEFAULT 'other',
  severity       ENUM('minor','major','write_off') NOT NULL DEFAULT 'minor',
  detail         VARCHAR(500) NOT NULL,
  cost_kobo      BIGINT       NOT NULL DEFAULT 0,     -- what it cost us
  charged_kobo   BIGINT       NOT NULL DEFAULT 0,     -- what the client agreed to pay
  status         ENUM('open','resolved','written_off') NOT NULL DEFAULT 'open',
  occurred_at    DATETIME     NULL,
  resolved_at    DATETIME     NULL,
  resolution     VARCHAR(400) NULL,
  payment_id     INT UNSIGNED NULL,                   -- the charge, if it was taken
  reported_by    INT UNSIGNED NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incident_booking (booking_id),
  KEY idx_incident_status (status, created_at),
  CONSTRAINT fk_incident_booking FOREIGN KEY (booking_id)
    REFERENCES hire_bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_vehicle FOREIGN KEY (vehicle_id)
    REFERENCES hire_vehicles (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_payment FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE SET NULL,
  CONSTRAINT fk_incident_actor FOREIGN KEY (reported_by)
    REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A hire payment points at the hire it is for, exactly like a renewal points at
-- its subscription: marking it paid is what confirms the booking.
ALTER TABLE `payments`
  ADD COLUMN hire_booking_id INT UNSIGNED NULL AFTER subscription_id,
  ADD KEY idx_payment_hire (hire_booking_id),
  ADD CONSTRAINT fk_payment_hire FOREIGN KEY (hire_booking_id)
    REFERENCES hire_bookings (id) ON DELETE SET NULL;

-- 'hire' joins the purpose enum. A hire payment is its own thing on a receipt —
-- 'other' would be the label the client reads next to the money they sent us.
-- The `retainer` and `subscription` values were added the same way.
ALTER TABLE `payments`
  MODIFY COLUMN purpose ENUM('order','booking','retainer','subscription','milestone','other','hire')
    NOT NULL DEFAULT 'other';
