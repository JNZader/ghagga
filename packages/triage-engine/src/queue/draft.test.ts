/**
 * Draft construction + pure queue-mutation tests (upsert/edit/get).
 */

import { describe, expect, it } from 'vitest';
import type { ReproEvidence } from '../types/evidence.js';
import { buildDraft, draftId, editDraftReply, getDraft, upsertDraft } from './draft.js';
import type { Queue } from './store.js';

describe('draftId', () => {
  it('builds a stable id from repo + iid', () => {
    expect(draftId('acme/widgets', '42')).toBe('acme/widgets#42');
  });
});

describe('buildDraft', () => {
  it('builds a PENDING_APPROVAL draft from triage output', () => {
    const draft = buildDraft({
      iid: '42',
      repo: 'acme/widgets',
      report: 'internal technical analysis',
      clientReply: 'client-facing reply',
    });

    expect(draft).toMatchObject({
      id: 'acme/widgets#42',
      issueIid: '42',
      repo: 'acme/widgets',
      status: 'PENDING_APPROVAL',
      report: 'internal technical analysis',
      clientReply: 'client-facing reply',
      reproductionEvidence: null,
    });
    expect(draft.createdAt).toBe(draft.updatedAt);
    expect(() => new Date(draft.createdAt).toISOString()).not.toThrow();
  });

  it('carries reproduction evidence through when provided', () => {
    const evidence: ReproEvidence = {
      reproduced: true,
      steps: ['click button'],
      consoleErrors: [],
      netFails: [],
      uiErrors: [],
    };

    const draft = buildDraft({
      iid: '7',
      repo: 'acme/widgets',
      report: 'r',
      clientReply: 'c',
      reproductionEvidence: evidence,
    });

    expect(draft.reproductionEvidence).toBe(evidence);
  });
});

describe('upsertDraft / getDraft', () => {
  it('inserts a draft keyed by its issueIid, without mutating the input queue', () => {
    const original: Queue = {};
    const draft = buildDraft({ iid: '42', repo: 'acme/widgets', report: 'r', clientReply: 'c' });

    const updated = upsertDraft(original, draft);

    expect(original).toEqual({});
    expect(getDraft(updated, '42')).toBe(draft);
  });

  it('overwrites any previous draft for the same issue (fresh triage supersedes)', () => {
    const first = buildDraft({ iid: '42', repo: 'acme/widgets', report: 'r1', clientReply: 'c1' });
    const second = buildDraft({ iid: '42', repo: 'acme/widgets', report: 'r2', clientReply: 'c2' });

    let queue = upsertDraft({}, first);
    queue = upsertDraft(queue, second);

    expect(getDraft(queue, '42')).toBe(second);
  });
});

describe('editDraftReply', () => {
  it('updates the clientReply and updatedAt without mutating the input queue', () => {
    const draft = buildDraft({ iid: '42', repo: 'acme/widgets', report: 'r', clientReply: 'c' });
    const queue = upsertDraft({}, draft);

    const updated = editDraftReply(queue, '42', 'edited reply');

    expect(queue['42']?.clientReply).toBe('c');
    expect(updated['42']?.clientReply).toBe('edited reply');
    expect(updated['42']?.status).toBe('PENDING_APPROVAL');
  });

  it('throws when no draft is queued for the given iid', () => {
    expect(() => editDraftReply({}, '999', 'x')).toThrowError(/No draft queued/);
  });
});
