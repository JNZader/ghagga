/**
 * Approval tests — the ONLY code path allowed to call `forge.postComment`.
 *
 * SECURITY: approve posts exactly once, only the (possibly edited)
 * clientReply, and is idempotent (an already-POSTED draft never re-posts).
 * reject never posts, under any circumstance.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ForgeAdapter } from '../forge/port.js';
import type { PostableReply } from '../types/postable.js';
import { approveAndPost, rejectDraft } from './approval.js';
import { buildDraft, upsertDraft } from './draft.js';
import type { Queue } from './store.js';

function makeForge(): ForgeAdapter & { postComment: ReturnType<typeof vi.fn> } {
  return {
    listIssues: vi.fn(),
    getIssue: vi.fn(),
    postComment: vi.fn(async () => undefined),
  };
}

function queueWithDraft(
  overrides: Parameters<typeof buildDraft>[0] = {
    iid: '42',
    repo: 'acme/widgets',
    report: 'internal analysis: NPE at handler.ts:88',
    clientReply: 'We are looking into this, thanks for the report.',
  },
): Queue {
  return upsertDraft({}, buildDraft(overrides));
}

describe('approveAndPost', () => {
  it('posts the clientReply exactly once via forge.postComment and marks POSTED', async () => {
    const forge = makeForge();
    const queue = queueWithDraft();

    const result = await approveAndPost(queue, '42', forge);

    expect(forge.postComment).toHaveBeenCalledTimes(1);
    expect(forge.postComment).toHaveBeenCalledWith(
      '42',
      'We are looking into this, thanks for the report.',
    );
    expect(result.posted).toBe(true);
    expect(result.draft.status).toBe('POSTED');
    expect(result.queue['42']?.status).toBe('POSTED');
  });

  it('NEVER posts the technical analysis (report) — only clientReply', async () => {
    const forge = makeForge();
    const queue = queueWithDraft();

    await approveAndPost(queue, '42', forge);

    const [, postedText] = forge.postComment.mock.calls[0] as [string, PostableReply];
    expect(postedText).not.toContain('NPE at handler.ts:88');
  });

  it('posts the edited reply when provided, not the original clientReply', async () => {
    const forge = makeForge();
    const queue = queueWithDraft();

    await approveAndPost(queue, '42', forge, 'human-edited final text');

    expect(forge.postComment).toHaveBeenCalledWith('42', 'human-edited final text');
  });

  it('is idempotent: an already-POSTED draft is returned unchanged without re-posting', async () => {
    const forge = makeForge();
    const queue = queueWithDraft();

    const first = await approveAndPost(queue, '42', forge);
    const second = await approveAndPost(first.queue, '42', forge);

    expect(forge.postComment).toHaveBeenCalledTimes(1);
    expect(second.posted).toBe(false);
    expect(second.draft).toEqual(first.draft);
  });

  it('throws when approving a REJECTED draft (never posts)', async () => {
    const forge = makeForge();
    const rejected = upsertDraft(
      {},
      { ...(await Promise.resolve(buildDraftForTest())), status: 'REJECTED' as const },
    );

    await expect(approveAndPost(rejected, '42', forge)).rejects.toThrow(/PENDING_APPROVAL/);
    expect(forge.postComment).not.toHaveBeenCalled();
  });

  it('throws when there is no draft queued for the given iid', async () => {
    const forge = makeForge();
    await expect(approveAndPost({}, '999', forge)).rejects.toThrow(/No draft queued/);
    expect(forge.postComment).not.toHaveBeenCalled();
  });
});

function buildDraftForTest() {
  return {
    id: 'acme/widgets#42',
    issueIid: '42',
    repo: 'acme/widgets',
    status: 'PENDING_APPROVAL' as const,
    report: 'r',
    clientReply: 'c',
    reproductionEvidence: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

describe('rejectDraft', () => {
  it('marks the draft REJECTED and never posts', () => {
    const forge = makeForge();
    const queue = queueWithDraft();

    const result = rejectDraft(queue, '42');

    expect(result.draft.status).toBe('REJECTED');
    expect(result.queue['42']?.status).toBe('REJECTED');
    expect(forge.postComment).not.toHaveBeenCalled();
  });

  it('throws when there is no draft queued for the given iid', () => {
    expect(() => rejectDraft({}, '999')).toThrowError(/No draft queued/);
  });
});
