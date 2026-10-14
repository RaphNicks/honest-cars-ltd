-- ============================================================================
-- 034 — email sign-in for every role; phone sign-in retired.
--
-- Staff, dealer and customer accounts all sign in with a verified email
-- (one-time code) or Google. Customer credentials already live in
-- `user_email_identities`; staff and dealer accounts were provisioned by the
-- business itself, so the profile email on those rows is trusted and becomes a
-- verified sign-in identity here. Customer profile emails are deliberately NOT
-- backfilled — an address typed into a form years ago is not proof of
-- ownership, and those accounts confirm an email through a code before it
-- becomes a credential.
--
-- An account that ends up with no verified identity cannot sign in until ops
-- sets one ("Sign-in email" on /admin/staff), which is the honest outcome for
-- rows that never carried an address.

INSERT INTO user_email_identities (user_id, email, google_subject, verified_at)
SELECT src.user_id, src.email, NULL, UTC_TIMESTAMP()
  FROM (
    SELECT MIN(u.id) AS user_id, LOWER(TRIM(u.email)) AS email
      FROM `users` u
     WHERE u.email IS NOT NULL
       AND TRIM(u.email) <> ''
       AND u.role <> 'customer'
       AND u.status <> 'deleted'
     GROUP BY LOWER(TRIM(u.email))
  ) src
 WHERE NOT EXISTS (
   SELECT 1 FROM user_email_identities e
    WHERE e.user_id = src.user_id OR e.email = src.email
 );

-- ============================================================================
-- DOWN
-- There is no automatic undo: the identity rows this migration adds are the
-- difference between an account that can sign in and one that cannot. To
-- revert, remove the identities it added (staff/dealer rows whose identity
-- still has no google_subject and was verified by this run) and put those
-- accounts back on ops-mediated access — then re-enable a phone sign-in path,
-- which this migration deliberately deleted from the application. The profile
-- email column stays: it was never a credential, only contact information.
-- ============================================================================
