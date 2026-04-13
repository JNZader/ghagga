/**
 * Types for the dual-critique review loop.
 *
 * The 3-agent pattern:
 *   1. Initial Review  — standard code review producing findings
 *   2. Self-Critique   — evaluates the review for false positives, overreactions, vagueness
 *   3. Refined Review  — produces a final review incorporating the critique feedback
 */

import type { ReviewFinding, ReviewStatus } from '../types.js';

// ─── Critique Verdict ──────────────────────────────────────────

export type CritiqueVerdict = 'valid' | 'false-positive' | 'overreaction' | 'vague' | 'redundant';

/**
 * A critique of a single finding from the initial review.
 * The self-critique agent evaluates each finding and assigns a verdict.
 */
export interface FindingCritique {
  /** Index of the finding in the initial review's findings array */
  findingIndex: number;

  /** The verdict on this finding */
  verdict: CritiqueVerdict;

  /** Explanation of why this verdict was assigned */
  reasoning: string;

  /** Suggested severity adjustment (only when verdict is 'overreaction') */
  suggestedSeverity?: ReviewFinding['severity'];
}

// ─── Critique Result ───────────────────────────────────────────

export interface CritiqueResult {
  /** Individual critiques for each finding */
  critiques: FindingCritique[];

  /** Overall assessment of the initial review quality */
  overallAssessment: string;

  /** Count of findings flagged as false positives */
  falsePositiveCount: number;

  /** Count of findings flagged as overreactions */
  overreactionCount: number;
}

// ─── Dual-Critique Config ──────────────────────────────────────

export interface DualCritiqueConfig {
  /**
   * Minimum number of findings in the initial review to trigger self-critique.
   * Below this threshold, the initial review is returned as-is.
   * Default: 1
   */
  minFindingsForCritique: number;

  /**
   * Whether to include the critique metadata in the final result.
   * Default: true
   */
  includeCritiqueMetadata: boolean;
}

export const DEFAULT_DUAL_CRITIQUE_CONFIG: DualCritiqueConfig = {
  minFindingsForCritique: 1,
  includeCritiqueMetadata: true,
};

// ─── Dual-Critique Input ───────────────────────────────────────

export interface DualCritiqueInput {
  /** The code diff being reviewed */
  diff: string;

  /** Static analysis context */
  staticContext: string;

  /** Memory context (if available) */
  memoryContext: string | null;

  /** Stack hints for the codebase */
  stackHints: string;

  /** Optional checklist context */
  checklistContext?: string;

  /** Configuration for the dual-critique loop */
  config?: Partial<DualCritiqueConfig>;
}

// ─── Dual-Critique Output ──────────────────────────────────────

export interface DualCritiqueResult {
  /** The final refined review status */
  status: ReviewStatus;

  /** The final refined summary */
  summary: string;

  /** The final refined findings (after false-positive removal) */
  findings: ReviewFinding[];

  /** Critique metadata (present when includeCritiqueMetadata is true) */
  critiqueMetadata?: {
    /** How many findings the initial review produced */
    initialFindingCount: number;

    /** How many findings survived the critique */
    finalFindingCount: number;

    /** How many were removed as false positives */
    removedAsFalsePositive: number;

    /** How many had severity adjusted */
    severityAdjusted: number;

    /** The full critique result */
    critiqueResult: CritiqueResult;
  };
}
