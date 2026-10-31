/**
 * In-memory sliding-window rate limiter.
 *
 * Honest limitation: on Vercel each warm instance keeps its own Map, and a
 * cold start resets it. At this scale (one class, one demo) that is enough to
 * blunt credential stuffing; a production deployment would move the counter to
 * Postgres or Redis. Documented in docs/decisions.md (ADR-004).
 */
export function createRateLimiter({ windowMs, max, keyFn, code = 'RATE_LIMITED', message = 'Too many requests. Try again shortly.' }) {
  const hits = new Map();
  let lastPrune = Date.now();

  const prune = (now) => {
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((ts) => now - ts < windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  };

  const limiter = function rateLimiter(req, res, next) {
    const now = Date.now();
    // Prune lazily rather than on a timer, so the process holds no handles.
    if (now - lastPrune > windowMs) {
      prune(now);
      lastPrune = now;
    }

    const key = keyFn(req);
    const timestamps = (hits.get(key) ?? []).filter((ts) => now - ts < windowMs);

    if (timestamps.length >= max) {
      const retryAfterMs = windowMs - (now - timestamps[0]);
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      res.status(429).json({ error: { code, message } });
      return;
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };

  // Test hook: counters must not leak between test cases.
  limiter.reset = () => hits.clear();
  return limiter;
}
