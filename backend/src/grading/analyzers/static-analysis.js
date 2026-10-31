import { z } from 'zod';
import { analyzeC } from '../../analysis/c-metrics.js';
import { clamp01, decayScore, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    max_cyclomatic: z.number().int().min(1).max(50).default(8),
    max_function_length: z.number().int().min(5).max(500).default(40),
    max_nesting: z.number().int().min(1).max(20).default(4),
    scoring: z.enum(['linear', 'step']).default('linear'),
    min_score: z.number().min(0).max(1).default(0),
  })
  .strict();

/**
 * Structure from the parse tree: cyclomatic complexity per function, function
 * length in physical lines, and maximum control-flow nesting. `main` is called
 * out because "everything in main" is the most common structural failure in a
 * first C course.
 */
export const staticAnalysisAnalyzer = {
  name: 'static_analysis',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const analysis = await analyzeC(ctx.source);
    if (!analysis.available) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: analysis.reason },
        feedback: 'The C parser could not read this file, so structure was not scored.',
      };
    }

    const metrics = analysis.metrics;
    const violations = metrics.perFunction
      .map((fn) => {
        const reasons = [];
        if (fn.cyclomatic > params.max_cyclomatic) reasons.push(`cyclomatic ${fn.cyclomatic} > ${params.max_cyclomatic}`);
        if (fn.lines > params.max_function_length) reasons.push(`length ${fn.lines} > ${params.max_function_length}`);
        if (fn.maxNesting > params.max_nesting) reasons.push(`nesting ${fn.maxNesting} > ${params.max_nesting}`);
        return reasons.length ? { name: fn.name, line: fn.startLine, cyclomatic: fn.cyclomatic, lines: fn.lines, nesting: fn.maxNesting, reasons } : null;
      })
      .filter(Boolean);

    const decay = (value, full) => (params.scoring === 'step' ? (value <= full ? 1 : 0) : decayScore(value, full, full * 2));
    const components = {
      cyclomatic: decay(metrics.cyclomaticMax, params.max_cyclomatic),
      function_length: decay(metrics.longestFunction, params.max_function_length),
      nesting: decay(metrics.maxNesting, params.max_nesting),
    };

    const computed = clamp01((components.cyclomatic + components.function_length + components.nesting) / 3);
    const score = Math.max(params.min_score, computed);

    return {
      score: round3(score),
      status: 'ok',
      evidence: {
        parser: metrics.parser,
        total_lines: metrics.totalLines,
        functions: metrics.functions,
        cyclomatic_max: metrics.cyclomaticMax,
        longest_function: metrics.longestFunction,
        max_nesting: metrics.maxNesting,
        main_lines: metrics.mainLines,
        components,
        violations,
        thresholds: {
          max_cyclomatic: params.max_cyclomatic,
          max_function_length: params.max_function_length,
          max_nesting: params.max_nesting,
        },
      },
      feedback: violations.length
        ? `${violations.length} function${violations.length === 1 ? '' : 's'} exceeded a structural limit: ${violations
            .slice(0, 2)
            .map((v) => `${v.name} (${v.reasons.join(', ')})`)
            .join('; ')}.`
        : `Structure is within bounds: worst function has cyclomatic complexity ${metrics.cyclomaticMax} and ${metrics.longestFunction} lines.`,
    };
  },
};
