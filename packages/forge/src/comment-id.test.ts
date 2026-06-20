/**
 * Unit tests for the sanctioned comment-id boxing helper (R-COMMENTID).
 *
 * This pins the same boxing contract review.comment-id.test.ts pins, but at the
 * pure-forge home so the helper is provable WITHOUT the BullMQ worker harness
 * (the reason it was lifted out of side-effectful review.ts in the first place).
 */

import { describe, expect, it } from 'vitest';
import { githubCommentId, gitlabCommentId } from './comment-id.js';
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

describe('gitlabCommentId (R-COMMENTID boxing helper)', () => {
  it('boxes a GitLab-native numeric note id into { kind: "gitlab", raw: String(n) }', () => {
    expect(gitlabCommentId(2002)).toEqual({ kind: 'gitlab', raw: '2002' });
    expect(gitlabCommentId(555)).toEqual({ kind: 'gitlab', raw: '555' });
  });

  it('round-trips back to the original GitLab-native number', () => {
    const boxed = gitlabCommentId(1001);
    expect(Number(boxed.raw)).toBe(1001);
  });

  it('does NOT collide cross-forge with a GitHub id of the same numeric value', () => {
    // R-COMMENTID cross-forge no-collision PROOF: a GitLab note id and a GitHub
    // comment id with the SAME numeric value box to distinct CommentIds because
    // the `kind` discriminator differs.
    const gitlab = gitlabCommentId(42);
    const github = githubCommentId(42);

    expect(gitlab).not.toEqual(github);
    expect(gitlab.kind).toBe('gitlab');
    expect(github.kind).toBe('github');
    expect(gitlab.raw).toBe(github.raw); // same opaque value (42 → '42')...
    // ...yet the boxed identities differ → never cross-usable across forges.
  });
});
