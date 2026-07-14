/**
 * QUEUE module barrel — local JSON persistence (store.ts), draft
 * construction/pure mutation (draft.ts), and the approval flow that is the
 * ONLY code path allowed to post to a forge (approval.ts). See design.md
 * `queue/` module + decision 3/4.
 */

export { type ApprovalResult, approveAndPost, rejectDraft } from './approval.js';
export {
  type BuildDraftInput,
  buildDraft,
  draftId,
  editDraftReply,
  getDraft,
  upsertDraft,
} from './draft.js';
export {
  defaultQueuePath,
  loadQueue,
  type Queue,
  type QueuePathOptions,
  repoSlug,
  saveQueue,
} from './store.js';
