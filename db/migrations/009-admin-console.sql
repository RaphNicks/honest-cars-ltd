-- ============================================================================
-- 009 — admin console (§7.3): roles, moderation, dispatch, pipeline, audit.
--
--   users.role              who is staff, and what they may do (§7.4 matrix)
--   users.watchlisted       admin flag on an account
--   leads                   owner + lost reason + last contact (CRM-lite)
--   bookings                inspector, checklist, verdict (dispatch)
--   vehicle_listings        moderation trail + the 14-day staleness rule
--   request_candidates      cars attached to a concierge request (§7.3)
--   admin_audit             every sensitive action, with the actor
-- ============================================================================

ALTER TABLE `users`
  ADD COLUMN role ENUM('customer','dealer','ops','inspector','marketing','finance','admin')
                    NOT NULL DEFAULT 'customer' AFTER status,
  ADD COLUMN watchlisted TINYINT(1) NOT NULL DEFAULT 0 AFTER role,
  ADD KEY idx_user_role (role);

ALTER TABLE leads
  ADD COLUMN assigned_to       INT UNSIGNED NULL AFTER status,
  ADD COLUMN assigned_at       DATETIME     NULL AFTER assigned_to,
  ADD COLUMN last_contacted_at DATETIME     NULL AFTER assigned_at,
  ADD COLUMN lost_reason       VARCHAR(160) NULL AFTER last_contacted_at,
  ADD COLUMN updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at,
  ADD KEY idx_leads_assignee (assigned_to, status),
  ADD CONSTRAINT fk_lead_assignee FOREIGN KEY (assigned_to) REFERENCES `users` (id) ON DELETE SET NULL;

ALTER TABLE bookings
  ADD COLUMN inspector_id  INT UNSIGNED NULL AFTER status,
  ADD COLUMN dispatched_at DATETIME     NULL AFTER inspector_id,
  ADD COLUMN completed_at  DATETIME     NULL AFTER dispatched_at,
  ADD COLUMN checklist     JSON         NULL AFTER completed_at,   -- {obd2_codes, sections{…}, photos[]}
  ADD COLUMN verdict       ENUM('pass','pass_with_advisory','fail') NULL AFTER checklist,
  ADD COLUMN report_notes  TEXT         NULL AFTER verdict,
  ADD KEY idx_booking_inspector (inspector_id, slot_at),
  ADD CONSTRAINT fk_booking_inspector FOREIGN KEY (inspector_id) REFERENCES `users` (id) ON DELETE SET NULL;

ALTER TABLE vehicle_listings
  ADD COLUMN moderated_by  INT UNSIGNED NULL AFTER status,
  ADD COLUMN moderated_at  DATETIME     NULL AFTER moderated_by,
  ADD COLUMN refresh_requested_at DATETIME NULL AFTER published_at,
  ADD COLUMN stale_flagged_at     DATETIME NULL AFTER refresh_requested_at,
  ADD COLUMN refreshed_at         DATETIME NULL AFTER stale_flagged_at,
  ADD COLUMN unlisted_at          DATETIME NULL AFTER refreshed_at,
  ADD COLUMN grade_checklist JSON      NULL AFTER verification_grade,
  ADD COLUMN grade_set_by    INT UNSIGNED NULL AFTER grade_checklist,
  ADD COLUMN grade_set_at    DATETIME     NULL AFTER grade_set_by,
  ADD KEY idx_listing_moderation (status, created_at),
  ADD KEY idx_listing_stale (status, refreshed_at, updated_at);

CREATE TABLE IF NOT EXISTS request_candidates (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  listing_id INT UNSIGNED NOT NULL,
  note       VARCHAR(200) NULL,
  rank_no    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  added_by   INT UNSIGNED NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_candidate (request_id, listing_id),
  KEY idx_candidate_request (request_id, rank_no),
  CONSTRAINT fk_candidate_request FOREIGN KEY (request_id) REFERENCES service_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_candidate_listing FOREIGN KEY (listing_id) REFERENCES vehicle_listings (id) ON DELETE CASCADE,
  CONSTRAINT fk_candidate_actor   FOREIGN KEY (added_by)   REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_audit (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id   INT UNSIGNED NULL,
  action     VARCHAR(60)  NOT NULL,          -- listing.publish, lead.status, booking.dispatch…
  entity     VARCHAR(40)  NOT NULL,          -- listing · lead · request · booking · user
  entity_id  INT UNSIGNED NULL,
  detail     JSON         NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity, entity_id, created_at),
  KEY idx_audit_actor (actor_id, created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
