import { z } from 'zod';
import { estimateComplexity, orderRank } from '../../analysis/complexity.js';
import { ORDER_CLASSES } from '../constants.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    required: z.enum(ORDER_CLASSES).default('O(1)'),
    sizes: z.array(z.number().int().positive()).max(10).default([1, 10, 100]),
    mode: z.enum(['static']).default('static'),
    timing_evidence: z.boolean().default(false),
  })
  .strict();

/**
 * Complexity from the AST. A class that is one band over decays by a quarter
 * per step; two bands over is half credit; and so on. Timing, when requested,
 * is evidence only - it is never multiplied by the weight.
 */
export const complexityAnalyzer = {
  name: 'complexity_estimator',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const result = await estimateComplexity(ctx.source);
    if (!result.available) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: result.reason, required: params.required },
        feedback: 'The C parser could not read this file, so complexity was not scored.',
      };
    }

    const actualRank = orderRank(result.orderClass);
    const requiredRank = orderRank(params.required);
    const over = Math.max(0, actualRank - requiredRank);
    const score = result.orderClass === 'unknown' ? 0 : clamp01(1 - over * 0.25);

    const evidence = {
      order_class: result.orderClass,
      required: params.required,
      bands_over: over,
      max_nesting: result.maxNesting,
      per_function: result.perFunction,
      mode: 'static',
    };

    if (params.timing_evidence) {
      // A size-parameterised timing run needs an input contract the rules file
      // does not have; stating that is better than inventing a curve.
      evidence.timing = {
        status: 'skipped',
        note: 'Timing evidence needs a size-parameterised input contract; the grade is static.',
        sizes: params.sizes,
      };
    }

    return {
      score: round3(score),
      status: score > 0 ? 'ok' : 'partial',
      evidence,
      feedback:
        actualRank <= requiredRank
          ? `Loops and recursion put this at ${result.orderClass}, within the required ${params.required}.`
          : `Estimated ${result.orderClass}, but the rules require ${params.required}. One factor of growth per extra nesting level.`,
    };
  },
};
