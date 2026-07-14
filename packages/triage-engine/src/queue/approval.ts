/**
 * Approval flow — the ONLY code path allowed to call `forge.postComment`
 * (design.md "Module Architecture" boundary: "serve+CLI call queue; NEVER
 * call forge.post directly"). `approveAndPost` constructs the branded
 * `PostableReply` via `approveDraft` (../types/postable.ts) — the type
 * system rejects passing `draft.report` (technical analysis) here.
 */

import type { ForgeAdapter } from '../forge/port.js';
import type { IssueDraft } from '../types/draft.js';
import { approveDraft as brandApproveDraft } from '../types/postable.js';
import type { Queue } from './store.js';

export interface ApprovalResult {
  queue: Queue;
  draft: IssueDraft;
  /** false when this call was an idempotent no-op (draft was already POSTED). */
  posted: boolean;
}

/**
 * Approves the queued draft for `iid` and posts the (optionally edited)
 * client reply via `forge.postComment`. Idempotent: an already-POSTED draft
 * is returned unchanged WITHOUT calling `forge.postComment` again. Any other
 * non-`PENDING_APPROVAL` status (REJECTED, APPROVED-without-post) throws via
 * `approveDraft`'s own status guard — approving is never a silent no-op for
 * a state other than "already posted".
 */
export async function approveAndPost(
  queue: Queue,
  iid: string,
  forge: ForgeAdapter,
  editedReply?: string,
): Promise<ApprovalResult> {
  const draft = queue[iid];
  if (!draft) {
    throw new Error(`No draft queued for issue #${iid}`);
  }

  if (draft.status === 'POSTED') {
    return { queue, draft, posted: false };
  }

  const reply = brandApproveDraft(draft, editedReply);
  await forge.postComment(iid, reply);

  const posted: IssueDraft = {
    ...draft,
    clientReply: reply,
    status: 'POSTED',
    updatedAt: new Date().toISOString(),
  };

  return { queue: { ...queue, [iid]: posted }, draft: posted, posted: true };
}

/** Marks a draft REJECTED. Never calls the forge — nothing is posted. */
export function rejectDraft(queue: Queue, iid: string): { queue: Queue; draft: IssueDraft } {
  const draft = queue[iid];
  if (!draft) {
    throw new Error(`No draft queued for issue #${iid}`);
  }
  const rejected: IssueDraft = {
    ...draft,
    status: 'REJECTED',
    updatedAt: new Date().toISOString(),
  };
  return { queue: { ...queue, [iid]: rejected }, draft: rejected };
}
