import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';
import { createPool, waitForDatabase } from './lib/pg-pool.js';

/**
 * Prisma 7 is Rust-free: the client borrows connections from a `pg` pool, so
 * the connection string is passed here rather than read from `schema.prisma`,
 * and the pool itself is ours to configure. See src/lib/pg-pool.js for why the
 * timeouts, keepalive and retries are what they are.
 *
 * `DATABASE_URL` must be the pooled host (Neon pgbouncer); migrations use
 * `DIRECT_URL` through prisma.config.ts.
 */
const pool = createPool(config.DATABASE_URL, { max: config.isTest ? 4 : 10 });

const adapter = new PrismaPg(pool);

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

export { pool };

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
  return waitForDatabase(pool);
}
