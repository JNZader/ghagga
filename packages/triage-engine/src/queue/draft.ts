/**
 * Draft construction + pure queue-mutation helpers. The queue is treated as
 * an immutable value: every function here returns a NEW queue object rather
 * than mutating its input, matching the rest of the engine's pure-function
 * boundaries (design.md "locate/reproduce are pure over injected deps").
 */

import type { IssueDraft } from '../types/draft.js';
import type { ReproEvidence } from '../types/evidence.js';
import type { Queue } from './store.js';

export interface BuildDraftInput {
  iid: string;
  repo: string;
  /** Internal technical analysis (never postable). */
  report: string;
  /** Draft client-facing reply (postable only via approveDraft/approveAndPost). */
  clientReply: string;
  reproductionEvidence?: ReproEvidence | null;
}

/** Stable draft id derived from repo + issue iid: `<repo>#<iid>`. */
export function draftId(repo: string, iid: string): string {
  return `${repo}#${iid}`;
}

/** Builds a new PENDING_APPROVAL draft from a TRIAGE stage result. */
export function buildDraft(input: BuildDraftInput): IssueDraft {
  const now = new Date().toISOString();
  return {
    id: draftId(input.repo, input.iid),
    issueIid: input.iid,
    repo: input.repo,
    status: 'PENDING_APPROVAL',
    report: input.report,
    clientReply: input.clientReply,
    reproductionEvidence: input.reproductionEvidence ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Upserts `draft` into `queue`, keyed by `String(draft.issueIid)`. A fresh
 * triage always supersedes any previous draft for the same issue, regardless
 * of the previous draft's status (matches the PoC's `q[iid] = d`).
 */
export function upsertDraft(queue: Queue, draft: IssueDraft): Queue {
  return { ...queue, [String(draft.issueIid)]: draft };
}

export function getDraft(queue: Queue, iid: string): IssueDraft | undefined {
  return queue[iid];
}

/** Returns a new queue with the draft's clientReply (and updatedAt) edited. */
export function editDraftReply(queue: Queue, iid: string, newReply: string): Queue {
  const draft = queue[iid];
  if (!draft) {
    throw new Error(`No draft queued for issue #${iid}`);
  }
  const updated: IssueDraft = {
    ...draft,
    clientReply: newReply,
    updatedAt: new Date().toISOString(),
  };
  return { ...queue, [iid]: updated };
}
