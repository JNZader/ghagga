/**
 * Forge-neutral contracts for one immutable, read-only explanation request.
 *
 * These contracts deliberately describe data only. Dispatch, authorization,
 * snapshot acquisition, persistence, and publication are owned by later layers.
 */

export const EXPLANATION_OUTCOME = {
  ANSWERED: 'ANSWERED',
  INVALID: 'INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  DISABLED: 'DISABLED',
  STALE: 'STALE',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AMBIGUOUS: 'AMBIGUOUS',
} as const;

export type ExplanationOutcomeKind = (typeof EXPLANATION_OUTCOME)[keyof typeof EXPLANATION_OUTCOME];

export interface ExplanationIdentity {
  readonly forgeInstance: string;
  readonly installationId: string;
  readonly actorId: string;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly requestedHeadSha: string;
  readonly sourceCommentId: string;
  readonly questionHash: string;
}

export interface ExplanationRequest {
  readonly identity: ExplanationIdentity;
  /** Untrusted source-comment text; the contract never interprets it as a command. */
  readonly question: string;
}

export interface ExplanationSnapshotFile {
  readonly path: string;
  readonly content: string;
}

export interface ExplanationSnapshot {
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diff: string;
  readonly files: readonly ExplanationSnapshotFile[];
}

export interface ExplanationMetadata {
  readonly provider: string;
  readonly model: string;
  readonly tokensUsed: number;
}

interface FindingFreeOutcome {
  readonly findings?: never;
  readonly verdict?: never;
  readonly coverage?: never;
  readonly reviewStatus?: never;
  readonly reviewScore?: never;
}

export interface AnsweredExplanationOutcome extends FindingFreeOutcome {
  readonly kind: typeof EXPLANATION_OUTCOME.ANSWERED;
  readonly answer: string;
  readonly metadata: ExplanationMetadata;
  readonly reason?: never;
}

export interface NonAnswerExplanationOutcome extends FindingFreeOutcome {
  readonly kind: Exclude<ExplanationOutcomeKind, typeof EXPLANATION_OUTCOME.ANSWERED>;
  readonly reason: string;
  readonly answer?: never;
  readonly metadata?: never;
}

export type ExplanationOutcome = AnsweredExplanationOutcome | NonAnswerExplanationOutcome;
