/**
 * Unit tests for the sanctioned comment-id boxing helper (R-COMMENTID).
 *
 * This pins the same boxing contract review.comment-id.test.ts pins, but at the
 * pure-forge home so the helper is provable WITHOUT the BullMQ worker harness
 * (the reason it was lifted out of side-effectful review.ts in the first place).
 */

import { describe, expect, it } from 'vitest';
import { githubCommentId } from './comment-id.js';
import type { CommentId } from './types.js';

describe('githubCommentId (R-COMMENTID boxing helper)', () => {
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
    const gitlab: CommentId = { kind: 'gitlab', raw: '42' };

    expect(github).not.toEqual(gitlab);
    expect(github.kind).not.toBe(gitlab.kind);
    expect(github.raw).toBe(gitlab.raw); // same opaque value...
    // ...yet the boxed identities differ, so they can never be cross-used.
  });
});
