/**
 * Engine facade — the single entry point CLI/web wiring calls into. Ties
 * together forge -> locate -> reproduce (best-effort, auto-wired) -> triage
 * -> queue exactly as design.md's Data Flow diagram describes:
 *
 *   forge.getIssue -> locate -> [reproduce] -> triage.run -> queue.save (PENDING_APPROVAL)
 *   human review (CLI/web) -> approveIssue -> forge.postComment (POSTED)
 *
 * SECURITY: `triageIssue`/`triageNew` NEVER call `forge.postComment`.
 * `approveIssue` is the ONLY function in this module that posts — it
 * delegates to `queue/approval.ts`'s `approveAndPost`, which itself is the
 * only caller of `ForgeAdapter.postComment` (see design.md module
 * boundaries: "serve+CLI call queue; NEVER call forge.post directly").
 *
 * REPRODUCE is best-effort and auto-wired: when `config.app` is set, a
 * `reproduceGenerateFn` is provided, and a route can be extracted from the
 * issue body (see `reproduce/route.ts`), `triageIssue` drives the live app
 * via `reproduce()` before triage runs. A failed/skipped reproduction never
 * blocks triage — it just proceeds without evidence (see `autoReproduce`
 * below). An explicitly-passed `reproEvidence` argument (including an
 * explicit `null`) always overrides auto-reproduction.
 */

import type { GenerateTextFn } from 'ghagga-core';
import type { TriageConfig } from './config/schema.js';
import { createForgeAdapter } from './forge/index.js';
import type { ForgeAdapter, ForgeIssue, ForgeIssueFilter } from './forge/port.js';
import { locate } from './locate/index.js';
import { type ApprovalResult, approveAndPost, rejectDraft } from './queue/approval.js';
import { buildDraft, editDraftReply, getDraft, upsertDraft } from './queue/draft.js';
import { defaultQueuePath, loadQueue, type Queue, saveQueue } from './queue/store.js';
import { type ReproduceOptions, reproduce } from './reproduce/index.js';
import { extractRouteFromIssueBody } from './reproduce/route.js';
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
  /**
   * generateFn used for REPRODUCE's agentic action loop. Auto-reproduction
   * is skipped entirely when this is absent, even if `config.app` is set —
   * see module doc above.
   */
  reproduceGenerateFn?: GenerateTextFn;
  /** Extra REPRODUCE options (maxSteps/headless/viewport/credentials/...) merged over the extracted route. */
  reproduceOptions?: Partial<Omit<ReproduceOptions, 'route'>>;
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
 * Best-effort REPRODUCE stage: runs ONLY when `config.app` is set, a
 * `reproduceGenerateFn` was provided, AND a route can be extracted from the
 * issue body. Any failure (browser missing, login fails, app unreachable,
 * navigation timeout, ...) is caught and logged as a warning — reproduction
 * is a nice-to-have, never a gate on triage (design.md decision 5: absence
 * of a repro is signal, not an error).
 */
async function autoReproduce(
  options: EngineOptions,
  issue: Pick<ForgeIssue, 'title' | 'description'>,
): Promise<ReproEvidence | null> {
  if (!options.config.app || !options.reproduceGenerateFn) {
    return null;
  }

  const route = extractRouteFromIssueBody(issue.description);
  if (!route) {
    return null;
  }

  try {
    return await reproduce(
      { title: issue.title, body: issue.description },
      options.config,
      options.reproduceGenerateFn,
      { route, ...options.reproduceOptions },
    );
  } catch (error) {
    console.warn(
      `[ghagga-triage-engine] REPRODUCE failed — proceeding without reproduction evidence: ${
        (error as Error).message
      }`,
    );
    return null;
  }
}

/**
 * Triages one issue end-to-end: fetch -> LOCATE -> [REPRODUCE, best-effort]
 * -> TRIAGE -> persist a PENDING_APPROVAL draft. Overwrites any previous
 * draft for the same issue.
 *
 * `reproEvidence` (including an explicit `null`) always overrides
 * auto-reproduction — see module doc above.
 */
export async function triageIssue(
  options: EngineOptions,
  iid: string,
  reproEvidence?: ReproEvidence | null,
): Promise<IssueDraft> {
  const forge = resolveForge(options);
  const queuePath = resolveQueuePath(options);

  const issue = await forge.getIssue(iid);

  const evidence =
    reproEvidence !== undefined ? reproEvidence : await autoReproduce(options, issue);

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
    reproEvidence: evidence,
    analysisGenerateFn: options.analysisGenerateFn,
    clientReplyGenerateFn: options.clientReplyGenerateFn,
  });

  const draft = buildDraft({
    iid: issue.iid,
    repo: options.config.repo,
    report: triageResult.technicalAnalysis,
    clientReply: triageResult.clientReply,
    reproductionEvidence: evidence,
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
