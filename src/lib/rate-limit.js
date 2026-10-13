'use strict';

/**
 * Tiny in-process rate limiter (§12.2 "rate-limited auth/OTP" and form abuse).
 * No dependency, no Redis: this box is small and single-instance. If the site
 * is ever load-balanced, swap this for a shared store — the middleware shape
 * stays identical.
 */

const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = 30, keyFn } = {}) {
  return function limiter(req, res, next) {
    const key = keyFn ? keyFn(req) : `${req.ip}:${req.path}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(max - 1));
      return next();
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many requests — please slow down.' });
    }
    return next();
  };
}

/** Housekeeping so the map cannot grow without bound. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(key);
}, 300_000).unref();

module.exports = rateLimit;
