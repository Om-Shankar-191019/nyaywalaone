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

export const resolveLimits = (overrides = {}) => ({
  ...DEFAULT_LIMITS,
  ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
});

/**
 * Limits a provider cannot enforce must not be presented as enforced.
 *
 * onlinecompiler.io takes a single `time_limit` in seconds and fixes memory at
 * 512 MB and the process count at 16. Asking it for 8 MB is not an error there -
 * it is simply a request the API cannot express - so the limit is dropped and
 * `applied` records what the run actually got. The report then says "the
 * provider's ceiling" instead of repeating a number nobody honoured.
 */
export function clampLimitsFor(capabilities, limits) {
  const resolved = resolveLimits(limits);
  const maxSeconds = capabilities?.maxTimeLimitSeconds ?? resolved.wallTimeLimitSeconds;
  const wallTimeLimitSeconds = capabilities?.perRunTimeLimit
    ? Math.min(resolved.wallTimeLimitSeconds, maxSeconds)
    : resolved.wallTimeLimitSeconds;

  return {
    ...resolved,
    wallTimeLimitSeconds,
    // A CPU limit finer than the wall clock cannot be expressed either, so it
    // follows the wall clock rather than pretending to be tighter than it is.
    cpuTimeLimitSeconds: Math.min(resolved.cpuTimeLimitSeconds, wallTimeLimitSeconds),
    applied: {
      time_limit_s: wallTimeLimitSeconds,
      cpu_limit_enforced: Boolean(capabilities?.cpuTimeLimit),
      memory_limit_enforced: Boolean(capabilities?.memoryLimit),
      process_limit_enforced: Boolean(capabilities?.processLimit),
      memory_limit_kb: capabilities?.memoryLimit ? resolved.memoryLimitKb : null,
    },
  };
}
