/**
 * Issue-Analysis Queue — BullMQ queue + worker for the issue-triage agent.
 *
 * SEPARATE from the PR `review` queue (apps/server/src/queues/review.ts). The
 * review worker (`processReview`) fetches a PR diff, runs the review pipeline,
 * and posts the comment IMMEDIATELY (review.ts:826). This worker is the
 * OPPOSITE: it runs issue triage and persists a DRAFT that a human approves
 * later in the dashboard. It NEVER posts a GitHub comment.
 *
 * Worker stages (per the issue-triage design):
 *   1. dedup    — findIssueDuplicates over memory (Phase 3). A hit short-circuits
 *                 to a DUPLICATE draft (cheap: no LLM call).
 *   2. analyze  — runIssueTriage (Phase 2) with a memoryContext built from the
 *                 dedup matches and an injected, RESOLVED generateFn (the SAME
 *                 backend-resolution the review pipeline uses — never hardwired).
 *   3. gate     — confidence threshold: below it (or unparseable → 0), the draft
 *                 is HELD as NEEDS_INFO (routes to a human), never auto-concluded.
 *   4. persist  — insert the DRAFT (status=DRAFT). One open DRAFT per (repo,issue)
 *                 is enforced in the DB; a conflict is skipped gracefully.
 *   5. memory   — save THIS issue under ISSUE_TRIAGE_OBSERVATION_TYPE so future
 *                 dedup can find it (dedup filters by that exact type).
 *
 * The webhook routing that ENQUEUES these jobs (and the GitHub fetch of issue
 * title/body/labels) lives in Phase 5 — this worker CONSUMES a payload that
 * already carries the issue data.
 */

import type { Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import type {
  GenerateTextFn,
  IssueComment,
  IssueDedupResult,
  IssueTriageResult,
  LLMProvider,
  MemoryStorage,
  ReviewInput,
} from 'ghagga-core';
import {
  findIssueDuplicates,
  formatMemoryContext,
  ISSUE_TRIAGE_OBSERVATION_TYPE,
  resolveGenerateTextFns,
  resolvePrimaryProvider,
  runIssueTriage,
} from 'ghagga-core';
import type { Database, DbProviderChainEntry, IssueDraftKind } from 'ghagga-db';
import {
  createDatabaseFromEnv,
  decrypt,
  getEffectiveRepoSettings,
  getRepositoryById,
  saveIssueDraft,
} from 'ghagga-db';
import Redis from 'ioredis';
import { logger as rootLogger } from '../lib/logger.js';
import { PostgresMemoryStorage } from '../memory/postgres.js';

const logger = rootLogger.child({ module: 'issue-analysis-queue' });

// ─── Tunables ───────────────────────────────────────────────────

/**
 * Minimum triage confidence to treat an analysis as a confident ANALYSIS draft.
 *
 * CONSERVATIVE default (tunable). Below this, the draft is HELD as NEEDS_INFO so
 * a human reviews it rather than the system silently concluding.
 *
 * FAIL-SAFE on unparseable output: the agent returns `confidence === 0` when it
 * could NOT parse a CONFIDENCE line (DEFAULT_CONFIDENCE in issue-triage.ts) — a
 * parse-miss, NOT a genuine "low" signal. Because 0 is below ANY positive
 * threshold, the same gate routes it to the held/human path. Nothing auto-posts
 * in v1 regardless (the dashboard does the human-approved post), so this gate
 * drives `draftKind`, not posting.
 */
export const ISSUE_TRIAGE_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Defensive cap on the number of issue comments the agent ingests.
 *
 * The job payload CARRIES the issue data (fetched at webhook time in Phase 5),
 * so this worker does not fetch. This cap is belt-and-suspenders against a
 * payload that smuggled a huge comment list (DoS via context blowup). The
 * authoritative count cap belongs on the Phase-5 FETCHER side (do not fetch an
 * unbounded comment page); this is a cheap second line of defense.
 */
export const MAX_ISSUE_COMMENTS = 20;

// ─── Redis Connection ───────────────────────────────────────────

const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ─── Types ──────────────────────────────────────────────────────

/**
 * Payload for an issue-triage job. The webhook (Phase 5) builds this from the
 * GitHub `issue_comment` event + the issue it targets, AFTER all server-side
 * gating (command match + author association). Issue title/body/labels are
 * carried so the worker does NOT re-fetch from GitHub.
 */
export interface IssueAnalysisJobData {
  /** Correlation id for end-to-end tracing (mirrors ReviewJobData.reviewId). */
  reviewId: string;
  /** GitHub installation id for token exchange. */
  installationId: number;
  /** Internal repository id in our database. */
  repositoryId: number;
  /** Repository full name (e.g. "owner/repo"). */
  repoFullName: string;
  /** Issue number the triage targets. */
  issueNumber: number;
  /** Issue title — untrusted, fenced by the agent. */
  issueTitle: string;
  /** Issue body — untrusted, fenced by the agent. */
  issueBody: string;
  /** Repo labels on the issue — trusted metadata. */
  labels: string[];
  /**
   * Issue comments (untrusted), if the Phase-5 fetcher attached them. Capped by
   * MAX_ISSUE_COMMENTS in the worker as a defensive measure.
   */
  comments?: IssueComment[];
  /** The triggering comment id (for correlation / future reaction feedback). */
  triggerCommentId?: number;
}

// ─── Queue Configuration ────────────────────────────────────────

export const issueAnalysisQueue = new Queue<IssueAnalysisJobData, unknown, string>(
  'issue-analysis',
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: redisConnection as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  },
);

// ─── Credential Resolution ──────────────────────────────────────

/**
 * Re-fetch the encrypted provider chain + legacy key for a triage job by
 * repository id. Mirrors review.ts `resolveEncryptedCredentials`: credentials
 * are NEVER carried in the Redis payload — the worker re-resolves them from the
 * DB at processing time. Degrades gracefully (empty chain) when the repo or DB
 * is gone, so the worker can still produce a NEEDS_INFO/duplicate draft.
 */
async function resolveEncryptedCredentials(
  repositoryId: number,
  db: Database | undefined,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<{ providerChain: DbProviderChainEntry[] | undefined; encryptedApiKey: string | null }> {
  if (!db) {
    log.warn({ repositoryId }, 'No DB handle — AI triage disabled for this job');
    return { providerChain: undefined, encryptedApiKey: null };
  }
  try {
    const repo = await getRepositoryById(db, repositoryId);
    if (!repo) {
      log.warn({ repositoryId }, 'Repository not found — AI triage disabled for this job');
      return { providerChain: undefined, encryptedApiKey: null };
    }
    const effective = await getEffectiveRepoSettings(db, repo);
    const chain = effective.providerChain;
    return {
      providerChain: chain.length > 0 ? chain : undefined,
      encryptedApiKey: repo.encryptedApiKey ?? null,
    };
  } catch (error) {
    log.warn({ repositoryId, error: String(error) }, 'Failed to fetch credentials — AI disabled');
    return { providerChain: undefined, encryptedApiKey: null };
  }
}

/**
 * Build a runtime provider chain (decrypted keys) from the DB chain. Mirrors the
 * decrypt-and-skip-on-corruption logic in review.ts: a corrupt entry is skipped,
 * never crashes the job.
 */
function buildRuntimeChain(
  dbChain: DbProviderChainEntry[] | undefined,
  log: { warn: (obj: unknown, msg?: string) => void },
): {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  gatewayUrl?: string;
  cliModel?: string;
}[] {
  if (!dbChain || dbChain.length === 0) return [];
  const mapped: {
    provider: LLMProvider;
    model: string;
    apiKey: string;
    gatewayUrl?: string;
    cliModel?: string;
  }[] = [];
  for (const entry of dbChain) {
    let apiKey = '';
    if (entry.encryptedApiKey) {
      try {
        apiKey = decrypt(entry.encryptedApiKey);
      } catch {
        log.warn({ provider: entry.provider }, 'credential decryption failed — skipping entry');
        continue;
      }
    }
    const runtime: {
      provider: LLMProvider;
      model: string;
      apiKey: string;
      gatewayUrl?: string;
      cliModel?: string;
    } = {
      provider: entry.provider as LLMProvider,
      model: entry.model,
      apiKey,
    };
    if (entry.gatewayUrl) runtime.gatewayUrl = entry.gatewayUrl;
    if (entry.cliModel) runtime.cliModel = entry.cliModel;
    mapped.push(runtime);
  }
  return mapped;
}

/**
 * Resolve a GenerateTextFn from a runtime provider chain, EXACTLY the way the
 * review pipeline's execute step does (pipeline/execute.ts:45-80):
 *   activeProvider → isCliBridge/isGateway/isOllama flags →
 *   resolveGenerateTextFns(input, ...)[0].
 *
 * Returns null when no provider is available (the worker then degrades to a
 * NEEDS_INFO draft instead of analysing — it never crashes and never posts).
 */
function resolveTriageGenerateFn(
  runtimeChain: {
    provider: LLMProvider;
    model: string;
    apiKey: string;
    gatewayUrl?: string;
    cliModel?: string;
  }[],
): { generateFn: GenerateTextFn; provider: LLMProvider; model: string; apiKey: string } | null {
  if (runtimeChain.length === 0) return null;

  // Shape a minimal ReviewInput so we can reuse the pipeline resolvers verbatim.
  const input = {
    providerChain: runtimeChain,
    aiReviewEnabled: true,
  } as unknown as ReviewInput;

  const activeProvider = runtimeChain[0]?.provider ?? 'gateway';
  const isCliBridge = activeProvider === 'cli-bridge';
  const isGateway = activeProvider === 'gateway';
  const isOllama = activeProvider === 'ollama';

  const primary = resolvePrimaryProvider(input);
  const generateFn = resolveGenerateTextFns(input, isCliBridge, isGateway, isOllama)[0];
  if (!generateFn) return null;

  return {
    generateFn,
    provider: primary.provider as LLMProvider,
    model: primary.model,
    apiKey: primary.apiKey,
  };
}

// ─── Memory context from dedup matches ──────────────────────────

/**
 * Build a memoryContext string from dedup matches so the agent can cite prior
 * issues as situational background. Uses the match titles (the slim dedup shape
 * carries title + score, not full content) — enough to surface "you've seen
 * this before" context without re-fetching. Empty matches → null (no context).
 */
function buildMemoryContextFromDedup(dedup: IssueDedupResult): string | null {
  if (dedup.matches.length === 0) return null;
  const observations = dedup.matches.map((m) => ({
    type: ISSUE_TRIAGE_OBSERVATION_TYPE,
    title: m.title,
    content: `Prior issue observation #${m.observationId} (overlap ${m.score.toFixed(2)}).`,
  }));
  return formatMemoryContext(observations) || null;
}

// ─── Draft assembly ─────────────────────────────────────────────

/**
 * Pick the draftKind from the triage result + confidence gate.
 *
 * - Below ISSUE_TRIAGE_CONFIDENCE_THRESHOLD (including the unparseable 0) →
 *   NEEDS_INFO: the draft is HELD for a human, never presented as a confident
 *   conclusion. This is the fail-safe for parse-misses.
 * - Otherwise → ANALYSIS.
 *
 * (The DUPLICATE kind is decided earlier, before the LLM call.)
 */
function resolveAnalysisDraftKind(result: IssueTriageResult): IssueDraftKind {
  if (result.confidence < ISSUE_TRIAGE_CONFIDENCE_THRESHOLD) return 'NEEDS_INFO';
  return 'ANALYSIS';
}

// ─── Job Processor ──────────────────────────────────────────────

async function processIssueAnalysis(
  job: Job<IssueAnalysisJobData>,
): Promise<{ success: boolean; reviewId: string; draftKind: IssueDraftKind; persisted: boolean }> {
  const data = job.data;
  const { reviewId, installationId, repositoryId, repoFullName, issueNumber } = data;
  const log = logger.child({ reviewId, repoFullName, issueNumber });

  log.info(`Starting issue triage for ${repoFullName}#${issueNumber}`);
  await job.updateProgress(10);

  // One DB handle for the whole job (credential re-fetch + memory). Degrade
  // gracefully when unavailable — the worker still produces a draft.
  let db: Database | undefined;
  try {
    db = createDatabaseFromEnv();
  } catch {
    log.warn('Database unavailable — AI triage + memory features disabled for this job');
  }

  const memoryStorage: MemoryStorage | undefined = db
    ? (new PostgresMemoryStorage(db, installationId) as unknown as MemoryStorage)
    : undefined;

  // ── Stage 1: dedup ──────────────────────────────────────────
  await job.updateProgress(25);
  let dedup: IssueDedupResult = { query: '', matches: [], isDuplicate: false };
  if (memoryStorage) {
    // findIssueDuplicates degrades gracefully (never throws).
    dedup = await findIssueDuplicates(memoryStorage, repoFullName, data.issueTitle, data.issueBody);
  }

  let draftKind: IssueDraftKind;
  let body: string;
  let tokensUsed = 0;
  let sources: IssueTriageResult['sources'] = [];

  if (dedup.isDuplicate) {
    // Cheap path: a confident dedup hit short-circuits before the LLM call.
    draftKind = 'DUPLICATE';
    const links = dedup.matches
      .map((m) => `- ${m.title} (observation #${m.observationId}, overlap ${m.score.toFixed(2)})`)
      .join('\n');
    body = `## Possible duplicate\n\nThis issue looks similar to prior tracked issue(s):\n\n${links}\n\nA maintainer should confirm before closing as a duplicate.`;
    log.info({ matches: dedup.matches.length }, 'Dedup hit — DUPLICATE draft (no LLM call)');
  } else {
    // ── Stage 2: analyze ──────────────────────────────────────
    await job.updateProgress(45);
    const { providerChain: dbChain } = await resolveEncryptedCredentials(repositoryId, db, log);
    const runtimeChain = buildRuntimeChain(dbChain, log);
    const resolved = resolveTriageGenerateFn(runtimeChain);

    if (!resolved) {
      // No usable LLM backend — hold for a human (NEEDS_INFO), never crash/post.
      draftKind = 'NEEDS_INFO';
      body =
        '## Triage pending\n\nNo LLM provider is configured for this repository, so automated triage could not run. A maintainer should review this issue manually.';
      log.warn('No LLM provider available — NEEDS_INFO draft (no analysis)');
    } else {
      const comments = (data.comments ?? []).slice(0, MAX_ISSUE_COMMENTS);
      const memoryContext = buildMemoryContextFromDedup(dedup);

      const result = await runIssueTriage({
        issueTitle: data.issueTitle,
        issueBody: data.issueBody,
        labels: data.labels,
        comments,
        memoryContext,
        provider: resolved.provider,
        model: resolved.model,
        apiKey: resolved.apiKey,
        generateFn: resolved.generateFn,
      });

      // ── Stage 3: confidence gate (fail-safe on 0/unparseable) ──
      draftKind = resolveAnalysisDraftKind(result);
      body = result.report;
      tokensUsed = result.tokensUsed;
      sources = result.sources;
      log.info(
        { classification: result.classification, confidence: result.confidence, draftKind },
        'Triage analysis complete',
      );

      // ── Stage 5: save THIS issue to memory for FUTURE dedup ────
      // CRITICAL: must use ISSUE_TRIAGE_OBSERVATION_TYPE or dedup (which filters
      // by that exact type) will never find it. Best-effort: a memory-save
      // failure must not fail the job or block the draft.
      if (memoryStorage) {
        try {
          await memoryStorage.saveObservation({
            project: repoFullName,
            type: ISSUE_TRIAGE_OBSERVATION_TYPE,
            title: `Issue #${issueNumber}: ${data.issueTitle}`,
            content: `${data.issueBody}\n\nClassification: ${result.classification}`,
          });
        } catch (error) {
          log.warn({ error: String(error) }, 'Failed to persist issue observation for dedup');
        }
      }
    }
  }

  // ── Stage 4: persist the DRAFT (NEVER post) ──────────────────
  await job.updateProgress(80);
  let persisted = false;
  if (db) {
    const inserted = await saveIssueDraft(db, {
      repositoryId,
      issueNumber,
      issueTitle: data.issueTitle.slice(0, 500),
      status: 'DRAFT',
      draftKind,
      body,
      sources,
      dedupMatches: dedup.matches,
      tokensUsed,
    });
    if (inserted) {
      persisted = true;
      log.info({ draftId: inserted.id, draftKind }, 'Issue draft persisted (DRAFT, not posted)');
    } else {
      // onConflictDoNothing → an open DRAFT already exists for this (repo,issue).
      // Skip gracefully rather than overwrite an in-flight human review.
      log.info('Open DRAFT already exists for this issue — skipping insert');
    }
  } else {
    log.warn('No DB handle — draft could not be persisted');
  }

  await job.updateProgress(100);
  // The worker NEVER posts a GitHub comment. Posting is a human-approved action
  // performed by the dashboard approval API (Phase 6).
  return { success: true, reviewId, draftKind, persisted };
}

// ─── Queue Functions ────────────────────────────────────────────

/** Enqueue an issue-triage job. */
export async function enqueueIssueAnalysis(
  data: IssueAnalysisJobData,
): Promise<Job<IssueAnalysisJobData, unknown, string>> {
  return issueAnalysisQueue.add('process-issue-analysis', data, {
    jobId: data.reviewId,
    priority: 1,
  });
}

/** Create the issue-analysis worker with the given concurrency. */
export function createIssueAnalysisWorker(
  concurrency = 3,
): Worker<IssueAnalysisJobData, unknown, string> {
  return new Worker<IssueAnalysisJobData, unknown, string>('issue-analysis', processIssueAnalysis, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: redisConnection as any,
    concurrency,
    lockDuration: 300_000, // 5 min — CLI-bridge triage can take ~100s
  });
}

export default issueAnalysisQueue;
