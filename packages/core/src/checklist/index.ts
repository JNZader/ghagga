/**
 * Checklist module — configurable SOLID + boundary conditions review.
 *
 * Provides review dimensions with weighted checks that guide AI agents
 * during code review. Findings are scored by weight * severity.
 */

// ─── Types ─────────────────────────────────────────────────────

export type { ChecklistCheck, ChecklistConfig, ChecklistDimension } from './types.js';
export { SEVERITY_MULTIPLIER } from './types.js';

// ─── Defaults ──────────────────────────────────────────────────

export { DEFAULT_CHECKLIST, DEFAULT_DIMENSIONS } from './defaults.js';

// ─── Config ────────────────────────────────────────────────────

export { resolveChecklistConfig } from './config.js';

// ─── Context ───────────────────────────────────────────────────

export { buildChecklistContext, countActiveChecks } from './context.js';

// ─── Scorer ───────────────────────────────────────────────────

export type {
  ChecklistScoreResult,
  DimensionScore,
  ScorableFinding,
  ScoredFinding,
} from './scorer.js';
export { scoreFindings } from './scorer.js';
