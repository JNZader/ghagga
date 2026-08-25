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
 *   0. precheck — getOpenIssueDraft: if an open DRAFT already exists for
 *                 (repo,issue), SKIP early (no dedup, no LLM, no memory save) and
 *                 return `{ success: true, skipped: 'draft-pending' }`. This makes
 *                 a BullMQ retry idempotent (no LLM re-charge) and stops a
 *                 re-triage from doing expensive work only to discard it at the
 *                 onConflictDoNothing insert.
 *   1. dedup    — findIssueDuplicates over memory (Phase 3). A hit short-circuits
 *                 to a DUPLICATE draft (cheap: no LLM call).
 *   2. analyze  — runIssueTriage (Phase 2) with a memoryContext built from the
 *                 dedup matches and an injected, RESOLVED generateFn (the SAME
 *                 backend-resolution + SSRF/legacy hardening the review pipeline
 *                 uses — never hardwired).
 *   3. gate     — confidence threshold: below it (or unparseable → 0), the draft
 *                 is HELD as NEEDS_INFO (routes to a human), never auto-concluded.
 *   4. persist  — insert the DRAFT (status=DRAFT). One open DRAFT per (repo,issue)
 *                 is enforced in the DB; a conflict is skipped gracefully.
 *   5. memory   — save THIS issue under ISSUE_TRIAGE_OBSERVATION_TYPE so future
 *                 dedup can find it (dedup filters by that exact type). Runs ONLY
 *                 AFTER the draft persisted successfully (no phantom observation
 *                 on persist-failure, and no retry-self-poison where attempt 2
 *                 finds attempt 1's observation and short-circuits as duplicate).
 *                 NOTE: the DUPLICATE path saves NOTHING — the issue IS a dup of an
 *                 already-stored observation, so the citation points at the
 *                 ORIGINAL; creating a second observation would pollute dedup.
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
import type { Database, DbProviderChainEntry, IssueDedupMatch, IssueDraftKind } from 'ghagga-db';
import {
  createDatabaseFromEnv,
  decrypt,
  getEffectiveRepoSettings,
  getOpenIssueDraft,
  getRepositoryById,
  saveIssueDraft,
} from 'ghagga-db';
import { logger as rootLogger } from '../lib/logger.js';
import { createRedisClient } from '../lib/redis.js';
import { PostgresMemoryStorage } from '../memory/postgres.js';
// SECURITY: reuse the review worker's provider hardening verbatim — do NOT
// reimplement. `revalidateGatewayChain` is the DNS-rebinding TOCTOU SSRF
// re-validation (review.ts:66); `normalizeLegacyProvider` remaps stale/legacy
// provider strings to the 3-variant v3 set (review.ts:277). Importing them keeps
// triage and review on a single source of truth for outbound-URL trust.
import { collectIssueCodeEvidence } from './issue-code-evidence.js';
import { normalizeLegacyProvider, revalidateGatewayChain } from './review.js';

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

// SEC-004 / PRODOPS-003: build the BullMQ connection from the SAME source as the
// review worker (queues/review.ts) and the shared singleton — REDIS_URL first
// (auth + TLS), else host/port with optional username/password/TLS. Previously
// this hand-rolled host/port only, so managed Redis with ACL/TLS in REDIS_URL was
// silently ignored. `createRedisClient` already sets maxRetriesPerRequest: null
// and enableReadyCheck: false (BullMQ requirements).
const redisConnection = createRedisClient();

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
   *
   * CARRY-FORWARD (Phase 5 — webhook fetch/enqueue): the worker's MAX_ISSUE_COMMENTS
   * cap is DEFENSIVE and runs only AFTER the payload already landed in Redis.
   * The Phase-5 fetcher MUST cap BOTH the comment COUNT and the total payload
   * SIZE before enqueue — a huge comment body smuggled into job.data is an
   * unbounded Redis job payload (DoS) that the worker-side cap cannot prevent.
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
interface TriageEncryptedCredentials {
  providerChain: DbProviderChainEntry[] | undefined;
  /** Legacy single encrypted key (repositories.encrypted_api_key). */
  encryptedApiKey: string | null;
  /** Legacy provider id (repositories.llm_provider) — drives the v3 normalize. */
  legacyProvider: string | null;
  /** Legacy model id (repositories.llm_model). */
  legacyModel: string | null;
}

async function resolveEncryptedCredentials(
  repositoryId: number,
  db: Database | undefined,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<TriageEncryptedCredentials> {
  const empty: TriageEncryptedCredentials = {
    providerChain: undefined,
    encryptedApiKey: null,
    legacyProvider: null,
    legacyModel: null,
  };
  if (!db) {
    log.warn({ repositoryId }, 'No DB handle — AI triage disabled for this job');
    return empty;
  }
  try {
    const repo = await getRepositoryById(db, repositoryId);
    if (!repo) {
      log.warn({ repositoryId }, 'Repository not found — AI triage disabled for this job');
      return empty;
    }
    const effective = await getEffectiveRepoSettings(db, repo);
    const chain = effective.providerChain;
    return {
      providerChain: chain.length > 0 ? chain : undefined,
      encryptedApiKey: repo.encryptedApiKey ?? null,
      legacyProvider: repo.llmProvider ?? null,
      legacyModel: repo.llmModel ?? null,
    };
  } catch (error) {
    log.warn({ repositoryId, error: String(error) }, 'Failed to fetch credentials — AI disabled');
    return empty;
  }
}

/**
 * Build a single-entry runtime chain from the legacy single-key credentials,
 * matching review.ts's legacy fallback (review.ts:649-688): repos that pre-date
 * the v3 provider chain store `llmProvider`/`llmModel` + a single
 * `encryptedApiKey`. Without this, such a repo (which still works for PR review)
 * would degrade triage to NEEDS_INFO. The provider string is normalised and the
 * key is decrypt-guarded (a corrupt key yields no usable entry, never crashes).
 *
 * Returns an empty array when there is no usable legacy key (the worker then
 * degrades to NEEDS_INFO, never posts).
 */
function buildLegacyRuntimeChain(
  creds: Pick<TriageEncryptedCredentials, 'encryptedApiKey' | 'legacyProvider' | 'legacyModel'>,
  log: { warn: (obj: unknown, msg?: string) => void },
): {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  gatewayUrl?: string;
  cliModel?: string;
}[] {
  if (!creds.encryptedApiKey) return [];
  let apiKey: string;
  try {
    apiKey = decrypt(creds.encryptedApiKey);
  } catch {
    log.warn(
      { provider: creds.legacyProvider },
      'legacy credential decryption failed — treating legacy key as absent',
    );
    return [];
  }
  return [
    {
      provider: normalizeLegacyProvider(creds.legacyProvider) as LLMProvider,
      model: creds.legacyModel ?? '',
      apiKey,
    },
  ];
}

/**
 * Build a runtime provider chain (decrypted keys) from the DB chain. Mirrors the
 * review pipeline's mapping loop (review.ts:608-647): a corrupt entry is skipped
 * (never crashes the job), and every provider string is run through
 * `normalizeLegacyProvider` so a legacy/stale value ('anthropic', 'openai', …)
 * is remapped to the v3 3-variant set BEFORE the pipeline resolvers see it —
 * instead of being unsafely cast to LLMProvider.
 *
 * SSRF: the caller MUST hand a chain that already passed `revalidateGatewayChain`
 * (DNS-rebinding TOCTOU re-validation). `gatewayUrl` is copied through verbatim
 * here, so an unvalidated URL reaching this function would smuggle past the SSRF
 * guard. See `processIssueAnalysis` — it revalidates the DB chain first.
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
      // Normalise legacy/stale provider strings (review.ts parity) — never an
      // unchecked cast.
      provider: normalizeLegacyProvider(entry.provider) as LLMProvider,
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

// ─── Observation content ────────────────────────────────────────

/** Per-comment body cap when folding comments into the saved observation. */
const OBSERVATION_COMMENT_BODY_CAP = 500;

/**
 * Build the saved observation's content for future dedup.
 *
 * `findIssueDuplicates` builds its keyword query from the stored title + content,
 * so the discriminating keywords MUST live in this string. The issue body +
 * classification alone omit LABELS and COMMENTS — both already fetched/analysed —
 * which means a later issue whose distinguishing terms live only in a comment or
 * a label would NOT be matched. Folding capped comments + labels in closes that
 * gap. Comments are already count-capped (MAX_ISSUE_COMMENTS) by the caller; each
 * body is length-capped here as a second-line defense against context blowup.
 */
function buildObservationContent(
  issueBody: string,
  classification: IssueTriageResult['classification'],
  labels: string[],
  comments: IssueComment[],
): string {
  const parts = [issueBody, `\nClassification: ${classification}`];
  if (labels.length > 0) {
    parts.push(`\nLabels: ${labels.join(', ')}`);
  }
  if (comments.length > 0) {
    const rendered = comments
      .map((c) => `- ${c.author}: ${c.body.slice(0, OBSERVATION_COMMENT_BODY_CAP)}`)
      .join('\n');
    parts.push(`\nComments:\n${rendered}`);
  }
  return parts.join('\n');
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

interface IssueAnalysisResult {
  success: boolean;
  reviewId: string;
  draftKind?: IssueDraftKind;
  persisted?: boolean;
  /** Set ONLY when stage 0 short-circuits on an already-open DRAFT. */
  skipped?: 'draft-pending';
}

async function processIssueAnalysis(job: Job<IssueAnalysisJobData>): Promise<IssueAnalysisResult> {
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

  // ── Stage 0: existing-open-draft pre-check (BEFORE any expensive work) ──
  // If an open DRAFT already exists for (repo,issue), skip dedup + LLM + memory
  // entirely. This makes a BullMQ retry idempotent (no LLM re-charge) and avoids
  // doing the expensive work only to silently discard it at the
  // onConflictDoNothing insert. A re-run from the dashboard (Phase 6) must delete
  // the prior draft first; until then we surface WHY we skipped.
  if (db) {
    try {
      const existing = await getOpenIssueDraft(db, repositoryId, issueNumber);
      if (existing) {
        log.info(
          { draftId: existing.id, draftKind: existing.draftKind },
          'Open DRAFT already exists for this issue — skipping triage (no dedup/LLM/memory)',
        );
        await job.updateProgress(100);
        return { success: true, reviewId, skipped: 'draft-pending' };
      }
    } catch (error) {
      // A read failure here must NOT block triage — fall through and let the
      // onConflictDoNothing insert remain the final guard against a duplicate.
      log.warn(
        { error: String(error) },
        'Open-draft pre-check failed — continuing (insert conflict remains the guard)',
      );
    }
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

  // The memory observation to write IFF the draft persists successfully. Built in
  // the analyze branch only (the DUPLICATE path saves NOTHING — see below).
  // Deferring it past a successful persist fixes BOTH the phantom observation on
  // persist-failure AND the retry-self-poison (attempt 2 finding attempt 1's
  // observation and short-circuiting as a duplicate).
  let pendingObservation:
    | { project: string; type: string; title: string; content: string }
    | undefined;

  if (dedup.isDuplicate) {
    // Cheap path: a confident dedup hit short-circuits before the LLM call.
    // It saves NO observation: this issue IS a duplicate of one ALREADY stored,
    // so the citation points at the ORIGINAL; creating a second observation would
    // pollute dedup with a near-identical row.
    draftKind = 'DUPLICATE';
    const links = dedup.matches
      .map((m) => `- ${m.title} (observation #${m.observationId}, overlap ${m.score.toFixed(2)})`)
      .join('\n');
    body = `## Possible duplicate\n\nThis issue looks similar to prior tracked issue(s):\n\n${links}\n\nA maintainer should confirm before closing as a duplicate.`;
    log.info({ matches: dedup.matches.length }, 'Dedup hit — DUPLICATE draft (no LLM call)');
  } else {
    // ── Stage 2: analyze ──────────────────────────────────────
    await job.updateProgress(45);
    const creds = await resolveEncryptedCredentials(repositoryId, db, log);

    // SECURITY: SSRF re-validation at EXECUTION time (DNS-rebinding TOCTOU). Run
    // the SAME `revalidateGatewayChain` the review worker uses (review.ts:592)
    // BEFORE building the runtime chain, so a stored gatewayUrl that now resolves
    // to a private/loopback/metadata address is DROPPED before reaching the
    // pipeline. Without this, a tampered/rebound URL would be copied through
    // buildRuntimeChain verbatim.
    const rawDbChain = (creds.providerChain ?? []) as DbProviderChainEntry[];
    const safeDbChain = await revalidateGatewayChain(rawDbChain, log);
    if (rawDbChain.length > 0 && safeDbChain.length === 0) {
      log.warn(
        { entriesIn: rawDbChain.length },
        'All provider chain entries dropped by SSRF re-validation — AI triage may degrade to NEEDS_INFO',
      );
    }

    let runtimeChain = buildRuntimeChain(safeDbChain, log);
    // Legacy fallback (review.ts:649-688 parity): repos that work for PR review
    // via legacy llmProvider/llmModel + a single encryptedApiKey must triage too,
    // not silently degrade to NEEDS_INFO.
    if (runtimeChain.length === 0) {
      runtimeChain = buildLegacyRuntimeChain(creds, log);
      if (runtimeChain.length > 0) {
        log.info({ provider: runtimeChain[0]?.provider }, 'Using legacy single-key credentials');
      }
    }

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

      // Code-in-evidence (best-effort): fetch the source the issue references so
      // triage can weigh the claim against real code. Any failure degrades to
      // text-only — it NEVER blocks triage. The fetched (attacker-influenceable)
      // bytes fold into memoryContext, which runIssueTriage fences as untrusted
      // DATA via buildMemoryContext.
      let codeContext = '';
      try {
        const issueText = [data.issueTitle, data.issueBody, ...comments.map((c) => c.body)].join(
          '\n',
        );
        codeContext = await collectIssueCodeEvidence({
          installationId,
          repoFullName,
          issueText,
          log,
        });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'code-evidence collection threw; triaging text-only',
        );
      }
      const combinedContext = [memoryContext, codeContext].filter(Boolean).join('\n\n') || null;

      const result = await runIssueTriage({
        issueTitle: data.issueTitle,
        issueBody: data.issueBody,
        labels: data.labels,
        comments,
        memoryContext: combinedContext,
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

      // Stage the observation to be written AFTER a successful persist. Include
      // the (capped) comments + labels so future dedup — whose query is built
      // from title/body keywords — can also match issues whose discriminating
      // keywords live in COMMENTS or LABELS, not just the body.
      pendingObservation = {
        project: repoFullName,
        type: ISSUE_TRIAGE_OBSERVATION_TYPE,
        title: `Issue #${issueNumber}: ${data.issueTitle}`,
        content: buildObservationContent(
          data.issueBody,
          result.classification,
          data.labels,
          comments,
        ),
      };
    }
  }

  // ── Stage 4: persist the DRAFT (NEVER post) ──────────────────
  // SECURITY/CORRECTNESS: this persist+memory block is wrapped so the worker
  // DEGRADES, never crashes — and so NO partial state (memory saved without a
  // draft) can result. The memory save runs ONLY after a successful insert.
  //
  // Behavior on a transient DB error from saveIssueDraft: we RE-THROW so BullMQ
  // retries. The Stage-0 pre-check makes that retry idempotent (a draft that DID
  // land on a prior attempt short-circuits next time), and the
  // onConflictDoNothing insert is the final guard. Re-throwing here never
  // violates the "never posts" contract — this worker has no posting path at all.
  await job.updateProgress(80);
  let persisted = false;
  if (db) {
    // Strip dedup matches to the DB-declared shape { observationId, title, score }
    // BEFORE persisting. core's IssueDedupMatch carries an optional
    // `relevanceScore` (observability only) that the jsonb column type omits —
    // dropping it keeps the stored blob faithful to the declared type.
    const dedupMatches: IssueDedupMatch[] = dedup.matches.map((m) => ({
      observationId: m.observationId,
      title: m.title,
      score: m.score,
    }));

    const inserted = await saveIssueDraft(db, {
      repositoryId,
      issueNumber,
      issueTitle: data.issueTitle.slice(0, 500),
      status: 'DRAFT',
      draftKind,
      body,
      sources,
      dedupMatches,
      tokensUsed,
    });
    if (inserted) {
      persisted = true;
      log.info({ draftId: inserted.id, draftKind }, 'Issue draft persisted (DRAFT, not posted)');

      // ── Stage 5: save THIS issue to memory — ONLY after a successful persist ──
      // CRITICAL: must use ISSUE_TRIAGE_OBSERVATION_TYPE or dedup (which filters
      // by that exact type) will never find it. Best-effort: a memory-save
      // failure must not fail the job or block the (already-persisted) draft.
      // Gating on `persisted === true` prevents the phantom observation on a
      // persist-failure and the retry-self-poison described above.
      if (memoryStorage && pendingObservation) {
        try {
          await memoryStorage.saveObservation(pendingObservation);
        } catch (error) {
          log.warn({ error: String(error) }, 'Failed to persist issue observation for dedup');
        }
      }
    } else {
      // onConflictDoNothing → an open DRAFT already exists for this (repo,issue)
      // (raced past the Stage-0 pre-check). Skip gracefully and do NOT save the
      // observation — there is no new draft to back it.
      log.info('Open DRAFT already exists for this issue — skipping insert (no memory save)');
    }
  } else {
    log.warn('No DB handle — draft could not be persisted (no memory save)');
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
