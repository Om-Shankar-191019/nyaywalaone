import pg from 'pg';

/**
 * The one place that knows how to open a Postgres pool.
 *
 * Prisma 7 has no Rust query engine: `@prisma/adapter-pg` borrows connections
 * from a `pg` pool, so every reliability property we want (timeouts, keepalive,
 * retries, not crashing on a dropped socket) has to be set here rather than in
 * the connection string or `schema.prisma`.
 *
 * Three concrete failures this exists for, all seen on a fresh Linux clone:
 *
 *  1. An idle client that errors emits 'error' on the pool; with no listener
 *     that is an unhandled event and Node exits - the API disappears
 *     mid-request, which shows up in Vite as `read ECONNRESET`.
 *  2. Neon free projects suspend when idle, and a laptop/WSL2 link to the
 *     pooler is not a long-lived reliable link. The first query after a gap
 *     (or the first query ever) can fail while the connection is being
 *     established: `ETIMEDOUT` from the socket, or "timeout exceeded when
 *     trying to connect". From the browser that is "it works sometimes".
 *  3. A short idle timeout turns the 2) window into the *normal* case: if the
 *     pool drops every connection after 30 s, every request pays a fresh DNS,
 *     TCP and TLS handshake, so every request has a chance to fail.
 */

/**
 * Codes that mean the connection never carried the query, so a retry cannot
 * duplicate a write: refused or unresolvable hosts, connect timeouts, and
 * Postgres' "server is starting up / shutting down" classes.
 */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08006', // connection_failure
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

/** Walk `cause` and `errors`: pg reports a failed connect as an AggregateError. */
export function errorChain(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const found = [error];
  if (Array.isArray(error.errors)) for (const inner of error.errors) found.push(...errorChain(inner, seen));
  if (error.cause) found.push(...errorChain(error.cause, seen));
  return found;
}

export function isConnectFailure(error) {
  return errorChain(error).some((inner) => {
    if (TRANSIENT_CODES.has(inner?.code)) return true;
    // Messages, because not every layer gives us a code: `pg` wraps a failed
    // connect in an AggregateError, and the HTTPS transport (Neon's serverless
    // driver) reports a broker problem as a WebSocket or fetch error.
    return /timeout exceeded when trying to connect|Connection terminated due to connection timeout|Connection terminated unexpectedly|websocket|fetch failed|network is unreachable/i.test(
      String(inner?.message ?? ''),
    );
  });
}

/** Flatten a driver/Prisma error whose `message` may be empty into one line. */
export function describeDbError(error) {
  const parts = [
    error?.code ? `[${error.code}]` : '',
    error?.message ?? '',
    error?.meta ? JSON.stringify(error.meta).slice(0, 400) : '',
    ...errorChain(error)
      .slice(1)
      .map((inner) => (inner?.code ? `cause=[${inner.code}] ${inner.message ?? ''}` : String(inner?.message ?? ''))),
  ].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 800) || '(no message, no code, no cause)';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps `query` and `connect` so that a failure raised *before* the statement is
 * sent is retried a couple of times with backoff. Prisma's adapter uses
 * `pool.connect()` for transactions and `pool.query()` otherwise, so both are
 * patched - retrying only one of them would leave the common path unprotected.
 */
function withConnectRetry(pool, { attempts = 3, baseDelayMs = 250 } = {}) {
  const rawQuery = pool.query.bind(pool);
  const rawConnect = pool.connect.bind(pool);

  const retrying = (run) => async (...args) => {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await run(...args);
      } catch (error) {
        // Only pre-statement failures are safe to replay.
        if (!isConnectFailure(error)) throw error;
        lastError = error;
        if (attempt < attempts - 1) await sleep(baseDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  };

  pool.query = retrying(rawQuery);
  pool.connect = retrying(rawConnect);

  return pool;
}

export function createPool(connectionString, { max = 10, attempts = 3 } = {}) {
  if (!connectionString) {
    throw new Error('No database connection string (DATABASE_URL / DIRECT_URL is empty). Run `npm run db:check`.');
  }

  const pool = new pg.Pool({
    connectionString,
    max,
    // A hung connect must fail in seconds with a named host, not hang for
    // minutes at the OS default while the browser shows a spinner.
    connectionTimeoutMillis: 10_000,
    // See (3): keep connections through normal pauses. Reconnecting is the
    // expensive, failure-prone step; an idle TCP connection costs nothing.
    idleTimeoutMillis: 10 * 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // Long idle timeouts would otherwise keep the event loop alive after a
    // short-lived process (tests, seed, db:check) has finished its work, so
    // those processes have to be killed instead of exiting. Idle clients are
    // unreferenced; a listening server keeps itself alive regardless.
    allowExitOnIdle: true,
  });

  // See (1): without a listener a server-side close is an unhandled 'error'
  // event and the process exits. The pool replaces a broken client itself.
  pool.on('error', (error) => {
    console.error('[db] idle connection dropped by the server, pool will replace it:', error?.code ?? '', error?.message ?? '');
  });

  return withConnectRetry(pool, { attempts });
}

/**
 * Prove the database is reachable, with backoff, before the API starts taking
 * traffic. Returns instead of throwing when unreachable: a server that answers
 * every request with a clear 503 is easier to diagnose than one that refuses to
 * boot, and `npm run db:check` is the command it points at.
 */
export async function waitForDatabase(pool, { attempts = 4, baseDelayMs = 500, onAttempt } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      onAttempt?.(attempt, attempts, error);
      if (!isConnectFailure(error) || attempt === attempts) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  return { ok: false, error: lastError };
}
