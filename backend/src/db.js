import { config } from './config.js';
import { createDatabase, resolveTransport, waitForConnection } from './lib/db-adapter.js';

/**
 * Prisma 7 is Rust-free: the client borrows connections from a driver adapter,
 * so the connection string is passed here rather than read from
 * `schema.prisma`, and the transport itself is ours to configure.
 *
 *  - DATABASE_TRANSPORT=tcp (default) borrows from the `pg` pool configured in
 *    src/lib/pg-pool.js - timeouts, keepalive and connect retries live there.
 *  - DATABASE_TRANSPORT=https uses Neon's serverless driver over 443, which is
 *    the working path on a network that drops outbound 5432.
 *
 * `DATABASE_URL` must be the pooled host (Neon pgbouncer); migrations use
 * `DIRECT_URL` through prisma.config.ts.
 */
const globalForPrisma = globalThis;

const log = config.isProd ? ['error'] : ['error', 'warn'];

/**
 * One client per process. On Vercel the module stays warm between invocations,
 * so a client per request would exhaust the pool.
 */
const existing = globalForPrisma.__nyaywalaPrisma;

let prisma = existing;
let pool = globalForPrisma.__nyaywalaPool ?? null;

if (!prisma) {
  const created = createDatabase({
    connectionString: config.DATABASE_URL,
    transport: config.DATABASE_TRANSPORT,
    max: config.isTest ? 4 : 10,
    log,
  });
  prisma = created.prisma;
  pool = created.pool;
}

if (!config.isProd) {
  globalForPrisma.__nyaywalaPrisma = prisma;
  globalForPrisma.__nyaywalaPool = pool;
}

export { pool, prisma };

/** The transport in force, for logs and `db:check`. */
export const databaseTransport = resolveTransport(config.DATABASE_TRANSPORT);

export async function pingDatabase() {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

/**
 * Open the first connection during boot, with backoff, so the first user
 * request does not pay for it and a cold or unreachable database is reported at
 * startup instead of as a 503 in the middle of a sign-in.
 */
export function warmDatabase() {
  return waitForConnection({ prisma, pool });
}
