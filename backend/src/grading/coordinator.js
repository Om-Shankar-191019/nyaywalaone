import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { sha256Hex } from '../lib/hash.js';
import { AppError } from '../lib/http.js';
import { assertWithinBudget } from '../execution/budget.js';
import { compilerOptionsFrom, limitsFromRules, requestedCompilerOptions, runCached } from '../execution/compile.js';
import { clampLimitsFor } from '../execution/limits.js';
import { capabilitiesOf } from '../execution/provider.js';
import { getToolchainFingerprint } from '../execution/toolchain.js';
import { evaluationKey, reportHash, rulesHash as hashRules, testsetHash } from './canonical.js';
import { compilerWarningsAnalyzer } from './analyzers/compiler-warnings.js';
import { registry } from './registry.js';
import { resolveRules } from './rules.js';
import { clamp01, contributionOf } from './score.js';
import { ANALYZER_VERSIONS, GRADER_VERSION } from './versions.js';

import { capabilitiesOf as capabilitiesFor } from '../execution/provider.js';

/**
 * The limitations wording lives in one versioned file (Day 20). Inlining these
 * strings meant three branches of the coordinator could describe the same caveat
 * three slightly different ways, and the text report drifted from the JSON.
 */
const LIMITATIONS = JSON.parse(readFileSync(new URL('./limitations.json', import.meta.url), 'utf8'));

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
    // The compiler identity is the fingerprint, not a Judge0 language id: Week 3
    // runs on onlinecompiler.io, where `gcc-15` is the pin and a Judge0 id is
    // just a number that never reached a compiler.
    compiler: fingerprint?.hash ?? 'unknown',
    // `null` means the sandbox chose the flags. Encoding that as a string keeps
    // "provider default" distinct from any flag string a rule set could declare.
    flags: compilerOptions ?? 'provider-default',
    analyzers: ANALYZER_VERSIONS,
    grader: GRADER_VERSION,
  };
  return sha256Hex(JSON.stringify(pin));
}

/** Everything an evaluation key is built from, computed in one place. */
export async function prepareEvaluationKey({ assignment, sourceHash, rules, tests, provider }) {
  const compilerOptions = compilerOptionsFrom(rules, provider);
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

/**
 * Marks for a program that never ran.
 *
 * The credit is added to the grade rather than folded into a weight, because
 * every metric that carries weight is `unavailable` on a compile error. The
 * analyzer produces a 0-1 confidence and the rule's `max_credit` caps it, so a
 * confidently-read program can recover at most 40% by default. Returns null
 * when the rule set has no recovery metric, so nothing changes for rule sets
 * that do not want this.
 */
export function recoveryCreditFor({ metrics, rules }) {
  const metric = metrics.find((item) => item.analyzer === 'llm_compile_recovery');
  if (!metric || metric.status === 'unavailable' || metric.status === 'error') return null;
  const rule = rules.metrics.find((item) => item.analyzer === 'llm_compile_recovery');
  const maxCredit = Math.min(0.6, Math.max(0, Number(rule?.params?.max_credit ?? 0.4)));
  const logicSound = Boolean(metric.evidence?.logic_sound);
  const confidence = clamp01(Number(metric.evidence?.confidence ?? metric.score ?? 0));
  const awarded = logicSound ? Math.round(confidence * maxCredit * 10_000) : 0;
  return {
    logic_sound: logicSound,
    confidence: Math.round(confidence * 1000) / 1000,
    max_credit: maxCredit,
    awarded_hundredths: awarded,
    errors: Array.isArray(metric.evidence?.errors) ? metric.evidence.errors.slice(0, 6) : [],
    explanation: String(metric.evidence?.summary ?? metric.feedback ?? '').slice(0, 1200),
    corrected_source: typeof metric.evidence?.corrected_source === 'string' ? metric.evidence.corrected_source : null,
    provider: metric.evidence?.provider ?? null,
    model: metric.evidence?.model ?? null,
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
  // Only a *terminal* row is skipped. RUNNING means the caller already claimed
  // the row - the queue claim stamps RUNNING before grading - so skipping it
  // there stranded every drained evaluation in RUNNING forever, and the next
  // drain skipped it again for the same reason.
  if (['SUCCEEDED', 'PARTIAL'].includes(evaluation.status)) {
    return { evaluation, skipped: true };
  }

  const assignment = evaluation.ruleset.assignment;
  const submission = evaluation.submission;

  const { rules, errors } = resolveRules(evaluation.ruleset.rules);
  if (errors.length) {
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: {
        status: 'FAILED',
        stage: 'failed',
        failedReason: `invalid_rule_set: ${errors[0].path} ${errors[0].message}`,
        finishedAt: new Date(),
      },
    });
    throw new AppError(500, 'RULE_SET_INVALID', `Stored rule set cannot be executed: ${errors[0].path} ${errors[0].message}`);
  }

  await prisma.evaluation.update({ where: { id: evaluation.id }, data: { status: 'RUNNING', stage: 'compiling' } });

  const provider = evaluation.provider;
  // What this sandbox can actually be asked to do. Everything downstream - the
  // compiler flags, the limits, the report's limitations block - reads this
  // rather than assuming Judge0's feature set.
  const capabilities = capabilitiesOf(provider);
  const compilerOptions = compilerOptionsFrom(rules, provider);
  const limits = clampLimitsFor(capabilities, limitsFromRules(rules.limits));
  const setStage = (stage) =>
    prisma.evaluation.update({ where: { id: evaluation.id }, data: { stage } }).catch(() => {});
  const tests = assignment.testCases.map((test) => ({
    name: test.name,
    stdin: test.stdin,
    expectedStdout: test.expectedStdout,
    isHidden: test.isHidden,
  }));
  const referenceHash = assignment.referenceSolution ? sha256Hex(assignment.referenceSolution) : null;

  const corpusSelect = {
    id: true,
    studentId: true,
    source: true,
    sourceHash: true,
    attempt: true,
    // Cached signatures make the pairwise compare integer-only when the same
    // parameters are used, instead of re-tokenising every peer per grade.
    signature: true,
    signatureParams: true,
  };

  const corpus =
    (await prisma.submission.findMany({
      // A student's own earlier attempts are not a similarity signal.
      where: { assignmentId: assignment.id, studentId: { not: submission.studentId } },
      select: corpusSelect,
    })) ?? [];

  // `assignment+archive` widens the corpus to previous assignments in the same
  // course - never to other instructors' courses, which would leak one class's
  // work into another's similarity evidence.
  const similarityRule = rules.metrics.find((metric) => metric.analyzer === 'similarity_flag');
  const wantsArchive = similarityRule?.params?.corpus === 'assignment+archive';
  let archiveCount = 0;
  if (wantsArchive) {
    const archive = await prisma.submission.findMany({
      where: {
        assignmentId: { not: assignment.id },
        assignment: { courseId: assignment.courseId },
        studentId: { not: submission.studentId },
      },
      select: corpusSelect,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    archiveCount = archive.length;
    corpus.push(...archive);
  }

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
    requestedCompilerOptions: requestedCompilerOptions(rules),
    limits,
    capabilities,
    corpus,
    provider,
    allowNoOracle: assignment.allowNoOracle,
    assignmentTitle: assignment.title,
    archiveCount,
    flags: {},
  };

  try {
    await assertWithinBudget(provider);
  } catch (error) {
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { status: 'FAILED', stage: 'failed', failedReason: 'budget_exhausted', finishedAt: new Date() },
    });
    throw error;
  }

  // An empty file never reaches the provider: the API rejects it as a bad
  // request, which would surface as a 502 instead of the compile error it is.
  // The corpus includes an empty submission precisely to keep this honest.
  const emptySource = !String(ctx.source ?? '').trim();
  const gate = emptySource
    ? { status: { code: 'COMPILATION_ERROR', id: null, description: 'Empty source', detail: 'empty_source' }, stdout: '', stderr: '', compileOutput: '' }
    : await runCached({
        kind: 'compile',
        source: ctx.source,
        sourceHash: ctx.sourceHash,
        compilerOptions,
        limits,
      });

  await setStage('testing');

  let results;
  let partial = false;
  let failedReason = null;

  // The provider compiles and then runs the program, so a zero exit code is
  // not required to prove compilation. A compile error is either the compiler
  // status, or an `error:` line in the compiler output.
  const compileFailed =
    gate.status.code === 'COMPILATION_ERROR' || /(^|\n)[^\n]*\berror:/.test(String(gate.compileOutput ?? ''));

  ctx.compileOutput = String(gate.compileOutput ?? '');

  /**
   * One rule, one metric row. Lifted out of the success branch because the
   * compile-failure branch now runs analyzers too: a language model can read a
   * program that never compiled, and that is exactly when a student needs it.
   */
  const runRule = async (rule) => {
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
  };

  if (compileFailed) {
    partial = true;
    failedReason = 'compile_error';
    results = rules.metrics.map((rule) => {
      if (rule.analyzer === compilerWarningsAnalyzer.name) {
        return {
          ...failureMetric(rule, 'compile_error'),
          status: 'ok',
          score: 0,
          evidence: { compile_errors: ctx.compileOutput.split('\n').filter(Boolean).length, compile_output: ctx.compileOutput.slice(0, 4000) },
          feedback: 'The program does not compile, so nothing could be measured.',
        };
      }
      return failureMetric(rule, 'compile_error');
    });

    // Only analyzers that opt in run without a compiled binary: the recovery
    // review, plus the two that read text alone (readability and originality).
    // Everything else has already been reported as unavailable, which is the
    // honest answer.
    ctx.metrics = results.map((metric) => ({ ...metric, contribution: 0 }));
    const recoveryRules = rules.metrics.filter((rule) => {
      const analyzer = registry.get(rule.analyzer);
      return Boolean(analyzer?.onCompileFailure || analyzer?.runsWithoutBinary);
    });
    if (recoveryRules.length) {
      // Replace the placeholder row, never append: the rule set already named
      // this metric, and metric_results is unique on (evaluation, name).
      const done = new Map(results.map((row) => [row.name, row]));
      // Same two-at-a-time rule as the normal pass: three text reviews on a file
      // that never compiled should not add 15 s of waiting.
      const rows = await mapLimit(recoveryRules, 2, runRule);
      for (const row of rows) done.set(row.name, row);
      results = rules.metrics.map((rule) => done.get(rule.name)).filter(Boolean);
    }
  } else {
    // The program compiled. Its exit status on empty stdin is the analyzers'
    // business, not the gate's.
    await setStage('analyzing');
    // Deferred analyzers need the marks, so they run in a second pass. Running
    // them in the first pass as well would duplicate their rows; running the
    // second pass sequentially keeps four model calls from arriving at a free
    // tier as a burst.
    const deferred = rules.metrics.filter((rule) => registry.get(rule.analyzer)?.needsMetrics);
    const immediate = rules.metrics.filter((rule) => !deferred.includes(rule));
    results = await mapLimit(immediate, config.GRADING_CONCURRENCY, runRule);

    if (deferred.length) {
      ctx.metrics = results.map((metric) => ({
        ...metric,
        contribution: contributionOf(metric.score ?? 0, metric.weight ?? 0),
      }));
      const done = new Map(results.map((row) => [row.name, row]));
      // Two at a time: the client's own semaphore caps concurrency anyway, and
      // sequential made a grade wait ~6 s per analyzer. This is the difference
      // between a 12 s report and a spinner long enough to look broken.
      const rows = await mapLimit(deferred, 2, runRule);
      for (const row of rows) done.set(row.name, row);
      results = rules.metrics.map((rule) => done.get(rule.name)).filter(Boolean);
    }
  }

  const scored = scoreMetrics(results, rules.on_unavailable);
  const { metrics } = scored;
  // Recovery credit is added on top, never by re-weighting the metrics that
  // could not run: a compile error must still cost most of the grade.
  const recovery = compileFailed ? recoveryCreditFor({ metrics, rules }) : null;
  const gradeHundredths = Math.min(10_000, scored.gradeHundredths + (recovery?.awarded_hundredths ?? 0));
  // `partial` is a legitimate result with a caveat; only missing evidence
  // (unavailable/error) makes the whole evaluation PARTIAL. A zero-weight
  // metric cannot, because it cannot move the grade: an unavailable advisory
  // LLM review must not downgrade a report.
  if (metrics.some((metric) => metric.weight > 0 && (metric.status === 'unavailable' || metric.status === 'error'))) {
    partial = true;
  }

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
    capabilities,
    recovery,
  });

  // One INSERT, not one per metric. Fourteen separate round trips to a pooled
  // remote database took longer than Prisma's default 5 s transaction budget,
  // and the commit then failed with P2028: a finished grade that never got
  // written, which the student saw as a permanent spinner. A single
  // `createMany` is one statement, and the timeout is generous enough that a
  // slow link degrades instead of failing.
  await prisma.$transaction(
    async (tx) => {
      await tx.metricResult.deleteMany({ where: { evaluationId: evaluation.id } });
      await tx.metricResult.createMany({
        data: metrics.map((metric, index) => ({
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
        })),
      });
      await tx.evaluation.update({
        where: { id: evaluation.id },
        data: {
          status: partial ? 'PARTIAL' : 'SUCCEEDED',
          stage: 'done',
          gradeHundredths,
          reportHash: reportView.hash,
          failedReason,
          finishedAt: new Date(),
        },
      });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

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
  // Identity, not output. The evaluation id/key change on every regrade by
  // design, and the submission id/attempt change on every upload - including a
  // student re-uploading byte-identical work. Hashing them made two identical
  // grades look different, which is exactly the drift Day 22 exists to catch.
  evaluation: { ...report.evaluation, id: undefined, key: undefined },
  submission: { ...report.submission, id: undefined, attempt: undefined },
  // Day 22: a zero-weight metric cannot move the grade, so its free text must
  // not be able to move the hash either. The advisory LLM review is the reason
  // this matters: its prose differs between two identical runs, which made a
  // reproducible grade look unreproducible. Structure and status are hashed;
  // the sentence is not.
  metrics: report.metrics.map((metric) =>
    metric.weight === 0
      ? { name: metric.name, analyzer: metric.analyzer, ordinal: metric.ordinal, weight: 0, score: 0, contribution: 0, status: metric.status }
      : metric,
  ),
  // Model prose is advice, not evidence. Keeping it out of the hash is what
  // lets two identical submissions hash identically whether or not a free tier
  // answered, and whichever model answered.
  llm: undefined,
  recovery: report.recovery
    ? {
        logic_sound: report.recovery.logic_sound,
        confidence: report.recovery.confidence,
        max_credit: report.recovery.max_credit,
        awarded_hundredths: report.recovery.awarded_hundredths,
      }
    : undefined,
});

/**
 * The report payload. Pure: same rows in, same bytes out. `timing`-class keys
 * are removed by `stableEvidence`, so the hash survives a cache-hot rerun.
 */
export function buildReportView({ evaluation, submission, assignment, ruleset, rules, metrics, tests, fingerprint, partial, failedReason, capabilities, recovery = null }) {
  const flags = {
    // Advisory (zero-weight) metrics are excluded: an unavailable LLM review is
    // not a reason to withhold a grade, and including it made the flag - and so
    // the hash - depend on whether a third party answered.
    review_recommended: metrics.filter((metric) => metric.weight > 0 && metric.status !== 'ok').map((metric) => metric.name),
    suspected_infinite_loop: metrics.some((metric) => metric.evidence?.suspected_infinite_loop),
    identical_copy: Boolean(metrics.find((m) => m.analyzer === 'similarity_flag')?.evidence?.identical),
    no_oracle: Boolean(metrics.find((m) => m.analyzer === 'edge_case_runner')?.evidence?.no_oracle),
  };

  // Collected as keys, then emitted in a fixed order, so the report bytes do not
  // depend on the order the analyzers happened to finish in.
  const limitationKeys = new Set();
  if (!assignment.referenceSolution) limitationKeys.add('no_reference_solution');
  if (!tests.length) limitationKeys.add('no_tests');
  const llmMetrics = metrics.filter((metric) => String(metric.analyzer).startsWith('llm_'));
  if (llmMetrics.some((metric) => metric.status === 'unavailable' || metric.status === 'error')) {
    limitationKeys.add('llm_unavailable');
  }
  if (llmMetrics.some((metric) => metric.status === 'ok' || metric.status === 'partial')) {
    limitationKeys.add('llm_advisory');
  }
  if (recovery?.awarded_hundredths) limitationKeys.add('llm_recovery_marks');
  if (metrics.some((metric) => metric.analyzer === 'llm_plagiarism')) limitationKeys.add('llm_plagiarism_unverified');
  if (failedReason === 'compile_error') limitationKeys.add('compile_error');
  if (metrics.some((metric) => metric.evidence?.reason === 'provider_has_no_compiler_flags')) {
    limitationKeys.add('no_compiler_flags');
  }
  if (metrics.some((metric) => metric.evidence?.reason === 'no_peer_submissions')) limitationKeys.add('no_peers');
  if (metrics.some((metric) => metric.evidence?.no_oracle === true)) limitationKeys.add('no_oracle');
  if (metrics.some((metric) => metric.status === 'unavailable')) limitationKeys.add('analyzer_failed');

  const caps = capabilities ?? capabilitiesFor(evaluation.provider);
  if (!caps.memoryLimit || !caps.processLimit) limitationKeys.add('provider_limits');
  if (caps.perRunTimeLimit && caps.maxTimeLimitSeconds) limitationKeys.add('sandbox_limits');

  const limitations = Object.entries(LIMITATIONS.entries)
    .filter(([key]) => limitationKeys.has(key))
    .map(([, text]) => text);

  // The advisory block the report UI renders. Every field is copied from the
  // metric that produced it, so the report never invents an opinion of its own.
  const pickLlm = (analyzer) => {
    const metric = llmMetrics.find((item) => item.analyzer === analyzer);
    return metric ? { status: metric.status, feedback: metric.feedback ?? '', evidence: metric.evidence ?? {} } : null;
  };
  const llmBlock = llmMetrics.length
    ? {
        available: llmMetrics.some((metric) => metric.status === 'ok'),
        provider: llmMetrics.map((metric) => metric.evidence?.provider).find(Boolean) ?? null,
        model: llmMetrics.map((metric) => metric.evidence?.model).find(Boolean) ?? null,
        feedback: pickLlm('llm_feedback'),
        readability: pickLlm('llm_style_review'),
        originality: pickLlm('llm_plagiarism'),
        recovery: pickLlm('llm_compile_recovery'),
      }
    : null;
  const metricHundredths = metrics.reduce((sum, metric) => sum + metric.contribution, 0);
  const totalHundredths = Math.max(0, Math.min(10_000, metricHundredths + (recovery?.awarded_hundredths ?? 0)));

  const report = {
    schema_version: '2.1',
    // The grader that actually produced this report, not the one installed now.
    grader_version: evaluation.graderVersion ?? GRADER_VERSION,
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
      hundredths: totalHundredths,
      percent: Math.round(totalHundredths) / 100,
      // Shown separately so a recovered mark is never mistaken for a test pass.
      recovery_hundredths: recovery?.awarded_hundredths ?? 0,
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
    llm: llmBlock,
    recovery,
    toolchain: {
      provider: evaluation.provider,
      compiler_version: fingerprint?.compilerVersion ?? 'unknown',
      stdc_version: fingerprint?.stdcVersion ?? 'unknown',
      pointer_bits: fingerprint?.pointerBits ?? 0,
      fingerprint_hash: fingerprint?.hash ?? 'unknown',
      analyzer_versions: ANALYZER_VERSIONS,
    },
    usefulness: LIMITATIONS.usefulness,
    limitations_version: LIMITATIONS.version,
    limitations,
  };

  return { report, hash: reportHash(reportContent(report)) };
}

/** Wrap prose to a fixed column, so the .txt report reads well in any editor. */
function wrap(text, width = 96) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
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
    ...(report.recovery
      ? [
          '',
          `Compile-error recovery  ${report.recovery.awarded_hundredths} / ${Math.round(report.recovery.max_credit * 10_000)} hundredths awarded`,
          ...wrap(report.recovery.explanation ?? '', 96).map((line) => `  ${line}`),
        ]
      : []),
    ...(report.llm
      ? [
          '',
          'AI review (advisory, excluded from the report hash)',
          ...Object.entries({ feedback: report.llm.feedback, readability: report.llm.readability, originality: report.llm.originality })
            .filter(([, value]) => value?.feedback)
            .map(([key, value]) => `  ${key}: ${value.feedback}`),
        ]
      : []),
    '',
    'Usefulness and limitations',
    ...wrap(report.usefulness ?? '', 96).map((line) => `  ${line}`),
    ...(report.limitations.length ? ['', 'Limitations', ...report.limitations.map((line) => `  - ${line}`)] : []),
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
    capabilities: capabilitiesFor(evaluation.provider),
    recovery: evaluation.failedReason === 'compile_error' ? recoveryCreditFor({ metrics, rules }) : null,
  });

  // A report is only re-verifiable against the analyzer set that produced it.
  // After a grader upgrade an old row is neither verified nor tampered with, and
  // saying "cannot be compared" is more honest than a red mismatch.
  const sameGrader = (evaluation.graderVersion ?? GRADER_VERSION) === GRADER_VERSION;

  return {
    json: pdf.report,
    text: renderReportText(pdf),
    hash: pdf.hash,
    storedHash: evaluation.reportHash,
    verified: sameGrader ? (evaluation.reportHash ? evaluation.reportHash === pdf.hash : false) : null,
    verification_note: sameGrader ? null : `Graded by grader ${evaluation.graderVersion ?? 'unknown'}; its hash is comparable only with that analyzer set.`,
    grader_version: evaluation.graderVersion ?? GRADER_VERSION,
  };
}
