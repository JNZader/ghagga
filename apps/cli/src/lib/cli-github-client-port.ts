/**
 * CLI-side implementation of the forge `GitHubClientPort`.
 *
 * The `GitHubForgeAdapter` (packages/forge) depends on an injected
 * {@link GitHubClientPort} (dependency inversion — forge MUST NOT import any
 * concrete HTTP client). The SERVER injects `apps/server/src/github/client.ts`.
 * The CLI has its OWN minimal client built on the same native-fetch +
 * {@link apiHeaders} / {@link GitHubApiError} pattern as `github-api.ts`.
 *
 * SCOPE (P3 — PR summary post-back only):
 *   REAL members — the write/idempotency fns `upsertSummaryComment` folds over:
 *     - postComment        (POST   /repos/{o}/{r}/issues/{n}/comments)
 *     - findExistingComment(GET    /repos/{o}/{r}/issues/{n}/comments — marker match)
 *     - deleteComment      (DELETE /repos/{o}/{r}/issues/comments/{id})
 *     - updateComment      (PATCH  /repos/{o}/{r}/issues/comments/{id})
 *   STUBBED members — read fns the CLI never needs (it has the diff locally and
 *   does not consume reactions / graph in the `--pr` flow):
 *     - fetchPRDiff, fetchPRDetails, getPRFileList, getPRCommitMessages
 *     - addCommentReaction
 *     - fetchGraphFromBranch, fetchGraphMetadata
 *     - fetchFileContents (server-only, checkout-less triage)
 *   Each stub THROWS so any accidental call surfaces loudly instead of silently
 *   returning bad data. The `--pr` post-back path (find → delete → post) only
 *   ever touches the REAL members; see pr-postback.ts + tests.
 *
 * The stale-comment match here mirrors the server EXACTLY: bot-authored-or-not is
 * NOT inspected (the CLI token's own comments carry the marker), the match is the
 * fixed `<!-- ghagga-review -->` marker substring (REVIEW_COMMENT_MARKER), latest
 * = last in chronological order, the rest are stale. This keeps idempotency
 * byte-compatible with the server post-back.
 */

import { REVIEW_COMMENT_MARKER } from 'ghagga-core';
import type { GitHubClientPort, GitHubReactionContent } from 'ghagga-forge';
import { GitHubApiError } from './github-api.js';

// The fixed marker the summary body carries. SINGLE SOURCE OF TRUTH: imported
// from ghagga-core (REVIEW_COMMENT_MARKER) so the stale-comment match here can
// never drift from the marker the body actually carries.
const REVIEW_MARKER = REVIEW_COMMENT_MARKER;

const API_BASE = 'https://api.github.com';

/**
 * Per-request timeout for the CLI's GitHub fetch calls. Mirrors the server
 * client's `AbortSignal.timeout(10_000)` so a slow/hung GitHub can never hang a
 * CI job indefinitely — the fetch aborts and surfaces as a thrown error.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Shared auth/version headers — same shape as github-api.ts apiHeaders. */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function failOn(res: Response, action: string): Promise<never> {
  const body = await res.text();
  throw new GitHubApiError(
    `GitHub API error ${action}: ${res.status} ${res.statusText}`,
    res.status,
    body,
  );
}

/**
 * Resolve the GitHub NUMERIC repo id from an owner/name pair (forge identity).
 *
 * `GET /repos/{owner}/{repo}` → `.id`. owner/repo is the MUTABLE display path
 * (a rename/transfer changes it but NOT the numeric id), so the numeric id is the
 * canonical {@link RepoRef.nativeId}. This MIRRORS the GitLab `--mr` flow's
 * {@link resolveGitLabProjectId} (one pre-construction call that turns the mutable
 * path into the immutable id). It is NOT part of the {@link GitHubClientPort} — the
 * adapter's actual API calls still key on owner/repo from its ctor; nativeId is
 * identity metadata only.
 *
 * @returns the numeric repo id as a STRING (RepoRef.nativeId is a string,
 *   consistent with GitLab's `String(id)`).
 */
export async function resolveGitHubRepoId(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const url = `${API_BASE}/repos/${owner}/${repo}`;
  const res = await fetch(url, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await failOn(res, 'resolving repo id');
  const data = (await res.json()) as { id: number };
  if (typeof data.id !== 'number') {
    throw new GitHubApiError(
      `GitHub API error resolving repo id: response had no numeric "id" for "${owner}/${repo}"`,
      res.status,
      JSON.stringify(data),
    );
  }
  return String(data.id);
}

/** Thrown by every stubbed port member so an accidental call is loud, not silent. */
function unsupported(member: string): never {
  throw new Error(
    `CliGitHubClientPort.${member} is not supported in CLI context — the CLI only ` +
      'posts the PR summary comment (postComment/findExistingComment/deleteComment/' +
      'updateComment). The diff/commits/file-list/graph are sourced locally.',
  );
}

/**
 * Build a {@link GitHubClientPort} backed by native fetch for the CLI `--pr`
 * post-back. Only the comment-write members are real; read members throw.
 */
export function createCliGitHubClientPort(): GitHubClientPort {
  return {
    // ── REAL: PR/issue comment writes (the upsert fold) ──────────
    async postComment(owner, repo, prNumber, body, token): Promise<{ id: number }> {
      const url = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
      const res = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(token),
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) await failOn(res, 'posting PR comment');
      const data = (await res.json()) as { id: number };
      return { id: data.id };
    },

    async findExistingComment(
      owner,
      repo,
      prNumber,
      token,
    ): Promise<{ latestId: number; staleIds: number[] } | null> {
      const baseUrl = `${API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
      // Paginate until exhausted (a page with < 100 items is the last page).
      // MAX_PAGES is a safety upper bound (50 × 100 = 5000 comments) so a
      // pathological PR can't loop forever; if hit we log rather than silently
      // truncate, since a stale marker beyond the bound would yield a DUPLICATE
      // comment. (Was 5 pages / 500 items — backlog #6.)
      const MAX_PAGES = 50;
      const allMatchIds: number[] = [];

      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${baseUrl}?per_page=100&page=${page}`;
        const res = await fetch(url, {
          headers: apiHeaders(token),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) await failOn(res, 'listing PR comments');

        const comments = (await res.json()) as Array<{ id: number; body: string }>;
        for (const comment of comments) {
          if (comment.body.includes(REVIEW_MARKER)) {
            allMatchIds.push(comment.id);
          }
        }
        if (comments.length < 100) break;
        if (page === MAX_PAGES) {
          console.warn(
            `[ghagga] findExistingComment hit MAX_PAGES (${MAX_PAGES}) for ${owner}/${repo}#${prNumber}; comment listing may be truncated`,
          );
        }
      }

      if (allMatchIds.length === 0) return null;
      // Latest = last (GitHub returns oldest first); the rest are stale.
      const latestId = allMatchIds[allMatchIds.length - 1];
      if (latestId == null) return null;
      const staleIds = allMatchIds.slice(0, -1);
      return { latestId, staleIds };
    },

    async deleteComment(owner, repo, commentId, token): Promise<void> {
      const url = `${API_BASE}/repos/${owner}/${repo}/issues/comments/${commentId}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: apiHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // The adapter's upsert tolerates delete failures (best-effort), but we still
      // surface a non-2xx so `deleted[]` only reflects genuinely-removed ids.
      if (!res.ok && res.status !== 404) await failOn(res, 'deleting PR comment');
    },

    async updateComment(owner, repo, commentId, body, token): Promise<void> {
      const url = `${API_BASE}/repos/${owner}/${repo}/issues/comments/${commentId}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: apiHeaders(token),
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) await failOn(res, 'updating PR comment');
    },

    // ── STUBBED: read/reaction/graph members (never hit in --pr flow) ──
    // Declared `async` so the throw surfaces as a REJECTED promise (not a sync
    // throw): callers `await` these, and a rejected promise is the contract-true
    // failure shape — also keeps test spies/`.rejects` well-behaved.
    async fetchPRDiff(): Promise<string> {
      return unsupported('fetchPRDiff');
    },
    async fetchPRDetails(): Promise<{ headSha: string; baseBranch: string; prAuthor: string }> {
      return unsupported('fetchPRDetails');
    },
    async getPRFileList(): Promise<string[]> {
      return unsupported('getPRFileList');
    },
    async getPRCommitMessages(): Promise<string[]> {
      return unsupported('getPRCommitMessages');
    },
    async addCommentReaction(
      _owner: string,
      _repo: string,
      _commentId: number,
      _reaction: GitHubReactionContent,
      _token: string,
    ): Promise<void> {
      return unsupported('addCommentReaction');
    },
    async fetchGraphFromBranch(): Promise<never> {
      return unsupported('fetchGraphFromBranch');
    },
    async fetchGraphMetadata(): Promise<never> {
      return unsupported('fetchGraphMetadata');
    },
    async fetchFileContents(): Promise<never> {
      // Server-only (checkout-less triage). The CLI --pr flow sources code
      // locally, so this read member is stubbed like the others.
      return unsupported('fetchFileContents');
    },
  };
}
