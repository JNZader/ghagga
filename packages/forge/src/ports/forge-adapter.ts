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
 * - Co-presence of the TWO graph methods is enforced AT THE TYPE LEVEL by the
 *   union `GraphReadCapable | { fetchGraph?: never; fetchGraphMetadata?: never }`
 *   in {@link ForgeAdapter}: an object may have BOTH graph methods or NEITHER,
 *   but never exactly one. (`Partial<GraphReadCapable>` would NOT enforce this —
 *   it would permit `fetchGraph` without `fetchGraphMetadata`.) Single-method
 *   capabilities stay `Partial<>` because co-presence is trivial for one method.
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

/**
 * A single line-anchored inline comment to publish.
 *
 * PUBLIC API (R-LEAK-PUBLISH). This shape is intentionally ANCHORABLE so the
 * GitLab discussion API (and a future GitHub inline-review impl) can be satisfied
 * WITHOUT a breaking change:
 * - `path` + `line` + `side` cover the common single-revision anchor (GitHub maps
 *   `side` → LEFT/RIGHT; GitLab maps `side` → old_line/new_line).
 * - `position` carries the GitLab diff-thread anchor (base/head/start SHAs +
 *   old/new line). When present, the GitLab v1 adapter USES it toward the
 *   discussions API for a true diff-thread; when absent it degrades to a
 *   `path:line` body-prefixed plain note.
 * - `oldPath`/`newPath` make RENAMES representable (GitLab requires BOTH
 *   `position[old_path]` and `position[new_path]` for text diff notes). When
 *   unset the adapter falls back to `path` for both — correct for non-renamed
 *   files.
 */
export interface InlineComment {
  /** File the comment anchors to (the post-change path for a renamed file). */
  path: string;
  /** Line number (in the diff's head/new revision unless `side` says otherwise). */
  line: number;
  /**
   * Which side of the diff the line is on. `'new'` (default) → added/context
   * line on the head revision; `'old'` → a line on the base revision.
   */
  side?: 'old' | 'new';
  /**
   * Pre-change path, for a RENAMED file. GitLab text diff notes require both the
   * old and new path; when set, the adapter sends `position[old_path]`. Defaults
   * to `path` when unset.
   */
  oldPath?: string;
  /**
   * Post-change path, for a RENAMED file. Defaults to `path` when unset. Carried
   * so a future impl never needs an API change to support renames.
   */
  newPath?: string;
  /**
   * Full GitLab-style diff-thread anchor. When present, the GitLab v1 adapter
   * uses it toward the discussions API (`position[position_type]=text`, the three
   * SHAs, plus `old_line`/`new_line`). When absent, the adapter degrades to a
   * plain note carrying the `path:line` prefix in the body.
   */
  position?: {
    /** Merge-base / comparison base SHA (GitLab `position[base_sha]`). */
    baseSha: string;
    /** Head SHA of the change request (GitLab `position[head_sha]`). */
    headSha: string;
    /** Start SHA (GitLab `position[start_sha]`). */
    startSha: string;
    /** Line on the base revision (GitLab `position[old_line]`). */
    oldLine?: number;
    /** Line on the head revision (GitLab `position[new_line]`). */
    newLine?: number;
  };
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
 * R-GRAPH: this is the typed graph-READ seam. The two methods are co-present:
 * {@link ForgeAdapter} composes this interface as an all-or-nothing union, so an
 * adapter has BOTH methods or NEITHER — never exactly one. Graph WRITE is
 * GitHub-only and
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

/**
 * Optional: adapter can READ a single file's contents at a ref, no clone.
 *
 * A single-method capability (composed as `Partial<>` on {@link ForgeAdapter}),
 * narrowed by method-presence (`'fetchFileContents' in adapter`) like every other
 * optional capability. `null` means "no such file at this ref" (missing, or the
 * path is a directory/submodule) — distinct from a throw, which is a real fault
 * (auth, rate-limit, oversize). Used to give code-blind (no-checkout) triage some
 * code-in-evidence.
 */
export interface FileReadCapable {
  /** Read a repo-relative file's UTF-8 contents at `ref`, or null if not a file there. */
  fetchFileContents(repo: RepoRef, path: string, ref: string): Promise<string | null>;
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
 * Base is mandatory; single-method capabilities are `Partial<>`-composed so an
 * adapter can implement any subset. The graph capability is composed as an
 * all-or-nothing union so an adapter cannot have exactly one of the two graph
 * methods (type-level co-presence; see R-GRAPH and the header note). Consumers
 * MUST narrow optional capabilities via method-presence (`'fetchGraph' in
 * adapter`) before calling — see R-CAPABILITY at the top of this file.
 */
export type ForgeAdapter = ForgeAdapterBase &
  Partial<ReactionCapable> &
  (GraphReadCapable | { fetchGraph?: never; fetchGraphMetadata?: never }) &
  Partial<FileReadCapable> &
  Partial<InlineCapable> &
  Partial<MarkerExtractable>;
