import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';

/**
 * Prisma 7 is Rust-free: the client talks to Postgres through a driver
 * adapter, so the connection string is passed here rather than read from
 * `schema.prisma`. `DATABASE_URL` must be the pooled host (Neon pgbouncer);
 * migrations use `DIRECT_URL` through prisma.config.ts.
 *
 * The pool is built here instead of being handed to the adapter as a string,
 * because three failures we hit on a fresh Linux clone all live in the pool:
 *
 *  1. An idle client that errors (Neon closing a suspended connection) emits
 *     'error' on the pool. With no listener that is an *unhandled* event and
 *     Node exits - the API vanishes mid-request, which the Vite proxy reports
 *     as `http proxy error: read ECONNRESET`.
 *  2. The first query after a suspended Neon compute wakes up can fail while
 *     the connection is being established. From the browser that is "login
 *     works sometimes", from the log it is a 500 on `prisma.user.findUnique`.
 *  3. Connect timeouts default to the OS value, so a wrong host hangs for
 *     minutes instead of failing with a readable error.
 */
const { Pool } = pg;

/**
 * Codes that mean the connection never carried the query, so retrying once
 * cannot duplicate a write: refused/unresolvable hosts, connect timeouts, and
 * Postgres' own "the server is shutting down / starting up" classes.
 */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
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

/**
 * pg reports a failed connect as an AggregateError of per-address attempts, so
 * the code worth matching is one level down. Walk `errors` and `cause`.
 */
function chainOf(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const found = [error];
  if (Array.isArray(error.errors)) for (const inner of error.errors) found.push(...chainOf(inner, seen));
  if (error.cause) found.push(...chainOf(error.cause, seen));
  return found;
}

function isTransientConnectFailure(error) {
  return chainOf(error).some((inner) => {
    if (TRANSIENT_CODES.has(inner?.code)) return true;
    return /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(
      String(inner?.message ?? ''),
    );
  });
}

function createPool() {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.isTest ? 4 : 10,
    // Fail in ten seconds with a named host rather than hanging at the OS
    // default: this is the difference between "why is login spinning" and a
    // log line that says which host refused.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
  });

  // See (1) above: without this the process dies on a connection the server
  // closed while it sat idle. A pool discards a broken client by itself; it
  // only needs someone to not crash.
  pool.on('error', (error) => {
    console.error('[db] idle connection dropped by the server, pool will replace it:', error?.code ?? '', error?.message ?? '');
  });

  // See (2): one retry, only for failures raised before the query was sent.
  const rawQuery = pool.query.bind(pool);
  pool.query = async (...args) => {
    try {
      return await rawQuery(...args);
    } catch (error) {
      if (!isTransientConnectFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
      return rawQuery(...args);
    }
  };

  return pool;
}

const adapter = new PrismaPg(createPool());

const globalForPrisma = globalThis;

/**
 * One client per process. On Vercel the module stays warm between invocations,
 * so a client per request would exhaust the pool.
 */
export const prisma =
  globalForPrisma.__nyaywalaPrisma ??
  new PrismaClient({
    adapter,
    log: config.isProd ? ['error'] : ['error', 'warn'],
  });

if (!config.isProd) {
  globalForPrisma.__nyaywalaPrisma = prisma;
}

export async function pingDatabase() {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}
