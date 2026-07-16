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

import type { IssueDedupMatch } from 'ghagga-core';
import type { ReproEvidence } from './evidence.js';

export type DraftStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'POSTED';

/**
 * Kind of draft produced by triage. Mirrors the server worker's draftKind:
 * - `ANALYSIS`  — the normal full LLM triage result.
 * - `DUPLICATE` — a memory-dedup hit short-circuited BEFORE the analysis LLM
 *   call (token-cost saving); `dedupMatches` carries the cited prior issues.
 *
 * Optional for backward compatibility: drafts persisted before dedup landed
 * (and object literals in tests) carry no `kind` — treat an absent kind as
 * `ANALYSIS`.
 */
export type IssueDraftKind = 'ANALYSIS' | 'DUPLICATE';

export interface IssueDraft {
  id: string;
  issueIid: string | number;
  repo: string;
  status: DraftStatus;
  /** Draft kind (absent ⇒ ANALYSIS, for pre-dedup drafts). */
  kind?: IssueDraftKind;
  /** Internal technical analysis. Never postable — see PostableReply brand. */
  report: string;
  /** Draft client-facing reply. Postable only via approveDraft(). */
  clientReply: string;
  reproductionEvidence?: ReproEvidence | null;
  /**
   * Prior issues cited by a DUPLICATE-kind draft (dedup matches). Surfaced by
   * `show`/`serve` so a human can adjudicate. Absent on ANALYSIS drafts.
   */
  dedupMatches?: IssueDedupMatch[];
  createdAt: string;
  updatedAt: string;
}
