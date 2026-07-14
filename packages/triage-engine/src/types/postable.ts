/**
 * PostableReply — a branded string type that encodes postability at the
 * TYPE level (design.md decision 4). It is constructible ONLY via
 * `approveDraft`, so no code path can pass raw evidence, issue text, or an
 * unapproved draft's `report` (technical analysis) to a forge's
 * `postComment(iid, reply: PostableReply)`.
 *
 * This is a compile-time guarantee, not a runtime convention: TypeScript
 * rejects `postComment(iid, draft.report)` because `report: string` is not
 * structurally assignable to `PostableReply`.
 */

import type { IssueDraft } from './draft.js';

export type PostableReply = string & { readonly __brand: 'PostableReply' };

/**
 * The ONLY constructor of `PostableReply`. Requires the draft to be in the
 * `PENDING_APPROVAL` state — approving a rejected, already-posted, or
 * already-approved draft is a programming error, not a silent no-op.
 *
 * @param draft - the draft being approved; must have `status === 'PENDING_APPROVAL'`
 * @param editedReply - optional human-edited text; when provided, replaces `draft.clientReply`
 */
export function approveDraft(draft: IssueDraft, editedReply?: string): PostableReply {
  if (draft.status !== 'PENDING_APPROVAL') {
    throw new Error(
      `Cannot approve draft "${draft.id}" with status "${draft.status}"; expected PENDING_APPROVAL`,
    );
  }

  const reply = editedReply ?? draft.clientReply;
  return reply as PostableReply;
}
