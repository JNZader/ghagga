/**
 * Engine facade — the single entry point CLI/web wiring calls into. Ties
 * together forge -> locate -> triage -> queue exactly as design.md's Data
 * Flow diagram describes:
 *
 *   forge.getIssue -> locate -> triage.run -> queue.save (PENDING_APPROVAL)
 *   human review (CLI/web) -> approveIssue -> forge.postComment (POSTED)
 *
 * SECURITY: `triageIssue`/`triageNew` NEVER call `forge.postComment`.
 * `approveIssue` is the ONLY function in this module that posts — it
 * delegates to `queue/approval.ts`'s `approveAndPost`, which itself is the
 * only caller of `ForgeAdapter.postComment` (see design.md module
 * boundaries: "serve+CLI call queue; NEVER call forge.post directly").
 */

import type { GenerateTextFn } from 'ghagga-core';
import type { TriageConfig } from './config/schema.js';
import { createForgeAdapter } from './forge/index.js';
import type { ForgeAdapter, ForgeIssueFilter } from './forge/port.js';
import { locate } from './locate/index.js';
import { type ApprovalResult, approveAndPost, rejectDraft } from './queue/approval.js';
import { buildDraft, editDraftReply, getDraft, upsertDraft } from './queue/draft.js';
import { defaultQueuePath, loadQueue, type Queue, saveQueue } from './queue/store.js';
import { runTriage } from './triage/run.js';
import type { IssueDraft } from './types/draft.js';
import type { ReproEvidence } from './types/evidence.js';

export interface EngineOptions {
  config: TriageConfig;
  /** Defaults to `createForgeAdapter(config)` when not provided. */
  forge?: ForgeAdapter;
  /** generateFn used ONLY for LOCATE's stage-1.5 candidate rerank. */
  rerankGenerateFn: GenerateTextFn;
  /** generateFn used for the TRIAGE stage-3 technical analysis call. */
  analysisGenerateFn: GenerateTextFn;
  /** generateFn used for the TRIAGE stage-4 client-reply call. Defaults to analysisGenerateFn. */
  clientReplyGenerateFn?: GenerateTextFn;
  /** Defaults to `defaultQueuePath(config.repo)` when not provided. */
  queuePath?: string;
}

function resolveForge(options: Pick<EngineOptions, 'config' | 'forge'>): ForgeAdapter {
  return options.forge ?? createForgeAdapter(options.config);
}

function resolveQueuePath(options: Pick<EngineOptions, 'config' | 'queuePath'>): string {
  return options.queuePath ?? defaultQueuePath(options.config.repo);
}

/**
 * Triages one issue end-to-end: fetch -> LOCATE -> TRIAGE -> persist a
 * PENDING_APPROVAL draft. Overwrites any previous draft for the same issue.
 */
export async function triageIssue(
  options: EngineOptions,
  iid: string,
  reproEvidence?: ReproEvidence | null,
): Promise<IssueDraft> {
  const forge = resolveForge(options);
  const queuePath = resolveQueuePath(options);

  const issue = await forge.getIssue(iid);
  const locateResult = await locate(
    { title: issue.title, body: issue.description, labels: issue.labels },
    options.config,
    options.rerankGenerateFn,
  );

  const triageResult = await runTriage({
    issue: {
      iid: issue.iid,
      title: issue.title,
      body: issue.description,
      labels: issue.labels,
      comments: issue.comments.map((comment) => ({
        author: comment.author ?? 'unknown',
        body: comment.body,
      })),
    },
    config: options.config,
    contextFiles: locateResult.contextFiles,
    files: locateResult.files,
    keywords: locateResult.keywords,
    reproEvidence,
    analysisGenerateFn: options.analysisGenerateFn,
    clientReplyGenerateFn: options.clientReplyGenerateFn,
  });

  const draft = buildDraft({
    iid: issue.iid,
    repo: options.config.repo,
    report: triageResult.technicalAnalysis,
    clientReply: triageResult.clientReply,
    reproductionEvidence: reproEvidence,
  });

  const queue = upsertDraft(loadQueue(queuePath), draft);
  saveQueue(queuePath, queue);
  return draft;
}

/**
 * Triages every issue returned by `forge.listIssues(filter)` that is not
 * already queued as PENDING_APPROVAL/APPROVED/POSTED — a REJECTED (or
 * absent) prior draft is re-triaged, matching the PoC's `--new` behavior.
 */
export async function triageNew(
  options: EngineOptions,
  filter?: ForgeIssueFilter,
): Promise<IssueDraft[]> {
  const forge = resolveForge(options);
  const queuePath = resolveQueuePath(options);

  const issues = await forge.listIssues(filter);
  const queue = loadQueue(queuePath);
  const pending = issues.filter((issue) => {
    const existing = queue[issue.iid];
    return !existing || existing.status === 'REJECTED';
  });

  const drafts: IssueDraft[] = [];
  for (const issue of pending) {
    // Sequential by design — matches the PoC's sequential --new loop and
    // keeps queue.json writes race-free (no concurrent saveQueue calls).
    drafts.push(await triageIssue(options, issue.iid));
  }
  return drafts;
}

export function listQueue(options: Pick<EngineOptions, 'config' | 'queuePath'>): Queue {
  return loadQueue(resolveQueuePath(options));
}

export function showDraft(
  options: Pick<EngineOptions, 'config' | 'queuePath'>,
  iid: string,
): IssueDraft {
  const draft = getDraft(listQueue(options), iid);
  if (!draft) {
    throw new Error(`No draft queued for issue #${iid}`);
  }
  return draft;
}

export function editDraft(
  options: Pick<EngineOptions, 'config' | 'queuePath'>,
  iid: string,
  newReply: string,
): IssueDraft {
  const queuePath = resolveQueuePath(options);
  const queue = editDraftReply(loadQueue(queuePath), iid, newReply);
  saveQueue(queuePath, queue);
  const draft = getDraft(queue, iid);
  if (!draft) {
    throw new Error(`No draft queued for issue #${iid}`);
  }
  return draft;
}

/**
 * Approves the queued draft for `iid` and posts the (optionally edited)
 * client reply. THE ONLY function in the engine facade that posts to the
 * forge — see module doc above.
 */
export async function approveIssue(
  options: Pick<EngineOptions, 'config' | 'forge' | 'queuePath'>,
  iid: string,
  editedReply?: string,
): Promise<ApprovalResult> {
  const forge = resolveForge(options);
  const queuePath = resolveQueuePath(options);
  const queue = loadQueue(queuePath);

  const result = await approveAndPost(queue, iid, forge, editedReply);
  saveQueue(queuePath, result.queue);
  return result;
}

/** Rejects the queued draft for `iid`. Never posts. */
export function rejectIssue(
  options: Pick<EngineOptions, 'config' | 'queuePath'>,
  iid: string,
): IssueDraft {
  const queuePath = resolveQueuePath(options);
  const queue = loadQueue(queuePath);
  const result = rejectDraft(queue, iid);
  saveQueue(queuePath, result.queue);
  return result.draft;
}
