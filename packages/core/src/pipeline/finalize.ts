/**
 * Finalize phase: steps 8 → 9 of the review pipeline.
 *
 *   8  persist review observations to memory (awaited for SQLite correctness)
 *   9  attach failed steps and downgrade PASSED → PARTIAL
 *
 * ⚠️ The downgrade is PASSED-only ON PURPOSE: a FAILED review stays
 * FAILED even when steps degraded (pinned by pipeline.test.ts —
 * "preserves FAILED status even when steps fail"). Do NOT "fix" this.
 */

import { persistReviewObservations } from '../memory/persist.js';
import { runDegradable } from './degrade.js';
import type { PipelineState } from './state.js';

/**
 * Run the finalize phase. Mutates `state.result` in-place.
 */
export async function finalize(state: PipelineState): Promise<void> {
  const { input, result } = state;

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
  if (state.failedSteps.length > 0) {
    result.failedSteps = state.failedSteps;
    // Only downgrade to PARTIAL if the review otherwise appeared successful
    if (result.status === 'PASSED') {
      result.status = 'PARTIAL';
    }
  }
}
