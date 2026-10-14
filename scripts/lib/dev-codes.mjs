#!/usr/bin/env node
/**
 * Dev-only one-time-code housekeeping for the smoke scripts.
 *
 * The auth policy is deliberately tight: AUTH_EMAIL_MAX_REQUESTS_PER_HOUR (5)
 * codes per address per hour, counted from the `email_auth_codes` rows
 * themselves. Both smokes sign in as the same handful of seeded accounts, so
 * the second run inside the hour dies on a 429 during sign-in — which reads
 * like an authorization regression and is not one. Verification gates have to
 * be repeatable, so each smoke clears the spent codes for its own accounts
 * first. (Phone-keyed codes are cleared the same way for legacy fixtures.)
 *
 * Scope: the identifiers handed in, this machine's development database, never
 * in production. Nothing else is touched.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Delete the one-time codes issued to `identifiers` (sign-in emails, and phone
 * numbers for legacy fixtures) so a fresh code can be requested. Returns how
 * many rows went, or 0 when it declined to act.
 */
export async function clearDevCodes(identifiers, { label = 'smoke', resetMfa = false } = {}) {
  if (process.env.NODE_ENV === 'production') return 0;
  const keys = [...new Set(identifiers.filter(Boolean))];
  if (!keys.length) return 0;

  const db = require('../../src/db');
  try {
    const placeholders = keys.map(() => '?').join(', ');
    const result = await db.query(`DELETE FROM email_auth_codes WHERE email IN (${placeholders})`, keys);
    await db.query(`DELETE FROM auth_codes WHERE phone IN (${placeholders})`, keys);
    const cleared = Number(result?.affectedRows ?? 0);
    if (cleared) console.log(`· cleared ${cleared} spent ${label} code(s) so this run can sign in`);

    // §12.2 — and the spent second-factor *step* on the demo accounts, for the
    // same reason: a repeat run inside the same 30-second window would be told,
    // correctly, that the code had already been used. This is the only place
    // that clears it, it clears a step and never a secret, and — like the code
    // deletion above — it never runs in production. The app's own replay rule
    // is unchanged; it is what makes this necessary.
    if (resetMfa) {
      const steps = await db.query(
        `UPDATE \`users\` SET totp_last_step = NULL
          WHERE totp_secret IS NOT NULL
            AND (email IN (${placeholders}) OR phone IN (${placeholders}) OR id IN
              (SELECT user_id FROM user_email_identities WHERE email IN (${placeholders})))`,
        [...keys, ...keys, ...keys],
      );
      const reset = Number(steps?.affectedRows ?? 0);
      if (reset) console.log(`· cleared ${reset} spent ${label} time-step(s) so this run can sign in`);
    }
    return cleared;
  } finally {
    // The smoke scripts talk to the site over HTTP, not to the database, so
    // releasing the pool here keeps the process free to exit.
    await db.pool.end();
  }
}

export default clearDevCodes;
