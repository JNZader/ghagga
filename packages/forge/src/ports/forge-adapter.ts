/**
 * The forge adapter port.
 *
 * A {@link ForgeAdapter} is what the core review engine talks to instead of any
 * concrete forge SDK. {@link ForgeAdapterBase} is the mandatory surface every
 * adapter MUST implement; optional capabilities are factored into discrete
 * sub-interfaces composed onto the base via `Partial<>`.
 *
 * R-CAPABILITY (the load-bearing rule of this file):
 * - Optional methods are guarded at runtime by METHOD PRESENCE
 *   (`'fetchGraph' in adapter`), NEVER by the {@link ForgeCapabilities} flags.
 * - The `capabilities` field is a HINT for planning/UI only. A misconfigured
 *   flag must never cause a missing method to be invoked (TypeError) nor a
 *   present method to be skipped.
 * - Sub-interfaces exist so that, once you DO narrow via `'m' in adapter`, TS
 *   gives you the full co-present method set of that capability (e.g. narrowing
 *   on `fetchGraph` co-presence is expressed by the {@link GraphReadCapable}
 *   interface owning BOTH graph methods).
 */

// Type-position import from core. This is the SANCTIONED forge→core import:
// core's graph schema is the canonical graph representation, and importing it
// `import type` keeps it strictly in type position (R-AGNOSTIC: forge may import
// core in TYPE position only; core MUST NOT import forge at all).
import type { DependencyGraph, GraphMetadata } from 'ghagga-core';
import type {
  ChangedFile,
  ChangeRequest,
  ChangeRequestRef,
  CommentId,
  CommentMarker,
  Commit,
  ForgeCapabilities,
  PublishReport,
  RepoRef,
  UnifiedDiff,
  UpsertSummaryResult,
} from '../types.js';

/** Kinds of reactions an adapter may support. */
export const REACTION_KIND = {
  THUMBS_UP: '+1',
  THUMBS_DOWN: '-1',
  EYES: 'eyes',
  ROCKET: 'rocket',
  CONFUSED: 'confused',
} as const;

export type ReactionKind = (typeof REACTION_KIND)[keyof typeof REACTION_KIND];

/** A single line-anchored inline comment to publish. */
export interface InlineComment {
  /** File the comment anchors to. */
  path: string;
  /** Line number (in the diff's head revision). */
  line: number;
  /** Comment body (markdown). */
  body: string;
}

/**
 * Mandatory surface every forge adapter MUST implement.
 *
 * The methods here are the irreducible operations the review pipeline needs:
 * read the diff, read change-request metadata, read the file list, read commits,
 * and idempotently upsert the single summary comment.
 */
export interface ForgeAdapterBase {
  /**
   * Declarative capability hints. READONLY and HINT-ONLY — never use these as
   * the runtime guard for an optional method (R-CAPABILITY).
   */
  readonly capabilities: ForgeCapabilities;

  /** Fetch the unified diff for a change request. */
  fetchDiff(ref: ChangeRequestRef): Promise<UnifiedDiff>;

  /** Fetch change-request metadata (head SHA, base branch, author). */
  fetchChangeRequest(ref: ChangeRequestRef): Promise<ChangeRequest>;

  /** Fetch the list of changed files. */
  fetchFileList(ref: ChangeRequestRef): Promise<ChangedFile[]>;

  /** Fetch the commits in the change request. */
  fetchCommits(ref: ChangeRequestRef): Promise<Commit[]>;

  /**
   * Idempotently upsert the single GHAGGA summary comment.
   *
   * The `marker` identifies prior GHAGGA summary comments so they can be cleaned
   * up; the result reports the surviving comment and any deleted stale ones.
   */
  upsertSummaryComment(
    ref: ChangeRequestRef,
    body: string,
    marker: CommentMarker,
  ): Promise<UpsertSummaryResult>;
}

/** Optional: adapter can add reactions to comments. */
export interface ReactionCapable {
  /** Add a reaction to a comment. */
  addReaction(commentId: CommentId, reaction: ReactionKind): Promise<void>;
}

/**
 * Optional: adapter can READ a dependency graph for a repo.
 *
 * R-GRAPH: this is the typed graph-READ seam. Both methods co-present (TS
 * enforces it by grouping them in one interface). Graph WRITE is GitHub-only and
 * is deliberately NOT part of the adapter surface (deferred to P5). Returns of
 * `null` mean "no graph available" — distinct from "graph read unsupported"
 * (which is method absence).
 */
export interface GraphReadCapable {
  /** Read the full dependency graph, or null if none is available. */
  fetchGraph(repo: RepoRef): Promise<DependencyGraph | null>;
  /** Read graph metadata (freshness, size, …), or null if none is available. */
  fetchGraphMetadata(repo: RepoRef): Promise<GraphMetadata | null>;
}

/** Optional: adapter can publish line-anchored inline comments. */
export interface InlineCapable {
  /** Publish a batch of inline comments; partial success is reported. */
  publishInline(ref: ChangeRequestRef, comments: InlineComment[]): Promise<PublishReport>;
}

/** Optional: adapter can extract a marker payload from a comment body. */
export interface MarkerExtractable {
  /**
   * Extract the payload embedded behind `marker` in `body`, or null if the
   * marker is not present.
   */
  extractMarker(body: string, marker: CommentMarker): string | null;
}

/**
 * The full adapter type the engine consumes.
 *
 * Base is mandatory; every capability is `Partial<>`-composed so an adapter can
 * implement any subset. Consumers MUST narrow optional capabilities via
 * method-presence (`'fetchGraph' in adapter`) before calling — see
 * R-CAPABILITY at the top of this file.
 */
export type ForgeAdapter = ForgeAdapterBase &
  Partial<ReactionCapable> &
  Partial<GraphReadCapable> &
  Partial<InlineCapable> &
  Partial<MarkerExtractable>;
