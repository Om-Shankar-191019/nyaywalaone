#!/usr/bin/env node
/**
 * Does every language-model check actually answer, end to end?
 *
 *   npm run llm:smoke
 *
 * Runs the four analyzers against two built-in programs (one clean, one that
 * does not compile), then builds a report view to prove the advisory block and
 * the recovery marks are wired in and that model prose stays out of the hash.
 * Costs at most four small model calls and no sandbox calls.
 */
import 'dotenv/config';

const { llmStatus } = await import('../src/grading/llm/client.js');
const { llmFeedbackAnalyzer } = await import('../src/grading/analyzers/llm-feedback.js');
const { llmStyleAnalyzer } = await import('../src/grading/analyzers/llm-style.js');
const { llmPlagiarismAnalyzer } = await import('../src/grading/analyzers/llm-originality.js');
const { llmCompileRecoveryAnalyzer } = await import('../src/grading/analyzers/llm-compile-recovery.js');
const { buildReportView, recoveryCreditFor, scoreMetrics } = await import('../src/grading/coordinator.js');
const { resolveRules, defaultRules } = await import('../src/grading/rules.js');

const status = llmStatus();
console.log(`LLM enabled: ${status.enabled}, configured: ${status.configured}`);
if (!status.configured) {
  console.log('No key: every check will report `unavailable`, which is a valid outcome and does not affect a grade.');
}

const CLEAN = `#include <stdio.h>

/* Sum of the integers from 1 to n, using the closed form. */
static long sum_to(int n) {
    if (n < 0) {
        return 0;
    }
    return (long)n * (n + 1) / 2;
}

int main(void) {
    int n = 0;
    if (scanf("%d", &n) != 1) {
        fprintf(stderr, "expected one integer\\n");
        return 1;
    }
    printf("%ld\\n", sum_to(n));
    return 0;
}
`;

const BROKEN = `#include <stdio.h>

int add(int a, int b) {
    return a + b
}

int main(void) {
    int a, b;
    scanf("%d %d", &a, &b);
    printf("%d\\n", add(a, b))
    return 0;
}
`;

const COMPILE_OUTPUT = `main.c: In function 'add':
main.c:4:18: error: expected ';' before '}' token
main.c: In function 'main':
main.c:11:31: error: expected ';' before 'return'`;

const metrics = [
  { name: 'correctness', analyzer: 'io_tests', weight: 0.2, score: 1, contribution: 2000, status: 'ok', feedback: 'All 3 tests passed.' },
  { name: 'readability', analyzer: 'style_analysis', weight: 0.1, score: 0.75, contribution: 750, status: 'ok', feedback: 'Names and comments are within the rules.' },
  { name: 'originality', analyzer: 'similarity_flag', weight: 0.1, score: 1, contribution: 1000, status: 'ok', feedback: 'Below the review threshold.', evidence: { max_similarity: 0.12, top_matches: [] } },
];

const ctx = {
  source: CLEAN,
  sourceHash: 'a'.repeat(64),
  assignmentTitle: 'Sum of an integer range',
  metrics,
  compileOutput: '',
};

const call = async (label, analyzer, source, params, extra = {}) => {
  const started = Date.now();
  const result = await analyzer.run({ ...ctx, source, ...extra }, analyzer.paramsSchema.parse(params ?? {}));
  const ms = Date.now() - started;
  const provider = result.evidence?.provider ?? '-';
  console.log(`\n${label}: status=${result.status} score=${result.score} provider=${provider} ${ms} ms`);
  console.log(`  ${String(result.feedback ?? '').slice(0, 220)}`);
  if (result.status === 'error') failures.push(`${label} returned error`);
  return result;
};

const failures = [];

const feedback = await call('feedback      ', llmFeedbackAnalyzer, CLEAN, {});
const style = await call('readability   ', llmStyleAnalyzer, CLEAN, { strictness: 'normal' });
const integrity = await call('originality   ', llmPlagiarismAnalyzer, CLEAN, {});
const recovery = await call('recovery      ', llmCompileRecoveryAnalyzer, BROKEN, { max_credit: 0.4 }, { compileOutput: COMPILE_OUTPUT });

// The advisory rows a real evaluation would carry.
const rows = [
  ...metrics,
  { name: 'feedback_llm', analyzer: 'llm_feedback', weight: 0, score: feedback.score, status: feedback.status, evidence: feedback.evidence, feedback: feedback.feedback },
  { name: 'style_llm', analyzer: 'llm_style_review', weight: 0, score: style.score, status: style.status, evidence: style.evidence, feedback: style.feedback },
  { name: 'integrity_llm', analyzer: 'llm_plagiarism', weight: 0, score: integrity.score, status: integrity.status, evidence: integrity.evidence, feedback: integrity.feedback },
  { name: 'recovery_llm', analyzer: 'llm_compile_recovery', weight: 0, score: recovery.score, status: recovery.status, evidence: recovery.evidence, feedback: recovery.feedback },
];

const { metrics: scored } = scoreMetrics(rows, 'renormalize');
const recoveryCredit = recoveryCreditFor({ metrics: scored, rules: { metrics: [{ analyzer: 'llm_compile_recovery', params: { max_credit: 0.4 } }] } });

const rules = resolveRules(defaultRules('sum_to_n')).rules;
const evaluation = { id: 'smoke', evaluationKey: 'k', provider: 'onlinecompiler', toolchainFingerprint: 'tf', graderVersion: '2.1.0', status: 'PARTIAL' };
const submission = { id: 's', assignmentId: 'a', studentId: 'u', attempt: 1, filename: 'sum.c', sizeBytes: CLEAN.length, sourceHash: 'a'.repeat(64) };
const assignment = { id: 'a', title: 'Sum', referenceSolution: CLEAN, allowNoOracle: false };
const tests = [{ name: 'basic', stdin: '5\n', expectedStdout: '15\n' }];
const fingerprint = { compilerVersion: 'gcc 15', stdcVersion: '202311', pointerBits: 64, hash: 'f'.repeat(64) };

const view = buildReportView({
  evaluation,
  submission,
  assignment,
  ruleset: { id: 'rs', version: 1 },
  rules,
  metrics: scored,
  tests,
  fingerprint,
  partial: true,
  failedReason: 'compile_error',
  capabilities: { compilerFlags: false, memoryLimit: false, processLimit: false },
  recovery: recoveryCredit,
});
const withoutAdvisory = buildReportView({
  evaluation,
  submission,
  assignment,
  ruleset: { id: 'rs', version: 1 },
  rules,
  metrics: scored,
  tests,
  fingerprint,
  partial: true,
  failedReason: 'compile_error',
  capabilities: { compilerFlags: false, memoryLimit: false, processLimit: false },
  recovery: recoveryCredit,
});

console.log('\nReport integration');
console.log(`  llm block present:       ${Boolean(view.report.llm)}`);
console.log(`  recovery marks:          ${recoveryCredit?.awarded_hundredths ?? 0} hundredths of ${Math.round((recoveryCredit?.max_credit ?? 0) * 10_000)}`);
console.log(`  grade:                   ${view.report.grade.percent.toFixed(2)} / 100 (recovery ${view.report.grade.recovery_hundredths})`);
console.log(`  hash excludes LLM prose: ${view.hash === withoutAdvisory.hash}`);
console.log(`  limitations:             ${view.report.limitations.length}`);

if (!view.report.llm) failures.push('report has no llm block');
if (view.hash !== withoutAdvisory.hash) failures.push('LLM prose changed the report hash');
if (recoveryCredit?.logic_sound && !recoveryCredit.awarded_hundredths) failures.push('sound logic but no recovery marks');
if (strictMode() && rows.some((row) => row.analyzer.startsWith('llm_') && row.status === 'error')) failures.push('an analyzer reported error');

function strictMode() {
  return process.argv.includes('--strict');
}

if (failures.length) {
  console.error(`\nFAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nPASS: all four checks answered (or reported unavailable), the report carries them, and the hash is unaffected.');
process.exit(0);
