/**
 * Sanctioned comment-id boxing helpers (R-COMMENTID).
 *
 * The forge adapters RETURN forge-native primitives (e.g. GitHub numeric
 * comment ids) — see {@link UpsertSummaryResult}. Boxing those primitives into
 * the canonical {@link CommentId} ({kind, raw}) happens caller-LOCAL, AFTER the
 * adapter returns. This module is the ONE blessed place that boxing lives, so
 * both the server worker (apps/server review.ts) AND the future P3 CLI can reuse
 * it WITHOUT importing side-effectful modules (review.ts constructs Redis/BullMQ
 * queue state at import time — unusable from a CLI / from the helper's own test).
 *
 * This is a PURE helper using the forge {@link CommentId} type. It does NOT
 * brand the adapter's return type (the adapter still returns numbers); it is the
 * sanctioned boxing step the caller applies at the seam.
 *
 * Boundary note (R-AGNOSTIC): this file imports only the forge-local
 * {@link CommentId} type — no `apps/server`, no `ghagga-core` value import — so
 * it does not breach any package boundary.
 */

import type { CommentId } from './types.js';

/**
 * BOX a GitHub-native numeric comment id into the canonical {@link CommentId}.
 *
 * The `kind: 'github'` tag prevents a GitHub comment id from being
 * cross-assigned as a GitLab note id — the same numeric value across forges
 * never collides because the discriminator differs.
 *
 * @param raw the GitHub-native numeric comment id.
 * @returns the boxed `{ kind: 'github', raw: String(raw) }`.
 */
export function githubCommentId(raw: number): CommentId {
  return { kind: 'github', raw: String(raw) };
}

/**
 * BOX a GitLab-native numeric note id into the canonical {@link CommentId}.
 *
 * GitLab note ids are NUMERIC but MR-scoped — the `kind: 'gitlab'` tag is what
 * disambiguates them from a GitHub comment id (R-COMMENTID). The SAME numeric
 * value boxed as `'github'` vs `'gitlab'` never collides because the
 * discriminator differs, so a GitHub comment id can never be cross-assigned as a
 * GitLab note id (and vice-versa).
 *
 * @param raw the GitLab-native numeric note id.
 * @returns the boxed `{ kind: 'gitlab', raw: String(raw) }`.
 */
export function gitlabCommentId(raw: number): CommentId {
  return { kind: 'gitlab', raw: String(raw) };
}
