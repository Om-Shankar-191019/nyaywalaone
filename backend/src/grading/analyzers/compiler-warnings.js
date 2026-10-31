import { z } from 'zod';
import { runCached } from '../../execution/compile.js';
import { STATUS } from '../../execution/status.js';
import { firstDiagnosticSummary, parseGccOutput } from '../diagnostics.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    flags: z.string().min(1).max(500).default('-Wall -Wextra -std=c11'),
    warnings_as_errors: z.boolean().default(false),
    penalty_per_warning: z.number().min(0).max(0.5).default(0.1),
  })
  .strict();

/**
 * Syntax health: compile-only with the instructor's flags.
 *
 * The flags are part of the rules file, and the compiler is pinned by the
 * toolchain fingerprint, so "0 warnings" means something specific rather than
 * "whatever compiler happened to be installed".
 */
export const compilerWarningsAnalyzer = {
  name: 'compiler_warnings',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const run = await runCached({
      kind: 'compile',
      source: ctx.source,
      sourceHash: ctx.sourceHash,
      stdin: '',
      compilerOptions: params.flags,
      limits: ctx.limits,
    });

    const parsed = parseGccOutput(run.compileOutput);
    const failedCompile = run.status.code === STATUS.COMPILATION_ERROR;

    // A compiler that rejects the source has more than a warning problem.
    if (failedCompile) {
      return {
        score: 0,
        status: 'ok',
        evidence: {
          errors: parsed.errors.length,
          warnings: parsed.warnings.length,
          diagnostics: parsed.errors.slice(0, 5),
          by_code: parsed.byCode,
          flags: params.flags,
        },
        feedback: parsed.errors[0]
          ? `The compiler rejected the file: ${firstDiagnosticSummary(parsed)}`
          : 'The compiler rejected the file.',
      };
    }

    const warnings = parsed.warnings.length;
    const score = params.warnings_as_errors && warnings > 0 ? 0 : clamp01(1 - warnings * params.penalty_per_warning);

    return {
      score: round3(score),
      status: 'ok',
      evidence: {
        errors: 0,
        warnings,
        diagnostics: parsed.warnings.slice(0, 5),
        by_code: parsed.byCode,
        flags: params.flags,
        warnings_as_errors: params.warnings_as_errors,
      },
      feedback:
        warnings === 0
          ? `Compiled cleanly with ${params.flags}.`
          : `${warnings} warning${warnings === 1 ? '' : 's'} with ${params.flags}${params.warnings_as_errors ? ' (treated as errors)' : ''}.`,
    };
  },
};
