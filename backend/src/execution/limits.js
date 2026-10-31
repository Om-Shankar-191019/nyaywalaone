import { z } from 'zod';

/**
 * Defaults chosen so a first-year C program finishes comfortably while a
 * runaway loop still dies inside the provider's wall clock.
 */
export const DEFAULT_LIMITS = Object.freeze({
  cpuTimeLimitSeconds: 1,
  wallTimeLimitSeconds: 5,
  memoryLimitKb: 65536,
  maxProcesses: 30,
  enableNetwork: false,
});

export const DEFAULT_COMPILER_OPTIONS = '-Wall -Wextra -std=c11';

export const limitsSchema = z.object({
  cpuTimeLimitSeconds: z.number().min(0.1).max(10).optional(),
  wallTimeLimitSeconds: z.number().min(0.5).max(20).optional(),
  memoryLimitKb: z.number().int().min(8192).max(262144).optional(),
  maxProcesses: z.number().int().min(1).max(60).optional(),
  enableNetwork: z.boolean().optional(),
});

export const resolveLimits = (overrides = {}) => ({ ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) });
