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
  /** Forge-native immutable id (GitHub repo node id, GitLab project id, …). */
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
  /** Current path of the file. */
  path: string;
  /** How the file changed. */
  changeKind: ChangeKind;
  /** Lines added. */
  additions: number;
  /** Lines removed. */
  deletions: number;
}

/** A single commit in a change request. */
export interface Commit {
  /** Commit SHA. */
  sha: string;
  /** Full commit message. */
  message: string;
  /** Commit author. */
  author: Actor;
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
 * `created` is the surviving summary comment; `deleted` lists any stale prior
 * summary comments that were removed during the upsert (idempotency cleanup).
 */
export interface UpsertSummaryResult {
  /** The summary comment that now exists. */
  created: CommentId;
  /** Stale summary comments removed during upsert. */
  deleted: CommentId[];
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
