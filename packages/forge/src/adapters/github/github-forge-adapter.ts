/**
 * GitHubForgeAdapter — wraps the GitHub HTTP client behind the forge-agnostic
 * {@link ForgeAdapterBase} + {@link ReactionCapable} + {@link GraphReadCapable}
 * surfaces.
 *
 * DEPENDENCY INVERSION (boundary rule R-AGNOSTIC):
 * `packages/forge` MUST NOT import `apps/server`. The concrete GitHub client
 * lives in `apps/server/src/github/client.ts`. So this adapter NEVER imports
 * that client directly — it depends on the injected {@link GitHubClientPort}
 * (declared inside the forge package). Task 1.4 (review.ts) constructs the
 * adapter passing the real `client.ts` functions as the port implementation:
 *
 *   new GitHubForgeAdapter({ client, token, owner, repo })
 *
 * CAPABILITIES: reactions ✅, graphRead ✅ (both methods co-present),
 * inlineComments ❌ (GitHub inline review is deferred — no `publishInline`).
 * The `capabilities` field is a HINT only (R-CAPABILITY): callers guard optional
 * methods by method-presence, never by these flags.
 *
 * COMMENT IDs: this adapter returns PLAIN GitHub-native numeric ids (number /
 * number[]). Boxing into {@link CommentId} happens caller-LOCAL in review.ts.
 * The adapter accepts a boxed {@link CommentId} in `addReaction` (port contract)
 * and unwraps `raw` to the GitHub-native number internally.
 */

import type { DependencyGraph, GraphMetadata } from 'ghagga-core';
import { ForgeAuthError, getErrorStatus } from '../../errors.js';
import type {
  ForgeAdapterBase,
  GraphReadCapable,
  ReactionCapable,
  ReactionKind,
} from '../../ports/forge-adapter.js';
import { REACTION_KIND } from '../../ports/forge-adapter.js';
import type {
  ChangedFile,
  ChangeRequest,
  ChangeRequestRef,
  CommentId,
  CommentMarker,
  Commit,
  ForgeCapabilities,
  RepoRef,
  UnifiedDiff,
  UpsertSummaryResult,
} from '../../types.js';
import { ACTOR_KIND } from '../../types.js';
import type { GitHubClientPort, GitHubReactionContent } from './github-client-port.js';

/** Construction options for {@link GitHubForgeAdapter}. */
export interface GitHubForgeAdapterDeps {
  /** Injected GitHub client function-set (real impl = apps/server client.ts). */
  client: GitHubClientPort;
  /** Installation access token used for all calls. */
  token: string;
  /** Repository owner (login). */
  owner: string;
  /** Repository name. */
  repo: string;
}

/** Maps a canonical {@link ReactionKind} to the GitHub reaction content string. */
function toGitHubReaction(reaction: ReactionKind): GitHubReactionContent {
  // ReactionKind values are already GitHub-native strings ('+1','-1','eyes',
  // 'rocket','confused'); this cast is the single sanctioned bridge point.
  return reaction as GitHubReactionContent;
}

/**
 * Extract the GitHub-native numeric comment id from a boxed {@link CommentId}.
 * `raw` is `string | number`; GitHub comment ids are numeric.
 *
 * Guards against a malformed/non-GitHub id silently coercing to `NaN` (which
 * would produce a `…/comments/NaN` URL). Throws a clear {@link TypeError} unless
 * the result is a safe integer.
 */
function toNativeCommentId(commentId: CommentId): number {
  const { raw } = commentId;
  const native = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(native)) {
    throw new TypeError(
      `GitHubForgeAdapter: comment id is not a safe integer (kind=${commentId.kind}, raw=${String(raw)})`,
    );
  }
  return native;
}

/**
 * GitHub implementation of the forge adapter.
 *
 * Implements the mandatory base plus the reaction and graph-read capabilities.
 * Deliberately does NOT implement {@link InlineCapable} (GitHub inline review
 * deferred), so `publishInline` is ABSENT — callers guarding by method-presence
 * will skip inline publishing cleanly.
 */
export class GitHubForgeAdapter implements ForgeAdapterBase, ReactionCapable, GraphReadCapable {
  readonly capabilities: ForgeCapabilities = {
    reactions: true,
    inlineComments: false,
    graphRead: true,
  };

  readonly #client: GitHubClientPort;
  readonly #token: string;
  readonly #owner: string;
  readonly #repo: string;

  constructor(deps: GitHubForgeAdapterDeps) {
    this.#client = deps.client;
    this.#token = deps.token;
    this.#owner = deps.owner;
    this.#repo = deps.repo;
  }

  /**
   * Run a client call, reclassifying a 401/403 failure as a {@link ForgeAuthError}.
   *
   * This is the SINGLE point where a GitHub auth failure (the token was rejected
   * server-side) becomes the typed signal the worker catches to drive the in-job
   * re-mint + retry (P2 401-recovery). NON-auth failures are rethrown UNCHANGED
   * (not reclassified) so retry logic only fires for genuine auth failures.
   *
   * The status is read off the thrown error's `status` field (the GitHub client
   * tags its errors with `GitHubApiError.status`). Errors with no usable status
   * pass through untouched.
   */
  async #mapAuth<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 401 || status === 403) {
        throw new ForgeAuthError(
          status,
          error instanceof Error ? error.message : `Forge auth failure (HTTP ${status})`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  // ─── Base: reads ───────────────────────────────────────────────

  async fetchDiff(ref: ChangeRequestRef): Promise<UnifiedDiff> {
    const text = await this.#mapAuth(() =>
      this.#client.fetchPRDiff(this.#owner, this.#repo, ref.iid, this.#token),
    );
    return { text };
  }

  async fetchChangeRequest(ref: ChangeRequestRef): Promise<ChangeRequest> {
    const details = await this.#mapAuth(() =>
      this.#client.fetchPRDetails(this.#owner, this.#repo, ref.iid, this.#token),
    );
    return {
      ref,
      headSha: details.headSha,
      baseBranch: details.baseBranch,
      // GitHub PR author kind is not exposed by fetchPRDetails; default USER.
      // (Bot detection, when needed, is the caller's concern via login suffix.)
      author: { login: details.prAuthor, kind: ACTOR_KIND.USER },
    };
  }

  async fetchFileList(ref: ChangeRequestRef): Promise<ChangedFile[]> {
    // client.getPRFileList returns bare paths; the GitHub PR file-list endpoint
    // wrapper does NOT expose changeKind/additions/deletions, so those optional
    // ChangedFile fields are OMITTED (honest absence) rather than fabricated as
    // zeros. The caller flattens via project.ts (toFileList) which only consumes
    // `path`.
    const paths = await this.#mapAuth(() =>
      this.#client.getPRFileList(this.#owner, this.#repo, ref.iid, this.#token),
    );
    return paths.map((path) => ({ path }));
  }

  async fetchCommits(ref: ChangeRequestRef): Promise<Commit[]> {
    // client.getPRCommitMessages returns only messages; the GitHub PR commit-list
    // endpoint wrapper does NOT expose sha/author, so those optional Commit fields
    // are OMITTED (honest absence) rather than fabricated as empty strings. The
    // caller flattens via toCommitMessages which only consumes `message`.
    const messages = await this.#mapAuth(() =>
      this.#client.getPRCommitMessages(this.#owner, this.#repo, ref.iid, this.#token),
    );
    return messages.map((message) => ({ message }));
  }

  // ─── Base: upsert summary comment (fold post/find/delete → 1) ──

  /**
   * Idempotently upsert the single GHAGGA summary comment.
   *
   * Behavior (FORGE-UPSERT-005 remediation — update-in-place, never
   * delete-before-create):
   * 1. find existing GHAGGA comments (latest + stale).
   * 2a. NO existing comment: post a FRESH comment. This is the only network
   *     call, so failure here simply means no summary was ever created — no
   *     regression vs. the previous behavior.
   * 2b. AN existing comment: update the LATEST one IN PLACE via
   *     `client.updateComment`. This call is the ONLY one that propagates on
   *     failure — and critically, nothing has been deleted yet at that point,
   *     so a transient update failure (timeout / 5xx) leaves the PR/MR with
   *     its PREVIOUS valid review intact instead of no review at all (the bug
   *     this remediation closes). Only AFTER the update confirms success are
   *     the stale duplicates removed, BEST-EFFORT: each delete is wrapped in
   *     try/catch so BOTH 404 (already gone) AND any non-404 failure are
   *     tolerated and do NOT undo the successful update. Only ids that
   *     actually deleted (no throw) are reported in `deleted`.
   *
   * Returns GitHub-native numeric ids (boxing happens caller-local). `created`
   * is the id of the comment that now carries the review body — it may be a
   * freshly-posted id (no prior comment) or the pre-existing latest id that
   * was updated in place.
   *
   * NOTE: `marker` is accepted for the port contract but is NOT threaded into
   * the client. The GitHub adapter currently matches the FIXED
   * `REVIEW_COMMENT_MARKER` (`<!-- ghagga-review -->`) hard-coded inside
   * client.findExistingComment (a "stale ghagga comment" = any comment whose body
   * contains that marker; author/bot status is NOT inspected). This is
   * baseline-faithful: threading `marker` into
   * GitHubClientPort.findExistingComment is DEFERRED (would change the port
   * signature). Consequently, if review.ts (1.4) passes a `marker`, it MUST equal
   * the existing `REVIEW_COMMENT_MARKER` — any other value is silently ignored.
   */
  async upsertSummaryComment(
    ref: ChangeRequestRef,
    body: string,
    _marker: CommentMarker,
  ): Promise<UpsertSummaryResult> {
    const existing = await this.#mapAuth(() =>
      this.#client.findExistingComment(this.#owner, this.#repo, ref.iid, this.#token),
    );

    if (!existing) {
      // No prior GHAGGA comment: the only safe move is to post a fresh one. A
      // 401/403 here is reclassified to ForgeAuthError so the worker can
      // re-mint + retry (P2).
      const posted = await this.#mapAuth(() =>
        this.#client.postComment(this.#owner, this.#repo, ref.iid, body, this.#token),
      );

      // Robustness guard: the real client.postComment returns `{ id }` or
      // throws, so a missing id is a contract violation (e.g. a mis-shaped
      // test double), never a live path. Fail loudly here rather than
      // silently boxing `undefined` → the meaningless CommentId
      // `{ kind:'github', raw:'undefined' }` downstream.
      if (posted?.id == null) {
        throw new TypeError(
          'GitHubForgeAdapter.upsertSummaryComment: postComment returned no id (expected { id: number })',
        );
      }

      return { created: posted.id, deleted: [] };
    }

    // Update the latest comment IN PLACE. This is the ONLY error that
    // propagates from the existing-comment path — and it propagates BEFORE
    // anything has been deleted, so the previous review remains visible on
    // the PR if this fails transiently. A 401/403 here is reclassified to
    // ForgeAuthError so the worker can re-mint + retry (P2).
    await this.#mapAuth(() =>
      this.#client.updateComment(this.#owner, this.#repo, existing.latestId, body, this.#token),
    );

    // The update confirmed success — now it's safe to prune stale duplicates.
    // BEST-EFFORT: tolerate BOTH 404 and non-404 delete failures, since the
    // now-current comment already carries the fresh body regardless of
    // whether the old duplicates get cleaned up.
    const deleted: number[] = [];
    for (const commentId of existing.staleIds) {
      try {
        await this.#client.deleteComment(this.#owner, this.#repo, commentId, this.#token);
        deleted.push(commentId);
      } catch {
        // Best-effort: a stale duplicate that cannot be deleted must NOT be
        // treated as a failure of the upsert — the primary comment is already
        // updated.
      }
    }

    return { created: existing.latestId, deleted };
  }

  // ─── ReactionCapable ───────────────────────────────────────────

  /**
   * Add a reaction to a comment (R-5).
   *
   * CRITICAL: the trigger-comment reaction MUST live in the adapter — it was
   * accidentally dropped once before. It is preserved here, wrapping
   * client.addCommentReaction (which is itself best-effort / non-throwing).
   */
  async addReaction(commentId: CommentId, reaction: ReactionKind): Promise<void> {
    await this.#mapAuth(() =>
      this.#client.addCommentReaction(
        this.#owner,
        this.#repo,
        toNativeCommentId(commentId),
        toGitHubReaction(reaction),
        this.#token,
      ),
    );
  }

  // ─── GraphReadCapable (both methods co-present) ─────────────────

  /**
   * Read the dependency graph from the `ghagga/graph` orphan branch.
   *
   * The orphan-branch ref (`?ref=ghagga/graph`), the 404→null behavior, and the
   * typed JSON validation all live INSIDE client.fetchGraphFromBranch — this
   * adapter preserves them by delegating, returning `null` for "no graph".
   */
  async fetchGraph(_repo: RepoRef): Promise<DependencyGraph | null> {
    return this.#client.fetchGraphFromBranch(this.#owner, this.#repo, this.#token);
  }

  /**
   * Read graph metadata from the `ghagga/graph` orphan branch (orphan-ref +
   * 404→null + validation handled inside client.fetchGraphMetadata).
   */
  async fetchGraphMetadata(_repo: RepoRef): Promise<GraphMetadata | null> {
    return this.#client.fetchGraphMetadata(this.#owner, this.#repo, this.#token);
  }
}

// Re-export so test files and 1.4 can reference the reaction-kind set succinctly.
export { REACTION_KIND };
