import { z } from 'zod';
import { analyzeCPatterns } from '../../analysis/c-patterns.js';
import { runCached } from '../../execution/compile.js';
import { STATUS } from '../../execution/status.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    check_leaks: z.boolean().default(true),
    check_unchecked_alloc: z.boolean().default(true),
    banned_functions: z.array(z.string().min(1)).max(20).default(['gets', 'strcpy', 'sprintf']),
    sanitizer_run: z.boolean().default(false),
    asan_penalty: z.number().min(0).max(1).default(0.5),
    penalty: z
      .object({
        banned_function: z.number().min(0).max(1).default(0.25),
        possible_leak: z.number().min(0).max(1).default(0.2),
        unchecked_alloc: z.number().min(0).max(1).default(0.1),
        double_free: z.number().min(0).max(1).default(0.3),
      })
      .strict()
      .default({}),
  })
  .strict();

const isAsanReport = (stderr) => /ERROR: AddressSanitizer/.test(String(stderr ?? ''));

/**
 * Memory safety: AST patterns first, an optional AddressSanitizer run second.
 *
 * Measured on Day 6: ASan works on this host inside 64 MB, contrary to the
 * plan's assumption. It stays opt-in (`sanitizer_run`) because a provider or
 * flags change can make it unavailable, and a missing tool must never be a
 * zero for the student.
 */
export const memoryAuditAnalyzer = {
  name: 'memory_audit',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const patterns = await analyzeCPatterns(ctx.source, {
      banned: params.banned_functions,
      checkLeaks: params.check_leaks,
      checkUnchecked: params.check_unchecked_alloc,
    });

    if (!patterns.available) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: patterns.reason },
        feedback: 'The C parser could not read this file, so memory patterns were not scored.',
      };
    }

    let score = 1;
    const penaltiesApplied = [];
    for (const finding of patterns.findings) {
      const penalty = params.penalty[finding.kind] ?? 0;
      if (!penalty) continue;
      score -= penalty;
      penaltiesApplied.push({ ...finding, penalty });
    }

    let sanitizer = { status: 'not_requested' };
    if (params.sanitizer_run) {
      try {
        const run = await runCached({
          kind: 'asan',
          source: ctx.source,
          sourceHash: ctx.sourceHash,
          stdin: '',
          compilerOptions: `${ctx.compilerOptions} -fsanitize=address -g`,
          limits: ctx.limits,
        });

        if (run.status.code === STATUS.COMPILATION_ERROR) {
          sanitizer = { status: 'unavailable', reason: 'the provider rejected -fsanitize=address' };
        } else if (isAsanReport(run.stderr)) {
          const report = String(run.stderr).split('\n').find((line) => line.includes('ERROR: AddressSanitizer')) ?? 'AddressSanitizer report';
          sanitizer = { status: 'finding', report: report.slice(0, 300) };
          score -= params.asan_penalty;
          penaltiesApplied.push({ kind: 'asan_report', penalty: params.asan_penalty, report: report.slice(0, 200) });
        } else if (run.status.code === STATUS.TIME_LIMIT_EXCEEDED) {
          sanitizer = { status: 'unavailable', reason: 'sanitizer build exceeded the CPU limit' };
        } else {
          sanitizer = { status: 'clean' };
        }
      } catch (error) {
        sanitizer = { status: 'unavailable', reason: error.message };
      }
    }

    score = clamp01(score);
    const kinds = [...new Set(patterns.findings.map((finding) => finding.kind))];

    return {
      score: round3(score),
      status: sanitizer.status === 'unavailable' && patterns.findings.length === 0 ? 'partial' : 'ok',
      evidence: {
        allocs: patterns.allocCount,
        frees: patterns.freeCount,
        findings: patterns.findings.slice(0, 20),
        findings_count: patterns.findings.length,
        kinds,
        penalties: penaltiesApplied,
        sanitizer,
        note: 'Static findings are possible, not certain: a free may exist on a path the parser cannot order.',
      },
      feedback:
        patterns.findings.length === 0
          ? 'No memory-safety pattern was found.'
          : `${patterns.findings.length} memory finding${patterns.findings.length === 1 ? '' : 's'}: ${patterns.findings
              .slice(0, 3)
              .map((finding) => `${finding.kind}${finding.variable ? ` (${finding.variable})` : ''} at line ${finding.line}`)
              .join('; ')}.`,
    };
  },
};
