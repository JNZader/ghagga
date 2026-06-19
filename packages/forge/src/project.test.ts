import { describe, expect, it } from 'vitest';
import { toCommitMessages, toFileList, toReviewContext } from './project.js';
import type { ChangedFile, Commit } from './types.js';
import { ACTOR_KIND, CHANGE_KIND } from './types.js';

const commit = (sha: string, message: string): Commit => ({
  sha,
  message,
  author: { login: 'alice', kind: ACTOR_KIND.USER },
});

const file = (path: string): ChangedFile => ({
  path,
  changeKind: CHANGE_KIND.MODIFIED,
  additions: 1,
  deletions: 0,
});

describe('toCommitMessages (R-PROJECTION)', () => {
  it('maps .message, NOT .sha', () => {
    const commits = [
      commit('a'.repeat(40), 'feat: add login'),
      commit('b'.repeat(40), 'fix: handle null token'),
    ];

    const result = toCommitMessages(commits);

    expect(result).toEqual(['feat: add login', 'fix: handle null token']);
  });

  it('never emits a SHA — every output differs from its source .sha', () => {
    const commits = [commit('deadbeef', 'chore: bump deps')];

    const result = toCommitMessages(commits);

    // The load-bearing assertion: if someone "fixes" the projection to map
    // .sha, this fails because .message !== .sha.
    expect(result[0]).toBe('chore: bump deps');
    expect(result[0]).not.toBe(commits[0]?.sha);
  });

  it('returns an empty array for no commits', () => {
    expect(toCommitMessages([])).toEqual([]);
  });
});

describe('toFileList', () => {
  it('projects changed files to their paths', () => {
    const files = [file('src/a.ts'), file('src/b.ts')];

    expect(toFileList(files)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns an empty array for no files', () => {
    expect(toFileList([])).toEqual([]);
  });
});

describe('toReviewContext', () => {
  it('assembles a ReviewContext using the sanctioned projections', () => {
    const commits = [commit('a'.repeat(40), 'feat: x')];
    const files = [file('src/x.ts')];

    const ctx = toReviewContext('owner/repo', 42, commits, files);

    expect(ctx).toEqual({
      repoFullName: 'owner/repo',
      prNumber: 42,
      commitMessages: ['feat: x'],
      fileList: ['src/x.ts'],
    });
  });

  it('carries commit MESSAGES into the context (not SHAs)', () => {
    const commits = [commit('c'.repeat(40), 'docs: readme')];

    const ctx = toReviewContext('o/r', 1, commits, []);

    expect(ctx.commitMessages).toEqual(['docs: readme']);
    expect(ctx.commitMessages[0]).not.toBe(commits[0]?.sha);
  });
});
