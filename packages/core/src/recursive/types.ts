/**
 * Recursive Review Loop — Types
 *
 * Types for the self-validating review cycle that re-reviews
 * suggested patches to catch regressions before they reach the user.
 */

import type { ReviewFinding } from '../types.js';

// ─── Patch Extraction ──────────────────────────────────────────

/**
 * A patch derived from a review finding's suggestion.
 * Represents a single code change that the AI reviewer recommended.
 */
export interface SuggestionPatch {
  /** File path from the finding */
  file: string;

  /** Line number from the finding (undefined = file-level suggestion) */
  line: number | undefined;

  /** The original finding message for context */
  originalMessage: string;

  /** The suggested fix text */
  suggestion: string;

  /** Index of the finding in the original results (for tracing) */
  findingIndex: number;
}

// ─── Regression Detection ──────────────────────────────────────

/**
 * A finding from re-review that represents a regression
 * introduced by a suggested fix.
 */
export interface RegressionFinding extends ReviewFinding {
  /** Always true — discriminant for regression findings */
  isRegression: true;

  /** The original suggestion that caused this regression */
  originatingSuggestion: {
    file: string;
    line: number | undefined;
    suggestion: string;
  };
}

// ─── Report ────────────────────────────────────────────────────

/**
 * Report from the recursive review loop.
 * Attached to ReviewResult when recursive review is enabled.
 */
export interface RecursiveReviewReport {
  /** Number of re-review iterations executed (1 or 2) */
  iterations: number;

  /** Whether the review converged (no new issues on last iteration) */
  converged: boolean;

  /** Findings identified as regressions from suggested fixes */
  regressions: RegressionFinding[];

  /** Total new issues found across all re-review iterations */
  totalNewIssues: number;
}

// ─── Configuration ─────────────────────────────────────────────

/**
 * Configuration for the recursive review step.
 * Extracted from ReviewSettings for internal use.
 */
export interface RecursiveReviewConfig {
  /** Maximum number of re-review iterations. Default: 2 */
  maxIterations: number;
  /** Number of consecutive identical-fingerprint iterations before circuit breaks. Default: 2 */
  circuitBreakerThreshold?: number;
}

/** Default configuration values */
export const DEFAULT_RECURSIVE_CONFIG: RecursiveReviewConfig = {
  maxIterations: 2,
  circuitBreakerThreshold: 2,
};
