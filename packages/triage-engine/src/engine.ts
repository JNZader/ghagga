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

import type { GenerateTextFn, IssueDedupResult, MemoryStorage } from 'ghagga-core';
import { findIssueDuplicates, ISSUE_TRIAGE_OBSERVATION_TYPE } from 'ghagga-core';
import type { TriageConfig } from './config/schema.js';
import {
  buildDedupMemoryContext,
  buildDuplicateReply,
  buildDuplicateReport,
  buildObservationContent,
  excludeSelfMatch,
  issueObservationTitle,
} from './dedup/index.js';
import { createForgeAdapter } from './forge/index.js';
import type { ForgeAdapter, ForgeIssue, ForgeIssueFilter } from './forge/port.js';
import { locate } from './locate/index.js';
import { type ApprovalResult, approveAndPost, rejectDraft } from './queue/approval.js';
import { buildDraft, editDraftReply, getDraft, upsertDraft } from './queue/draft.js';
import { defaultQueuePath, loadQueue, type Queue, repoSlug, saveQueue } from './queue/store.js';
import { type ReproduceOptions, reproduce } from './reproduce/index.js';
import { deduceRouteFromLabels, extractRouteFromIssueBody } from './reproduce/route.js';
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
  /**
   * Optional memory store enabling issue DEDUP (`findIssueDuplicates`) + the
   * post-triage observation persistence that future dedup matches against. When
   * absent, dedup is skipped ENTIRELY (the pre-dedup behavior is preserved
   * exactly). `config.dedup.enabled === false` also disables it even when a
   * store is present. Scoped per-repo via `repoSlug(config.repo)`. The CLI
   * wires a `SqliteMemoryStorage` here for `ghagga triage`.
   */
  memory?: MemoryStorage;
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
  issue: Pick<ForgeIssue, 'title' | 'description' | 'rawDescription' | 'labels'>,
): Promise<ReproEvidence | null> {
  if (!options.config.app || !options.reproduceGenerateFn) {
    return null;
  }

  // Route resolution — two sources, body wins:
  //  1. The `Ruta:` line in the RAW (un-stripped) body: forge adapters strip the
  //     `---`-delimited widget trailer from `description`, where the `Ruta:` line
  //     lives; `rawDescription` retains it (falls back to `description`).
  //  2. FALLBACK for issues WITHOUT a `Ruta:` line (e.g. created from meeting
  //     notes, not the widget): deduce the route from the `módulo::X` label via
  //     the default `/app/<module>` heuristic + `config.moduleRoutes` overrides.
  // Skip reproduce only when BOTH yield null.
  const route =
    extractRouteFromIssueBody(issue.rawDescription ?? issue.description) ??
    deduceRouteFromLabels(issue.labels, options.config.moduleRoutes);
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

  // Snapshot the prior draft (idempotency guard, mirrors the server's Stage-0
  // open-draft short-circuit): a NON-REJECTED prior draft means this issue was
  // already triaged and its observation already stored — so we do NOT re-store
  // it below (avoids polluting dedup with a near-identical second row).
  const prior = getDraft(loadQueue(queuePath), String(issue.iid));
  const alreadyTriaged = prior !== undefined && prior.status !== 'REJECTED';

  const evidence =
    reproEvidence !== undefined ? reproEvidence : await autoReproduce(options, issue);

  // ── DEDUP stage — BEFORE the expensive LOCATE + LLM analysis ──────────
  // Runs only when a memory store is wired AND config.dedup is not disabled.
  const dedupEnabled = options.config.dedup?.enabled ?? true;
  const project = repoSlug(options.config.repo);
  let dedup: IssueDedupResult | null = null;
  if (options.memory && dedupEnabled) {
    // findIssueDuplicates degrades gracefully (never throws). Drop the issue's
    // OWN prior observation so a re-triage never flags itself as a duplicate.
    const raw = await findIssueDuplicates(options.memory, project, issue.title, issue.description);
    dedup = excludeSelfMatch(raw, issueObservationTitle(issue.iid, project));

    if (dedup.isDuplicate) {
      // Cheap path: a confident dedup hit short-circuits BEFORE any LLM call —
      // no LOCATE, no analysis, no client-reply generation, no re-persist (the
      // issue IS a duplicate of an already-stored observation).
      const duplicateDraft = buildDraft({
        iid: issue.iid,
        repo: options.config.repo,
        kind: 'DUPLICATE',
        report: buildDuplicateReport(dedup.matches),
        clientReply: buildDuplicateReply(
          dedup.matches,
          options.config.clientReplyPolicy?.language ?? 'es',
        ),
        reproductionEvidence: evidence,
        dedupMatches: dedup.matches,
      });
      saveQueue(queuePath, upsertDraft(loadQueue(queuePath), duplicateDraft));
      return duplicateDraft;
    }
  }

  const locateResult = await locate(
    { title: issue.title, body: issue.description, labels: issue.labels },
    options.config,
    options.rerankGenerateFn,
  );

  const comments = issue.comments.map((comment) => ({
    author: comment.author ?? 'unknown',
    body: comment.body,
  }));

  const triageResult = await runTriage({
    issue: {
      iid: issue.iid,
      title: issue.title,
      body: issue.description,
      labels: issue.labels,
      comments,
    },
    config: options.config,
    contextFiles: locateResult.contextFiles,
    files: locateResult.files,
    keywords: locateResult.keywords,
    reproEvidence: evidence,
    // Weak (non-blocking) dedup matches become situational context for the
    // analysis agent — mirrors the server's buildMemoryContextFromDedup.
    memoryContext: dedup ? buildDedupMemoryContext(dedup.matches) : null,
    analysisGenerateFn: options.analysisGenerateFn,
    clientReplyGenerateFn: options.clientReplyGenerateFn,
  });

  const draft = buildDraft({
    iid: issue.iid,
    repo: options.config.repo,
    kind: 'ANALYSIS',
    report: triageResult.technicalAnalysis,
    clientReply: triageResult.clientReply,
    reproductionEvidence: evidence,
  });

  saveQueue(queuePath, upsertDraft(loadQueue(queuePath), draft));

  // ── Persist THIS issue to memory for future dedup ─────────────────────
  // Only after a successful NON-duplicate triage, only when a store is wired,
  // and only for a FRESH (or previously REJECTED) issue — re-triaging an
  // already-queued issue must not double-store its observation. Best-effort:
  // a memory failure never fails the (already-persisted) draft.
  if (options.memory && dedupEnabled && !alreadyTriaged) {
    try {
      await options.memory.saveObservation({
        project,
        type: ISSUE_TRIAGE_OBSERVATION_TYPE,
        title: issueObservationTitle(issue.iid, project),
        content: buildObservationContent({
          issueTitle: issue.title,
          issueBody: issue.description,
          classification: triageResult.classification,
          labels: issue.labels,
          comments,
        }),
      });
    } catch (error) {
      console.warn(
        `[ghagga-triage-engine] failed to persist issue observation for dedup: ${
          (error as Error).message
        }`,
      );
    }
  }

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
