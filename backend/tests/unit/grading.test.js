import '../setup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, evaluationKey, reportHash, rulesHash, testsetHash } from '../../src/grading/canonical.js';
import { contributionOf, decayScore } from '../../src/grading/score.js';
import { resolveRules } from '../../src/grading/rules.js';
import { buildReportView, scoreMetrics } from '../../src/grading/coordinator.js';

const rules = (overrides = {}) => ({
  schema_version: '1.0',
  problem: 'add_two_integers',
  limits: { time_limit_s: 1, memory_limit_mb: 64, max_processes: 30 },
  on_unavailable: 'renormalize',
  metrics: [
    { name: 'correctness', analyzer: 'io_tests', weight: 0.5, params: {} },
    { name: 'syntax', analyzer: 'compiler_warnings', weight: 0.5, params: {} },
  ],
  ...overrides,
});

test('canonical JSON ignores key order but not values', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.notEqual(canonicalize({ a: 2 }), canonicalize({ a: 3 }));
  assert.equal(canonicalize({ list: [3, 1, 2] }), '{"list":[3,1,2]}');
});

test('rules_hash is stable across key order and whitespace', () => {
  const a = rules();
  const b = JSON.parse(JSON.stringify(a));
  assert.equal(rulesHash(a), rulesHash(b));

  const changed = rules();
  changed.metrics[0].weight = 0.4;
  assert.notEqual(rulesHash(a), rulesHash(changed));
});

test('testset_hash is order independent and content bound', () => {
  const tests = [
    { name: 'a', stdin: '1\n', expectedStdout: '1\n' },
    { name: 'b', stdin: '2\n', expectedStdout: '2\n' },
  ];
  assert.equal(testsetHash(tests), testsetHash([...tests].reverse()));
  assert.notEqual(testsetHash(tests), testsetHash([{ ...tests[0], expectedStdout: '3\n' }, tests[1]]));
  // Trailing whitespace is formatting, not content.
  assert.equal(testsetHash(tests), testsetHash([{ ...tests[0], expectedStdout: '1  \n\n' }, tests[1]]));
});

test('every evaluation-key input changes the key', () => {
  const base = {
    sourceHash: 'a'.repeat(64),
    rulesHash: 'b'.repeat(64),
    testsetHash: 'c'.repeat(64),
    toolchainHash: 'd'.repeat(64),
    graderVersion: '2.0.0',
  };
  const key = evaluationKey(base);
  assert.equal(key, evaluationKey({ ...base }));
  for (const field of Object.keys(base)) {
    assert.notEqual(key, evaluationKey({ ...base, [field]: `${base[field]}x` }), `${field} must change the key`);
  }
});

test('report_hash ignores timing keys and nothing else', () => {
  const report = { grade: { hundredths: 9000 }, metrics: [{ name: 'syntax', score: 1, timing: { ms: 12 } }] };
  const sameWithoutTiming = { grade: { hundredths: 9000 }, metrics: [{ name: 'syntax', score: 1, timing: { ms: 999 } }] };
  assert.equal(reportHash(report), reportHash(sameWithoutTiming));
  assert.notEqual(reportHash(report), reportHash({ ...report, grade: { hundredths: 8999 } }));
});

test('a re-run of the same content reports the same hash, whatever the run is called', () => {
  const base = {
    submission: { id: 'sub-1', assignmentId: 'asg-1', studentId: 'stu-1', attempt: 1, filename: 'add.c', sizeBytes: 120, sourceHash: 'a'.repeat(64) },
    assignment: { referenceSolution: 'int main(void){return 0;}' },
    ruleset: { id: 'rs-1', version: 1 },
    rules: resolveRules(rules()).rules,
    metrics: [{ name: 'correctness', analyzer: 'io_tests', weight: 1, score: 1, contribution: 1000, status: 'ok', feedback: 'All 3 tests passed.', evidence: { tests_passed: 3 } }],
    tests: [{ name: 't1', stdin: '2 3', expectedStdout: '5' }],
    fingerprint: { compilerVersion: 'gcc 14.1.0', stdcVersion: '201710', pointerBits: 64, hash: 'f'.repeat(64) },
    partial: false,
    failedReason: null,
  };
  const run = (evaluation) => buildReportView({ ...base, evaluation });

  const first = run({ id: 'ev-1', evaluationKey: '0'.repeat(64), provider: 'judge0', toolchainFingerprint: 'tf' });
  // A regrade gets a fresh row and a deliberately salted key.
  const saltedKey = `${'0'.repeat(64)}:regrade:1`;
  const regraded = run({ id: 'ev-2', evaluationKey: saltedKey, provider: 'judge0', toolchainFingerprint: 'tf' });

  assert.equal(first.hash, regraded.hash, 'identical content must hash identically across runs');
  // The identity stays in the report itself - it is only kept out of the hash.
  assert.equal(first.report.evaluation.id, 'ev-1');
  assert.equal(regraded.report.evaluation.key, saltedKey);

  const weaker = buildReportView({
    ...base,
    metrics: [{ ...base.metrics[0], score: 0.5, contribution: 500, feedback: '1 of 2 tests passed.' }],
    evaluation: { id: 'ev-1', evaluationKey: '0'.repeat(64), provider: 'judge0', toolchainFingerprint: 'tf' },
  });
  assert.notEqual(first.hash, weaker.hash, 'a content change must change the hash');
});

test('weights must sum to 1.00 and analyzers must exist', () => {
  assert.equal(resolveRules(rules()).errors.length, 0);

  const badSum = rules();
  badSum.metrics[0].weight = 0.3;
  assert.match(resolveRules(badSum).errors[0].message, /sum to 1\.00/);

  const unknown = rules();
  unknown.metrics[1].analyzer = 'not_an_analyzer';
  assert.match(resolveRules(unknown).errors[0].message, /Unknown analyzer/);

  const badParams = rules();
  badParams.metrics[1].params = { flags: 42 };
  assert.ok(resolveRules(badParams).errors.some((error) => error.path.startsWith('metrics[1].params')));
});

test('defaults are filled, so the hash covers what actually runs', () => {
  const resolved = resolveRules(rules()).rules;
  assert.equal(resolved.metrics[0].params.partial_credit, true);
  assert.equal(resolved.limits.memory_limit_mb, 64);
  assert.equal(resolved.on_unavailable, 'renormalize');
});

test('integer hundredths add up to 10000 for full marks', () => {
  assert.equal(contributionOf(1, 0.1), 1000);
  const { gradeHundredths, metrics } = scoreMetrics(
    [
      { name: 'a', analyzer: 'io_tests', weight: 0.5, score: 1, status: 'ok' },
      { name: 'b', analyzer: 'io_tests', weight: 0.5, score: 0.5, status: 'ok' },
    ],
    'renormalize',
  );
  assert.equal(gradeHundredths, 7500);
  assert.equal(
    metrics.reduce((sum, metric) => sum + metric.contribution, 0),
    7500,
  );
});

test('an unavailable metric is renormalised or zeroed by policy', () => {
  const rows = [
    { name: 'a', analyzer: 'io_tests', weight: 0.5, score: 1, status: 'ok' },
    { name: 'b', analyzer: 'llm_review', weight: 0.5, score: 0, status: 'unavailable' },
  ];

  const renormalised = scoreMetrics(rows, 'renormalize');
  assert.equal(renormalised.gradeHundredths, 10000, 'available weight takes over');
  assert.equal(renormalised.metrics[1].weight, 0);

  const zeroed = scoreMetrics(rows, 'zero');
  assert.equal(zeroed.gradeHundredths, 5000, 'the missing metric costs half');
});

test('decay score is piecewise linear and clamped', () => {
  assert.equal(decayScore(4, 8), 1);
  assert.equal(decayScore(12, 8), 0.5);
  assert.equal(decayScore(20, 8), 0);
  assert.equal(decayScore(Number.NaN, 8), 0);
});
