/**
 * Uniform runner for degradable pipeline steps.
 *
 * Most optional steps in the review pipeline share the same failure
 * contract: catch the error, console.warn with a step-specific label,
 * record the failure in `failedSteps`, and optionally emit a progress
 * event — then continue the pipeline.
 *
 * The catch bookkeeping order is fixed: warn → push → emit. This
 * reproduces every adopted call site byte-for-byte (the golden
 * snapshot suite pins both the warn strings and the emit stream).
 *
 * NOT every degradable step uses this helper — sites whose catch
 * blocks carry their own logic (blast-radius fallback metadata,
 * ai-review static-only fallback, the three `*Safe` helpers) stay
 * bespoke by design.
 *
 * ⚠️ INVARIANT: this helper assumes SEQUENTIAL execution. Wrapping a
 * synchronous `fn` in `await fn()` adds one microtask tick compared to
 * the original inline try/catch. That tick is invisible TODAY because
 * no adopted call site runs inside a `Promise.all` — every adoption is
 * awaited in pipeline order. If a future change runs `runDegradable`
 * sites concurrently, revisit this assumption (relative interleaving
 * of warns/pushes/emits would no longer be pinned by sequence).
 */

import type { ProgressEvent } from '../types.js';
import type { PipelineState } from './state.js';

export interface DegradableOpts {
  /** Step name recorded in `failedSteps` (e.g. 'recursive-review'). */
  step: string;
  /**
   * EXACT console.warn label, e.g.
   * '[ghagga] Recursive review failed (non-fatal):'.
   * Omitted = no console.warn at all (the ai-enhance case).
   */
  warnLabel?: string;
  /**
   * Progress event emitted after the failure is recorded.
   * Omitted = no emit (author-trust, memory-persist).
   */
  failEmit?: ProgressEvent;
  /**
   * Whether the failure is pushed to `failedSteps`. Defaults to true.
   * `false` marks a DELIBERATE non-uniformity: the step degrades with
   * a warn only and never surfaces in `failedSteps` (call-chain,
   * negative-examples, self-improve). The step name is still recorded
   * in `warnOnlyDegradations` so `coverageComplete` reflects it.
   */
  reportFailure?: boolean;
}

/**
 * Run `fn`, degrading gracefully on failure.
 *
 * On throw/rejection: console.warn(warnLabel, message) if warnLabel is
 * set → push `{ step, error }` to `failedSteps` (or the step name to
 * `warnOnlyDegradations` when `reportFailure === false`) → emit
 * `failEmit` if set. The error never propagates — the pipeline
 * continues.
 */
export async function runDegradable(
  state: Pick<PipelineState, 'failedSteps' | 'warnOnlyDegradations' | 'emit'>,
  opts: DegradableOpts,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.warnLabel) {
      console.warn(opts.warnLabel, message);
    }
    if (opts.reportFailure !== false) {
      state.failedSteps.push({ step: opts.step, error: message });
    } else {
      // Warn-only degradation: kept OUT of failedSteps (no PARTIAL
      // downgrade, no wire exposure) but recorded so coverageComplete
      // can tell the whole truth (see pipeline/finalize.ts).
      state.warnOnlyDegradations.push(opts.step);
    }
    if (opts.failEmit) {
      state.emit(opts.failEmit);
    }
  }
}
