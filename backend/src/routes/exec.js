import { Router } from 'express';
import { z } from 'zod';
import { analyzeC } from '../analysis/c-metrics.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { config } from '../config.js';
import { assertWithinBudget, recordUsage, usageToday } from '../execution/budget.js';
import { DEFAULT_COMPILER_OPTIONS, limitsSchema, resolveLimits } from '../execution/limits.js';
import { getProvider } from '../execution/provider.js';
import { AppError, asyncHandler, send } from '../lib/http.js';

/**
 * Day 6 probe: prove the sandbox before any grading code depends on it.
 * Instructor-only, and switched off in production unless explicitly enabled,
 * because it runs arbitrary C on our provider budget.
 */
export const execRouter = Router();

const smokeSchema = z.object({
  source: z.string().min(1, 'Source is required').max(config.maxSourceBytes, 'Source is too large'),
  stdin: z.string().max(64 * 1024).optional().default(''),
  compilerOptions: z.string().max(200).optional(),
  limits: limitsSchema.optional(),
  includeAst: z.boolean().optional().default(true),
});

execRouter.use(requireAuth);

execRouter.post(
  '/smoke',
  requireRole('INSTRUCTOR'),
  asyncHandler(async (req, res) => {
    if (config.isProd && !config.EXEC_SMOKE_ENABLED) {
      throw new AppError(404, 'EXEC_DISABLED', 'The smoke route is disabled in this environment');
    }

    const body = smokeSchema.parse(req.body);
    const provider = getProvider();
    const limits = resolveLimits(body.limits);
    const compilerOptions = body.compilerOptions ?? DEFAULT_COMPILER_OPTIONS;

    const budgetBefore = await assertWithinBudget(provider.name);

    const startedAt = process.hrtime.bigint();
    let result;
    try {
      result = await provider.run({ source: body.source, stdin: body.stdin, compilerOptions, limits });
    } finally {
      // A failed call still spends quota.
      await recordUsage(provider.name);
    }
    const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const ast = body.includeAst ? await analyzeC(body.source) : { available: false, reason: 'skipped', metrics: null };

    return send(res, {
      execution: {
        provider: result.provider,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        compileOutput: result.compileOutput,
        message: result.message,
        timeMs: result.timeMs,
        memoryKb: result.memoryKb,
        token: result.token,
      },
      request: { compilerOptions, limits },
      timings: { totalMs: Math.round(totalMs) },
      ast,
      budget: { ...(await usageToday(provider.name)), before: budgetBefore.used },
    });
  }),
);
