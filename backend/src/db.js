import { config } from './config.js';
import { TRANSPORTS, createDatabase, resolveTransport, waitForConnection } from './lib/db-adapter.js';
import { describeDbError } from './lib/pg-pool.js';

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
 *
 * Both routes reach the same database, so which one is configured is not a
 * correctness decision - it is a reachability decision, and the network decides.
 * `warmDatabase()` therefore falls back to the other transport when the
 * configured one cannot connect (see the comment there).
 */
const globalForPrisma = globalThis;

const log = config.isProd ? ['error'] : ['error', 'warn'];
const maxConnections = config.isTest ? 4 : 10;

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
    max: maxConnections,
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

/**
 * The transport in force, for logs and `db:check`. It starts as the configured
 * value and becomes the one that actually connected if `warmDatabase()` had to
 * fall back - importers read the live binding, so they never see a stale value.
 */
export let databaseTransport = resolveTransport(config.DATABASE_TRANSPORT);

export async function pingDatabase() {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

/** Swap the live client for one on another transport, and keep the cache honest. */
function adopt(created, transport) {
  prisma = created.prisma;
  pool = created.pool;
  databaseTransport = transport;
  if (!config.isProd) {
    globalForPrisma.__nyaywalaPrisma = prisma;
    globalForPrisma.__nyaywalaPool = pool;
  }
}

/**
 * Open the first connection during boot, with backoff, so the first user
 * request does not pay for it and a cold or unreachable database is reported at
 * startup instead of as a 503 in the middle of a sign-in.
 *
 * If the configured transport cannot connect, the other one is tried once. That
 * is the difference between "the Wi-Fi is unusable" and "the Wi-Fi blocks one
 * port": campus and hostel networks routinely drop outbound 5432 while allowing
 * 443, and the mirror image (a network that allows 5432 but strips the
 * WebSocket upgrade the HTTPS driver needs) is just as common. Either way the
 * application should keep serving instead of dying mid-request.
 *
 * The fallback is one-way per boot and only on a connect failure. A wrong
 * password fails on both transports and the original error is what gets
 * reported, so this cannot hide a configuration mistake.
 */
export async function warmDatabase() {
  const first = await waitForConnection({ prisma, pool });
  if (first.ok || config.isTest) return first;

  const configured = databaseTransport;
  const alternate = TRANSPORTS.find((transport) => transport !== configured) ?? 'tcp';

  let swapped;
  try {
    swapped = createDatabase({
      connectionString: config.DATABASE_URL,
      transport: alternate,
      max: maxConnections,
      log,
    });
  } catch {
    return first;
  }

  const second = await waitForConnection(
    { prisma: swapped.prisma, pool: swapped.pool },
    { attempts: 2, baseDelayMs: 400 },
  );

  if (!second.ok) {
    await swapped.prisma.$disconnect().catch(() => {});
    console.error('[db] neither transport reached the database');
    console.error(`[db]   ${configured.padEnd(5)} ${describeDbError(first.error)}`);
    console.error(`[db]   ${alternate.padEnd(5)} ${describeDbError(second.error)}`);
    return first;
  }

  const stale = prisma;
  adopt(swapped, alternate);
  await stale.$disconnect().catch(() => {});

  console.warn(`[db] DATABASE_TRANSPORT=${configured} could not connect (${describeDbError(first.error)})`);
  console.warn(`[db] continuing over ${alternate} - same database, different route.`);
  console.warn(`[db] if this is your everyday network, put DATABASE_TRANSPORT=${alternate} in backend/.env and run npm run db:check`);
  return second;
}
