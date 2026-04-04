/**
 * AI Enhance types — used by the enhance module to group,
 * prioritize, and filter static analysis findings.
 */

import type { FindingSeverity } from '../types.js';

/** Input for the enhance function. */
export interface EnhanceInput {
  findings: EnhanceFindingSummary[];
  provider: string;
  model: string;
  apiKey: string;

  /**
   * Optional backend-agnostic generation function.
   * When provided, used instead of creating one from provider/model/apiKey.
   */
  generateFn?: import('../providers/generate-fn.js').GenerateTextFn;
}

/** Compact finding representation for the AI prompt (token-efficient). */
export interface EnhanceFindingSummary {
  id: number;
  file: string;
  line?: number;
  severity: FindingSeverity;
  category: string;
  message: string;
  source: string;
}

/** Result from the AI enhance pass. */
export interface EnhanceResult {
  /** Grouped findings by root cause. */
  groups: FindingGroup[];
  /** AI-assigned priority scores (findingId → 1-10). */
  priorities: Record<number, number>;
  /** Fix suggestions for top findings (findingId → suggestion text). */
  suggestions: Record<number, string>;
  /** Findings flagged as likely false positives. */
  filtered: FilteredFinding[];
}

/** A group of related findings. */
export interface FindingGroup {
  groupId: string;
  label: string;
  findingIds: number[];
}

/** A finding flagged as a likely false positive. */
export interface FilteredFinding {
  findingId: number;
  reason: string;
}

/** Metadata from the enhance pass. */
export interface EnhanceMetadata {
  model: string;
  tokenUsage: { input: number; output: number };
  groupCount: number;
  filteredCount: number;
}
