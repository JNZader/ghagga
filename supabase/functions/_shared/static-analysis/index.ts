/**
 * Static Analysis Module - Layer 0 (pre-LLM)
 *
 * Deterministic checks that run before LLM review:
 * - AI attribution detection (regex, in-process)
 * - Commit message validation (regex, in-process)
 * - Stack detection (in-process)
 * - Semgrep security scan (HTTP call to microservice)
 */

export type {
  DetectedStack,
  StaticAnalysisFinding,
  StaticAnalysisResult,
  StaticAnalysisConfig,
} from './types.ts';

export { DEFAULT_STATIC_ANALYSIS_CONFIG } from './types.ts';

export {
  checkFileForAiAttribution,
  checkCommitsForAiAttribution,
} from './ai-attribution.ts';

export { scanWithSemgrep } from './semgrep-client.ts';

export { detectStack, getStackContext } from './stack-detection.ts';

export { validateCommitMessages } from './commit-validation.ts';

export {
  runStaticAnalysis,
  formatFindingsAsLLMContext,
  type StaticAnalysisInput,
} from './analyzer.ts';
