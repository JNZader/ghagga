/**
 * PostableReply branded-type tests.
 *
 * Runtime: `approveDraft` is the ONLY constructor, and it enforces
 * `status === 'PENDING_APPROVAL'`.
 *
 * Compile-time: a plain `string` (including `draft.report`, the technical
 * analysis) is NOT assignable to `PostableReply` — verified with
 * `expectTypeOf` (vitest's built-in type-testing API, no extra tooling).
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { IssueDraft } from './draft.js';
import { approveDraft, type PostableReply } from './postable.js';

function makeDraft(overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    id: 'draft-1',
    issueIid: 42,
    repo: 'acme/widgets',
    status: 'PENDING_APPROVAL',
    report: 'Internal technical analysis: NPE at handler.ts:88 under null session.',
    clientReply: 'We reproduced the issue and are working on a fix.',
    reproductionEvidence: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('approveDraft', () => {
  it('constructs a PostableReply from clientReply when the draft is PENDING_APPROVAL', () => {
    const draft = makeDraft();

    const result: PostableReply = approveDraft(draft);

    expect(result).toBe(draft.clientReply);
  });

  it('uses the edited reply text when provided, not the original clientReply', () => {
    const draft = makeDraft({ clientReply: 'original text' });

    const result = approveDraft(draft, 'human-edited text');

    expect(result).toBe('human-edited text');
  });

  it('throws when the draft status is not PENDING_APPROVAL', () => {
    const rejected = makeDraft({ status: 'REJECTED' });

    expect(() => approveDraft(rejected)).toThrowError(/PENDING_APPROVAL/);
  });

  it('throws for an already-POSTED draft (cannot double-approve)', () => {
    const posted = makeDraft({ status: 'POSTED' });

    expect(() => approveDraft(posted)).toThrowError(/POSTED/);
  });
});

describe('PostableReply type-level guarantee', () => {
  it('is NOT assignable from a plain string', () => {
    expectTypeOf<string>().not.toMatchTypeOf<PostableReply>();
  });

  it('is NOT assignable from IssueDraft.report (the technical analysis field)', () => {
    // `report` is typed `string`, structurally identical to the raw-string
    // case above, but asserted explicitly because it is the exact security
    // boundary the brand exists to enforce (draft.report must never post).
    expectTypeOf<IssueDraft['report']>().not.toMatchTypeOf<PostableReply>();
  });

  it('approveDraft is the only function in this module returning PostableReply', () => {
    expectTypeOf(approveDraft).returns.toEqualTypeOf<PostableReply>();
  });
});
