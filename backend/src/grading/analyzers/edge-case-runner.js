import { z } from 'zod';
import { normalizeOutput, sha256Hex } from '../canonical.js';
import { EDGE_CASES } from '../constants.js';
import { generateCases } from '../generators.js';
import { oracleFor } from '../oracle.js';
import { runCached } from '../../execution/compile.js';
import { STATUS } from '../../execution/status.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    cases: z.array(z.enum(EDGE_CASES)).min(1).default(['zero', 'negatives', 'int_overflow', 'whitespace']),
    no_oracle_cap: z.number().min(0).max(1).default(0.5),
    dedupe_tests: z.boolean().default(true),
    max_cases: z.number().int().min(1).max(40).default(20),
  })
  .strict();

const CRASH = new Set([
  STATUS.RUNTIME_ERROR_NZEC,
  STATUS.RUNTIME_ERROR_SIGSEGV,
  STATUS.RUNTIME_ERROR_SIGFPE,
  STATUS.RUNTIME_ERROR_SIGABRT,
  STATUS.RUNTIME_ERROR_OTHER,
]);

/**
 * Boundary cases checked against the reference solution's output.
 *
 * If there is no reference, a crash is still a fact and is reported; an answer
 * that merely differs is not a failure, because we do not know the right
 * answer. That case is labelled `oracle: "none"` and the metric is capped.
 */
export const edgeCaseRunnerAnalyzer = {
  name: 'edge_case_runner',
  supports: ['source', 'stdin'],
  paramsSchema,

  async run(ctx, params) {
    const seen = new Set((ctx.tests ?? []).map((test) => sha256Hex(normalizeOutput(test.stdin ?? ''))));
    const generated = generateCases(params.cases)
      .filter((item) => !params.dedupe_tests || !seen.has(sha256Hex(normalizeOutput(item.stdin))))
      .slice(0, params.max_cases);

    if (!generated.length) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: 'every_generated_case_duplicates_a_trusted_test' },
        feedback: 'Every generated boundary case already appears in the trusted test set, so none was added.',
      };
    }

    const evidence = [];
    let detected = 0;
    let withOracle = 0;
    let crashes = 0;

    for (const item of generated) {
      const oracle = await oracleFor({
        stdin: item.stdin,
        reference: ctx.reference,
        referenceHash: ctx.referenceHash,
        compilerOptions: ctx.compilerOptions,
        limits: ctx.limits,
      });

      const run = await runCached({
        kind: 'edge',
        source: ctx.source,
        sourceHash: ctx.sourceHash,
        stdin: item.stdin,
        compilerOptions: ctx.compilerOptions,
        limits: ctx.limits,
      });

      const got = normalizeOutput(run.stdout);
      const crashed = CRASH.has(run.status.code) || run.status.code === STATUS.TIME_LIMIT_EXCEEDED;
      if (crashed) crashes += 1;

      let failed = crashed;
      let note = item.note;
      if (oracle.oracle === 'reference') {
        withOracle += 1;
        failed = crashed || got !== oracle.expected;
      } else if (!crashed) {
        note = `${note} No reference solution, so only a crash would count as a failure.`;
      }

      if (failed) detected += 1;
      evidence.push({
        case: item.case,
        label: item.label,
        input: item.stdin.slice(0, 200),
        expected: oracle.expected,
        got: got.slice(0, 400),
        detected: failed,
        oracle: oracle.oracle,
        status: run.status.code,
        note,
      });
    }

    const total = evidence.length;
    const noOracle = withOracle === 0;
    const base = 1 - detected / total;
    const score = noOracle ? clamp01(base) * params.no_oracle_cap : clamp01(base);

    return {
      score: round3(score),
      status: noOracle ? 'partial' : 'ok',
      evidence: {
        generated: evidence,
        cases_total: total,
        detected,
        crashes,
        oracle: noOracle ? 'none' : 'reference',
        no_oracle_cap: noOracle ? params.no_oracle_cap : null,
        capped_because: noOracle ? 'No reference solution exists, so correctness could not be asserted.' : null,
      },
      feedback: noOracle
        ? `${crashes} of ${total} boundary cases crashed. Without a reference solution, correctness is capped at ${Math.round(
            params.no_oracle_cap * 100,
          )}%.`
        : detected === 0
          ? `All ${total} boundary cases matched the reference solution.`
          : `${detected} of ${total} boundary cases differ from the reference: ${evidence
              .filter((item) => item.detected)
              .slice(0, 2)
              .map((item) => item.case)
              .join(', ')}.`,
    };
  },
};
