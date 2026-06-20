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
 * github-native ids, and no github-native boxing helper. All of that is
 * encapsulated inside the adapter + its client port. To add GitLab in P4, the
 * command-level glue builds a GitLab adapter + a `gitlab`-kind ref and calls
 * THIS function UNCHANGED.
 *
 * Idempotency (find stale → delete all → post fresh) lives inside
 * `adapter.upsertSummaryComment`; this wrapper just relays the adapter's RAW
 * forge-native result. Boxing into a canonical `CommentId` (if ever needed) is
 * the kind-specific HANDLER's concern, not this neutral seam's — the only
 * consumer today logs the raw id, so we do not box at all.
 */

import type { ChangeRequestRef, CommentMarker, ForgeAdapterBase } from 'ghagga-forge';

export interface PostBackResult {
  /** The forge-native id of the summary comment that now exists. */
  createdNativeId: number;
  /** Forge-native ids of stale summary comments removed during the upsert. */
  deletedNativeIds: number[];
}

/**
 * Upsert the single GHAGGA summary comment on a change request via any forge
 * adapter. Forge-neutral — usable for GitHub PRs (P3) and GitLab MRs (P4)
 * UNCHANGED (zero GitHub coupling).
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
  // Relay the adapter's RAW forge-native result. No boxing here — this keeps
  // the seam fully forge-agnostic so P4 reuses it unchanged. The kind-specific
  // handler boxes/logs as it sees fit.
  return {
    createdNativeId: result.created,
    deletedNativeIds: result.deleted,
  };
}
