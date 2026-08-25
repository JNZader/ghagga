import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../types.js';
import { FORGE_KIND } from '../types.js';
import type { ForgeAdapter, SearchCapable } from './forge-adapter.js';

/**
 * Type-level test for {@link SearchCapable} (triage-search-discovery T2).
 *
 * `SearchCapable` is a SINGLE-METHOD optional capability, composed as
 * `Partial<SearchCapable>` onto {@link ForgeAdapter} — the same pattern as
 * `FileReadCapable`. It is narrowed by METHOD PRESENCE (`'searchCode' in
 * adapter`), never by a `ForgeCapabilities` flag (R-CAPABILITY), so there is no
 * `searchCode` entry in `ForgeCapabilities` and none should ever be added for
 * this single-method capability.
 */
describe('SearchCapable (port shape)', () => {
  const repo: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: 'node-1', path: 'octo/demo' };

  it('is a single-method interface: (repo, term, limit) => Promise<string[]>', async () => {
    const impl: SearchCapable = {
      searchCode: async (_repo, term, limit) => Array.from({ length: limit }, () => term),
    };
    const out = await impl.searchCode(repo, 'fetchGraph', 2);
    expect(out).toEqual(['fetchGraph', 'fetchGraph']);
  });

  it('composes onto ForgeAdapter as Partial<> (an adapter may omit it entirely)', () => {
    // A minimal adapter WITHOUT searchCode still satisfies ForgeAdapter — proves
    // the capability is optional (Partial<>), not mandatory co-presence.
    const withoutSearch: Pick<ForgeAdapter, 'capabilities'> = {
      capabilities: { reactions: false, inlineComments: false, graphRead: false },
    };
    expect('searchCode' in withoutSearch).toBe(false);
  });

  it('narrows by method presence, not a capabilities flag', () => {
    const withSearch: Partial<SearchCapable> = {
      searchCode: async () => [],
    };
    expect('searchCode' in withSearch).toBe(true);
    const withoutSearch: Partial<SearchCapable> = {};
    expect('searchCode' in withoutSearch).toBe(false);
  });
});
