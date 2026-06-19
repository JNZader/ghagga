import { describe, expect, it } from 'vitest';
import { repoRefEquals } from './ref.js';
import type { RepoRef } from './types.js';
import { FORGE_KIND } from './types.js';

/**
 * `repoRefEquals` keys on `nativeId` — `path` is mutable and MUST NOT
 * participate in identity. This is the contract every consumer (registry, dedup,
 * caching) relies on.
 */
describe('repoRefEquals — RepoRef identity (R-COMMENTID family)', () => {
  it('identity is keyed on nativeId', () => {
    const a: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '123', path: 'owner/repo' };
    const b: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '123', path: 'owner/repo' };

    expect(repoRefEquals(a, b)).toBe(true);
  });

  it('a path change (rename/transfer) does NOT break identity', () => {
    const before: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '123', path: 'old-owner/repo' };
    const after: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '123', path: 'new-owner/renamed' };

    expect(repoRefEquals(before, after)).toBe(true);
  });

  it('different nativeId means different repo, even with the same path', () => {
    const a: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '123', path: 'owner/repo' };
    const b: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '999', path: 'owner/repo' };

    expect(repoRefEquals(a, b)).toBe(false);
  });

  it('same nativeId on different forges is NOT the same repo', () => {
    const gh: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '123' };
    const gl: RepoRef = { kind: FORGE_KIND.GITLAB, nativeId: '123' };

    expect(repoRefEquals(gh, gl)).toBe(false);
  });

  it('path is optional (identity holds without it)', () => {
    const a: RepoRef = { kind: FORGE_KIND.GITEA, nativeId: '7' };
    const b: RepoRef = { kind: FORGE_KIND.GITEA, nativeId: '7', path: 'team/proj' };

    expect(repoRefEquals(a, b)).toBe(true);
  });
});
