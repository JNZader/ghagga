/**
 * GitHub client PORT (dependency inversion seam for the GitHub adapter).
 *
 * R-AGNOSTIC / boundary rule: `packages/forge` MUST NOT import `apps/server`
 * (the boundary lint forbids it). The concrete GitHub HTTP client lives in
 * `apps/server/src/github/client.ts`. To wrap it WITHOUT importing it, the
 * adapter declares — here — the exact function-set it depends on, and the caller
 * (review.ts, task 1.4) injects the real `client.ts` functions at construction.
 *
 * This interface mirrors the SIGNATURES of the client.ts functions the adapter
 * folds over (owner/repo/token positional style). It is intentionally
 * GitHub-native (numeric ids, GitHub-shaped returns): the adapter is the layer
 * that maps GitHub-native shapes ↔ canonical forge types. Comment ids cross THIS
 * seam as PLAIN numbers (GitHub-native) — boxing into `CommentId` happens
 * review.ts-LOCAL in 1.4, not here.
 *
 * Graph return types are kept structural (`unknown`-validated downstream is done
 * inside client.ts itself) so this port does NOT need a value/type import of
 * core; client.ts already returns the validated `DependencyGraph | null` /
 * `GraphMetadata | null`. We re-state those as type-only imports from core,
 * which the boundary lint explicitly permits (`import type` from core).
 */

import type { DependencyGraph, GraphMetadata } from 'ghagga-core';

/** Reaction emojis the underlying GitHub client accepts. */
export type GitHubReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes';

/**
 * The set of GitHub client functions the {@link GitHubForgeAdapter} depends on.
 *
 * Each member matches the corresponding `apps/server/src/github/client.ts`
 * export by signature. The adapter receives an implementation of this port via
 * its constructor (dependency inversion) so the forge package never imports the
 * server.
 */
export interface GitHubClientPort {
  /** Fetch the unified diff text for a PR. */
  fetchPRDiff(owner: string, repo: string, prNumber: number, token: string): Promise<string>;

  /** Fetch PR details (head SHA, base branch, author login). */
  fetchPRDetails(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<{ headSha: string; baseBranch: string; prAuthor: string }>;

  /** Fetch the list of changed file paths for a PR. */
  getPRFileList(owner: string, repo: string, prNumber: number, token: string): Promise<string[]>;

  /** Fetch commit messages for a PR. */
  getPRCommitMessages(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<string[]>;

  /** Post a fresh comment; returns the GitHub-native numeric id. */
  postComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    token: string,
  ): Promise<{ id: number }>;

  /** Find existing GHAGGA comments; returns latest + stale numeric ids, or null. */
  findExistingComment(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<{ latestId: number; staleIds: number[] } | null>;

  /** Delete a comment by its GitHub-native numeric id. */
  deleteComment(owner: string, repo: string, commentId: number, token: string): Promise<void>;

  /** Update a comment in place by its GitHub-native numeric id. */
  updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
    token: string,
  ): Promise<void>;

  /** Add a reaction to an issue comment (best-effort in client.ts). */
  addCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    reaction: GitHubReactionContent,
    token: string,
  ): Promise<void>;

  /** Read the dependency graph from the `ghagga/graph` orphan branch, or null. */
  fetchGraphFromBranch(owner: string, repo: string, token: string): Promise<DependencyGraph | null>;

  /** Read graph metadata from the `ghagga/graph` orphan branch, or null. */
  fetchGraphMetadata(owner: string, repo: string, token: string): Promise<GraphMetadata | null>;
}

/**
 * Mints a GitHub installation access token. Matches `getInstallationToken` in
 * `apps/server/src/github/client.ts`. Injected into
 * {@link TemporaryGitHubTokenSource}.
 *
 * @deprecated P2 — superseded by {@link GitHubInstallationTokenMintWithExpiry}.
 * This token-ONLY shape carries no `expires_at`, so it cannot drive the TTL cache
 * in `GitHubAppCredentialProvider`. It is retained ONLY for the soon-to-be-deleted
 * {@link TemporaryGitHubTokenSource}; remove it together with that class.
 */
export type GitHubInstallationTokenMint = (
  installationId: number,
  appId: string,
  privateKey: string,
  options?: { repositoryIds?: number[] },
) => Promise<string>;

/**
 * A minted installation token plus its absolute expiry.
 *
 * `expiresAtMs` is the token's expiry as an epoch-millis timestamp (comparable to
 * `Date.now()`), derived by the composition root from the GitHub access-token
 * response `expires_at` (an ISO-8601 string the REST API already returns).
 */
export interface MintedInstallationToken {
  /** The installation access token string. */
  token: string;
  /** Absolute expiry, epoch millis (comparable to {@link Date.now}). */
  expiresAtMs: number;
}

/**
 * Mints a GitHub installation access token AND reports its expiry (P2).
 *
 * This is the expiry-carrying mint the {@link GitHubAppCredentialProvider} TTL
 * cache requires. The underlying `client.getInstallationToken` returns ONLY the
 * token string today (it discards the GitHub `expires_at`); the composition root
 * (apps/server) adapts it to ALSO surface the expiry so the forge package can
 * cache without importing apps/server (dependency inversion, R-AGNOSTIC).
 */
export type GitHubInstallationTokenMintWithExpiry = (
  installationId: number,
  appId: string,
  privateKey: string,
  options?: { repositoryIds?: number[] },
) => Promise<MintedInstallationToken>;
