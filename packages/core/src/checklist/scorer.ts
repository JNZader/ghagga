/**
 * Checklist scoring engine — evaluates review findings against weighted checks.
 *
 * Maps each finding to the most relevant checklist dimension/check using
 * keyword matching, then produces a weighted score sorted by severity.
 */

import type { FindingSeverity } from '../types.js';
import { SEVERITY_MULTIPLIER } from './types.js';
import type { ChecklistCheck, ChecklistConfig, ChecklistDimension } from './types.js';

// ─── Types ────────────────────────────────────────────────────

/** A finding scored against a specific checklist check. */
export interface ScoredFinding {
  /** Original finding index in the input array. */
  findingIndex: number;

  /** The dimension this finding was matched to. */
  dimensionId: string;

  /** The specific check this finding was matched to, or null if matched to dimension only. */
  checkId: string | null;

  /** The check weight (1-10), or 5 as default for dimension-only matches. */
  checkWeight: number;

  /** The severity multiplier applied. */
  severityMultiplier: number;

  /** Final weighted score: checkWeight * severityMultiplier. */
  score: number;
}

/** Summary of checklist scoring results. */
export interface ChecklistScoreResult {
  /** Total weighted score across all matched findings. */
  totalScore: number;

  /** Scored findings, sorted by score descending (highest severity first). */
  findings: ScoredFinding[];

  /** Per-dimension score summary. */
  dimensionScores: DimensionScore[];
}

/** Score summary for a single dimension. */
export interface DimensionScore {
  dimensionId: string;
  dimensionName: string;
  totalScore: number;
  findingCount: number;
}

// ─── Keyword Maps ─────────────────────────────────────────────

/**
 * Keywords that map finding categories/messages to dimension IDs.
 * Checked in order: first match wins.
 */
const DIMENSION_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['solid', ['solid', 'single responsibility', 'srp', 'open closed', 'ocp', 'liskov', 'lsp', 'interface segregation', 'isp', 'dependency inversion', 'dip', 'coupling', 'cohesion', 'god class', 'fat interface']],
  ['error-handling', ['error', 'exception', 'catch', 'throw', 'try', 'finally', 'unhandled', 'silent failure', 'swallow', 'propagat']],
  ['boundary-conditions', ['boundary', 'null', 'undefined', 'empty', 'overflow', 'underflow', 'division by zero', 'nan', 'unicode', 'encoding', 'race condition', 'concurrent', 'off-by-one']],
  ['security', ['security', 'injection', 'xss', 'csrf', 'auth', 'token', 'password', 'secret', 'credential', 'sensitive', 'sanitiz', 'validat', 'vulnerab', 'cve', 'exploit']],
]);

/**
 * Keywords that map to specific check IDs within a dimension.
 */
const CHECK_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  // SOLID
  ['single-responsibility', ['single responsibility', 'srp', 'one reason to change', 'god class', 'too many responsibilities']],
  ['open-closed', ['open closed', 'ocp', 'open for extension', 'closed for modification']],
  ['liskov-substitution', ['liskov', 'lsp', 'substitut', 'subtype', 'base type']],
  ['interface-segregation', ['interface segregation', 'isp', 'fat interface', 'too many methods']],
  ['dependency-inversion', ['dependency inversion', 'dip', 'depend on abstraction', 'concrete dependency', 'coupling']],
  // Error handling
  ['error-propagation', ['error propagat', 'error context', 'wrap error', 'error chain']],
  ['error-recovery', ['error recovery', 'graceful', 'fallback', 'retry', 'degrad']],
  ['error-types', ['error type', 'specific error', 'generic error', 'custom error']],
  ['silent-failures', ['silent', 'swallow', 'empty catch', 'ignore error']],
  ['async-error-handling', ['async error', 'promise', 'unhandled rejection', 'await', '.catch']],
  // Boundary conditions
  ['null-undefined', ['null', 'undefined', 'nil', 'optional', 'nullable', 'nullish']],
  ['empty-collections', ['empty array', 'empty list', 'empty map', 'empty string', 'length 0', 'size 0']],
  ['numeric-limits', ['overflow', 'underflow', 'division by zero', 'nan', 'infinity', 'max safe integer']],
  ['string-encoding', ['unicode', 'utf', 'encoding', 'multi-byte', 'special character']],
  ['concurrency-bounds', ['race condition', 'concurrent', 'mutex', 'lock', 'deadlock', 'thread safe']],
  // Security
  ['input-validation', ['input validat', 'sanitiz', 'untrusted input', 'user input']],
  ['auth-checks', ['auth', 'authentication', 'authorization', 'permission', 'access control']],
  ['sensitive-data', ['sensitive data', 'password', 'token', 'secret', 'pii', 'credential', 'api key']],
  ['injection-prevention', ['injection', 'xss', 'sql inject', 'command inject', 'path traversal']],
  ['dependency-safety', ['dependency', 'vulnerab', 'cve', 'outdated', 'known vulnerab']],
]);

// ─── Finding Input ────────────────────────────────────────────

/** Minimal finding shape needed for scoring. */
export interface ScorableFinding {
  severity: FindingSeverity;
  category: string;
  message: string;
}

// ─── Scoring ──────────────────────────────────────────────────

/**
 * Score an array of findings against a resolved checklist configuration.
 *
 * Each finding is matched to the most relevant dimension and check
 * using keyword analysis of its category and message fields.
 * Unmatched findings are excluded from the score.
 *
 * @param findings - Array of findings to score
 * @param config - Resolved checklist configuration (must be non-null and enabled)
 * @returns Scored results sorted by weighted score descending
 */
export function scoreFindings(
  findings: readonly ScorableFinding[],
  config: ChecklistConfig,
): ChecklistScoreResult {
  const activeDimensions = config.dimensions.filter((d) => d.enabled);
  if (activeDimensions.length === 0) {
    return { totalScore: 0, findings: [], dimensionScores: [] };
  }

  const scored: ScoredFinding[] = [];

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!;
    const match = matchFinding(finding, activeDimensions);
    if (!match) continue;

    const severityMultiplier = SEVERITY_MULTIPLIER[finding.severity] ?? 1;
    const score = match.weight * severityMultiplier;

    scored.push({
      findingIndex: i,
      dimensionId: match.dimensionId,
      checkId: match.checkId,
      checkWeight: match.weight,
      severityMultiplier,
      score,
    });
  }

  // Sort by score descending (highest severity first)
  scored.sort((a, b) => b.score - a.score);

  // Build dimension summaries
  const dimMap = new Map<string, DimensionScore>();
  for (const dim of activeDimensions) {
    dimMap.set(dim.id, {
      dimensionId: dim.id,
      dimensionName: dim.name,
      totalScore: 0,
      findingCount: 0,
    });
  }

  for (const sf of scored) {
    const ds = dimMap.get(sf.dimensionId);
    if (ds) {
      ds.totalScore += sf.score;
      ds.findingCount += 1;
    }
  }

  const dimensionScores = Array.from(dimMap.values())
    .filter((ds) => ds.findingCount > 0)
    .sort((a, b) => b.totalScore - a.totalScore);

  const totalScore = scored.reduce((sum, sf) => sum + sf.score, 0);

  return { totalScore, findings: scored, dimensionScores };
}

// ─── Matching ─────────────────────────────────────────────────

interface MatchResult {
  dimensionId: string;
  checkId: string | null;
  weight: number;
}

const DEFAULT_DIMENSION_WEIGHT = 5;

/**
 * Match a finding to the best dimension and check using keyword analysis.
 * Returns null if no dimension matches.
 */
function matchFinding(
  finding: ScorableFinding,
  dimensions: ChecklistDimension[],
): MatchResult | null {
  const text = `${finding.category} ${finding.message}`.toLowerCase();

  // Try to match a specific check first (more precise)
  for (const dim of dimensions) {
    if (!dim.enabled) continue;
    const activeChecks = dim.checks.filter((c) => c.enabled);

    for (const check of activeChecks) {
      const keywords = CHECK_KEYWORDS.get(check.id);
      if (keywords && keywords.some((kw) => text.includes(kw))) {
        return { dimensionId: dim.id, checkId: check.id, weight: check.weight };
      }
    }
  }

  // Fallback: match at dimension level
  for (const dim of dimensions) {
    if (!dim.enabled) continue;
    const keywords = DIMENSION_KEYWORDS.get(dim.id);
    if (keywords && keywords.some((kw) => text.includes(kw))) {
      // Use average weight of active checks in this dimension
      const activeChecks = dim.checks.filter((c) => c.enabled);
      const avgWeight = activeChecks.length > 0
        ? Math.round(activeChecks.reduce((s, c) => s + c.weight, 0) / activeChecks.length)
        : DEFAULT_DIMENSION_WEIGHT;
      return { dimensionId: dim.id, checkId: null, weight: avgWeight };
    }
  }

  return null;
}
