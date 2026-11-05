/**
 * Bumped whenever scoring logic changes. The evaluation key includes it, so a
 * logic change is visible in the report instead of silently altering old marks.
 */
export const GRADER_VERSION = '2.1.0';

/** Per-analyzer versions, hashed into toolchain_hash. */
export const ANALYZER_VERSIONS = Object.freeze({
  io_tests: '1.0.0',
  compiler_warnings: '1.0.0',
  static_analysis: '1.0.0',
  function_split: '1.0.0',
  edge_case_runner: '1.0.0',
  complexity_estimator: '1.0.0',
  memory_audit: '1.1.0',
  style_analysis: '1.0.0',
  similarity_flag: '1.0.0',
  // 1.1.0: model fallback and multi-provider routing; a provider failure is now
  // `unavailable` rather than `error`, and the model name is optional.
  llm_review: '1.1.0',
  llm_feedback: '1.0.0',
  llm_style_review: '1.0.0',
  llm_plagiarism: '1.0.0',
  llm_compile_recovery: '1.0.0',
});
