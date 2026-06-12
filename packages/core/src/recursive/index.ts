/**
 * Recursive Review Loop — Public API
 *
 * Self-validating review cycle: after suggesting fixes, re-run review
 * on the suggested patches to verify they don't introduce new issues.
 *
 * Flow:
 *   1. Extract patches from findings with suggestions
 *   2. Apply patches virtually (no filesystem changes)
 *   3. Re-review the patched diff
 *   4. Check convergence (max 2 iterations or no new issues)
 *   5. Build regression report
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { ReviewFinding } from '../types.js';
import {
  checkCircuitBreaker,
  createCircuitBreakerState,
  updateCircuitBreakerState,
} from './circuit-breaker.js';
import { applyVirtualPatches, buildPatchContext, extractPatches } from './patch-extractor.js';
import { runReReview } from './re-reviewer.js';
import type {
  RecursiveReviewConfig,
  RecursiveReviewReport,
  RegressionFinding,
  SuggestionPatch,
} from './types.js';
import { DEFAULT_RECURSIVE_CONFIG } from './types.js';

// ─── Orchestrator ──────────────────────────────────────────────

export interface RecursiveReviewInput {
  /** Original diff (before any patches) */
  originalDiff: string;

  /** Findings from the initial review (to extract suggestions from) */
  findings: ReviewFinding[];

  /** Generation function for re-review LLM calls */
  generateFn: GenerateTextFn;

  /** Optional configuration overrides */
  config?: Partial<RecursiveReviewConfig>;

  /** Optional progress callback */
  onProgress?: (message: string) => void;

  /** Feature flags forwarded from ReviewInput.features */
  features?: { circuitBreaker?: boolean };
}

/**
 * Run the recursive review loop.
 *
 * Extracts suggestion patches from findings, applies them virtually,
 * and re-reviews to catch regressions. Stops when no new issues are
 * found or after maxIterations.
 *
 * @param input - Original diff, findings, and LLM config
 * @returns Report with convergence status and any regressions found
 */
export async function recursiveReview(
  input: RecursiveReviewInput,
): Promise<RecursiveReviewReport | null> {
  const config: RecursiveReviewConfig = {
    ...DEFAULT_RECURSIVE_CONFIG,
    ...input.config,
  };
  const emit = input.onProgress ?? (() => {});

  // Step 1: Extract patches from findings
  const patches = extractPatches(input.findings);

  if (patches.length === 0) {
    emit('Recursive review: no suggestions to validate');
    return null;
  }

  emit(`Recursive review: ${patches.length} suggestion(s) to validate`);

  let currentDiff = input.originalDiff;
  let currentPatches = patches;
  let totalNewIssues = 0;
  const allRegressions: RegressionFinding[] = [];

  const circuitBreakerEnabled = input.features?.circuitBreaker !== false;
  let cbState = createCircuitBreakerState(config.circuitBreakerThreshold ?? 2);

  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    emit(`Recursive review: iteration ${iteration}/${config.maxIterations}`);

    // Step 2: Apply patches virtually.
    // `applyVirtualPatches` returns a `VirtualPatchResult` ({ diff, injectedLineIndices }).
    // Only `diff` is consumed by the recursive loop today. The out-of-band
    // `injectedLineIndices` (marker positions) are collision-immune metadata that a
    // future marker-aware classifier could read; if/when that lands, destructure it
    // here and thread it LOOP-LOCAL — it must NEVER enter `RecursiveReviewReport`.
    const { diff: patchedDiff } = applyVirtualPatches(currentDiff, currentPatches);
    const patchContext = buildPatchContext(currentPatches);

    // Step 3: Re-review
    const reReviewResult = await runReReview({
      patchedDiff,
      patchContext,
      generateFn: input.generateFn,
    });

    const newFindings = reReviewResult.findings;
    totalNewIssues += newFindings.length;

    // Step 4a: Circuit breaker — detect semantic loops before convergence check
    if (circuitBreakerEnabled) {
      const cbResult = checkCircuitBreaker(newFindings, cbState);
      if (cbResult.shouldBreak) {
        emit(`Recursive review: ${cbResult.reason}`);
        return {
          iterations: iteration,
          converged: false,
          regressions: allRegressions,
          totalNewIssues,
        };
      }
      cbState = updateCircuitBreakerState(newFindings, cbState);
    }

    // Step 4b: Check convergence
    if (newFindings.length === 0) {
      emit(`Recursive review: converged after ${iteration} iteration(s) — no new issues`);
      return {
        iterations: iteration,
        converged: true,
        regressions: allRegressions,
        totalNewIssues,
      };
    }

    // Step 5: Classify regressions
    const regressions = classifyRegressions(newFindings, currentPatches);
    allRegressions.push(...regressions);

    emit(
      `Recursive review: iteration ${iteration} found ${newFindings.length} new issue(s), ${regressions.length} regression(s)`,
    );

    // For the next iteration, the new findings become the patches to check
    // But only if they also have suggestions
    const nextPatches = extractPatches(newFindings);
    if (nextPatches.length === 0) {
      // New issues found but no new suggestions — can't iterate further
      return {
        iterations: iteration,
        converged: false,
        regressions: allRegressions,
        totalNewIssues,
      };
    }

    currentDiff = patchedDiff;
    currentPatches = nextPatches;
  }

  // Max iterations reached without convergence
  emit(`Recursive review: max iterations (${config.maxIterations}) reached without convergence`);
  return {
    iterations: config.maxIterations,
    converged: false,
    regressions: allRegressions,
    totalNewIssues,
  };
}

// ─── Regression Classification ─────────────────────────────────

/**
 * Classify which re-review findings are regressions from applied patches.
 *
 * A finding is a regression if it targets the same file as a patch.
 * Line-level matching is best-effort (LLM line numbers can be approximate).
 */
function classifyRegressions(
  findings: ReviewFinding[],
  patches: SuggestionPatch[],
): RegressionFinding[] {
  const patchFileSet = new Set(patches.map((p) => p.file));
  const patchByFile = new Map<string, SuggestionPatch[]>();
  for (const patch of patches) {
    const existing = patchByFile.get(patch.file) ?? [];
    existing.push(patch);
    patchByFile.set(patch.file, existing);
  }

  const regressions: RegressionFinding[] = [];

  for (const finding of findings) {
    if (!patchFileSet.has(finding.file)) continue;

    // Find the closest matching patch in the same file
    const filePatches = patchByFile.get(finding.file) ?? [];
    const closestPatch = findClosestPatch(finding, filePatches);

    if (closestPatch) {
      regressions.push({
        ...finding,
        isRegression: true,
        originatingSuggestion: {
          file: closestPatch.file,
          line: closestPatch.line,
          suggestion: closestPatch.suggestion,
        },
      });
    }
  }

  return regressions;
}

/**
 * Find the patch closest to a finding by line number.
 * Falls back to the first patch in the file if no line match.
 */
function findClosestPatch(
  finding: ReviewFinding,
  patches: SuggestionPatch[],
): SuggestionPatch | undefined {
  if (patches.length === 0) return undefined;
  if (patches.length === 1) return patches[0];
  if (!finding.line) return patches[0];

  let closest = patches[0];
  let minDistance = Number.MAX_SAFE_INTEGER;

  for (const patch of patches) {
    if (!patch.line) continue;
    const distance = Math.abs(finding.line - patch.line);
    if (distance < minDistance) {
      minDistance = distance;
      closest = patch;
    }
  }

  return closest;
}

// ─── Re-exports ────────────────────────────────────────────────

export type { VirtualPatchResult } from './patch-extractor.js';
export { applyVirtualPatches, buildPatchContext, extractPatches } from './patch-extractor.js';
export type { ReReviewInput, ReReviewResult } from './re-reviewer.js';
export { runReReview } from './re-reviewer.js';
export type {
  RecursiveReviewConfig,
  RecursiveReviewReport,
  RegressionFinding,
  SuggestionPatch,
} from './types.js';
export { DEFAULT_RECURSIVE_CONFIG } from './types.js';
