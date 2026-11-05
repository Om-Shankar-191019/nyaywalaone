import { z } from 'zod';
import { analyzerByName, analyzerNames } from './registry.js';
import { EDGE_CASES, ORDER_CLASSES } from './constants.js';

export const RULE_SCHEMA_VERSION = '1.0';
export { EDGE_CASES, ORDER_CLASSES };

export const limitsSchema = z
  .object({
    time_limit_s: z.number().min(0.1).max(10).default(1),
    memory_limit_mb: z.number().int().min(8).max(256).default(64),
    max_processes: z.number().int().min(1).max(60).default(30),
  })
  .strict();

const metricSchema = z
  .object({
    name: z.string().min(1).max(64),
    analyzer: z.string().min(1),
    weight: z.number().min(0).max(1),
    params: z.record(z.unknown()).default({}),
  })
  .strict();

export const rulesetSchema = z
  .object({
    schema_version: z.literal(RULE_SCHEMA_VERSION).default(RULE_SCHEMA_VERSION),
    problem: z.string().min(1).max(120).default('untitled'),
    limits: limitsSchema.default({}),
    on_unavailable: z.enum(['renormalize', 'zero']).default('renormalize'),
    metrics: z.array(metricSchema).min(1),
  })
  .strict();

/**
 * The example rule set from section 9, with the Week 1 finding applied:
 * `sanitizer_run` exists (it worked on the measured host) but stays off by
 * default, because a provider that rejects ASan must not fail a submission.
 */
export function defaultRules(problem = 'add_two_integers') {
  return {
    schema_version: RULE_SCHEMA_VERSION,
    problem,
    limits: { time_limit_s: 1, memory_limit_mb: 64, max_processes: 30 },
    on_unavailable: 'renormalize',
    metrics: [
      { name: 'correctness', analyzer: 'io_tests', weight: 0.2, params: { testset: 'assignment', partial_credit: true } },
      {
        name: 'syntax',
        analyzer: 'compiler_warnings',
        weight: 0.1,
        params: { flags: '-Wall -Wextra -std=c11', warnings_as_errors: false, penalty_per_warning: 0.1 },
      },
      {
        name: 'structure',
        analyzer: 'static_analysis',
        weight: 0.1,
        params: { max_cyclomatic: 8, max_function_length: 40, max_nesting: 4, scoring: 'linear', min_score: 0 },
      },
      {
        name: 'modularity',
        analyzer: 'function_split',
        weight: 0.1,
        params: { min_functions: 2, expect_helpers: true, max_main_lines: 25 },
      },
      {
        name: 'logical',
        analyzer: 'edge_case_runner',
        weight: 0.1,
        params: { cases: ['zero', 'negatives', 'int_overflow', 'whitespace'], no_oracle_cap: 0.5 },
      },
      {
        name: 'complexity',
        analyzer: 'complexity_estimator',
        weight: 0.1,
        params: { required: 'O(1)', sizes: [1, 10, 100], mode: 'static', timing_evidence: false },
      },
      {
        name: 'memory_safety',
        analyzer: 'memory_audit',
        weight: 0.1,
        params: {
          check_leaks: true,
          check_unchecked_alloc: true,
          banned_functions: ['gets', 'strcpy', 'sprintf'],
          sanitizer_run: false,
        },
      },
      {
        name: 'readability',
        analyzer: 'style_analysis',
        weight: 0.1,
        params: { min_name_length: 3, min_comment_ratio: 0.03, max_line_length: 100 },
      },
      {
        name: 'originality',
        analyzer: 'similarity_flag',
        weight: 0.1,
        params: { corpus: 'assignment', flag_threshold: 0.85, shingle_size: 7, num_perm: 128, seed: 42 },
      },
      {
        name: 'readability_llm',
        analyzer: 'llm_review',
        weight: 0,
        params: { temperature: 0, advisory_only: true },
      },
      // The four optional language-model checks. All weight 0: they add advice,
      // never marks - except llm_compile_recovery, which the coordinator lets
      // award its own capped credit when a program does not compile.
      { name: 'feedback_llm', analyzer: 'llm_feedback', weight: 0, params: {} },
      { name: 'style_llm', analyzer: 'llm_style_review', weight: 0, params: { strictness: 'normal' } },
      { name: 'integrity_llm', analyzer: 'llm_plagiarism', weight: 0, params: {} },
      { name: 'compile_recovery_llm', analyzer: 'llm_compile_recovery', weight: 0, params: { max_credit: 0.4 } },
    ],
  };
}

const round9 = (value) => Math.round(value * 1e9) / 1e9;

/**
 * Validate and fill defaults. Returns field-level errors such as
 * "metrics[3].params.max_main_lines: Expected number, received string" instead
 * of a generic 400, because the instructor has to be able to fix it.
 */
export function resolveRules(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { rules: null, errors: [{ path: '(root)', message: 'A rule set object is required' }] };
  }

  const parsed = rulesetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      rules: null,
      errors: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }

  const rules = parsed.data;
  const seen = new Set();
  let total = 0;

  const metrics = rules.metrics.map((metric, index) => {
    const analyzer = analyzerByName(metric.analyzer);
    if (!analyzer) {
      errors.push({ path: `metrics[${index}].analyzer`, message: `Unknown analyzer "${metric.analyzer}". Available: ${analyzerNames().join(', ')}` });
      return metric;
    }
    if (seen.has(metric.name)) {
      errors.push({ path: `metrics[${index}].name`, message: `Duplicate metric name "${metric.name}"` });
    }
    seen.add(metric.name);
    total += metric.weight;

    const params = analyzer.paramsSchema.safeParse(metric.params ?? {});
    if (!params.success) {
      for (const issue of params.error.issues) {
        const where = issue.path.length ? issue.path.join('.') : '(root)';
        errors.push({ path: `metrics[${index}].params.${where}`, message: issue.message });
      }
      return metric;
    }
    return { ...metric, params: params.data };
  });

  if (Math.abs(round9(total) - 1) > 1e-9) {
    errors.push({
      path: 'metrics',
      message: `Weights must sum to 1.00; they currently sum to ${total.toFixed(2)}`,
    });
  }

  return {
    rules: { ...rules, metrics },
    errors,
  };
}

/** Throws nothing: callers decide whether to 400 or to store the errors. */
export const validateRules = (input) => resolveRules(input);

export const resolvedRuleSet = (input) => {
  const { rules, errors } = resolveRules(input);
  return errors.length ? null : rules;
};
