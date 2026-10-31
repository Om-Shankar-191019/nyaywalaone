import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma, pingDatabase } from '../db.js';
import { asyncHandler, notFound, send } from '../lib/http.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { usageToday } from '../execution/budget.js';
import { getToolchainFingerprint } from '../execution/toolchain.js';
import { capabilitiesOf } from '../execution/provider.js';
import { defaultsFor, zodToSchema } from '../grading/schema.js';
import { registry } from '../grading/registry.js';
import { runEvaluation } from '../grading/coordinator.js';

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
systemRouter.post(
  '/internal/drain',
  asyncHandler(async (req, res) => {
    if (!config.CRON_SECRET) throw notFound('Not found');
    if (req.get('x-cron-secret') !== config.CRON_SECRET) throw notFound('Not found');

    const limit = z.coerce.number().int().min(1).max(5).default(1).parse(req.body?.limit ?? 1);
    const queued = await prisma.evaluation.findMany({
      where: { status: 'QUEUED' },
      orderBy: { startedAt: 'asc' },
      select: { id: true },
      take: limit,
    });

    const processed = [];
    for (const row of queued) {
      try {
        const outcome = await runEvaluation(row.id);
        processed.push({ id: row.id, status: outcome.evaluation.status, gradeHundredths: outcome.gradeHundredths ?? null });
      } catch (error) {
        processed.push({ id: row.id, status: 'FAILED', reason: String(error.message ?? error).slice(0, 200) });
      }
    }

    return send(res, { processed });
  }),
);
