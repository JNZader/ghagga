/**
 * Digest aggregation for stored findings (nightly-health-digest S1).
 *
 * Pure, forge-agnostic DB-sourced health inputs: aggregates `reviews.findings`
 * jsonb rows into the window finding set + per-severity counts the nightly
 * digest consumes, and ranks files by risk (severity weight x recency, with
 * blast-radius and path tiebreaks). No LLM calls, no HTTP, no filesystem.
 */

import type { FindingSeverity, ReviewFinding } from '../types.js';
import { SEVERITY_WEIGHTS } from './score.js';

/** One stored review row as read from the `reviews` table. */
export interface ReviewRow {
  /** Raw `reviews.findings` jsonb — unknown by contract, parsed defensively. */
  findings: unknown;
  /** Raw `reviews.metadata` jsonb — blast-radius counts live here when present. */
  metadata: unknown;
  /** Review creation timestamp. */
  createdAt: Date;
}

/** Per-review finding group carried into risk ranking (recency is per review). */
export interface DigestReviewGroup {
  createdAt: Date;
  findings: ReviewFinding[];
  /** Best-effort blast-radius dependents from review metadata (0 when absent). */
  blastRadiusDependents: number;
}

/** Aggregated digest inputs for one repository window. */
export interface DigestInputs {
  /** Combined well-formed findings across the window (scoring-equivalent set). */
  findings: ReviewFinding[];
  /** Per-severity counts across the window (all five keys initialized). */
  severityCounts: Record<FindingSeverity, number>;
  /** Per-review finding groups inside the window (ranking recency source). */
  reviews: DigestReviewGroup[];
  /** Max blast-radius dependents observed per file across window reviews. */
  fileBlastRadius: Record<string, number>;
  /** Rows whose findings yielded no valid entries (malformed jsonb tolerance). */
  skippedRows: number;
}

/** One ranked file in the digest. */
export interface FileRisk {
  file: string;
  /** `Σ |SEVERITY_WEIGHTS[severity]| x recency` across window reviews. */
  score: number;
  /** Max blast-radius dependents from review metadata (0 when absent). */
  blastRadius: number;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set(Object.keys(SEVERITY_WEIGHTS));

/**
 * Ranking window: only the last 30 days of reviews contribute (D2).
 * MUST match `DIGEST_RANKING_WINDOW_DAYS` in `packages/db/src/queries.ts`
 * (same constant, two homes — deliberately NOT a shared import: core must
 * not depend on db, nor db on core; change them together).
 */
export const RANKING_WINDOW_DAYS = 30;
/** Recency tier boundary: reviews at most this old score at full weight. */
export const RECENCY_FULL_DAYS = 7;
/** Maximum number of ranked files in a digest. */
export const MAX_RANKED_FILES = 10;

function emptySeverityCounts(): Record<FindingSeverity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

/**
 * Parse one row's raw findings jsonb into valid `ReviewFinding[]`.
 *
 * Malformed shapes (`null`, non-array, entries missing severity) are skipped —
 * never thrown on. Entries with a valid severity but no `file` are KEPT (they
 * count toward severity totals) and simply never rank.
 */
function parseFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];

  const parsed: ReviewFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.severity !== 'string' || !VALID_SEVERITIES.has(candidate.severity)) {
      continue;
    }
    parsed.push(entry as unknown as ReviewFinding);
  }
  return parsed;
}

/** Best-effort blast-radius dependents from raw review metadata (0 when absent). */
function blastRadiusDependents(metadata: unknown): number {
  if (typeof metadata !== 'object' || metadata === null) return 0;
  const blastRadius = (metadata as Record<string, unknown>).blastRadius;
  if (typeof blastRadius !== 'object' || blastRadius === null) return 0;
  const count = (blastRadius as Record<string, unknown>).blastRadiusFiles;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Aggregate stored review rows into digest inputs.
 *
 * Rows created at or before `since` (the watermark) are excluded entirely.
 * Malformed findings rows are skipped and counted, never fatal; well-formed
 * rows in the same window aggregate normally.
 */
export function aggregateHealth(rows: ReviewRow[], since?: Date): DigestInputs {
  const inputs: DigestInputs = {
    findings: [],
    severityCounts: emptySeverityCounts(),
    reviews: [],
    fileBlastRadius: {},
    skippedRows: 0,
  };

  for (const row of rows) {
    if (since && row.createdAt.getTime() <= since.getTime()) continue;

    const findings = parseFindings(row.findings);
    if (findings.length === 0) {
      inputs.skippedRows += 1;
      continue;
    }

    const dependents = blastRadiusDependents(row.metadata);
    inputs.reviews.push({
      createdAt: row.createdAt,
      findings,
      blastRadiusDependents: dependents,
    });
    inputs.findings.push(...findings);

    for (const finding of findings) {
      inputs.severityCounts[finding.severity] += 1;
      if (typeof finding.file === 'string' && finding.file.length > 0) {
        const current = inputs.fileBlastRadius[finding.file] ?? 0;
        inputs.fileBlastRadius[finding.file] = Math.max(current, dependents);
      }
    }
  }

  return inputs;
}

/**
 * Rank files by digest risk (D2): `fileRisk = Σ |SEVERITY_WEIGHTS[severity]| x
 * recency` summed per file over reviews inside the 30-day window. Review age
 * ≤ 7 days scores at full weight, otherwise half. Ties break on max
 * blast-radius dependents, then path ascending. Top 10 only. Deterministic:
 * identical inputs and `now` produce identical output.
 */
export function rankFileRisk(digestInputs: DigestInputs, now: Date): FileRisk[] {
  const windowStart = now.getTime() - RANKING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const fullWeightCutoff = now.getTime() - RECENCY_FULL_DAYS * 24 * 60 * 60 * 1000;

  const scores = new Map<string, number>();

  for (const review of digestInputs.reviews) {
    if (review.createdAt.getTime() < windowStart) continue;
    const multiplier = review.createdAt.getTime() >= fullWeightCutoff ? 1.0 : 0.5;

    for (const finding of review.findings) {
      if (typeof finding.file !== 'string' || finding.file.length === 0) continue;
      const weight = Math.abs(SEVERITY_WEIGHTS[finding.severity] ?? 0);
      if (weight === 0) continue;
      scores.set(finding.file, (scores.get(finding.file) ?? 0) + weight * multiplier);
    }
  }

  return [...scores.entries()]
    .map(([file, score]) => ({ file, score, blastRadius: digestInputs.fileBlastRadius[file] ?? 0 }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.blastRadius !== a.blastRadius) return b.blastRadius - a.blastRadius;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    })
    .slice(0, MAX_RANKED_FILES);
}
