/**
 * Types for the Static Analysis module (Layer 0 - pre-LLM)
 */

/** Detected project stack from build files */
export type DetectedStack =
  | 'java-gradle'
  | 'java-maven'
  | 'node-npm'
  | 'node-yarn'
  | 'node-pnpm'
  | 'python'
  | 'go'
  | 'rust'
  | 'unknown';

/** A static analysis finding */
export interface StaticAnalysisFinding {
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  category: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
  source: 'static-analysis';
  ruleId: string;
}

/** Result from running all static analysis checks */
export interface StaticAnalysisResult {
  detectedStack: DetectedStack;
  findings: StaticAnalysisFinding[];
  summary: {
    aiAttribution: { fileFindings: number; commitFindings: number };
    security: { findings: number; serviceAvailable: boolean };
    commitMessage: { valid: number; invalid: number };
  };
  totalTimeMs: number;
  hasBlockingFindings: boolean;
}

/** Configuration for static analysis checks */
export interface StaticAnalysisConfig {
  enabled: boolean;
  aiAttributionCheck: boolean;
  securityPatternsCheck: boolean;
  semgrepServiceUrl: string;
  commitMessageCheck: boolean;
  stackAwarePrompts: boolean;
}

/** Default configuration when no repo-specific config exists */
export const DEFAULT_STATIC_ANALYSIS_CONFIG: StaticAnalysisConfig = {
  enabled: true,
  aiAttributionCheck: true,
  securityPatternsCheck: true,
  semgrepServiceUrl: '',
  commitMessageCheck: true,
  stackAwarePrompts: true,
};
