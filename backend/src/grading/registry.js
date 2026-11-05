import { ioTestAnalyzer } from './analyzers/io-tests.js';
import { compilerWarningsAnalyzer } from './analyzers/compiler-warnings.js';
import { staticAnalysisAnalyzer } from './analyzers/static-analysis.js';
import { functionSplitAnalyzer } from './analyzers/function-split.js';
import { edgeCaseRunnerAnalyzer } from './analyzers/edge-case-runner.js';
import { complexityAnalyzer } from './analyzers/complexity.js';
import { memoryAuditAnalyzer } from './analyzers/memory-audit.js';
import { styleAnalyzer } from './analyzers/style.js';
import { similarityAnalyzer } from './analyzers/similarity.js';
import { llmReviewAnalyzer } from './analyzers/llm-review.js';
import { llmFeedbackAnalyzer } from './analyzers/llm-feedback.js';
import { llmStyleAnalyzer } from './analyzers/llm-style.js';
import { llmPlagiarismAnalyzer } from './analyzers/llm-originality.js';
import { llmCompileRecoveryAnalyzer } from './analyzers/llm-compile-recovery.js';

/**
 * The analyzer registry. A rule set names an analyzer; if the name is not here,
 * publishing fails with a field-level error rather than a runtime 500.
 */
const ANALYZERS = [
  ioTestAnalyzer,
  compilerWarningsAnalyzer,
  staticAnalysisAnalyzer,
  functionSplitAnalyzer,
  edgeCaseRunnerAnalyzer,
  complexityAnalyzer,
  memoryAuditAnalyzer,
  styleAnalyzer,
  similarityAnalyzer,
  llmReviewAnalyzer,
  llmFeedbackAnalyzer,
  llmStyleAnalyzer,
  llmPlagiarismAnalyzer,
  llmCompileRecoveryAnalyzer,
];

const byName = new Map(ANALYZERS.map((analyzer) => [analyzer.name, analyzer]));

export const analyzerByName = (name) => byName.get(name) ?? null;
export const analyzerNames = () => [...byName.keys()];
export const analyzerList = () => ANALYZERS;

export const registry = {
  get: analyzerByName,
  names: analyzerNames,
  all: analyzerList,
};
