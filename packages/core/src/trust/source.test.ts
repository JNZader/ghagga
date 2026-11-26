import { describe, expect, it } from 'vitest';
import { chooseGraphRef, mayUseRepoSource } from './source.js';

describe('mayUseRepoSource', () => {
  const trusted = {
    isFork: false,
    authorHasWrite: true,
    refIsDefaultBranch: true,
    refIsProtected: false,
  };

  it('allows the default branch for an author who can write', () => {
    expect(mayUseRepoSource(trusted)).toBe(true);
  });

  it('allows a protected branch that is not the default', () => {
    expect(mayUseRepoSource({ ...trusted, refIsDefaultBranch: false, refIsProtected: true })).toBe(
      true,
    );
  });

  it('refuses a pull request head that is neither default nor protected', () => {
    expect(mayUseRepoSource({ ...trusted, refIsDefaultBranch: false, refIsProtected: false })).toBe(
      false,
    );
  });

  it('refuses a fork even when the ref is that fork default branch', () => {
    expect(mayUseRepoSource({ ...trusted, isFork: true })).toBe(false);
  });

  it('refuses an author without write even on a protected branch', () => {
    expect(
      mayUseRepoSource({
        ...trusted,
        authorHasWrite: false,
        refIsDefaultBranch: false,
        refIsProtected: true,
      }),
    ).toBe(false);
  });
});

describe('chooseGraphRef', () => {
  it('prefers the default branch when the graph file is there', () => {
    expect(
      chooseGraphRef({
        defaultBranch: 'main',
        defaultBranchHasGraph: true,
        graphBranchProtected: true,
      }),
    ).toBe('main');
  });

  it('uses ghagga/graph only when that branch is protected and the default branch has no graph', () => {
    expect(
      chooseGraphRef({
        defaultBranch: 'main',
        defaultBranchHasGraph: false,
        graphBranchProtected: true,
      }),
    ).toBe('ghagga/graph');
  });

  it('refuses an unprotected ghagga/graph branch', () => {
    expect(
      chooseGraphRef({
        defaultBranch: 'main',
        defaultBranchHasGraph: false,
        graphBranchProtected: false,
      }),
    ).toBeNull();
  });

  it('refuses the orphan branch when protection could not be confirmed', () => {
    expect(
      chooseGraphRef({
        defaultBranch: 'main',
        defaultBranchHasGraph: false,
        graphBranchProtected: null,
      }),
    ).toBeNull();
  });
});
