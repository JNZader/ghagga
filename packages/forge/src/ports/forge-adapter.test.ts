import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../types.js';
import { FORGE_KIND } from '../types.js';
import type { DigestPublicationCapable, ForgeAdapter, SearchCapable } from './forge-adapter.js';

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

/**
 * Type-level + runtime shape test for {@link DigestPublicationCapable}
 * (nightly-health-digest T2.1).
 *
 * A three-method optional capability composed as `Partial<>` onto
 * {@link ForgeAdapter}. GitHub implements it against the issues API; GitLab
 * implements ALL verbs by throwing unsupported (the port keeps the seam —
 * MR-notes-only, no silent no-op). `findOpenDigestIssue` powers the digest
 * worker's adopt-before-create idempotency (4R RISK-001/RES-001).
 */
describe('DigestPublicationCapable (port shape)', () => {
  const repo: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: 'node-1', path: 'octo/demo' };

  it('is a three-method interface: create returns { number }, update is void, find returns { number } | null', async () => {
    const impl: DigestPublicationCapable = {
      createDigestIssue: async (_repo, title, body) => ({ number: title.length + body.length }),
      updateDigestIssue: async () => undefined,
      findOpenDigestIssue: async (_repo, title) => (title === 'none' ? null : { number: 42 }),
    };
    const created = await impl.createDigestIssue(
      repo,
      'GHAGGA Health Digest',
      '<!-- ghagga-digest -->',
    );
    expect(created).toEqual({ number: 42 });
    await expect(impl.updateDigestIssue(repo, 42, 'body')).resolves.toBeUndefined();
    await expect(impl.findOpenDigestIssue(repo, 'GHAGGA Health Digest')).resolves.toEqual({
      number: 42,
    });
    await expect(impl.findOpenDigestIssue(repo, 'none')).resolves.toBeNull();
  });

  it('composes onto ForgeAdapter as Partial<> (an adapter may omit it entirely)', () => {
    const withoutDigest: Pick<ForgeAdapter, 'capabilities'> = {
      capabilities: { reactions: false, inlineComments: false, graphRead: false },
    };
    expect('createDigestIssue' in withoutDigest).toBe(false);
    expect('updateDigestIssue' in withoutDigest).toBe(false);
  });

  it('narrows by method presence, not a capabilities flag', () => {
    const withDigest: Partial<DigestPublicationCapable> = {
      createDigestIssue: async () => ({ number: 1 }),
      updateDigestIssue: async () => undefined,
    };
    expect('createDigestIssue' in withDigest).toBe(true);
    expect('updateDigestIssue' in withDigest).toBe(true);
  });
});
