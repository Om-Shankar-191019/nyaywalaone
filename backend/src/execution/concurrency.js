import { config } from '../config.js';

/**
 * Day 23: the provider is the scarce resource, so the number of calls in flight
 * is capped in one place rather than hoped for by every caller.
 *
 * Two different ceilings apply:
 *   - the process-wide `EXEC_MAX_INFLIGHT` (what we are willing to spend), and
 *   - the provider's own `maxConcurrentRuns` (what it will accept before it
 *     starts answering 429).
 *
 * The smaller of the two wins. A per-provider limiter means a slow Wandbox run
 * cannot starve the configured provider, and every route - HTTP submit, cron
 * drain, batch grade, scripts - obeys the same number.
 */

const limiters = new Map();

export function createSemaphore(size) {
  const max = Math.max(1, Number(size) || 1);
  let active = 0;
  const waiting = [];

  const next = () => {
    if (active >= max || waiting.length === 0) return;
    active += 1;
    const resolve = waiting.shift();
    resolve(() => {
      active -= 1;
      next();
    });
  };

  return {
    limit: max,
    acquire() {
      return new Promise((resolve) => {
        waiting.push(resolve);
        next();
      });
    },
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
  };
}

function limiterFor(name, requested) {
  const ceiling = Math.min(config.EXEC_MAX_INFLIGHT, Number(requested) || config.EXEC_MAX_INFLIGHT);
  const key = `${name}:${ceiling}`;
  if (!limiters.has(key)) limiters.set(key, createSemaphore(ceiling));
  return limiters.get(key);
}

/** Run `fn` while holding one provider slot. Always releases, even on throw. */
export async function withProviderSlot(name, requested, fn) {
  const limiter = limiterFor(name, requested);
  const release = await limiter.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Snapshot for `/api/meta/usage` and the load check. */
export function inflightSnapshot() {
  return [...limiters.entries()].map(([key, limiter]) => ({
    provider: key.split(':')[0],
    limit: limiter.limit,
    active: limiter.active,
    queued: limiter.queued,
  }));
}
