/**
 * The CI runner port — INTERFACE DEFINITION ONLY (task 0.4).
 *
 * This file is intentionally impl-free and unwired. It declares the seam the
 * forge-agnostic layer will use to ensure a CI workflow exists, dispatch a run,
 * and verify an async completion callback. No adapter implements it in P0; no
 * call-site consumes it in P0.
 */

import type { RepoRef } from '../types.js';

/** Outcome of {@link CiRunner.ensureWorkflow}. */
export interface EnsureWorkflowResult {
  /** Whether the required CI workflow is present and ready to dispatch. */
  ready: boolean;
  /** When not ready, a human-readable reason. */
  reason?: string;
}

/** A request to dispatch a CI run. */
export interface CiDispatchRequest {
  /** Repository to run CI in. */
  repo: RepoRef;
  /** Git ref (branch / SHA) to run against. */
  ref: string;
  /** Free-form inputs passed to the workflow. */
  inputs?: Record<string, string>;
}

/** Outcome of {@link CiRunner.dispatch}. */
export interface CiDispatchResult {
  /** Forge-native identifier of the dispatched run. */
  runId: string;
}

/**
 * Ensure / dispatch / verify a CI run on a forge.
 *
 * Definition only — implementation and wiring are out of scope for P0.
 */
export interface CiRunner {
  /** Ensure the required CI workflow exists in the repo. */
  ensureWorkflow(repo: RepoRef): Promise<EnsureWorkflowResult>;

  /** Dispatch a CI run. */
  dispatch(request: CiDispatchRequest): Promise<CiDispatchResult>;

  /**
   * Verify a completion callback's authenticity for a dispatched run.
   *
   * @returns true iff the callback is authentic for `id`.
   */
  verifyCallback(id: string, payload: unknown, signature: string): boolean;
}
