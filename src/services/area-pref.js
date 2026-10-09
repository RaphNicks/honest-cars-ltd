'use strict';

/**
 * FR-32 — the visitor's market preference.
 *
 * A cookie rather than localStorage, because the pages that most need it are
 * server-rendered: /cars has to apply the preference *before* the HTML is
 * written, and for a prebuilt static page Node never runs at all — there the
 * client labels the switcher from the same cookie. The cookie is only ever a
 * slug, and it is resolved against `service_cities` before it filters anything,
 * so a hand-edited value cannot invent a market.
 *
 * This build has no cookie-parser (§17.2 — no dependency we do not need), so
 * the header is read by hand exactly as auth.readSessionToken does.
 */

const COOKIE = 'hc_city';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function readCityPreference(req) {
  const header = req && req.headers ? req.headers.cookie : null;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== COOKIE) continue;
    try {
      return decodeURIComponent(rest.join('=')) || null;
    } catch (error) {
      return null;
    }
  }
  return null;
}

/**
 * Remember a market the visitor asked for by name. `httpOnly: false` is
 * deliberate: the static pages' own script reads it to label the switcher.
 */
function setCityPreference(res, slug) {
  res.cookie(COOKIE, slug, {
    maxAge: MAX_AGE_MS,
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
  });
}

function clearCityPreference(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

module.exports = { COOKIE, MAX_AGE_MS, readCityPreference, setCityPreference, clearCityPreference };
