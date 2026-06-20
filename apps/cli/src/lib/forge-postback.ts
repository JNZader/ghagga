/**
 * Shared forge-NEUTRAL composition helper for the CLI change-request post-back
 * (`ghagga review --pr N` GitHub / `--mr N` GitLab) — resolves
 * BL-CLI-FORGE-COMPOSITION.
 *
 * The P3 `--pr` path and the P4 `--mr` path are the SAME pipeline:
 *   resolve-token → parse-remote → build-adapter → make-ref → postSummaryComment
 * The ONLY differences are forge-specific: which token env vars to read, how to
 * parse the remote into a `RepoRef`, and which adapter to construct. This module
 * captures the SHARED pipeline ONCE — the forge-specific steps are injected via a
 * {@link ForgeCompositionBuilder} so BOTH commands route through one path instead
 * of each hand-rolling the glue. Adding a third forge (Gitea) is a new builder,
 * not a new branch.
 *
 * The actual idempotent upsert (find stale → delete → repost) lives inside the
 * adapter + the forge-neutral {@link postSummaryComment}; this helper only
 * orchestrates token-resolution → composition-build → post.
 */

import type { ChangeRequestRef, CommentMarker, ForgeAdapterBase } from 'ghagga-forge';
import { type PostBackResult, postSummaryComment } from './pr-postback.js';

/** The forge-specific pieces a post-back composition resolves to. */
export interface ForgeComposition {
  /** The forge adapter (built over its CLI client port + the resolved token). */
  adapter: ForgeAdapterBase;
  /** The canonical change-request ref (PR/MR) with forge-native identity. */
  ref: ChangeRequestRef;
}

/**
 * Builds the forge-specific composition (adapter + ref) from a resolved token +
 * the change-request number. ASYNC because some forges need a pre-flight REST
 * call (GitLab resolves the numeric project id from the remote path).
 */
export type ForgeCompositionBuilder = (
  token: string,
  changeRequestNumber: number,
) => Promise<ForgeComposition>;

/**
 * Why a forge post-back could not run, distinct from a thrown post error.
 *
 * `missing-token` is surfaced separately so the caller can print the
 * forge-appropriate "set X / run ghagga login" guidance and apply the
 * blocking/soft-fail exit policy uniformly.
 */
export type ForgePostbackOutcome =
  | { kind: 'posted'; result: PostBackResult }
  | { kind: 'missing-token' };

/** Inputs for {@link composeForgePostback}. */
export interface ForgePostbackInput {
  /** The change-request number (PR/MR). */
  changeRequestNumber: number;
  /** Resolve the forge token (env-first, stored fallback). null ⇒ missing. */
  resolveToken: () => string | null;
  /** Build the forge-specific adapter + ref from the resolved token. */
  buildComposition: ForgeCompositionBuilder;
  /** The pre-rendered comment body (parity with the server post-back). */
  body: string;
  /** The comment marker identifying GHAGGA-owned comments. */
  marker: CommentMarker;
}

/**
 * Run the SHARED post-back pipeline for one forge.
 *
 * 1. resolve the token (forge-specific resolver). Missing ⇒ `missing-token`.
 * 2. build the forge composition (adapter + ref) — async (GitLab project-id).
 * 3. upsert the summary comment via the forge-neutral {@link postSummaryComment}.
 *
 * Throws on a post/build failure (the caller owns the blocking vs soft-fail exit
 * policy). A missing token is returned as data, NOT thrown, so the caller prints
 * forge-appropriate guidance.
 */
export async function composeForgePostback(
  input: ForgePostbackInput,
): Promise<ForgePostbackOutcome> {
  const token = input.resolveToken();
  if (!token) return { kind: 'missing-token' };

  const composition = await input.buildComposition(token, input.changeRequestNumber);
  const result = await postSummaryComment(
    composition.adapter,
    composition.ref,
    input.body,
    input.marker,
  );
  return { kind: 'posted', result };
}
