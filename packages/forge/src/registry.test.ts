import { describe, expect, it, vi } from 'vitest';
import type { ForgeAdapter } from './ports/forge-adapter.js';
import { MapForgeRegistry, UnknownForgeError } from './registry.js';
import type { RepoRef } from './types.js';
import { FORGE_KIND } from './types.js';

const stubAdapter = (): ForgeAdapter =>
  ({
    capabilities: { reactions: false, inlineComments: false, graphRead: false },
    fetchDiff: vi.fn(),
    fetchChangeRequest: vi.fn(),
    fetchFileList: vi.fn(),
    fetchCommits: vi.fn(),
    upsertSummaryComment: vi.fn(),
  }) as unknown as ForgeAdapter;

describe('MapForgeRegistry (R-RESOLVE)', () => {
  it('resolves a registered adapter by repo.kind', () => {
    const registry = new MapForgeRegistry();
    const adapter = stubAdapter();
    registry.register(FORGE_KIND.GITHUB, adapter);

    const repo: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '1' };

    expect(registry.resolve(repo)).toBe(adapter);
  });

  it('throws a TYPED UnknownForgeError on a miss (not undefined)', () => {
    const registry = new MapForgeRegistry();
    const repo: RepoRef = { kind: FORGE_KIND.GITLAB, nativeId: '1' };

    expect(() => registry.resolve(repo)).toThrow(UnknownForgeError);
  });

  it('the error carries the missing kind and is instanceof-narrowable', () => {
    const registry = new MapForgeRegistry();
    const repo: RepoRef = { kind: FORGE_KIND.GITEA, nativeId: '1' };

    try {
      registry.resolve(repo);
      expect.unreachable('resolve should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownForgeError);
      if (error instanceof UnknownForgeError) {
        expect(error.kind).toBe(FORGE_KIND.GITEA);
      }
    }
  });

  it('never returns undefined — a miss never reaches undefined.fetchDiff(...)', () => {
    const registry = new MapForgeRegistry();
    const repo: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '1' };

    // If resolve returned undefined instead of throwing, this would be a
    // TypeError at call time. The typed throw makes the failure explicit.
    let resolved: ForgeAdapter | undefined;
    expect(() => {
      resolved = registry.resolve(repo);
    }).toThrow(UnknownForgeError);
    expect(resolved).toBeUndefined();
  });

  it('has() reports registration state', () => {
    const registry = new MapForgeRegistry();
    expect(registry.has(FORGE_KIND.GITHUB)).toBe(false);
    registry.register(FORGE_KIND.GITHUB, stubAdapter());
    expect(registry.has(FORGE_KIND.GITHUB)).toBe(true);
  });

  it('a later registration overrides an earlier one for the same kind', () => {
    const registry = new MapForgeRegistry();
    const first = stubAdapter();
    const second = stubAdapter();
    registry.register(FORGE_KIND.GITHUB, first);
    registry.register(FORGE_KIND.GITHUB, second);

    expect(registry.resolve({ kind: FORGE_KIND.GITHUB, nativeId: '1' })).toBe(second);
  });
});
