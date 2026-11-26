/**
 * Finalize phase: steps 8 → 9 of the review pipeline.
 *
 *   8  persist review observations to memory (awaited for SQLite correctness)
 *   9  attach failed steps, set coverageComplete, downgrade PASSED → PARTIAL
 *
 * ⚠️ The downgrade is PASSED-only ON PURPOSE: a FAILED review stays
 * FAILED even when steps degraded (pinned by pipeline.test.ts —
 * "preserves FAILED status even when steps fail"). Do NOT "fix" this.
 * The first-class coverage signal for non-PASSED statuses is
 * `coverageComplete` (orthogonal to the verdict), set below for EVERY
 * result that reaches finalize. It accounts for BOTH degradation kinds:
 * tracked failures (`failedSteps`) AND warn-only degradations
 * (`reportFailure: false` sites — call-chain, negative-examples,
 * self-improve, semantic-diff), which never enter `failedSteps`, never trigger the
 * PARTIAL downgrade, and stay internal — but still mean incomplete
 * coverage. SKIPPED early-returns (flood-skip / all-files-filtered)
 * short-circuit in prepare and never reach this phase — they stay
 * `coverageComplete: undefined` (not applicable).
 */

import { persistReviewObservations } from '../memory/persist.js';
import { openFindingsStillFail, verifyBeforePublish } from '../security/verify-before-publish.js';
import { FINDING_LEDGER_STATUS } from '../types.js';
import { runDegradable } from './degrade.js';
import type { PipelineState } from './state.js';

/**
 * Run the finalize phase. Mutates `state.result` in-place.
 */
export async function finalize(state: PipelineState): Promise<void> {
  const { input, result } = state;

  // Mandatory refuter. A failure here must not block the review: the
  // helper swallows its own errors, and this guard is the second line.
  try {
    const verified = verifyBeforePublish(result.findings);
    const changed = verified.some(
      (finding, index) => finding.ledgerStatus !== result.findings[index]?.ledgerStatus,
    );
    if (changed) {
      result.findings = verified;
      if (result.status === 'FAILED' && !openFindingsStillFail(verified)) {
        const open = verified.filter(
          (finding) => finding.ledgerStatus !== FINDING_LEDGER_STATUS.refuted,
        );
        result.status = open.length > 0 ? 'NEEDS_HUMAN_REVIEW' : 'PASSED';
      }
    }
  } catch (error) {
    console.warn(
      '[ghagga] Security verification failed (non-fatal):',
      error instanceof Error ? error.message : String(error),
    );
  }

  // ── Step 8: Persist to memory (awaited for SQLite correctness) ──
  if (input.settings.enableMemory && input.memoryStorage && input.context) {
    // Hoisted consts: property narrowing does not survive inside closures.
    const memoryStorage = input.memoryStorage;
    const reviewContext = input.context;
    await runDegradable(
      state,
      { step: 'memory-persist', warnLabel: '[ghagga] Memory persist failed (non-fatal):' },
      async () => {
        await persistReviewObservations(
          memoryStorage,
          reviewContext.repoFullName,
          reviewContext.prNumber,
          result,
        );
      },
    );
  }

  // ── Step 9: Attach failed steps and mark as PARTIAL ─────────
  // Coverage is orthogonal to the verdict: every result that reaches
  // finalize gets the signal, including FAILED / NEEDS_HUMAN_REVIEW.
  // Warn-only degradations count too — the boolean tells the WHOLE
  // truth even though the step names stay internal.
  result.coverageComplete =
    state.failedSteps.length === 0 && state.warnOnlyDegradations.length === 0;
  if (state.failedSteps.length > 0) {
    result.failedSteps = state.failedSteps;
    // Only downgrade to PARTIAL if the review otherwise appeared successful
    if (result.status === 'PASSED') {
      result.status = 'PARTIAL';
    }
  }
}
