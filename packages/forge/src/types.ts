/**
 * Canonical forge-agnostic domain types.
 *
 * These types are the lingua franca between GHAGGA's core review engine and any
 * concrete forge adapter (GitHub / GitLab / Gitea). They are deliberately
 * provider-neutral: nothing here leaks a GitHub PR number, a GitLab IID, or a
 * Gitea path as a bare primitive that could be mis-assigned across forges.
 *
 * Invariants enforced by these shapes:
 * - R-COMMENTID: comment identifiers are BOXED ({@link CommentId}), never a bare
 *   number — a GitHub comment id and a GitLab note id must never be cross-assigned.
 * - RepoRef identity keys on {@link RepoRef.nativeId} — `path` is mutable (repos
 *   get renamed/moved) and MUST NOT participate in identity.
 * - ChangeRequestRef uses {@link ChangeRequestRef.iid} (project-scoped) with an
 *   optional {@link ChangeRequestRef.globalId} for forges that expose one.
 */

// ─── Kind enums (const-object pattern → single source of truth) ──

/** The forge providers GHAGGA can target. */
export const FORGE_KIND = {
  GITHUB: 'github',
  GITLAB: 'gitlab',
  GITEA: 'gitea',
} as const;

export type ForgeKind = (typeof FORGE_KIND)[keyof typeof FORGE_KIND];

/** How a single file changed within a change request. */
export const CHANGE_KIND = {
  ADDED: 'added',
  MODIFIED: 'modified',
  REMOVED: 'removed',
  RENAMED: 'renamed',
} as const;

export type ChangeKind = (typeof CHANGE_KIND)[keyof typeof CHANGE_KIND];

/** Whether an {@link Actor} is a human or an automated account. */
export const ACTOR_KIND = {
  USER: 'user',
  BOT: 'bot',
} as const;

export type ActorKind = (typeof ACTOR_KIND)[keyof typeof ACTOR_KIND];

/**
 * Relationship between a comment author and the repository.
 *
 * Mirrors GitHub's `author_association`; other forges map their nearest
 * equivalent. Used for trust/permission gating (e.g. only act on commands from
 * owners/members/collaborators).
 */
export const AUTHOR_ASSOCIATION = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
  CONTRIBUTOR: 'contributor',
  NONE: 'none',
} as const;

export type AuthorAssociation = (typeof AUTHOR_ASSOCIATION)[keyof typeof AUTHOR_ASSOCIATION];

// ─── Identity & value types (0.2a) ──────────────────────────────

/**
 * Stable identity of a repository on a given forge.
 *
 * IDENTITY RULE (R-COMMENTID family): two RepoRefs are the same repository iff
 * their `kind` AND `nativeId` match. `path` is a human-friendly *label* that can
 * change when a repo is renamed/transferred — it MUST NOT be used for identity
 * comparison or as a lookup key.
 */
export interface RepoRef {
  /** Which forge this repo lives on. */
  kind: ForgeKind;
  /**
   * OPAQUE forge-native identity string. It is the numeric repo/project id WHEN
   * resolvable (GitHub repo id, GitLab project id) — immutable across
   * rename/transfer — but it MAY be a path-shaped legacy/fallback value
   * (e.g. `owner/repo`) when the numeric id could not be resolved (an old
   * in-flight job, or a network/404 failure during CLI resolution; both are
   * intentional safe degradations, not bugs).
   *
   * Consumers MUST treat this as an opaque identity token: compare it for
   * equality, key on it, persist it — but MUST NOT assume it parses as a number.
   * `Number(ref.nativeId)` is NOT safe (a path-shaped fallback yields NaN).
   */
  nativeId: string;
  /** Human-friendly "owner/name" path. Mutable — NOT part of identity. */
  path?: string;
}

/**
 * Reference to a single change request (PR / MR).
 *
 * `iid` is the project-scoped number a human sees (GitHub PR number, GitLab MR
 * IID). `globalId` is the forge-global identifier when one exists (GitLab MRs
 * have both; GitHub does not expose a separate global PR number).
 */
export interface ChangeRequestRef {
  /** The repository this change request belongs to. */
  repo: RepoRef;
  /** Project-scoped identifier (PR number / MR IID). */
  iid: number;
  /** Forge-global identifier, when the forge exposes one. */
  globalId?: string;
}

/** A human or bot account on a forge. */
export interface Actor {
  /** Login / username. */
  login: string;
  /** Whether this account is a human or an automated bot. */
  kind: ActorKind;
}

/** One file changed within a change request. */
export interface ChangedFile {
  /** Current path of the file. Always available. */
  path: string;
  /**
   * How the file changed. Optional because the GitHub PR file-list endpoint
   * wrapper does not expose it; populated only when a richer source is available.
   */
  changeKind?: ChangeKind;
  /**
   * Lines added. Optional because the GitHub PR file-list endpoint wrapper does
   * not expose it; populated only when a richer source is available.
   */
  additions?: number;
  /**
   * Lines removed. Optional because the GitHub PR file-list endpoint wrapper
   * does not expose it; populated only when a richer source is available.
   */
  deletions?: number;
}

/** A single commit in a change request. */
export interface Commit {
  /**
   * Commit SHA. Optional because the GitHub PR commit-list endpoint wrapper only
   * returns messages; populated only when a richer source is available.
   */
  sha?: string;
  /** Full commit message. Always available. */
  message: string;
  /**
   * Commit author. Optional because the GitHub PR commit-list endpoint wrapper
   * does not expose author identity; populated only when a richer source is
   * available.
   */
  author?: Actor;
}

/**
 * Optional diff anchoring SHAs.
 *
 * When present, ALL THREE are required (the three-dot base, the head, and the
 * GitLab-style start SHA). The whole block is optional; partial diffRefs are not
 * representable by design.
 */
export interface DiffRefs {
  /** Merge-base / comparison base SHA. */
  baseSha: string;
  /** Head SHA of the change request. */
  headSha: string;
  /** Start SHA (GitLab diff_refs.start_sha analogue). */
  startSha: string;
}

/** A unified diff plus optional anchoring SHAs. */
export interface UnifiedDiff {
  /** The raw unified-diff text. */
  text: string;
  /** Anchoring SHAs; all-or-nothing (see {@link DiffRefs}). */
  diffRefs?: DiffRefs;
}

/**
 * A full change request projection (after fetch).
 *
 * Carries the fields the review engine needs to anchor a review: head SHA, the
 * base branch it targets, and the author.
 */
export interface ChangeRequest {
  /** Reference identifying this change request. */
  ref: ChangeRequestRef;
  /** Head commit SHA. */
  headSha: string;
  /** Branch this change request targets. */
  baseBranch: string;
  /** Author of the change request. */
  author: Actor;
}

/**
 * BOXED comment identifier (R-COMMENTID).
 *
 * Never pass a bare number where a comment id is expected. The `kind` tag plus
 * the opaque `raw` value prevents a GitHub comment id from being silently used
 * as a GitLab note id (and vice-versa). `raw` is intentionally `string | number`
 * because forges differ (GitHub: number, GitLab note id: number, but some
 * resources are string-keyed) — consumers MUST treat it as opaque.
 */
export interface CommentId {
  /** Discriminator naming the resource/forge the id belongs to. */
  kind: string;
  /** Opaque forge-native identifier. Treat as opaque — do not parse. */
  raw: string | number;
}

// ─── Contract types (0.2b) ──────────────────────────────────────

/**
 * Result of upserting the single summary comment.
 *
 * `created` is the surviving summary comment id; `deleted` lists any stale prior
 * summary comment ids that were removed during the upsert (idempotency cleanup).
 *
 * BOUNDARY DECISION (forge-agnostic P1): ids here are PLAIN FORGE-NATIVE
 * primitives (e.g. GitHub numeric comment ids), NOT boxed {@link CommentId}.
 * The {@link CommentId} boxing ({kind, raw}) happens caller-LOCAL (review.ts)
 * after the adapter returns — it is NOT part of the adapter↔caller wire shape.
 * `CommentId` remains the canonical boxed type for cross-forge comment
 * identity elsewhere; only THIS result intentionally stays native.
 */
export interface UpsertSummaryResult {
  /** The forge-native id of the summary comment that now exists. */
  created: number;
  /** Forge-native ids of stale summary comments removed during upsert. */
  deleted: number[];
}

/**
 * Outcome of publishing a batch of inline comments.
 *
 * Partial success is representable: `posted` holds the ids that succeeded,
 * `failed` records the index (into the input array) and error for each failure.
 */
export interface PublishReport {
  /** Comment ids that were successfully posted. */
  posted: CommentId[];
  /** Per-item failures, keyed by input index. */
  failed: PublishFailure[];
}

/** A single inline-publish failure. */
export interface PublishFailure {
  /** Index into the input {@link InlineComment} array. */
  index: number;
  /** Human-readable error. */
  error: string;
  /**
   * The HTTP status of the underlying forge failure, when one was carried on the
   * thrown error (e.g. `401`, `403`, `422`, `500`). Absent when the failure had
   * no usable numeric status (e.g. a network error or a non-HTTP throw). Lets a
   * caller distinguish an auth failure from a transient/server one WITHOUT
   * string-parsing {@link PublishFailure.error}. Additive + optional, so older
   * consumers are unaffected.
   */
  status?: number;
  /**
   * `true` when the failure was an AUTHENTICATION/authorization failure (HTTP
   * 401/403). A static-token forge cannot recover from this (nothing to re-mint),
   * so a caller can surface "fix your token" guidance instead of treating it as a
   * retry-able transient. Absent/`false` for non-auth failures. Additive +
   * optional.
   */
  authFailure?: boolean;
}

/**
 * Declarative capability HINTS for an adapter.
 *
 * R-CAPABILITY: these flags are HINTS ONLY (e.g. for UI / planning). They MUST
 * NOT be used as the runtime guard for calling an optional method. The runtime
 * guard is ALWAYS method-presence (`'methodName' in adapter`). See
 * `ports/forge-adapter.ts`.
 */
export interface ForgeCapabilities {
  /** Adapter can add reactions to comments. */
  readonly reactions: boolean;
  /** Adapter can publish inline (line-anchored) comments. */
  readonly inlineComments: boolean;
  /** Adapter can read a dependency graph for the repo. */
  readonly graphRead: boolean;
}

/**
 * An HTML marker embedded in a comment body to identify GHAGGA-owned comments.
 *
 * Typically an HTML comment like `<!-- ghagga:summary -->` so it renders
 * invisibly but is machine-extractable for idempotent upserts.
 */
export interface CommentMarker {
  /** The literal HTML marker string. */
  html: string;
}

/**
 * A comment normalized into forge-agnostic shape.
 *
 * Produced by the webhook codec when parsing an incoming comment event so the
 * core engine never touches forge-specific payload shapes.
 */
export interface NormalizedComment {
  /** Change request the comment belongs to. */
  ref: ChangeRequestRef;
  /** Boxed id of the comment itself. */
  commentId: CommentId;
  /** Comment body (markdown). */
  body: string;
  /** Who wrote the comment. */
  author: Actor;
  /** Author's relationship to the repo (trust gating). */
  association: AuthorAssociation;
}

/** A parsed, forge-agnostic webhook event. */
export type ForgeEvent =
  | { type: 'comment'; comment: NormalizedComment }
  | { type: 'unsupported'; raw: unknown };

/**
 * Minimal tenant-routing hint extracted from a webhook BEFORE verification.
 *
 * Used in the two-phase webhook flow to pick the right secret/credentials for
 * the verify step. Contains no trusted data — only enough to route.
 */
export interface TenantHint {
  /** Which forge the webhook came from. */
  forge: ForgeKind;
  /** Opaque tenant routing key (installation id, project namespace, …). */
  tenantKey: string;
}
