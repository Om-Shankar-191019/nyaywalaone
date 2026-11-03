import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pingDatabase, prisma } from '../db.js';
import { asyncHandler, notFound, send } from '../lib/http.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { usageToday } from '../execution/budget.js';
import { getToolchainFingerprint } from '../execution/toolchain.js';
import { capabilitiesOf, getProvider } from '../execution/provider.js';
import { defaultsFor, zodToSchema } from '../grading/schema.js';
import { registry } from '../grading/registry.js';
import { drain, queueDepth } from '../services/queue.js';
import { executionStats } from '../execution/compile.js';
import { inflightSnapshot } from '../execution/concurrency.js';

export const systemRouter = Router();

/** Liveness plus a real DB round trip. Never cached: a stale ok is worse than a 503. */
systemRouter.get(
  '/health',
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    try {
      await pingDatabase();
      return send(res, {
        status: 'ok',
        db: 'ok',
        dbLatencyMs: Date.now() - startedAt,
        provider: config.EXECUTION_PROVIDER,
        environment: config.NODE_ENV,
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (error) {
      return res.status(503).json({
        error: { code: 'DB_UNAVAILABLE', message: 'The database is not reachable', details: { reason: error.message.split('\n')[0] } },
      });
    }
  }),
);

/**
 * Why a submission could fail, answered in one call: is the database reachable,
 * is its schema current, is the sandbox key accepted, and is there budget left?
 *
 * This exists because "Something went wrong on our side" is unactionable, and
 * the three causes behind it on a fresh deployment - unmigrated database, wrong
 * provider key, spent budget - are each fixable in a minute once named.
 */
systemRouter.get(
  '/health/ready',
  asyncHandler(async (req, res) => {
    const checks = {};

    try {
      await pingDatabase();
      checks.database = { ok: true };
    } catch {
      checks.database = { ok: false, hint: 'Check DATABASE_URL / DIRECT_URL and that the database is awake.' };
    }

    if (checks.database.ok) {
      try {
        // The columns added in Week 4. A deployment that skipped the migration
        // answers every submit with a 500 until this is fixed.
        const rows = await prisma.$queryRawUnsafe(
          // `column_name` is Postgres' internal `name` type; cast it so the
          // HTTPS transport (which cannot deserialize `name`) reports schema
          // health the same way the TCP transport does.
          `SELECT column_name::text AS column_name FROM information_schema.columns
             WHERE table_name = 'evaluations' AND column_name IN ('claimed_at', 'attempt_count', 'stage')`,
        );
        const present = new Set(rows.map((row) => row.column_name));
        const missing = ['stage', 'claimed_at', 'attempt_count'].filter((column) => !present.has(column));
        checks.schema = missing.length
          ? { ok: false, missing, hint: 'Run `npm run db:deploy` in backend/ to apply pending migrations.' }
          : { ok: true };
      } catch (error) {
        checks.schema = { ok: false, hint: 'Could not read information_schema.', detail: String(error.message).slice(0, 160) };
      }
    }

    try {
      const provider = getProvider(config.EXECUTION_PROVIDER);
      const probe = await provider.ping();
      checks.provider = { ok: true, name: config.EXECUTION_PROVIDER, version: probe.version ?? 'ok' };
    } catch (error) {
      checks.provider = {
        ok: false,
        name: config.EXECUTION_PROVIDER,
        code: error?.code ?? 'PROVIDER_UNAVAILABLE',
        hint:
          error?.code === 'PROVIDER_AUTH'
            ? 'Replace ONLINECOMPILER_API_KEY with the bare REST key (no "Bearer ").'
            : 'The sandbox did not answer. Check the key, the base URL and the provider status page.',
        detail: String(error?.message ?? '').slice(0, 200),
      };
    }

    try {
      const usage = await usageToday(config.EXECUTION_PROVIDER);
      const remaining = Math.max(0, usage.budget - usage.calls);
      checks.budget =
        usage.budget > 0 && remaining === 0
          ? { ok: false, ...usage, remaining, hint: 'Raise EXEC_DAILY_BUDGET or wait for 00:00 UTC.' }
          : { ok: true, ...usage, remaining };
    } catch {
      checks.budget = { ok: false, hint: 'Usage table not readable; the schema check above is the likely cause.' };
    }

    const ready = Object.values(checks).every((check) => check.ok !== false);
    return res.status(ready ? 200 : 503).json({ data: { ready, checks, requestId: req.id } });
  }),
);

/** Section 4.4: the pinned toolchain that goes into every report. */
systemRouter.get(
  '/meta/toolchain',
  requireAuth,
  asyncHandler(async (req, res) => {
    const fingerprint = await getToolchainFingerprint(config.EXECUTION_PROVIDER);
    return send(res, { fingerprint });
  }),
);

systemRouter.get(
  '/meta/usage',
  requireAuth,
  asyncHandler(async (req, res) => send(res, { usage: await usageToday(config.EXECUTION_PROVIDER) })),
);

/**
 * Day 17: the rules editor builds its form from these schemas.
 *
 * Sending the descriptor instead of a hand-maintained field list means the form
 * cannot offer a parameter the analyzer does not accept, and a new parameter
 * appears in the UI the moment the analyzer gains it.
 */
systemRouter.get(
  '/meta/analyzers',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) =>
    send(res, {
      analyzers: registry.all().map((analyzer) => ({
        name: analyzer.name,
        supports: analyzer.supports ?? [],
        params: zodToSchema(analyzer.paramsSchema),
        defaults: defaultsFor(analyzer.paramsSchema),
      })),
      provider: {
        name: config.EXECUTION_PROVIDER,
        ...capabilitiesOf(config.EXECUTION_PROVIDER),
      },
    })),
);

/**
 * Queue drain, for a cron job. Authenticated by a shared secret header - not a
 * user session - and 404s when no secret is configured, so the route simply
 * does not exist in a deployment that has not opted in.
 */
/** Constant-time secret comparison: a prefix must not be learnable by timing. */
function secretMatches(given) {
  const expected = config.CRON_SECRET;
  const provided = String(given ?? '');
  if (!expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Queue drain, for a cron job. Two accepted credentials, because the callers
 * differ: a shell sends `x-cron-secret`, Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` and a GET. The route 404s unless a
 * secret is configured, so it does not exist in a deployment that has not
 * opted in.
 */
const drainHandler = asyncHandler(async (req, res) => {
  const bearer = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secretMatches(req.get('x-cron-secret')) && !secretMatches(bearer)) throw notFound('Not found');

  const source = { ...(req.query ?? {}), ...(req.body ?? {}) };
  const limit = z.coerce.number().int().min(1).max(10).default(1).parse(source.limit ?? 1);
  const concurrency = z.coerce.number().int().min(1).max(4).default(2).parse(source.concurrency ?? 2);

  // `drain` claims rows with FOR UPDATE SKIP LOCKED, so two overlapping cron
  // invocations (or a cron racing a live submission) never grade the same row.
  return send(res, await drain({ limit, concurrency }));
});

systemRouter.post('/internal/drain', drainHandler);
systemRouter.get('/internal/drain', drainHandler);

/** Queue depth and age, for the cohort progress chip and for monitoring. */
systemRouter.get(
  '/meta/queue',
  requireAuth,
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) =>
    send(res, {
      queue: await queueDepth(),
      provider: {
        name: config.EXECUTION_PROVIDER,
        inFlight: inflightSnapshot(),
        counters: executionStats(),
        budget: config.EXEC_DAILY_BUDGET,
        perUserSubmissions: config.EXEC_USER_DAILY_SUBMISSIONS,
      },
    })),
);
