import { z } from 'zod';
import { analyzeC } from '../../analysis/c-metrics.js';
import { clamp01, decayScore, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    min_functions: z.number().int().min(1).max(20).default(2),
    expect_helpers: z.boolean().default(true),
    max_main_lines: z.number().int().min(5).max(500).default(25),
  })
  .strict();

/**
 * Modularity: is the work split into functions, is `main` short, is there at
 * least one helper? Deliberately coarse - it is a first-year C course, not a
 * style contest.
 */
export const functionSplitAnalyzer = {
  name: 'function_split',
  supports: ['source'],
  paramsSchema,

  async run(ctx, params) {
    const analysis = await analyzeC(ctx.source);
    if (!analysis.available) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: analysis.reason },
        feedback: 'The C parser could not read this file, so modularity was not scored.',
      };
    }

    const functions = analysis.metrics.perFunction;
    const helpers = functions.filter((fn) => fn.name !== 'main');
    const main = functions.find((fn) => fn.name === 'main');
    const mainLines = main?.lines ?? 0;

    const countScore = functions.length >= params.min_functions ? 1 : clamp01(functions.length / params.min_functions);
    const helperScore = params.expect_helpers ? (helpers.length >= 1 ? 1 : 0) : 1;
    const mainScore = decayScore(mainLines, params.max_main_lines, params.max_main_lines * 2);

    const score = clamp01(0.4 * countScore + 0.2 * helperScore + 0.4 * mainScore);

    return {
      score: round3(score),
      status: 'ok',
      evidence: {
        functions: functions.length,
        helpers: helpers.length,
        main_lines: mainLines,
        components: { count: countScore, helpers: helperScore, main: mainScore },
        thresholds: {
          min_functions: params.min_functions,
          max_main_lines: params.max_main_lines,
          expect_helpers: params.expect_helpers,
        },
        function_list: functions.map((fn) => ({ name: fn.name, lines: fn.lines, line: fn.startLine })),
      },
      feedback:
        functions.length < params.min_functions
          ? `Only ${functions.length} function${functions.length === 1 ? '' : 's'}; the rules expect at least ${params.min_functions}.`
          : mainLines > params.max_main_lines
            ? `main is ${mainLines} lines; the rules allow ${params.max_main_lines}. Move logic into a helper.`
            : `Split into ${functions.length} functions with main at ${mainLines} lines.`,
    };
  },
};
