import { z } from 'zod';
import { normalizeOutput } from '../canonical.js';
import { runCached } from '../../execution/compile.js';
import { STATUS } from '../../execution/status.js';
import { clamp01, round3 } from '../score.js';

export const paramsSchema = z
  .object({
    testset: z.string().default('assignment'),
    partial_credit: z.boolean().default(true),
    max_stored_output: z.number().int().min(64).max(16_384).default(4096),
  })
  .strict();

const FAILURE_STATUS = {
  [STATUS.WRONG_ANSWER]: 'wrong_answer',
  [STATUS.TIME_LIMIT_EXCEEDED]: 'time_limit_exceeded',
  [STATUS.RUNTIME_ERROR_NZEC]: 'runtime_error',
  [STATUS.RUNTIME_ERROR_SIGSEGV]: 'runtime_error',
  [STATUS.RUNTIME_ERROR_SIGFPE]: 'runtime_error',
  [STATUS.RUNTIME_ERROR_SIGABRT]: 'runtime_error',
  [STATUS.RUNTIME_ERROR_OTHER]: 'runtime_error',
  [STATUS.INTERNAL_ERROR]: 'internal_error',
  [STATUS.EXEC_FORMAT_ERROR]: 'exec_format_error',
  [STATUS.COMPILATION_ERROR]: 'compile_error',
};

const store = (text, limit) => String(text ?? '').slice(0, limit);

/**
 * Correctness: every trusted test, compared after the documented
 * normalisation. Internal whitespace is not ignored - `1 2` and `1  2` are
 * different answers - but trailing spaces and CRLF are formatting, not logic.
 */
export const ioTestAnalyzer = {
  name: 'io_tests',
  supports: ['source', 'stdin'],
  paramsSchema,

  async run(ctx, params) {
    const tests = ctx.tests ?? [];
    if (!tests.length) {
      return {
        score: 0,
        status: 'unavailable',
        evidence: { reason: 'no_test_cases', tests_total: 0 },
        feedback: 'This assignment has no test cases yet, so correctness could not be measured.',
      };
    }

    const failing = [];
    const results = [];
    let passed = 0;
    let timedOut = 0;

    for (const test of tests) {
      const run = await runCached({
        kind: 'test',
        source: ctx.source,
        sourceHash: ctx.sourceHash,
        stdin: test.stdin ?? '',
        compilerOptions: ctx.compilerOptions,
        limits: ctx.limits,
      });

      if (run.status.code === STATUS.COMPILATION_ERROR) {
        return {
          score: 0,
          status: 'unavailable',
          evidence: { reason: 'compile_error', compile_output: store(run.compileOutput, 2000) },
          feedback: 'The program did not compile, so no test could run.',
        };
      }

      const got = normalizeOutput(run.stdout);
      const expected = normalizeOutput(test.expectedStdout);
      const accepted = run.status.code === STATUS.ACCEPTED;
      const match = accepted && got === expected;

      if (match) passed += 1;
      if (run.status.code === STATUS.TIME_LIMIT_EXCEEDED) timedOut += 1;

      if (!match && failing.length < 3) {
        failing.push({
          name: test.name,
          input: store(test.stdin, params.max_stored_output),
          expected: store(expected, params.max_stored_output),
          got: store(got, params.max_stored_output),
          status: FAILURE_STATUS[run.status.code] ?? 'wrong_answer',
          detail: run.status.detail ?? null,
          stderr: store(run.stderr, 500),
        });
      }

      results.push({
        name: test.name,
        passed: match,
        status: FAILURE_STATUS[run.status.code] ?? (match ? 'accepted' : 'wrong_answer'),
        time_ms: run.timeMs,
        memory_kb: run.memoryKb,
        cached: run.cached,
      });
    }

    const total = tests.length;
    const ratio = total ? passed / total : 0;
    const score = params.partial_credit ? ratio : passed === total ? 1 : 0;
    const suspectedInfiniteLoop = timedOut > 0 && timedOut === total;

    return {
      score: round3(clamp01(score)),
      status: 'ok',
      evidence: {
        tests_passed: passed,
        tests_total: total,
        failing,
        results,
        suspected_infinite_loop: suspectedInfiniteLoop,
        testset: params.testset,
      },
      feedback:
        passed === total
          ? `All ${total} test${total === 1 ? '' : 's'} passed.`
          : `${passed} of ${total} tests passed.${failing[0] ? ` First failure: "${failing[0].name}" - expected ${JSON.stringify(failing[0].expected)}, got ${JSON.stringify(failing[0].got)}.` : ''}`,
    };
  },
};
