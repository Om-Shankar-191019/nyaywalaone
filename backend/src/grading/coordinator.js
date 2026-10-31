import { config } from '../config.js';
import { prisma } from '../db.js';
import { sha256Hex } from '../lib/hash.js';
import { AppError } from '../lib/http.js';
import { assertWithinBudget } from '../execution/budget.js';
import { compilerOptionsFrom, limitsFromRules, runCached } from '../execution/compile.js';
import { getToolchainFingerprint } from '../execution/toolchain.js';
import { evaluationKey, reportHash, rulesHash as hashRules, testsetHash } from './canonical.js';
import { compilerWarningsAnalyzer } from './analyzers/compiler-warnings.js';
import { registry } from './registry.js';
import { resolveRules } from './rules.js';
import { clamp01, contributionOf } from './score.js';
import { ANALYZER_VERSIONS, GRADER_VERSION } from './versions.js';

/** One slow analyzer must not hold a request open forever. */
const ANALYZER_TIMEOUT_MS = 90_000;

/** Keys that differ between two identical runs; they never enter a report hash. */
const VOLATILE_KEYS = new Set(['time_ms', 'memory_kb', 'cached', 'durationMs', 'timing', 'compile_ms']);

export function stableEvidence(value) {
  if (Array.isArray(value)) return value.map(stableEvidence);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stableEvidence(item);
    }
    return out;
  }
  return value;
}

/**
 * `toolchain_hash` pins everything outside the source that can change a mark:
 * provider, compiler fingerprint, compiler flags and every analyzer version.
 * `ANALYZER_ANALYZERS` is a frozen map, so the hash is stable for a release.
 */
export async function toolchainHashFor({ provider, compilerOptions, fingerprint }) {
  const pin = {
    provider,
    language_id: config.JUDGE0_LANGUAGE_ID,
    compiler: fingerprint?.hash ?? 'unknown',
    flags: compilerOptions,
    analyzers: ANALYZER_VERSIONS,
    grader: GRADER_VERSION,
  };
  return sha256Hex(JSON.stringify(pin));
}

/** Everything an evaluation key is built from, computed in one place. */
export async function prepareEvaluationKey({ assignment, sourceHash, rules, tests, provider }) {
  const compilerOptions = compilerOptionsFrom(rules);
  const fingerprint = await getToolchainFingerprint(provider);
  const toolchainHash = await toolchainHashFor({ provider, compilerOptions, fingerprint });

  return {
    key: evaluationKey({
      sourceHash,
      rulesHash: hashRules(rules),
      testsetHash: testsetHash(tests),
      toolchainHash,
      graderVersion: GRADER_VERSION,
    }),
    rules_hash: hashRules(rules),
    testset_hash: testsetHash(tests),
    toolchain_hash: toolchainHash,
    compilerOptions,
    fingerprint,
    provider,
    assignmentId: assignment?.id ?? null,
  };
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.()),
  ]);

/** Bounded concurrency that preserves declaration order in the result array. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Integer-hundredths scoring with the `on_unavailable` policy applied to the
 * weights, not to the grade. A metric that could not run is reported as such
 * and the others are renormalised - or, if the rule set says `zero`, left at
 * their declared weight so the missing evidence costs marks.
 */
export function scoreMetrics(metrics, onUnavailable) {
  const total = metrics.reduce((sum, metric) => sum + metric.weight, 0);
  const available = metrics.filter((metric) => metric.status !== 'unavailable' && metric.status !== 'error');
  const availableWeight = available.reduce((sum, metric) => sum + metric.weight, 0);

  const scored = metrics.map((metric) => {
    const isAvailable = available.includes(metric);
    const weight =
      onUnavailable === 'renormalize' && availableWeight > 0
        ? (isAvailable ? (metric.weight * total) / availableWeight : 0)
        : metric.weight;
    const rounded = Math.round(weight * 1e6) / 1e6;
    return {
      ...metric,
      score: Math.round(clamp01(Number.isFinite(metric.score) ? metric.score : 0) * 1e3) / 1e3,
      weight: rounded,
      contribution: contributionOf(metric.score, weight),
    };
  });

  return {
    metrics: scored,
    gradeHundredths: scored.reduce((sum, metric) => sum + metric.contribution, 0),
  };
}

function failureMetric(rule, reason) {
  return {
    name: rule.name,
    analyzer: rule.analyzer,
    weight: rule.weight,
    score: 0,
    status: 'unavailable',
    evidence: { reason },
    feedback: 'Not measured: the program did not compile.',
  };
}

async function loadEvaluation(evaluationId) {
  return prisma.evaluation.findUnique({
    where: { id: evaluationId },
    include: {
      submission: true,
      ruleset: { include: { assignment: { include: { testCases: { orderBy: [{ ordinal: 'asc' }, { name: 'asc' }] } } } } },
      metrics: { orderBy: { ordinal: 'asc' } },
    },
  });
}

/**
 * The coordinator. Loads the frozen rule set, gates on compilation, runs the
 * analyzers through the registry, then writes one immutable evaluation row and
 * its metric results. Every branch ends in a report that says what happened -
 * there is no silent zero.
 */
export async function runEvaluation(evaluationId) {
  const evaluation = await loadEvaluation(evaluationId);
  if (!evaluation) throw new AppError(404, 'NOT_FOUND', 'Evaluation not found');
  if (['RUNNING', 'SUCCEEDED', 'PARTIAL'].includes(evaluation.status)) {
    return { evaluation, skipped: true };
  }

  const assignment = evaluation.ruleset.assignment;
  const submission = evaluation.submission;

  const { rules, errors } = resolveRules(evaluation.ruleset.rules);
  if (errors.length) {
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { status: 'FAILED', failedReason: `invalid_rule_set: ${errors[0].path} ${errors[0].message}`, finishedAt: new Date() },
    });
    throw new AppError(500, 'RULE_SET_INVALID', `Stored rule set cannot be executed: ${errors[0].path} ${errors[0].message}`);
  }

  await prisma.evaluation.update({ where: { id: evaluation.id }, data: { status: 'RUNNING' } });

  const provider = evaluation.provider;
  const compilerOptions = compilerOptionsFrom(rules);
  const limits = limitsFromRules(rules.limits);
  const tests = assignment.testCases.map((test) => ({
    name: test.name,
    stdin: test.stdin,
    expectedStdout: test.expectedStdout,
    isHidden: test.isHidden,
  }));
  const referenceHash = assignment.referenceSolution ? sha256Hex(assignment.referenceSolution) : null;

  const corpus =
    (await prisma.submission.findMany({
      // A student's own earlier attempts are not a similarity signal.
      where: { assignmentId: assignment.id, studentId: { not: submission.studentId } },
      select: { id: true, studentId: true, source: true, sourceHash: true, attempt: true },
    })) ?? [];

  const ctx = {
    source: submission.source,
    sourceHash: submission.sourceHash,
    submissionId: submission.id,
    assignmentId: assignment.id,
    studentId: submission.studentId,
    tests,
    reference: assignment.referenceSolution,
    referenceHash,
    compilerOptions,
    limits,
    corpus,
    provider,
    allowNoOracle: assignment.allowNoOracle,
    flags: {},
  };

  try {
    await assertWithinBudget(provider);
  } catch (error) {
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { status: 'FAILED', failedReason: 'budget_exhausted', finishedAt: new Date() },
    });
    throw error;
  }

  const gate = await runCached({
    kind: 'compile',
    source: ctx.source,
    sourceHash: ctx.sourceHash,
    compilerOptions,
    limits,
  });

  let results;
  let partial = false;
  let failedReason = null;

  // The provider compiles and then runs the program, so a zero exit code is
  // not required to prove compilation. A compile error is either the compiler
  // status, or an `error:` line in the compiler output.
  const compileFailed =
    gate.status.code === 'COMPILATION_ERROR' || /(^|\n)[^\n]*\berror:/.test(String(gate.compileOutput ?? ''));

  if (compileFailed) {
    partial = true;
    failedReason = 'compile_error';
    results = rules.metrics.map((rule) => {
      if (rule.analyzer === compilerWarningsAnalyzer.name) {
        return {
          ...failureMetric(rule, 'compile_error'),
          status: 'ok',
          score: 0,
          evidence: { compile_errors: (gate.compileOutput ?? '').split('\n').filter(Boolean).length, compile_output: String(gate.compileOutput ?? '').slice(0, 4000) },
          feedback: 'The program does not compile, so nothing could be measured.',
        };
      }
      return failureMetric(rule, 'compile_error');
    });
  } else {
    // The program compiled. Its exit status on empty stdin is the analyzers'
    // business, not the gate's.
    results = await mapLimit(rules.metrics, config.GRADING_CONCURRENCY, async (rule) => {
      const base = { name: rule.name, analyzer: rule.analyzer, weight: rule.weight };
      const analyzer = registry.get(rule.analyzer);
      if (!analyzer) {
        return { ...base, score: 0, status: 'error', evidence: { reason: 'analyzer_missing' }, feedback: 'This metric could not run: the analyzer is not registered.' };
      }
      // A submission that already hit the time limit is not re-run for edge cases.
      if (ctx.flags.suspected_infinite_loop && ['edge_case_runner', 'memory_audit'].includes(rule.analyzer)) {
        return {
          ...base,
          score: 0,
          status: 'unavailable',
          evidence: { reason: 'skipped_after_time_limit' },
          feedback: 'Skipped because an earlier test exceeded its time limit.',
        };
      }

      try {
        const outcome = await withTimeout(analyzer.run(ctx, rule.params), ANALYZER_TIMEOUT_MS, rule.analyzer);
        if (outcome?.evidence?.suspected_infinite_loop) ctx.flags.suspected_infinite_loop = true;
        return {
          ...base,
          score: Number.isFinite(outcome?.score) ? outcome.score : 0,
          status: outcome?.status ?? 'ok',
          evidence: outcome?.evidence ?? {},
          feedback: String(outcome?.feedback ?? ''),
        };
      } catch (error) {
        if (error instanceof AppError && error.status === 429) throw error;
        return {
          ...base,
          score: 0,
          status: 'error',
          evidence: { reason: String(error.message ?? error).slice(0, 300) },
          feedback: `The ${rule.name} check could not complete, so it is reported as unavailable rather than as a zero.`,
        };
      }
    });
  }

  const { metrics, gradeHundredths } = scoreMetrics(results, rules.on_unavailable);
  // `partial` is a legitimate result with a caveat; only missing evidence
  // (unavailable/error) makes the whole evaluation PARTIAL.
  if (metrics.some((metric) => metric.status === 'unavailable' || metric.status === 'error')) partial = true;

  const similarity = metrics.find((metric) => metric.analyzer === 'similarity_flag');
  const topMatch = similarity?.evidence?.top_match;
  if (similarity?.evidence?.identical || (topMatch && Number(topMatch.similarity) >= 0.85)) {
    const [a, b] = [submission.id, topMatch?.submission_id].filter(Boolean).sort();
    if (a && b && a !== b) {
      await prisma.similarityMatch
        .upsert({
          where: { submissionA_submissionB_method: { submissionA: a, submissionB: b, method: 'minhash-128' } },
          create: {
            assignmentId: assignment.id,
            submissionA: a,
            submissionB: b,
            similarity: Number(topMatch?.similarity ?? 1),
            method: 'minhash-128',
            matchedSpan: topMatch?.sample ? { sample: topMatch.sample } : undefined,
          },
          update: { similarity: Number(topMatch?.similarity ?? 1) },
        })
        .catch(() => {});
    }
  }

  const fingerprint = await getToolchainFingerprint(provider).catch(() => null);
  const reportView = buildReportView({
    evaluation,
    submission,
    assignment,
    ruleset: evaluation.ruleset,
    rules,
    metrics,
    tests,
    fingerprint,
    partial,
    failedReason,
  });

  await prisma.$transaction([
    prisma.metricResult.deleteMany({ where: { evaluationId: evaluation.id } }),
    ...metrics.map((metric, index) =>
      prisma.metricResult.create({
        data: {
          evaluationId: evaluation.id,
          name: metric.name,
          analyzer: metric.analyzer,
          score: metric.score,
          weight: metric.weight,
          contribution: metric.contribution,
          status: metric.status,
          evidence: stableEvidence(metric.evidence ?? {}),
          feedback: metric.feedback ?? '',
          ordinal: index,
        },
      }),
    ),
    prisma.evaluation.update({
      where: { id: evaluation.id },
      data: {
        status: partial ? 'PARTIAL' : 'SUCCEEDED',
        gradeHundredths,
        reportHash: reportView.hash,
        failedReason,
        finishedAt: new Date(),
      },
    }),
  ]);

  return { evaluation: await loadEvaluation(evaluation.id), gradeHundredths, partial };
}

/**
 * What the report hash covers. The evaluation row's own id and key identify
 * this run, not what it produced: a regrade salts the key on purpose, so
 * hashing them would make an identical grade look different. Both stay in the
 * report; neither enters the hash.
 */
const reportContent = (report) => ({
  ...report,
  evaluation: { ...report.evaluation, id: undefined, key: undefined },
});

/**
 * The report payload. Pure: same rows in, same bytes out. `timing`-class keys
 * are removed by `stableEvidence`, so the hash survives a cache-hot rerun.
 */
export function buildReportView({ evaluation, submission, assignment, ruleset, rules, metrics, tests, fingerprint, partial, failedReason }) {
  const flags = {
    review_recommended: metrics.filter((metric) => metric.status !== 'ok').map((metric) => metric.name),
    suspected_infinite_loop: metrics.some((metric) => metric.evidence?.suspected_infinite_loop),
    identical_copy: Boolean(metrics.find((m) => m.analyzer === 'similarity_flag')?.evidence?.identical),
    no_oracle: Boolean(metrics.find((m) => m.analyzer === 'edge_case_runner')?.evidence?.no_oracle),
  };

  const limitations = [];
  if (!assignment.referenceSolution) limitations.push('No reference solution is set, so edge cases are checked for well-formed output only.');
  if (!tests.length) limitations.push('No test cases are attached to this assignment, so correctness and edge cases are unmeasured.');
  if (metrics.some((metric) => metric.analyzer === 'llm_review' && metric.status === 'unavailable')) {
    limitations.push('The optional language-model review is not configured or not enabled for this rule set.');
  }
  if (failedReason === 'compile_error') limitations.push('The program did not compile; every metric except syntax is reported as unavailable.');

  const report = {
    schema_version: '2.0',
    grader_version: GRADER_VERSION,
    evaluation: {
      id: evaluation.id,
      key: evaluation.evaluationKey,
      status: partial ? 'PARTIAL' : 'SUCCEEDED',
      provider: evaluation.provider,
      toolchain_hash: evaluation.toolchainFingerprint,
    },
    submission: {
      id: submission.id,
      assignment_id: submission.assignmentId,
      student_id: submission.studentId,
      attempt: submission.attempt,
      filename: submission.filename,
      size_bytes: submission.sizeBytes,
      source_hash: submission.sourceHash,
    },
    rule_set: {
      id: ruleset.id,
      version: ruleset.version,
      rules_hash: hashRules(rules),
      problem: rules.problem,
    },
    testset: {
      hash: testsetHash(tests),
      count: tests.length,
      names: tests.map((test) => test.name),
    },
    grade: {
      hundredths: Math.max(0, Math.min(10_000, metrics.reduce((sum, metric) => sum + metric.contribution, 0))),
      percent: Math.round(metrics.reduce((sum, metric) => sum + metric.contribution, 0)) / 100,
    },
    metrics: metrics.map((metric, index) => ({
      name: metric.name,
      analyzer: metric.analyzer,
      ordinal: index,
      score: Math.round(clamp01(metric.score) * 1e3) / 1e3,
      weight: Math.round(metric.weight * 1e6) / 1e6,
      contribution: metric.contribution,
      status: metric.status,
      feedback: metric.feedback ?? '',
      evidence: stableEvidence(metric.evidence ?? {}),
    })),
    flags,
    toolchain: {
      provider: evaluation.provider,
      compiler_version: fingerprint?.compilerVersion ?? 'unknown',
      stdc_version: fingerprint?.stdcVersion ?? 'unknown',
      pointer_bits: fingerprint?.pointerBits ?? 0,
      fingerprint_hash: fingerprint?.hash ?? 'unknown',
      analyzer_versions: ANALYZER_VERSIONS,
    },
    limitations,
  };

  return { report, hash: reportHash(reportContent(report)) };
}

/** Plain-text report, for the "Download .txt" button and for email later. */
export function renderReportText(view) {
  const { report } = view;
  const lines = [
    `Nyaywala evaluation report`,
    `Submission      ${report.submission.id} (attempt ${report.submission.attempt})`,
    `Assignment      ${report.submission.assignment_id}`,
    `Rule set        v${report.rule_set.version}  ${report.rule_set.problem}`,
    `Evaluation key  ${report.evaluation.key}`,
    `Grader          ${report.grader_version}   provider ${report.evaluation.provider}`,
    `Toolchain       gcc ${report.toolchain.compiler_version}  (${report.toolchain.fingerprint_hash.slice(0, 12)})`,
    '',
    `GRADE           ${report.grade.percent.toFixed(2)} / 100`,
    '',
    'Metric                 Analyzer               Score  Weight  Contrib  Status',
    '---------------------------------------------------------------------------',
    ...report.metrics.map(
      (metric) =>
        `${metric.name.padEnd(22).slice(0, 22)} ${metric.analyzer.padEnd(22).slice(0, 22)} ${metric.score
          .toFixed(2)
          .padStart(5)}  ${metric.weight.toFixed(2).padStart(6)}  ${String(metric.contribution).padStart(7)}  ${metric.status}`,
    ),
    '',
    ...report.metrics.filter((metric) => metric.feedback).map((metric) => `- ${metric.name}: ${metric.feedback}`),
    '',
    ...(report.flags.review_recommended.length ? [`Review recommended: ${report.flags.review_recommended.join(', ')}`] : []),
    ...(report.flags.suspected_infinite_loop ? ['Suspected infinite loop: an earlier test exceeded its time limit.'] : []),
    ...(report.flags.identical_copy ? ['Identical copy: an exact source match was found in this assignment.'] : []),
    ...(report.limitations.length ? ['', 'Limitations', ...report.limitations.map((line) => `- ${line}`)] : []),
    '',
    'Scores are reproducible from the evaluation key; wall-clock timings are excluded from the report hash.',
  ];
  return `${lines.join('\n')}\n`;
}

/** Rebuild the same report from persisted rows (GET /report). */
export async function reportForEvaluation(evaluationId) {
  const evaluation = await loadEvaluation(evaluationId);
  if (!evaluation) throw new AppError(404, 'NOT_FOUND', 'Evaluation not found');
  const assignment = evaluation.ruleset.assignment;
  const { rules } = resolveRules(evaluation.ruleset.rules);
  const fingerprint = await prisma.toolchainFingerprint.findFirst({
    where: { provider: evaluation.provider },
    orderBy: { capturedAt: 'desc' },
  });

  const metrics = evaluation.metrics.map((metric) => ({
    name: metric.name,
    analyzer: metric.analyzer,
    score: metric.score,
    weight: metric.weight,
    contribution: metric.contribution,
    status: metric.status,
    feedback: metric.feedback,
    evidence: metric.evidence ?? {},
  }));

  const pdf = buildReportView({
    evaluation,
    submission: evaluation.submission,
    assignment,
    ruleset: evaluation.ruleset,
    rules,
    metrics,
    tests: assignment.testCases.map((test) => ({ name: test.name, stdin: test.stdin, expectedStdout: test.expectedStdout })),
    fingerprint,
    partial: evaluation.status === 'PARTIAL',
    failedReason: evaluation.failedReason,
  });

  return {
    json: pdf.report,
    text: renderReportText(pdf),
    hash: pdf.hash,
    storedHash: evaluation.reportHash,
    verified: evaluation.reportHash ? evaluation.reportHash === pdf.hash : false,
  };
}
