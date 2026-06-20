/**
 * Forge-NEUTRAL summary post-back for the CLI.
 *
 * This is the single plumbing point the `ghagga review --pr N` (GitHub) path
 * routes through — and the SAME function P4 will reuse for `--mr N` (GitLab).
 * It is deliberately written against the forge-agnostic surface ONLY:
 *   - a `ForgeAdapterBase` (whatever forge built it — GitHub today, GitLab next),
 *   - a canonical `ChangeRequestRef`,
 *   - a pre-rendered comment `body` (caller renders via ghagga-core for parity),
 *   - a `CommentMarker`.
 *
 * It contains NO GitHub specifics: no owner/repo strings, no REST paths, no
 * github-native ids. All of that is encapsulated inside the adapter + its client
 * port. To add GitLab in P4, the command-level glue builds a GitLab adapter +
 * a `gitlab`-kind ref and calls THIS function unchanged.
 *
 * Idempotency (find stale → delete all → post fresh) lives inside
 * `adapter.upsertSummaryComment`; this wrapper just boxes the returned native id
 * into the canonical `CommentId` (forge-agnostic boxing helper) and returns it.
 */

import type { ChangeRequestRef, CommentId, CommentMarker, ForgeAdapterBase } from 'ghagga-forge';
import { githubCommentId } from 'ghagga-forge';

export interface PostBackResult {
  /** The canonical id of the summary comment that now exists. */
  commentId: CommentId;
  /** Forge-native ids of stale summary comments removed during the upsert. */
  deletedNativeIds: number[];
}

/**
 * Upsert the single GHAGGA summary comment on a change request via any forge
 * adapter. Forge-neutral — usable for GitHub PRs (P3) and GitLab MRs (P4).
 *
 * @param adapter the forge adapter (built by the command glue per forge).
 * @param ref     the canonical change-request ref (PR/MR).
 * @param body    the rendered comment body (parity with the server post-back).
 * @param marker  the comment marker identifying GHAGGA-owned comments.
 */
export async function postSummaryComment(
  adapter: ForgeAdapterBase,
  ref: ChangeRequestRef,
  body: string,
  marker: CommentMarker,
): Promise<PostBackResult> {
  const result = await adapter.upsertSummaryComment(ref, body, marker);
  // Box the forge-native id into the canonical CommentId. The boxing helper is
  // forge-specific (githubCommentId) only because P3 ships GitHub; P4 will box
  // via the GitLab helper at this same seam (selected by ref.repo.kind).
  return {
    commentId: githubCommentId(result.created),
    deletedNativeIds: result.deleted,
  };
}
