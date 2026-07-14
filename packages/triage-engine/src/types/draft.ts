/**
 * IssueDraft — the queue record type produced by the TRIAGE stage and
 * consumed by the human-approval → post lifecycle (queue implementation
 * lands in a later PR; this is the shared type shape).
 *
 * `report` is the internal technical analysis — it MUST NEVER be posted.
 * `clientReply` is the draft client-facing text — it becomes postable ONLY
 * through `approveDraft` (see ./postable.ts), which requires
 * `status === 'PENDING_APPROVAL'`.
 */

import type { ReproEvidence } from './evidence.js';

export type DraftStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'POSTED';

export interface IssueDraft {
  id: string;
  issueIid: string | number;
  repo: string;
  status: DraftStatus;
  /** Internal technical analysis. Never postable — see PostableReply brand. */
  report: string;
  /** Draft client-facing reply. Postable only via approveDraft(). */
  clientReply: string;
  reproductionEvidence?: ReproEvidence | null;
  createdAt: string;
  updatedAt: string;
}
