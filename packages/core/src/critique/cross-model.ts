/**
 * Cross-model review: run the same PR through multiple models,
 * then surface disagreements as high-confidence findings.
 *
 * Where both models agree on an issue → confidence is high.
 * Where they disagree → flagged for human review.
 *
 * Builds on the dual-critique loop: each model's review goes through
 * self-critique before comparison, ensuring cleaner signal.
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { FindingSeverity, ProgressCallback, ReviewFinding, ReviewResult } from '../types.js';
import { runDualCritique } from './critique.js';
import type { DualCritiqueInput, DualCritiqueResult } from './types.js';

// ─── Types ─────────────────────────────────────────────────────

export type AgreementLevel = 'agreed' | 'model-a-only' | 'model-b-only' | 'disagreed';

/**
 * A finding annotated with cross-model agreement information.
 */
export interface CrossModelFinding extends ReviewFinding {
  /** Which models produced this finding */
  agreementLevel: AgreementLevel;

  /** Confidence derived from cross-model agreement (0.0–1.0) */
  crossModelConfidence: number;

  /** Which model(s) reported this finding */
  reportedBy: string[];
}

export interface CrossModelConfig {
  /**
   * Similarity threshold for matching findings across models.
   * Two findings are considered "the same" if they share the same file
   * and their messages have a similarity score above this threshold.
   * Default: 0.6
   */
  similarityThreshold: number;

  /**
   * Whether to run dual-critique on each model's review before comparison.
   * Default: true (recommended — reduces noise before cross-model diff)
   */
  enableCritique: boolean;

  /**
   * Confidence boost for agreed findings (added to base confidence).
   * Default: 0.3
   */
  agreementBoost: number;

  /**
   * Confidence penalty for single-model-only findings.
   * Default: 0.2
   */
  disagreementPenalty: number;
}

export const DEFAULT_CROSS_MODEL_CONFIG: CrossModelConfig = {
  similarityThreshold: 0.6,
  enableCritique: true,
  agreementBoost: 0.3,
  disagreementPenalty: 0.2,
};

export interface CrossModelInput {
  /** The code diff */
  diff: string;

  /** Static analysis context */
  staticContext: string;

  /** Memory context */
  memoryContext: string | null;

  /** Stack hints */
  stackHints: string;

  /** Optional checklist context */
  checklistContext?: string;

  /** Label for model A (e.g., "claude-sonnet") */
  modelALabel: string;

  /** Label for model B (e.g., "gpt-4o") */
  modelBLabel: string;

  /** Configuration */
  config?: Partial<CrossModelConfig>;
}

export interface CrossModelResult {
  /** Final status based on cross-model consensus */
  status: ReviewResult['status'];

  /** Summary incorporating cross-model analysis */
  summary: string;

  /** All findings with agreement annotations */
  findings: CrossModelFinding[];

  /** Metadata about the cross-model comparison */
  metadata: {
    modelALabel: string;
    modelBLabel: string;
    modelAFindingCount: number;
    modelBFindingCount: number;
    agreedCount: number;
    modelAOnlyCount: number;
    modelBOnlyCount: number;
    disagreedCount: number;
  };
}

// ─── Similarity ────────────────────────────────────────────────

/**
 * Simple word-overlap similarity between two strings.
 * Returns a score between 0.0 and 1.0.
 *
 * This is intentionally simple — we're comparing review finding
 * messages that should share significant vocabulary if they describe
 * the same issue.
 */
export function computeSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  // Jaccard similarity
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── Matching ──────────────────────────────────────────────────

interface FindingMatch {
  indexA: number;
  indexB: number;
  similarity: number;
}

/**
 * Match findings from two reviews based on file + message similarity.
 * Uses greedy matching: best match first, no finding matched twice.
 */
export function matchFindings(
  findingsA: ReviewFinding[],
  findingsB: ReviewFinding[],
  threshold: number,
): {
  matches: FindingMatch[];
  unmatchedA: number[];
  unmatchedB: number[];
} {
  const candidates: FindingMatch[] = [];

  for (let i = 0; i < findingsA.length; i++) {
    for (let j = 0; j < findingsB.length; j++) {
      // Must be about the same file
      if (findingsA[i].file !== findingsB[j].file) continue;

      const sim = computeSimilarity(findingsA[i].message, findingsB[j].message);
      if (sim >= threshold) {
        candidates.push({ indexA: i, indexB: j, similarity: sim });
      }
    }
  }

  // Greedy matching: sort by similarity desc, take best non-overlapping
  candidates.sort((a, b) => b.similarity - a.similarity);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const matches: FindingMatch[] = [];

  for (const candidate of candidates) {
    if (usedA.has(candidate.indexA) || usedB.has(candidate.indexB)) continue;
    matches.push(candidate);
    usedA.add(candidate.indexA);
    usedB.add(candidate.indexB);
  }

  const unmatchedA = findingsA.map((_, i) => i).filter((i) => !usedA.has(i));
  const unmatchedB = findingsB.map((_, i) => i).filter((i) => !usedB.has(i));

  return { matches, unmatchedA, unmatchedB };
}

// ─── Confidence ────────────────────────────────────────────────

/**
 * Compute confidence for a finding based on its severity and agreement.
 */
function baseConfidence(severity: FindingSeverity): number {
  switch (severity) {
    case 'critical':
      return 0.9;
    case 'high':
      return 0.8;
    case 'medium':
      return 0.6;
    case 'low':
      return 0.4;
    case 'info':
      return 0.3;
    default:
      return 0.5;
  }
}

// ─── Main Function ─────────────────────────────────────────────

/**
 * Run cross-model review: two models review the same diff,
 * then their findings are compared and annotated with agreement levels.
 *
 * @param reviewA - Review result from model A
 * @param reviewB - Review result from model B
 * @param input - Context for the cross-model comparison
 * @param generateFnA - LLM generation function for model A (used by critique)
 * @param generateFnB - LLM generation function for model B (used by critique)
 * @param onProgress - Optional progress callback
 */
export async function runCrossModelReview(
  reviewA: ReviewResult,
  reviewB: ReviewResult,
  input: CrossModelInput,
  generateFnA: GenerateTextFn,
  generateFnB: GenerateTextFn,
  onProgress?: ProgressCallback,
): Promise<CrossModelResult> {
  const emit = onProgress ?? (() => {});
  const config: CrossModelConfig = { ...DEFAULT_CROSS_MODEL_CONFIG, ...input.config };

  // ── Step 1: Optionally run dual-critique on each review ──────
  let critiquedA: DualCritiqueResult | ReviewResult = reviewA;
  let critiquedB: DualCritiqueResult | ReviewResult = reviewB;

  if (config.enableCritique) {
    emit({
      step: 'cross-model',
      message: `Running dual-critique on both models in parallel...`,
    });

    const critiqueInput: DualCritiqueInput = {
      diff: input.diff,
      staticContext: input.staticContext,
      memoryContext: input.memoryContext,
      stackHints: input.stackHints,
      checklistContext: input.checklistContext,
    };

    [critiquedA, critiquedB] = await Promise.all([
      runDualCritique(reviewA, critiqueInput, generateFnA, (event) =>
        emit({ ...event, message: `[${input.modelALabel}] ${event.message}` }),
      ),
      runDualCritique(reviewB, critiqueInput, generateFnB, (event) =>
        emit({ ...event, message: `[${input.modelBLabel}] ${event.message}` }),
      ),
    ]);
  }

  // ── Step 2: Extract AI findings from each model ──────────────
  const findingsA = critiquedA.findings.filter((f) => f.source === 'ai');
  const findingsB = critiquedB.findings.filter((f) => f.source === 'ai');

  emit({
    step: 'cross-model',
    message: `Comparing ${findingsA.length} findings from ${input.modelALabel} vs ${findingsB.length} from ${input.modelBLabel}...`,
  });

  // ── Step 3: Match findings across models ─────────────────────
  const { matches, unmatchedA, unmatchedB } = matchFindings(
    findingsA,
    findingsB,
    config.similarityThreshold,
  );

  // ── Step 4: Build annotated findings ─────────────────────────
  const crossFindings: CrossModelFinding[] = [];

  // Agreed findings (both models flagged the same issue)
  for (const match of matches) {
    const fA = findingsA[match.indexA];
    const fB = findingsB[match.indexB];

    // Use the higher severity between the two
    const severity = severityRank(fA.severity) >= severityRank(fB.severity)
      ? fA.severity
      : fB.severity;

    const conf = Math.min(1.0, baseConfidence(severity) + config.agreementBoost);

    crossFindings.push({
      ...fA,
      severity,
      agreementLevel: 'agreed',
      crossModelConfidence: conf,
      reportedBy: [input.modelALabel, input.modelBLabel],
    });
  }

  // Model A only
  for (const idx of unmatchedA) {
    const f = findingsA[idx];
    const conf = Math.max(0.1, baseConfidence(f.severity) - config.disagreementPenalty);

    crossFindings.push({
      ...f,
      agreementLevel: 'model-a-only',
      crossModelConfidence: conf,
      reportedBy: [input.modelALabel],
    });
  }

  // Model B only
  for (const idx of unmatchedB) {
    const f = findingsB[idx];
    const conf = Math.max(0.1, baseConfidence(f.severity) - config.disagreementPenalty);

    crossFindings.push({
      ...f,
      agreementLevel: 'model-b-only',
      crossModelConfidence: conf,
      reportedBy: [input.modelBLabel],
    });
  }

  // Sort by confidence descending
  crossFindings.sort((a, b) => b.crossModelConfidence - a.crossModelConfidence);

  // ── Step 5: Merge static findings (untouched) ────────────────
  // Collect static findings from model A only (avoid duplicates)
  const staticFindings: CrossModelFinding[] = critiquedA.findings
    .filter((f) => f.source !== 'ai')
    .map((f) => ({
      ...f,
      agreementLevel: 'agreed' as AgreementLevel,
      crossModelConfidence: 1.0,
      reportedBy: ['static-analysis'],
    }));

  const allFindings = [...crossFindings, ...staticFindings];

  // ── Step 6: Determine status ─────────────────────────────────
  const agreedCount = matches.length;
  const hasHighConfidenceCritical = crossFindings.some(
    (f) => f.agreementLevel === 'agreed' && (f.severity === 'critical' || f.severity === 'high'),
  );

  let status: ReviewResult['status'];
  if (hasHighConfidenceCritical) {
    status = 'FAILED';
  } else if (crossFindings.some((f) => f.agreementLevel !== 'agreed')) {
    status = 'NEEDS_HUMAN_REVIEW';
  } else if (crossFindings.length === 0) {
    status = 'PASSED';
  } else {
    status = 'PASSED';
  }

  const summary = buildCrossModelSummary(
    input.modelALabel,
    input.modelBLabel,
    agreedCount,
    unmatchedA.length,
    unmatchedB.length,
  );

  emit({
    step: 'cross-model',
    message: `Cross-model complete: ${agreedCount} agreed, ${unmatchedA.length} ${input.modelALabel}-only, ${unmatchedB.length} ${input.modelBLabel}-only`,
  });

  return {
    status,
    summary,
    findings: allFindings,
    metadata: {
      modelALabel: input.modelALabel,
      modelBLabel: input.modelBLabel,
      modelAFindingCount: findingsA.length,
      modelBFindingCount: findingsB.length,
      agreedCount,
      modelAOnlyCount: unmatchedA.length,
      modelBOnlyCount: unmatchedB.length,
      disagreedCount: 0,
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function severityRank(severity: FindingSeverity): number {
  switch (severity) {
    case 'critical':
      return 5;
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    case 'info':
      return 1;
    default:
      return 0;
  }
}

function buildCrossModelSummary(
  modelA: string,
  modelB: string,
  agreed: number,
  aOnly: number,
  bOnly: number,
): string {
  const parts: string[] = [];

  if (agreed > 0) {
    parts.push(`${agreed} finding(s) confirmed by both ${modelA} and ${modelB} (high confidence)`);
  }

  if (aOnly > 0) {
    parts.push(`${aOnly} finding(s) reported only by ${modelA} (needs human verification)`);
  }

  if (bOnly > 0) {
    parts.push(`${bOnly} finding(s) reported only by ${modelB} (needs human verification)`);
  }

  if (parts.length === 0) {
    return `Cross-model review by ${modelA} and ${modelB}: no issues found.`;
  }

  return `Cross-model review: ${parts.join('; ')}.`;
}
