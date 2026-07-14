/**
 * Forge adapter factory dispatch tests.
 *
 * Unrecognized forges are rejected at CONFIG-VALIDATION time by
 * `TriageConfigSchema`'s `forge: z.enum(['gitlab','github'])` — NOT at
 * `createForgeAdapter` call-time (see forge/index.ts doc comment). These
 * tests assert dispatch only; the schema-level rejection is covered by
 * `../config/schema.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { createForgeAdapter } from './index.js';

describe('createForgeAdapter', () => {
  it('dispatches to the GitLab adapter for forge: "gitlab"', () => {
    const adapter = createForgeAdapter({ forge: 'gitlab', repo: 'acme/widgets' });

    expect(adapter).toHaveProperty('listIssues');
    expect(adapter).toHaveProperty('getIssue');
    expect(adapter).toHaveProperty('postComment');
  });

  it('dispatches to the GitHub adapter for forge: "github"', () => {
    const adapter = createForgeAdapter({ forge: 'github', repo: 'acme/widgets' });

    expect(adapter).toHaveProperty('listIssues');
    expect(adapter).toHaveProperty('getIssue');
    expect(adapter).toHaveProperty('postComment');
  });

  it('throws for an unrecognized forge value bypassing the type system (defense in depth)', () => {
    // A schema-validated TriageConfig can never reach this branch — the zod
    // enum rejects it first. This test exercises the runtime safety net by
    // forcing a value the type system would otherwise block.
    const bogusConfig = { forge: 'bitbucket', repo: 'acme/widgets' } as unknown as Parameters<
      typeof createForgeAdapter
    >[0];

    expect(() => createForgeAdapter(bogusConfig)).toThrowError(/Unrecognized forge/);
  });
});
