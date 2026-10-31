import { prisma } from '../db.js';
import { config } from '../config.js';
import { sha256Hex } from '../lib/hash.js';
import { stableStringify } from '../grading/canonical-utils.js';
import { recordUsage } from './budget.js';
import { DEFAULT_COMPILER_OPTIONS, resolveLimits } from './limits.js';
import { getProvider } from './provider.js';

/** The rules file speaks seconds and megabytes; the provider speaks CPU and KB. */
export function limitsFromRules(limits = {}) {
  return resolveLimits({
    cpuTimeLimitSeconds: limits.time_limit_s,
    wallTimeLimitSeconds: Math.max(5, (limits.time_limit_s ?? 1) * 5),
    memoryLimitKb: (limits.memory_limit_mb ?? 64) * 1024,
    maxProcesses: limits.max_processes,
    enableNetwork: false,
  });
}

/** Only the fields a report can use; the provider response is not stored whole. */
function serialise(result) {
  return {
    provider: result.provider,
    status: {
      id: result.status?.id ?? null,
      code: result.status?.code ?? 'UNKNOWN',
      description: result.status?.description ?? '',
      detail: result.status?.detail ?? null,
    },
    stdout: String(result.stdout ?? '').slice(0, 64 * 1024),
    stderr: String(result.stderr ?? '').slice(0, 16 * 1024),
    compileOutput: String(result.compileOutput ?? '').slice(0, 32 * 1024),
    message: String(result.message ?? '').slice(0, 2000),
    timeMs: Number.isFinite(result.timeMs) ? result.timeMs : null,
    memoryKb: Number.isFinite(result.memoryKb) ? result.memoryKb : null,
  };
}

/**
 * One compile or run, reused by content.
 *
 * The cache key is `(kind, source, stdin, flags, limits)`. It makes a repeated
 * grade cheap and keeps a regrade byte-identical, but it also means the key
 * must contain everything that can change the output - hence the limits, not
 * just the source.
 */
export async function runCached({
  kind,
  source,
  sourceHash,
  stdin = '',
  compilerOptions = DEFAULT_COMPILER_OPTIONS,
  limits,
  bypassCache = false,
}) {
  const resolvedLimits = limits ?? resolveLimits();
  const cacheKey = sha256Hex(
    stableStringify({ kind, source: sourceHash, stdin, compilerOptions, limits: resolvedLimits }),
  );

  if (!bypassCache) {
    const cached = await prisma.executionCache.findUnique({ where: { cacheKey } });
    if (cached) return { ...cached.output, cached: true };
  }

  const provider = getProvider();
  const result = await provider.run({ source, stdin, compilerOptions, limits: resolvedLimits });
  await recordUsage(provider.name);

  const output = serialise(result);
  // A cache write must never fail a grade (for example during a read-only test).
  await prisma.executionCache.upsert({ where: { cacheKey }, create: { cacheKey, kind, output }, update: {} }).catch(() => {});
  return { ...output, cached: false };
}

export const compilerOptionsFrom = (rules) => {
  const syntax = rules?.metrics?.find((metric) => metric.analyzer === 'compiler_warnings');
  return syntax?.params?.flags ?? DEFAULT_COMPILER_OPTIONS;
};

export { config };
