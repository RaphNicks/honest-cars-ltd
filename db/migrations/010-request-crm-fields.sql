-- ============================================================================
-- 010 — the CRM fields service_requests needs to sit in the same inbox as
-- leads (§7.3 “Unified inbox … auto-assign rules … follow-up reminders,
-- lost-reason capture”).
--
-- 009 gave `leads` an owner, a contact clock and a lost reason. Requests are
-- worked the same way from the concierge board, so they need the same three
-- columns rather than a second mechanism.
-- ============================================================================

ALTER TABLE service_requests
  ADD COLUMN assigned_to       INT UNSIGNED NULL AFTER status,
  ADD COLUMN assigned_at       DATETIME     NULL AFTER assigned_to,
  ADD COLUMN last_contacted_at DATETIME     NULL AFTER assigned_at,
  ADD COLUMN lost_reason       VARCHAR(160) NULL AFTER last_contacted_at,
  ADD KEY idx_request_assignee (assigned_to, status),
  ADD CONSTRAINT fk_request_assignee FOREIGN KEY (assigned_to) REFERENCES `users` (id) ON DELETE SET NULL;
