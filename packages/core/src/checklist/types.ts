/**
 * Checklist types — configurable review dimensions with weighted checks.
 *
 * Each dimension (e.g., SOLID, error handling) contains named checks
 * that guide AI agents during code review. Checks have weights (1-10)
 * used for severity scoring.
 */

// ─── Check ─────────────────────────────────────────────────────

/** A single review check within a dimension. */
export interface ChecklistCheck {
  /** Unique kebab-case identifier (e.g., "single-responsibility") */
  id: string;

  /** Human-readable question the AI should evaluate (e.g., "Does this class have one reason to change?") */
  description: string;

  /** Importance weight (1-10). Higher = more severe when violated. */
  weight: number;

  /** Whether this check is active. Default: true. */
  enabled: boolean;
}

// ─── Dimension ─────────────────────────────────────────────────

/** A review dimension grouping related checks. */
export interface ChecklistDimension {
  /** Unique kebab-case identifier (e.g., "solid", "error-handling") */
  id: string;

  /** Human-readable name (e.g., "SOLID Principles") */
  name: string;

  /** Whether this dimension is active. Default: true. */
  enabled: boolean;

  /** Ordered list of checks in this dimension. */
  checks: ChecklistCheck[];
}

// ─── Config ────────────────────────────────────────────────────

/** Top-level checklist configuration. */
export interface ChecklistConfig {
  /** Master switch. When false, checklist is skipped entirely. */
  enabled: boolean;

  /** Review dimensions with their checks. */
  dimensions: ChecklistDimension[];
}

// ─── Severity Multipliers ──────────────────────────────────────

/** Multipliers for finding severity when computing weighted scores. */
export const SEVERITY_MULTIPLIER: Record<string, number> = {
  critical: 5,
  high: 3,
  medium: 2,
  low: 1,
  info: 0.5,
};
