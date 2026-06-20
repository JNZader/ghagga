/**
 * Task 1.11 — CommentId boxing at the review.ts forge seam (R-COMMENTID).
 *
 * review.ts boxes every GitHub-native numeric comment id (the upserted summary
 * comment id and the trigger-comment id) into the canonical {@link CommentId}
 * BEFORE it crosses the forge-adapter seam. These tests pin that boxing:
 *   - numeric → { kind: 'github', raw: String(n) }
 *   - the SAME numeric value, boxed for two different forges, never collides
 *     (the `kind` tag is what disambiguates a GitHub id from a GitLab note id).
 *
 * The boxing helper now lives in the side-effect-free `ghagga-forge` package
 * (`githubCommentId`) so it is reusable by both this worker AND the P3 CLI
 * without importing the BullMQ worker harness. This unit imports it from there
 * directly (it no longer lives review.ts-local).
 */

import type { CommentId } from 'ghagga-forge';
import { githubCommentId } from 'ghagga-forge';
import { describe, expect, it } from 'vitest';

describe('githubCommentId (R-COMMENTID boxing at the review.ts seam)', () => {
  it('boxes a GitHub-native numeric id into { kind: "github", raw: String(n) }', () => {
    expect(githubCommentId(2002)).toEqual({ kind: 'github', raw: '2002' });
    expect(githubCommentId(555)).toEqual({ kind: 'github', raw: '555' });
  });

  it('round-trips back to the original GitHub-native number', () => {
    const boxed = githubCommentId(1001);
    expect(Number(boxed.raw)).toBe(1001);
  });

  it('does NOT collide cross-forge: same numeric value, different kind', () => {
    const github = githubCommentId(42);
    // A hypothetical GitLab note id with the SAME raw number is a DISTINCT id —
    // the `kind` tag is what prevents cross-forge mis-assignment.
    const gitlab: CommentId = { kind: 'gitlab', raw: '42' };

    expect(github).not.toEqual(gitlab);
    expect(github.kind).not.toBe(gitlab.kind);
    expect(github.raw).toBe(gitlab.raw); // same opaque value...
    // ...yet the boxed identities differ, so they can never be cross-used.
  });
});
