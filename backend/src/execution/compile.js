import { prisma } from '../db.js';
import { config } from '../config.js';
import { sha256Hex } from '../lib/hash.js';
import { stableStringify } from '../grading/canonical-utils.js';
import { recordUsage } from './budget.js';
import { DEFAULT_COMPILER_OPTIONS, resolveLimits } from './limits.js';
import { capabilitiesOf, getProvider } from './provider.js';
import { withProviderSlot } from './concurrency.js';

/**
 * Day 23: counters the load check and `/api/meta/usage` report. In-process, so
 * they describe this instance rather than the whole fleet - which is what a
 * "did the cache help?" question actually needs.
 */
const stats = { runs: 0, cacheHits: 0, retries: 0, failures: 0 };

export const executionStats = () => ({ ...stats });
export const resetExecutionStats = () => Object.assign(stats, { runs: 0, cacheHits: 0, retries: 0, failures: 0 });

const RETRYABLE_CODES = new Set(['PROVIDER_RATE_LIMITED']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One run, holding a provider slot, retried when the provider says "not now".
 * A 429 is not a grading result: without this, a burst turns into a report full
 * of `unavailable` metrics that look like the student's fault.
 */
async function runWithRetry(provider, args) {
  const capabilities = capabilitiesOf(provider.name);
  let lastError = null;

  // Five attempts, 1/2/4/8 s. The provider allows 30 runs a minute and answers
  // 429 well before that under a burst; two retries ran out during the golden
  // corpus and turned a rate limit into a failed evaluation. Jitter keeps three
  // analyzers from retrying in lockstep.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await withProviderSlot(provider.name, capabilities.maxConcurrentRuns, () => provider.run(args));
    } catch (error) {
      lastError = error;
      const retryable = RETRYABLE_CODES.has(error?.code) || error?.status === 503;
      if (!retryable || attempt === 4) break;
      stats.retries += 1;
      const backoff = 1000 * 2 ** attempt + Math.floor(Math.random() * 400);
      await sleep(backoff);
    }
  }

  stats.failures += 1;
  throw lastError;
}

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
    if (cached) {
      stats.cacheHits += 1;
      return { ...cached.output, cached: true };
    }
  }

  const provider = getProvider();
  stats.runs += 1;
  const result = await runWithRetry(provider, { source, stdin, compilerOptions, limits: resolvedLimits });
  await recordUsage(provider.name);

  const output = serialise(result);
  // A cache write must never fail a grade (for example during a read-only test).
  await prisma.executionCache.upsert({ where: { cacheKey }, create: { cacheKey, kind, output }, update: {} }).catch(() => {});
  return { ...output, cached: false };
}

export const requestedCompilerOptions = (rules) => {
  const syntax = rules?.metrics?.find((metric) => metric.analyzer === 'compiler_warnings');
  return syntax?.params?.flags ?? DEFAULT_COMPILER_OPTIONS;
};

/**
 * Flags actually handed to the provider.
 *
 * `null` means "this sandbox compiles with fixed flags and cannot be told
 * otherwise" - onlinecompiler.io runs `gcc -O2 code.c -o code.out -lm` and
 * exposes no options field. Returning the requested string anyway would put a
 * flag into the evaluation key that never reached a compiler, so two runs with
 * different flags would look like different toolchains when nothing changed.
 */
export const compilerOptionsFrom = (rules, providerName) => {
  const capabilities = capabilitiesOf(providerName);
  return capabilities.compilerFlags ? requestedCompilerOptions(rules) : null;
};

export { config };
