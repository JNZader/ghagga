import { describe, expect, it, vi } from 'vitest';
import type { ForgeAdapter, GraphReadCapable, ReactionCapable } from './ports/forge-adapter.js';
import { REACTION_KIND } from './ports/forge-adapter.js';
import type { CommentId, RepoRef } from './types.js';
import { FORGE_KIND } from './types.js';

const baseOnly = (): ForgeAdapter =>
  ({
    capabilities: { reactions: false, inlineComments: false, graphRead: false },
    fetchDiff: vi.fn(),
    fetchChangeRequest: vi.fn(),
    fetchFileList: vi.fn(),
    fetchCommits: vi.fn(),
    upsertSummaryComment: vi.fn(),
  }) as unknown as ForgeAdapter;

const withReactions = (): ForgeAdapter => {
  const adapter = baseOnly() as ForgeAdapter & ReactionCapable;
  adapter.addReaction = vi.fn().mockResolvedValue(undefined);
  return adapter;
};

const repo: RepoRef = { kind: FORGE_KIND.GITHUB, nativeId: '1' };
const commentId: CommentId = { kind: 'github:issue-comment', raw: 99 };

describe('capability guarding (R-CAPABILITY)', () => {
  it('method-presence guard skips a missing optional method with no TypeError', async () => {
    const adapter = baseOnly();

    let called = false;
    // The ONLY sanctioned guard: method presence.
    if ('addReaction' in adapter && typeof adapter.addReaction === 'function') {
      await adapter.addReaction(commentId, REACTION_KIND.ROCKET);
      called = true;
    }

    expect(called).toBe(false); // skipped cleanly, no throw
  });

  it('method-presence guard invokes a present optional method', async () => {
    const adapter = withReactions();

    let called = false;
    if ('addReaction' in adapter && typeof adapter.addReaction === 'function') {
      await adapter.addReaction(commentId, REACTION_KIND.ROCKET);
      called = true;
    }

    expect(called).toBe(true);
    expect(adapter.addReaction).toHaveBeenCalledWith(commentId, REACTION_KIND.ROCKET);
  });

  it('the capabilities FLAG is NOT the guard — a lying flag does not cause a TypeError', async () => {
    // Adapter advertises reactions=true but has NO addReaction method. If a
    // caller (wrongly) trusted the flag, this would TypeError. The presence
    // guard protects us regardless of the flag's value.
    const adapter = baseOnly();
    (adapter as { capabilities: { reactions: boolean } }).capabilities.reactions = true;

    let threw = false;
    try {
      if ('addReaction' in adapter && typeof adapter.addReaction === 'function') {
        await adapter.addReaction(commentId, REACTION_KIND.EYES);
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it('graph-read co-presence: both methods guarded together', async () => {
    const adapter = baseOnly() as ForgeAdapter & GraphReadCapable;
    adapter.fetchGraph = vi.fn().mockResolvedValue(null);
    adapter.fetchGraphMetadata = vi.fn().mockResolvedValue(null);

    if ('fetchGraph' in adapter && typeof adapter.fetchGraph === 'function') {
      const graph = await adapter.fetchGraph(repo);
      expect(graph).toBeNull();
    }
    if ('fetchGraphMetadata' in adapter && typeof adapter.fetchGraphMetadata === 'function') {
      const meta = await adapter.fetchGraphMetadata(repo);
      expect(meta).toBeNull();
    }
  });
});
