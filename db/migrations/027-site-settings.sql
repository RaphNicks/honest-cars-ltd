-- ============================================================================
-- 027 — §5.1: the settings screen, the half that is not the area list
--
-- §5.1's sitemap lists a **settings** screen, and FR-32 left it half-built: the
-- market/area manager is real, everything else was configuration. Business
-- facts, page limits, the sold-car windows, the concierge SLA card and the
-- channel each message takes were all `.env` — which is fine for a self-hosted
-- install and useless for the desk, because changing a retainer price needed a
-- deploy.
--
-- One table, one row per setting somebody has changed:
--
--   settings   the overrides. A setting nobody has touched has **no row** — the
--              default lives in `src/lib/settings-schema.js` (and the
--              environment it reads), so a fresh install with an empty table
--              behaves exactly as the site did before this screen existed.
--
-- Two decisions worth naming:
--
--   * **"Reset to default" is a DELETE.** Writing the default into the table
--     would make it a second copy that can drift from the registry — the exact
--     failure this table exists to avoid.
--   * **No key whitelist in SQL.** The registry is code; duplicating the list
--     here would be a second place to update. The loader ignores unknown keys
--     and reports them instead — a typo in a manual INSERT cannot quietly change
--     a number.
--
-- There are no secrets in this table by design: provider keys are deployment
-- credentials, and a page where the desk can read them is a page where they leak.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `settings` (
  setting_key   VARCHAR(80)  NOT NULL,               -- dotted, and stable: it is the row key
  setting_value VARCHAR(255) NOT NULL,
  updated_by    INT UNSIGNED NULL,                   -- who changed it, for the audit trail
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  KEY idx_settings_updated (updated_at),
  CONSTRAINT fk_settings_actor FOREIGN KEY (updated_by) REFERENCES `users` (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
