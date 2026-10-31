import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';

/**
 * Prisma 7 is Rust-free: the client talks to Postgres through a driver
 * adapter, so the connection string is passed here rather than read from
 * `schema.prisma`. `DATABASE_URL` must be the pooled host (Neon pgbouncer);
 * migrations use `DIRECT_URL` through prisma.config.ts.
 */
const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });

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
