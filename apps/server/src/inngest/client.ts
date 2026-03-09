/**
 * Inngest client configuration.
 *
 * Defines the Inngest client instance and event schemas
 * used across all durable functions.
 */

import type { StaticAnalysisResult } from 'ghagga-core';
import { EventSchemas, Inngest } from 'inngest';

// ─── Event Types ────────────────────────────────────────────────

export interface ReviewRequestedData {
  /** Correlation ID for end-to-end review tracing (8-char UUID prefix) */
  reviewId: string;

  /** GitHub installation ID for token exchange */
  installationId: number;

  /** Repository full name (e.g., "owner/repo") */
  repoFullName: string;

  /** Pull request number */
  prNumber: number;

  /** Internal repository ID in our database */
  repositoryId: number;

  /** HEAD commit SHA for the PR */
  headSha?: string;

  /** Base branch name */
  baseBranch?: string;

  // ── Provider chain (new) ──────────────────────────────────

  /** Ordered provider chain from DB (entries have encrypted keys) */
  providerChain?: Array<{
    provider: string;
    model: string;
    encryptedApiKey: string | null;
  }>;

  /** Whether AI review is enabled for this repo */
  aiReviewEnabled?: boolean;

  // ── Comment trigger metadata (optional) ────────────────────

  /** If review was triggered by a comment, the comment ID for reaction feedback */
  triggerCommentId?: number;

  // ── Legacy flat fields (backward compat) ──────────────────

  /** LLM provider to use */
  llmProvider: string;

  /** LLM model to use */
  llmModel: string;

  /** Review mode */
  reviewMode: string;

  /** Encrypted API key (will be decrypted at runtime) */
  encryptedApiKey: string | null;

  /** Review settings from repo configuration */
  settings: {
    enableSemgrep: boolean;
    enableTrivy: boolean;
    enableCpd: boolean;
    enableMemory: boolean;
    customRules: string[];
    ignorePatterns: string[];
    reviewLevel: string;
    enabledTools?: string[];
    disabledTools?: string[];
  };
}

// ─── Delegated CI Event Types ───────────────────────────────────

export interface DelegatedCiRequestedData {
  /** GitHub installation ID for token exchange */
  installationId: number;

  /** Internal repository ID in our database */
  repositoryId: number;

  /** Repository full name (e.g., "owner/repo") */
  repoFullName: string;

  /** Pull request number (optional for manual triggers) */
  prNumber?: number;

  /** HEAD commit SHA for the PR */
  headSha: string;

  /** Base branch name */
  baseBranch: string;

  /** Jobs that were approved by the policy evaluator */
  approvedJobs: Array<{
    jobKey: string;
    profile: string;
    allowArtifacts: false | string[];
    allowCache: boolean;
    maxDurationMinutes: number;
  }>;
}

export interface DelegatedCiCallbackData {
  /** Unique callback ID for correlation */
  callbackId: string;

  /** Repository full name (e.g., "owner/repo") */
  repoFullName: string;

  /** Job key identifying which CI job this callback is for */
  jobKey: string;

  /** Current state of the job */
  state: 'running' | 'completed' | 'failed';

  /** When the job started running */
  startedAt?: string;

  /** When the job completed */
  completedAt?: string;

  /** Total duration in milliseconds */
  durationMs?: number;

  /** Human-readable summary of the job result */
  summary?: string;

  /** Outcome of the job (only present when state is 'completed') */
  outcome?: 'success' | 'failure';

  /** Error code (only present when state is 'failed') */
  errorCode?: string;

  /** Error message (only present when state is 'failed') */
  errorMessage?: string;
}

// ─── Event Schemas ──────────────────────────────────────────────

export interface RunnerCompletedData {
  /** Unique callback ID for correlation */
  callbackId: string;

  /** Repository full name (e.g., "owner/repo") */
  repoFullName: string;

  /** Pull request number */
  prNumber: number;

  /** HEAD commit SHA */
  headSha: string;

  /** Precomputed static analysis results from the runner */
  staticAnalysis: StaticAnalysisResult;
}

type Events = {
  'ghagga/review.requested': {
    data: ReviewRequestedData;
  };
  'ghagga/runner.completed': {
    data: RunnerCompletedData;
  };
  'ghagga/delegated-ci.requested': {
    data: DelegatedCiRequestedData;
  };
  'ghagga/delegated-ci.callback': {
    data: DelegatedCiCallbackData;
  };
};

// ─── Client ─────────────────────────────────────────────────────

export const inngest = new Inngest({
  id: 'ghagga',
  schemas: new EventSchemas().fromRecord<Events>(),
});
