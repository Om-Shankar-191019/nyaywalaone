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
 * Syntax health: compile the file and count what the compiler said.
 *
 * The flags are part of the rules file, and the compiler is pinned by the
 * toolchain fingerprint, so "0 warnings" means something specific rather than
 * "whatever compiler happened to be installed".
 *
 * Some sandboxes cannot be told which flags to use - onlinecompiler.io compiles
 * with a fixed `gcc -O2` and has no options field. In that case the metric still
 * runs (a compile failure is a compile failure whatever the flags), but it is
 * reported as `partial` and the feedback says exactly which diagnostics were
 * unavailable. Silently claiming a clean `-Wall` compile would be a lie of
 * omission, and it would change the grade without changing the code.
 */
export const compilerWarningsAnalyzer = {
  name: 'compiler_warnings',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const supportsFlags = ctx.capabilities?.compilerFlags ?? true;
    const flags = supportsFlags ? params.flags : null;

    const run = await runCached({
      kind: 'compile',
      source: ctx.source,
      sourceHash: ctx.sourceHash,
      stdin: '',
      compilerOptions: flags,
      limits: ctx.limits,
    });

    const parsed = parseGccOutput(run.compileOutput);
    const failedCompile =
      run.status.code === STATUS.COMPILATION_ERROR || /(^|\n)[^\n]*\berror:/.test(String(run.compileOutput ?? ''));

    // A compiler that rejects the source has more than a warning problem.
    if (failedCompile) {
      return {
        score: 0,
        status: 'ok',
        evidence: {
          errors: Math.max(1, parsed.errors.length),
          warnings: parsed.warnings.length,
          diagnostics: parsed.errors.slice(0, 5),
          by_code: parsed.byCode,
          flags_requested: params.flags,
          flags_applied: flags,
        },
        feedback: parsed.errors[0]
          ? `The compiler rejected the file: ${firstDiagnosticSummary(parsed)}`
          : 'The compiler rejected the file.',
      };
    }

    const warnings = parsed.warnings.length;
    const score = params.warnings_as_errors && warnings > 0 ? 0 : clamp01(1 - warnings * params.penalty_per_warning);

    if (!supportsFlags) {
      return {
        score: round3(score),
        status: 'partial',
        evidence: {
          errors: 0,
          warnings,
          diagnostics: parsed.warnings.slice(0, 5),
          by_code: parsed.byCode,
          flags_requested: params.flags,
          flags_applied: null,
          warnings_as_errors: params.warnings_as_errors,
          reason: 'provider_has_no_compiler_flags',
        },
        feedback:
          warnings === 0
            ? `Compiled without errors. The sandbox uses a fixed compile line, so the ${params.flags} diagnostics requested by this rule set were not available.`
            : `Compiled with ${warnings} warning${warnings === 1 ? '' : 's'} from the compiler's default set; ${params.flags} could not be applied on this sandbox.`,
      };
    }

    return {
      score: round3(score),
      status: 'ok',
      evidence: {
        errors: 0,
        warnings,
        diagnostics: parsed.warnings.slice(0, 5),
        by_code: parsed.byCode,
        flags_requested: params.flags,
        flags_applied: flags,
        warnings_as_errors: params.warnings_as_errors,
      },
      feedback:
        warnings === 0
          ? `Compiled cleanly with ${params.flags}.`
          : `${warnings} warning${warnings === 1 ? '' : 's'} with ${params.flags}${params.warnings_as_errors ? ' (treated as errors)' : ''}.`,
    };
  },
};
