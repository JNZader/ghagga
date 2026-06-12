/**
 * Main review pipeline orchestrator.
 *
 * Coordinates the entire review flow as a thin sequence of phases
 * (each phase lives in `pipeline/` and shares a single mutable
 * `PipelineState` — see `pipeline/state.ts`):
 *
 *   prepare        → validate, parse/filter diff, flood check,
 *                    blast-radius, call-chain, stacks, token budget
 *   gather-context → static analysis ∥ memory ∥ code-intel + prompts
 *   execute        → enhance compute, trust scoring, agent dispatch
 *   enrich         → merge findings + post-processing (7 → 7.8)
 *   finalize       → persist to memory + status downgrade
 *
 * Each step degrades gracefully — if static analysis fails, or
 * memory is unavailable, the pipeline continues with what it has.
 */

import { enrich } from './pipeline/enrich.js';
import { execute } from './pipeline/execute.js';
import { finalize } from './pipeline/finalize.js';
import { gatherContext } from './pipeline/gather-context.js';
import { prepare } from './pipeline/prepare.js';
import type { PipelineState } from './pipeline/state.js';
import type { ReviewInput, ReviewResult } from './types.js';

/**
 * Run the full review pipeline.
 *
 * This is the primary entry point for all review operations.
 * It orchestrates parsing, analysis, agent execution, and
 * memory operations in a resilient pipeline that degrades
 * gracefully when optional components fail.
 *
 * @param input - Complete review input with diff, config, and settings
 * @returns ReviewResult with status, findings, and metadata
 */
export async function reviewPipeline(input: ReviewInput): Promise<ReviewResult> {
  // ── Steps 1 → 4: prepare (validate + parse/filter + budget) ──
  // Constructs the shared PipelineState base, or short-circuits with a
  // final result (flood-skip / all-files-filtered).
  const prepared = await prepare(input);
  if (prepared.kind === 'early') {
    return prepared.result;
  }
  const base = prepared.base;

  // ── Steps 5 → 5.4: gather context (trio ∥ + prompts + checklist) ──
  await gatherContext(base);

  // ── Steps 5.5 → 6: execute (enhance compute + trust + dispatch) ──
  const result = await execute(base);

  // Attach the result created by execute. Object.assign keeps the SAME
  // base object (no copy — aliases like `failedSteps` stay intact) and
  // upgrades it to a full PipelineState.
  const state: PipelineState = Object.assign(base, { result });

  // ── Steps 7 → 7.8: enrich (merge + post-processing) ─────────
  await enrich(state);

  // ── Steps 8 → 9: finalize (persist + status downgrade) ──────
  await finalize(state);

  return state.result;
}
