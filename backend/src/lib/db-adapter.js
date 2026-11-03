import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '../generated/prisma/client.js';
import { createPool, describeDbError, isConnectFailure, waitForDatabase } from './pg-pool.js';

/**
 * Two ways to reach the same Postgres, because one of them can be blocked by a
 * network we do not control.
 *
 *  tcp   (default) - `pg` over a raw socket to port 5432, via
 *                    @prisma/adapter-pg. Fastest, and what every local setup
 *                    uses.
 *  https          - Neon's serverless driver over TLS on port 443, via
 *                    @prisma/adapter-neon. Postgres speaks inside a WebSocket,
 *                    so it survives the campus, hostel and office networks that
 *                    drop outbound 5432 - the failure a Linux laptop reports as
 *                    `ETIMEDOUT` while the same URL works from Windows on
 *                    another network.
 *
 * The transport is picked by DATABASE_TRANSPORT; nothing else in the app knows
 * which one is in use. Both paths support transactions (the HTTPS driver uses a
 * WebSocket per connection), so `$transaction` and the queue behave the same.
 */

export const TRANSPORTS = ['tcp', 'https'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalise the env value; anything unrecognised is the safe default. */
export function resolveTransport(value) {
  return String(value ?? '').trim().toLowerCase() === 'https' ? 'https' : 'tcp';
}

export function createDatabase({ connectionString, transport = 'tcp', max = 10, log } = {}) {
  if (!connectionString) {
    throw new Error('No database connection string (DATABASE_URL is empty). Run `npm run db:check`.');
  }

  if (resolveTransport(transport) === 'https') {
    const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString }), log });
    return { prisma, pool: null, transport: 'https' };
  }

  const pool = createPool(connectionString, { max });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log });
  return { prisma, pool, transport: 'tcp' };
}

/**
 * Same contract as waitForDatabase, for the transport that has no pool to warm:
 * the HTTPS driver opens a connection per query, so this retries the query with
 * the same backoff and the same definition of "the connection never happened".
 */
export async function waitForConnection({ prisma, pool }, { attempts = 4, baseDelayMs = 500, onAttempt } = {}) {
  if (pool) return waitForDatabase(pool, { attempts, baseDelayMs, onAttempt });

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      onAttempt?.(attempt, attempts, error);
      if (!isConnectFailure(error) || attempt === attempts) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  return { ok: false, error: lastError, detail: describeDbError(lastError) };
}
