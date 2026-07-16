/**
 * Review Queue - BullMQ implementation for review processing.
 *
 * BullMQ durable job queue for self-hosted deployment.
 * Processes code review jobs asynchronously with retry support.
 */

import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import type {
  GraphLoader,
  LLMProvider,
  ProviderChainEntry,
  ReviewInput,
  ReviewLevel,
  ReviewMode,
  StaticAnalysisResult,
} from 'ghagga-core';
import {
  createEmbeddingProvider,
  fetchGatewayModels,
  fetchGatewayProviders,
  formatReviewComment,
  PreloadedGraphLoader,
  REVIEW_COMMENT_MARKER,
  resolveEmbeddingConfig,
  reviewPipeline,
  validateProviderChain,
} from 'ghagga-core';
import type { Database, DbProviderChainEntry } from 'ghagga-db';
import {
  createDatabaseFromEnv,
  decrypt,
  eq,
  getEffectiveRepoSettings,
  getRepositoryById,
  repositories,
  saveReview,
} from 'ghagga-db';
import {
  GitHubAppCredentialProvider,
  githubCommentId,
  isForgeAuthError,
  REACTION_KIND,
  toCommitMessages,
  toFileList,
} from 'ghagga-forge';
// Namespace import (NOT named imports): getInstallationToken is read lazily at
// call time (token mint), so a partial test mock of '../github/client.js' that
// omits other exports doesn't trip vitest's named-import validation.
// NOTE: the forge-adapter wiring (GitHubClientPort) no longer lives here — it was
// extracted to the composition-root factory (makeGitHubAdapter), now the SOLE
// consumer of the client.ts forge-adapter fns.
import * as githubClient from '../github/client.js';
import { makeGitHubAdapter } from '../github/forge-adapter-factory.js';
import { deriveCallbackSecret, dispatchWorkflow, injectWorkflow } from '../github/runner.js';
import { logger as rootLogger } from '../lib/logger.js';
import { callbackResultKey, createRedisClient, redis } from '../lib/redis.js';
import { validateOutboundUrl } from '../lib/safe-url.js';
import { PostgresMemoryStorage } from '../memory/postgres.js';

const logger = rootLogger.child({ module: 'review-queue' });

// ─── Forge adapter wiring (forge-agnostic seam) ─────────────────
//
// The review worker no longer calls the GitHub HTTP client directly. It routes
// forge calls through GitHubForgeAdapter (packages/forge), built by the shared
// composition-root factory `makeGitHubAdapter` (../github/forge-adapter-factory),
// which injects the real apps/server client.ts functions as the GitHubClientPort.
// That factory is the SOLE consumer of the client.ts forge-adapter fns; this
// worker only asks it for a per-token adapter. The EXACT observable behavior
// pinned by review.baseline.test.ts is preserved (the factory keeps the same
// lazy-getter port wiring this module used to hold inline).

/** Canonical GHAGGA summary-comment marker (boundary-faithful: the adapter
 * currently matches the FIXED marker hard-coded in client.findExistingComment). */
const REVIEW_MARKER = { html: REVIEW_COMMENT_MARKER } as const;

// COMMENT-ID BOXING (R-COMMENTID): the boxing helper now lives in the
// side-effect-free `ghagga-forge` package (githubCommentId) so it is reusable by
// both this worker AND the P3 CLI without dragging Redis/BullMQ init into the
// helper's test. review.ts call-sites box every native numeric id BEFORE it
// crosses the adapter seam — the `kind` tag prevents a GitHub id from being
// cross-assigned as a GitLab note id (same numeric value, different forge, never
// collides).

// ─── SSRF re-validation (DNS-rebinding TOCTOU defense) ──────────
//
// gatewayUrl is validated at PERSIST time (PUT /api/settings and
// /api/installation-settings), but the worker fetches the stored hostname
// LATER — potentially hours after persist. An attacker who controls the
// gateway hostname's DNS can pass validation at persist time (resolving to a
// public IP) and then re-point the record at an internal/metadata address
// before the worker runs (classic DNS-rebinding TOCTOU).
//
// Re-validating here, immediately before the URL is handed to the pipeline,
// narrows the rebind window from hours to milliseconds. Entries whose URL now
// fails validation are DROPPED from the chain (logged generically, never
// echoing the URL). The policy lives in the server worker — the right trust
// boundary — because packages/core (gateway.ts) cannot import the server's
// safe-url module.
export async function revalidateGatewayChain<T extends { provider: string; gatewayUrl?: string }>(
  chain: T[],
  log: { warn: (obj: object, msg: string) => void } = logger,
): Promise<T[]> {
  const out: T[] = [];
  for (const entry of chain) {
    // Validate ANY entry that carries a gatewayUrl, regardless of provider.
    // gatewayUrl is "only meaningful when provider === 'gateway'" (see
    // DbProviderChainEntry), but the field is set per-entry and later re-assigned
    // unconditionally onto the runtime chain (`if (entry.gatewayUrl) mapped.gatewayUrl = ...`).
    // Gating on `provider === 'gateway'` here would let a non-gateway entry that
    // still carries a gatewayUrl (legacy/tampered DB row, or a provider value that
    // didn't equal the literal 'gateway' at this point) smuggle an unvalidated URL
    // past the SSRF guard. Validating on presence closes that per-entry bypass.
    if (entry.gatewayUrl) {
      const check = await validateOutboundUrl(entry.gatewayUrl);
      if (!check.ok) {
        // Generic warn — never echo the URL (it is the SSRF target itself).
        log.warn(
          { reason: check.reason },
          'Dropping provider chain entry with invalid gatewayUrl: failed SSRF re-validation at execution time',
        );
        continue;
      }
    }
    out.push(entry);
  }
  return out;
}

/**
 * Validate a runtime provider chain against the bridge's live /v1/models and
 * /v1/providers, dropping entries the bridge can't serve (unknown/unavailable
 * provider, or a model that provider doesn't advertise).
 *
 * SSRF: the gatewayUrl used here came from a chain already run through
 * revalidateGatewayChain (validateOutboundUrl), so the discovery fetch targets
 * a re-validated host — same posture as the generation fetch that follows.
 *
 * Fails OPEN: a discovery fetch error (bridge down / transient) leaves the
 * chain untouched rather than disabling AI review on a blip — mirrors the
 * empty-discovery semantics inside validateProviderChain.
 */
export async function validateChainAgainstBridge(
  chain: ProviderChainEntry[],
  log: { warn: (obj: object, msg: string) => void } = logger,
): Promise<ProviderChainEntry[]> {
  const gatewayEntry = chain.find((e) => e.provider === 'gateway' && e.gatewayUrl);
  if (!gatewayEntry?.gatewayUrl) {
    return chain; // no gateway entry to validate against
  }

  try {
    const [models, providers] = await Promise.all([
      fetchGatewayModels(gatewayEntry.gatewayUrl, gatewayEntry.apiKey),
      fetchGatewayProviders(gatewayEntry.gatewayUrl, gatewayEntry.apiKey),
    ]);
    const { valid, invalid } = validateProviderChain(chain, models, providers);
    for (const { entry, reason } of invalid) {
      // Never log the gatewayUrl (SSRF target) or apiKey.
      log.warn(
        {
          provider: entry.provider,
          targetProvider: entry.targetProvider,
          model: entry.model,
          reason,
        },
        'Dropping provider chain entry: failed bridge discovery validation',
      );
    }
    return valid;
  } catch (error) {
    log.warn(
      { error: String(error) },
      'Bridge discovery validation skipped (discovery fetch failed) — provider chain sent unvalidated',
    );
    return chain;
  }
}

// ─── Redis Connection ───────────────────────────────────────────

// SEC-004 / PRODOPS-003: build the BullMQ connection from the SAME source as the
// shared singleton — REDIS_URL first (auth + TLS), else host/port with optional
// username/password/TLS. Previously this used host/port only, so managed Redis
// with ACL/TLS in REDIS_URL was silently ignored.
const redisConnection = createRedisClient();

// ─── Types ──────────────────────────────────────────────────────

export interface ReviewJobData {
  /** Correlation ID for end-to-end review tracing */
  reviewId: string;
  /** GitHub installation ID for token exchange */
  installationId: number;
  /** Repository full name (e.g., "owner/repo") */
  repoFullName: string;
  /** Pull request number */
  prNumber: number;
  /** Internal repository ID in our database */
  repositoryId: number;
  /**
   * IMMUTABLE numeric GitHub repo id (the forge-native canonical identity used
   * for {@link RepoRef.nativeId}). A rename/transfer changes owner/repo but NOT
   * this id. Populated for FREE at enqueue time from the webhook payload's
   * `repository.id` — the worker does NOT need a DB lookup or an API call.
   *
   * OPTIONAL only for backward tolerance: in-flight jobs already in Redis at
   * deploy time carry the old shape. When absent, the worker falls back to the
   * path-shaped owner/repo for nativeId (inert — the adapter keys on owner/repo).
   */
  githubRepoId?: number;
  /** HEAD commit SHA for the PR */
  headSha?: string;
  /** Base branch name */
  baseBranch?: string;
  /**
   * Ordered provider chain with encrypted keys.
   *
   * SECURITY: This field is NO LONGER written into the job payload by the
   * enqueue path — encrypted credentials are re-fetched from the DB inside
   * the worker (see resolveEncryptedCredentials) so they never live in Redis.
   *
   * It remains OPTIONAL only for backward tolerance: in-flight jobs already
   * sitting in Redis at deploy time carry the old shape. When present, the
   * worker uses it directly instead of hitting the DB.
   *
   * TOLERANCE: remove this field once the queue has drained post-deploy.
   */
  providerChain?: Array<{
    provider: string;
    model: string;
    encryptedApiKey: string | null;
  }>;
  /** Whether AI review is enabled for this repo */
  aiReviewEnabled?: boolean;
  /** If review was triggered by a comment, the comment ID for reaction feedback */
  triggerCommentId?: number;
  /** GitHub username of the PR author, used for @mention notification */
  prAuthor?: string;
  /**
   * GitHub username of the person who triggered the review (wrote the trigger comment).
   * When set, takes precedence over prAuthor for @mention notifications.
   * Useful when the PR was opened by a bot (e.g., Dependabot) but reviewed by a human.
   */
  reviewTriggeredBy?: string;
  /** LLM provider to use (legacy) */
  llmProvider: string;
  /** LLM model to use (legacy) */
  llmModel: string;
  /** Review mode */
  reviewMode: string;
  /**
   * Legacy single encrypted API key.
   *
   * SECURITY: This field is NO LONGER written into the job payload by the
   * enqueue path — it is re-fetched from the DB inside the worker (see
   * resolveEncryptedCredentials) so the secret never lives in Redis.
   *
   * It remains OPTIONAL only for backward tolerance with in-flight jobs that
   * still carry the old shape. When present, the worker uses it directly.
   *
   * TOLERANCE: remove this field once the queue has drained post-deploy.
   */
  encryptedApiKey?: string | null;
  /** Review settings from repo configuration */
  settings: {
    enableSemgrep: boolean;
    enableTrivy: boolean;
    enableCpd: boolean;
    enableMemory: boolean;
    customRules: string[];
    ignorePatterns: string[];
    reviewLevel: string;
    enabledTools?: string[];
    disabledTools?: string[];
    enableBlastRadius?: boolean;
  };
}

interface RunnerResult {
  dispatched: boolean;
  callbackId: string | null;
}

// ─── Callback Poll ─────────────────────────────────────────────

/**
 * Poll Redis for a static analysis result written by the runner callback endpoint.
 *
 * The callback endpoint writes `ghagga:callback:{callbackId}` after verifying the
 * HMAC signature. This function checks for that key on a fixed interval, parses
 * the JSON payload when found, deletes the key, and returns the result.
 *
 * Returns null if maxAttempts is exhausted — caller should continue without
 * static analysis (graceful degradation).
 */
export async function waitForCallbackResult(
  callbackId: string,
  pollIntervalMs = 10_000,
  maxAttempts = 66,
): Promise<StaticAnalysisResult | null> {
  const key = callbackResultKey(callbackId);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));

    const raw = await redis.get(key);
    if (raw !== null) {
      await redis.del(key);
      try {
        return JSON.parse(raw) as StaticAnalysisResult;
      } catch {
        logger.warn(
          { callbackId },
          'Failed to parse callback result JSON — skipping static analysis',
        );
        return null;
      }
    }
  }

  return null;
}

// ─── Queue Configuration ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reviewQueue = new Queue<ReviewJobData, unknown, string>('review', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// ─── Legacy Provider Migration ────────────────────────────────

/**
 * Legacy provider names stored in DB before the v3 refactor.
 * These are remapped silently to 'gateway' at runtime so existing
 * installations never crash when the stored value is stale.
 */
const LEGACY_PROVIDER_TO_GATEWAY = new Set([
  'anthropic',
  'openai',
  'google',
  'groq',
  'openrouter',
  'github',
  'azure',
  'deepseek',
  'qwen',
  'cerebras',
]);

const VALID_PROVIDERS = new Set(['gateway', 'cli-bridge', 'ollama']);

/**
 * Normalise a provider string read from the DB (or any untrusted source) to
 * the 3-variant LLMProvider type used in the v3 pipeline.
 *
 * - Legacy providers ('anthropic', 'openai', etc.) → 'gateway' + console.warn
 * - 'cli-bridge' | 'ollama' | 'gateway' → pass through unchanged
 * - Unknown/empty → 'gateway' (safe fallback, never crashes)
 */
export function normalizeLegacyProvider(
  raw: string | undefined | null,
): 'gateway' | 'cli-bridge' | 'ollama' {
  if (!raw) return 'gateway';

  if (VALID_PROVIDERS.has(raw)) {
    return raw as 'gateway' | 'cli-bridge' | 'ollama';
  }

  if (LEGACY_PROVIDER_TO_GATEWAY.has(raw)) {
    console.warn(
      `[ghagga] Legacy provider "${raw}" remapped to "gateway". ` +
        'Update this repository\'s settings to use "gateway" with mcp-llm-bridge.',
    );
    return 'gateway';
  }

  console.warn(`[ghagga] Unknown provider "${raw}" — defaulting to "gateway".`);
  return 'gateway';
}

// ─── Credential Resolution ─────────────────────────────────────

/**
 * The encrypted credentials a review needs, kept OUT of the Redis job payload.
 *
 * `providerChain` mirrors the v3 chain (entries carry encrypted keys).
 * `encryptedApiKey` is the legacy single-key fallback.
 */
interface EncryptedCredentials {
  providerChain: DbProviderChainEntry[] | undefined;
  encryptedApiKey: string | null;
}

/**
 * Resolve the encrypted provider chain + legacy key for a review job.
 *
 * SECURITY: Encrypted credentials are NOT carried in the BullMQ/Redis job
 * payload anymore. The producer enqueues only identifiers; the worker
 * re-fetches the SAME settings from the DB at processing time using
 * `repositoryId`. This reproduces exactly what the webhook resolved at
 * enqueue time (getRepositoryById → getEffectiveRepoSettings →
 * effective.providerChain, plus repo.encryptedApiKey).
 *
 * TOLERANCE (remove after queue drains post-deploy): in-flight jobs enqueued
 * before this change still carry `providerChain` / `encryptedApiKey` in their
 * payload. If either is present on the job, we honour the old shape and skip
 * the DB round-trip rather than risk resolving a different chain.
 *
 * Graceful degradation: if the repo/settings were deleted between enqueue and
 * processing (installation uninstalled, repo removed), the lookup returns an
 * empty chain + null key. The existing no-key / static-only fallback path in
 * processReview then takes over — the worker never crashes.
 */
async function resolveEncryptedCredentials(
  data: ReviewJobData,
  log: { warn: (obj: unknown, msg?: string) => void },
  db: Database | undefined,
): Promise<EncryptedCredentials> {
  // Old-format in-flight job tolerance: use whatever the payload carries.
  if (data.providerChain !== undefined || data.encryptedApiKey != null) {
    return {
      providerChain: data.providerChain as DbProviderChainEntry[] | undefined,
      encryptedApiKey: data.encryptedApiKey ?? null,
    };
  }

  // No usable DB handle (creation failed upstream) — degrade to static-only.
  if (!db) {
    log.warn(
      { repositoryId: data.repositoryId },
      'No database handle available when resolving credentials — falling back to static-analysis-only',
    );
    return { providerChain: undefined, encryptedApiKey: null };
  }

  // New path: re-fetch encrypted settings from the DB by identifier.
  try {
    const repo = await getRepositoryById(db, data.repositoryId);

    if (!repo) {
      // Repo deleted between enqueue and processing — degrade to static-only.
      log.warn(
        { repositoryId: data.repositoryId },
        'Repository not found when resolving credentials — falling back to static-analysis-only',
      );
      return { providerChain: undefined, encryptedApiKey: null };
    }

    const effective = await getEffectiveRepoSettings(db, repo);
    const chain = effective.providerChain;

    return {
      providerChain: chain.length > 0 ? chain : undefined,
      encryptedApiKey: repo.encryptedApiKey ?? null,
    };
  } catch (error) {
    // DB unavailable or settings vanished — degrade gracefully, never crash.
    log.warn(
      { repositoryId: data.repositoryId, error: String(error) },
      'Failed to fetch credentials from DB — falling back to static-analysis-only',
    );
    return { providerChain: undefined, encryptedApiKey: null };
  }
}

// ─── Job Processor ──────────────────────────────────────────────

async function processReview(
  job: Job<ReviewJobData>,
): Promise<{ success: boolean; reviewId: string }> {
  const reviewStartTime = Date.now();
  const data = job.data;

  const {
    reviewId,
    installationId,
    repoFullName,
    prNumber,
    repositoryId,
    githubRepoId,
    headSha: eventHeadSha,
    baseBranch: eventBaseBranch,
    triggerCommentId,
    aiReviewEnabled,
    llmProvider,
    llmModel,
    reviewMode,
    settings,
  } = data;

  const log = logger.child({ reviewId, repoFullName, prNumber });

  // Create ONE database handle for the whole job — reused for credential
  // re-fetch and memory storage. Each createDatabaseFromEnv() spins up a fresh
  // pg.Pool, so calling it twice per job leaked a pool. Degrade gracefully when
  // the DB is unavailable (both consumers tolerate a missing handle).
  let db: Database | undefined;
  try {
    db = createDatabaseFromEnv();
  } catch {
    log.warn('Database unavailable — credential re-fetch and memory features disabled');
  }

  // SECURITY: encrypted credentials are NOT in the job payload — re-fetch them
  // from the DB by identifier (with old-format in-flight tolerance + graceful
  // degradation when settings were deleted). See resolveEncryptedCredentials.
  const { providerChain: rawProviderChain, encryptedApiKey } = await resolveEncryptedCredentials(
    data,
    log,
    db,
  );
  const [owner, repo] = repoFullName.split('/') as [string, string];

  log.info(`Starting review processing for ${repoFullName}#${prNumber}`);
  await job.updateProgress(10);

  // Step 1: Fetch context from GitHub
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set');
  }

  // Forge credential seam (P2): GitHubAppCredentialProvider TTL-caches the
  // installation token (singleflight + budget-valid + 401 force-refresh). It
  // replaces P1's TemporaryGitHubTokenSource via a 1-line DI swap — the call
  // sites below (tokenSource.getToken()) are unchanged because both implement
  // ForgeCredentialProvider.
  //
  // OBSERVABLE CHANGE (deliberate, the point of P2): because the phase-1 token
  // is still budget-valid by postback time, the second getToken() returns the
  // CACHED token instead of minting a fresh one → the per-job mint count drops
  // from 2 to 1. User-observable output (comments, review) is identical; only
  // the token-mint count changes. See review.baseline.test.ts test 3.
  //
  // The injected mint is getInstallationTokenWithExpiry (NOT getInstallationToken)
  // so the provider knows expires_at for its TTL cache.
  const tokenSource = new GitHubAppCredentialProvider({
    mint: githubClient.getInstallationTokenWithExpiry,
    installationId,
    appId,
    privateKey,
  });

  // Canonical refs for adapter calls (forge-agnostic shape).
  // nativeId = the OPAQUE forge-native identity (see RepoRef.nativeId in
  // packages/forge/src/types.ts). Normally the IMMUTABLE numeric GitHub repo id
  // (a rename changes owner/repo but NOT the id), threaded for FREE through the
  // job payload from the webhook's `repository.id` — NO DB lookup, NO API call on
  // the worker hot path. `path` is the MUTABLE display label. Stringified to match
  // RepoRef.nativeId's string type (consistent with GitLab's String(id)).
  //
  // TOLERANCE FALLBACK: in-flight jobs enqueued BEFORE this field existed carry no
  // githubRepoId — for those nativeId degrades to a path-shaped OPAQUE string
  // (owner/repo), NOT a number. This is honest per the RepoRef.nativeId contract
  // (opaque, may be path-shaped). It is observably inert (the adapter keys on
  // owner/repo from its ctor, not nativeId), and the fallback disappears once the
  // queue drains post-deploy.
  const repoRef = {
    kind: 'github' as const,
    nativeId: githubRepoId != null ? String(githubRepoId) : `${owner}/${repo}`,
    path: repoFullName,
  };
  const changeRef = { repo: repoRef, iid: prNumber };

  // PHASE 1 mint (was getInstallationToken ~498): one token reused across
  // fetch + dispatch + poll. Kept as a raw token because dispatchWorkflow /
  // runner.ts (CiRunner not wired this cycle) still consume it directly.
  const token = await tokenSource.getToken();

  // Fetch context via the adapter (adapter1) instead of the client directly.
  //
  // FETCH-PHASE 401-RETRY (assessed, deliberately NOT wrapped): the fetch phase
  // runs IMMEDIATELY after the single mint above, so token1 is brand-new here —
  // there is no long-poll window in which it could be revoked BEFORE these calls
  // (unlike the postback, which runs AFTER the poll loop and is the actual P2
  // regression). Wrapping the fetch in the same bounded retry would add code +
  // test surface for a window that does not exist in this ordering, so the retry
  // is intentionally scoped to the postback only. If fetch ordering ever moves
  // after a long wait, mirror the postback's invalidate→re-mint→retry-once block.
  const adapter1 = makeGitHubAdapter({ owner, repo, token });

  const [diffResult, commits, files] = await Promise.all([
    adapter1.fetchDiff(changeRef),
    adapter1.fetchCommits(changeRef),
    adapter1.fetchFileList(changeRef),
  ]);
  const diff = diffResult.text;
  // R-PROJECTION: project via the sanctioned helpers — NEVER hand-rolled .map().
  const commitMessages = toCommitMessages(commits);
  const fileList = toFileList(files);

  log.info(
    { metrics: { step: 'fetch-context', fileCount: fileList.length } },
    'Fetch context completed',
  );
  await job.updateProgress(20);

  // Step 2: Inject workflow (lazy) + dispatch static analysis inline
  const runnerResult: RunnerResult = await (async (): Promise<RunnerResult> => {
    const anyToolEnabled =
      settings.enabledTools !== undefined ||
      settings.disabledTools !== undefined ||
      settings.enableSemgrep ||
      settings.enableTrivy ||
      settings.enableCpd;

    if (!anyToolEnabled) {
      log.info('No static analysis tools enabled — skipping inline workflow');
      return { dispatched: false, callbackId: null };
    }

    const headSha = eventHeadSha ?? 'unknown';
    const baseBranch = eventBaseBranch ?? 'main';
    const serverUrl = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;
    const callbackUrl = `${serverUrl}/runner/callback`;

    // Step 2a: Lazy workflow injection — ensure ghagga.yml exists in the target repo
    let currentWorkflowSha: string | null = null;
    try {
      const db = createDatabaseFromEnv();
      const [repoRecord] = await db
        .select({ workflowSha: repositories.workflowSha })
        .from(repositories)
        .where(eq(repositories.id, repositoryId))
        .limit(1);
      currentWorkflowSha = repoRecord?.workflowSha ?? null;
    } catch (dbErr) {
      log.warn({ error: String(dbErr) }, 'Failed to read workflowSha from DB — proceeding');
    }

    // If no workflow installed yet, inject it now
    if (!currentWorkflowSha) {
      try {
        const injectionResult = await injectWorkflow(owner, repo, token);
        currentWorkflowSha = injectionResult.sha;

        // Persist to DB
        try {
          const db = createDatabaseFromEnv();
          await db
            .update(repositories)
            .set({
              workflowInstalledAt: new Date(),
              workflowSha: injectionResult.sha,
              updatedAt: new Date(),
            })
            .where(eq(repositories.id, repositoryId));
          log.info(
            { sha: injectionResult.sha, created: injectionResult.created },
            'Workflow injected and DB updated',
          );
        } catch (dbErr) {
          log.warn({ error: String(dbErr) }, 'Workflow injected but failed to update DB');
        }
      } catch (injectionErr) {
        log.warn(
          { error: String(injectionErr) },
          'Workflow injection failed — skipping static analysis (graceful degradation)',
        );
        return { dispatched: false, callbackId: null };
      }
    }

    // Step 2b: Generate callbackId + secret and dispatch workflow to PR's repo
    const callbackId = `${randomUUID()}.${Date.now().toString(36)}`;
    const callbackSecret = deriveCallbackSecret(callbackId);

    try {
      await dispatchWorkflow({
        repoFullName,
        prNumber,
        headSha,
        baseBranch,
        callbackUrl,
        callbackSecret,
        callbackId,
        enableSemgrep: settings.enableSemgrep,
        enableTrivy: settings.enableTrivy,
        enableCpd: settings.enableCpd,
        enabledTools: settings.enabledTools,
        disabledTools: settings.disabledTools,
        enableBlastRadius: settings.enableBlastRadius,
        token,
      });

      log.info({ callbackId, repoFullName }, 'Inline workflow dispatched');
      return { dispatched: true, callbackId };
    } catch (error) {
      log.warn(
        { error: String(error) },
        'Failed to dispatch inline workflow — static analysis will run locally',
      );
      return { dispatched: false, callbackId: null };
    }
  })();

  await job.updateProgress(30);

  // Step 3: Wait for runner callback or use local static analysis
  let precomputedStaticAnalysis: StaticAnalysisResult | undefined;

  if (runnerResult.dispatched && runnerResult.callbackId) {
    log.info(
      { callbackId: runnerResult.callbackId },
      'Runner dispatched — waiting for callback result (poll loop)',
    );

    const callbackResult = await waitForCallbackResult(runnerResult.callbackId);

    if (callbackResult !== null) {
      precomputedStaticAnalysis = callbackResult;
      log.info(
        { callbackId: runnerResult.callbackId, tools: Object.keys(callbackResult) },
        'Received static analysis results from runner callback',
      );
    } else {
      log.warn(
        { callbackId: runnerResult.callbackId },
        'Runner callback poll timed out — continuing review without static analysis',
      );
    }
  }

  await job.updateProgress(40);

  // Step 4: Run the core review pipeline
  const reviewResult = await (async () => {
    const stepStart = Date.now();

    // Build the provider chain (decrypt API keys)
    const rawDbChain = (rawProviderChain ?? []) as DbProviderChainEntry[];
    // SSRF re-validation at EXECUTION time (DNS-rebinding TOCTOU defense — see
    // revalidateGatewayChain). Gateway entries whose URL now resolves to a
    // private/loopback/metadata address are dropped before we fetch them.
    const dbChain = await revalidateGatewayChain(rawDbChain, log);
    // Observability: if a non-empty chain was fully emptied by SSRF
    // re-validation, the worker silently falls through to the legacy/no-key
    // path below and the AI review can degrade to static-analysis-only. The
    // degradation semantics are intentional (sprint 2, same pattern as
    // decrypt-failure) — we only make the all-dropped case VISIBLE so an
    // operator can tell "no AI key" apart from "every gateway URL got dropped
    // by SSRF re-validation".
    if (rawDbChain.length > 0 && dbChain.length === 0) {
      log.warn(
        { entriesIn: rawDbChain.length },
        'All provider chain entries dropped by SSRF re-validation — AI review may degrade to static-analysis-only',
      );
    }
    let providerChain: ProviderChainEntry[] | undefined;

    if (dbChain.length > 0) {
      const mappedChain: ProviderChainEntry[] = [];
      for (const entry of dbChain) {
        // Normalise any legacy provider value stored in the DB chain.
        const normalizedProvider = normalizeLegacyProvider(entry.provider);

        let apiKey = '';
        if (entry.encryptedApiKey) {
          try {
            apiKey = decrypt(entry.encryptedApiKey);
          } catch {
            // Corrupt/tampered stored credentials must not reject the whole
            // job. Skip this chain entry and continue with the rest; if every
            // entry fails, the no-key fallback path below degrades gracefully.
            // SECURITY: never log the encrypted value or error internals.
            log.warn(
              { provider: entry.provider },
              'credential decryption failed — skipping provider chain entry',
            );
            continue;
          }
        }

        const mapped: ProviderChainEntry = {
          provider: normalizedProvider,
          model: entry.model,
          apiKey,
        };
        if (entry.cliModel) mapped.cliModel = entry.cliModel;
        if (entry.targetProvider) mapped.targetProvider = entry.targetProvider;
        // SSRF: safe to assign — `dbChain` was produced by revalidateGatewayChain
        // above, which re-validates the gatewayUrl of EVERY entry that carries one
        // (not just provider === 'gateway') against validateOutboundUrl. Any entry
        // whose URL resolves to a private/loopback/metadata address was already
        // dropped, so no unvalidated URL can reach the runtime provider chain here.
        if (entry.gatewayUrl) mapped.gatewayUrl = entry.gatewayUrl;
        mappedChain.push(mapped);
      }

      // F10: validate gateway entries against what the bridge actually exposes,
      // so we never send a voice (provider/model) the bridge can't serve. Runs
      // on the already-SSRF-revalidated gatewayUrl (mappedChain derives from
      // dbChain = revalidateGatewayChain output). Fails open on discovery error.
      const validated = await validateChainAgainstBridge(mappedChain, log);
      providerChain = validated.length > 0 ? validated : undefined;
    }

    // Fallback: legacy single provider
    let legacyApiKey: string | undefined;
    let legacyProvider: LLMProvider | undefined;
    let legacyModel: string | undefined;

    if (!providerChain || providerChain.length === 0) {
      // Normalize legacy provider values stored in the DB before the v3 refactor.
      legacyProvider = normalizeLegacyProvider(llmProvider);
      legacyModel = llmModel;

      // Guard the legacy decrypt the same way as chain entries: a corrupt
      // stored value is treated as "no key" so the job degrades instead of
      // rejecting. SECURITY: never log the encrypted value or error internals.
      let decryptedLegacyKey: string | undefined;
      if (encryptedApiKey) {
        try {
          decryptedLegacyKey = decrypt(encryptedApiKey);
        } catch {
          log.warn(
            { provider: llmProvider },
            'credential decryption failed — treating legacy key as absent',
          );
        }
      }

      if (decryptedLegacyKey) {
        legacyApiKey = decryptedLegacyKey;
      } else {
        const envKey = process.env[`${llmProvider?.toUpperCase()}_API_KEY`];
        if (!envKey) {
          log.warn(
            { provider: llmProvider },
            `No API key configured for provider ${llmProvider} — falling back to static-analysis-only`,
          );
          legacyProvider = undefined;
          legacyApiKey = undefined;
        } else {
          legacyApiKey = envKey;
        }
      }
    }

    // If no provider available at all, force AI review off
    if (!providerChain && !legacyProvider) {
      log.info('No LLM provider available — AI review disabled, static analysis only');
    }

    // Reuse the single db handle created at the top of processReview — do NOT
    // create another pool here (that was the per-job connection leak).
    //
    // Embedding provider (env-driven, design D2 / task 5.1): resolved
    // per-invocation (not module scope) so `process.env` is read fresh on
    // every job — matches how the rest of processReview reads env-driven
    // credentials, and keeps this wiring test-observable without module
    // reset gymnastics. `embeddingProvider` is `undefined` when
    // `EMBEDDING_PROVIDER` is unset/`none`, so this stays on the pre-existing
    // keyword-only path unless a provider is actually configured (none-default
    // parity, spec R5).
    const embeddingConfig = resolveEmbeddingConfig(process.env);
    const embeddingProvider = createEmbeddingProvider(embeddingConfig) ?? undefined;
    const memoryStorage = db
      ? new PostgresMemoryStorage(
          db,
          installationId,
          embeddingProvider,
          undefined,
          embeddingProvider ? embeddingConfig.model : undefined,
          embeddingProvider ? embeddingConfig.candidateK : undefined,
        )
      : undefined;

    // Fetch dependency graph for blast-radius analysis (if enabled)
    let graphLoader: GraphLoader | undefined;
    log.info({ enableBlastRadius: settings.enableBlastRadius ?? false }, 'Blast-radius check');
    if (settings.enableBlastRadius) {
      try {
        // R-CAPABILITY: guard by method-presence, never the capabilities flag.
        const graph = 'fetchGraph' in adapter1 ? await adapter1.fetchGraph(repoRef) : null;
        if (graph) {
          graphLoader = new PreloadedGraphLoader(graph);
          log.info('Dependency graph loaded for blast-radius analysis');
        } else {
          log.info('Blast-radius enabled but no graph available');
        }
      } catch (error) {
        log.warn(
          { error: String(error) },
          'Failed to fetch dependency graph — skipping blast-radius',
        );
      }
    }

    const input: ReviewInput = {
      diff,
      mode: reviewMode as ReviewMode,
      providerChain,
      aiReviewEnabled: (aiReviewEnabled ?? true) && !!(providerChain || legacyProvider),
      provider: legacyProvider,
      model: legacyModel,
      apiKey: legacyApiKey,
      precomputedStaticAnalysis,
      graphLoader,
      settings: {
        enableSemgrep: settings.enableSemgrep,
        enableTrivy: settings.enableTrivy,
        enableCpd: settings.enableCpd,
        enableMemory: settings.enableMemory,
        customRules: settings.customRules,
        ignorePatterns: settings.ignorePatterns,
        reviewLevel: settings.reviewLevel as ReviewLevel,
        enabledTools: settings.enabledTools,
        disabledTools: settings.disabledTools,
        enableBlastRadius: settings.enableBlastRadius,
      },
      context: {
        repoFullName,
        prNumber,
        commitMessages,
        fileList,
      },
      memoryStorage,
    };

    const result = await reviewPipeline(input);

    log.info(
      { metrics: { step: 'run-review', durationMs: Date.now() - stepStart } },
      'AI review analysis completed',
    );

    return result;
  })();

  await job.updateProgress(60);

  // Step 5: Save review to database. Reuse the job-level handle when available;
  // fall back to minting one (preserving the original throw-on-missing-DB
  // behavior) only if the top-of-job creation degraded to undefined.
  const persistDb = db ?? createDatabaseFromEnv();
  await saveReview(persistDb, {
    repositoryId,
    prNumber,
    status: reviewResult.status,
    mode: reviewResult.metadata.mode,
    summary: reviewResult.summary,
    findings: reviewResult.findings,
    tokensUsed: reviewResult.metadata.tokensUsed,
    executionTimeMs: reviewResult.metadata.executionTimeMs,
    // The reviews table persists discrete columns + this jsonb blob — NOT the
    // full ReviewResult. `coverageComplete` is top-level on ReviewResult, so
    // it's folded into the blob here for the wire to read back (reviews.ts
    // toReviewDto). Omitted when undefined (SKIPPED early-returns never set
    // it) so old and not-applicable rows simply lack the key.
    metadata: {
      ...reviewResult.metadata,
      ...(reviewResult.coverageComplete !== undefined
        ? { coverageComplete: reviewResult.coverageComplete }
        : {}),
    },
  });

  await job.updateProgress(80);

  // Step 6: Post or update comment on GitHub PR (idempotent)
  // PHASE 2 token (was a FRESH mint pre-P2): tokenSource.getToken() now returns
  // the CACHED phase-1 token when it is still budget-valid (the common case), so
  // NO second mint occurs — the per-job mint count is 1, not 2. The provider
  // guarantees this token outlives the postback (BUDGET_SECONDS), or re-mints
  // PROACTIVELY if the cache has aged out during a long poll loop.
  const freshToken = await tokenSource.getToken();
  let adapter2 = makeGitHubAdapter({ owner, repo, token: freshToken });
  let commentBody = formatReviewComment(reviewResult, {
    fileStats:
      reviewResult.metadata.totalAdditions !== undefined
        ? {
            additions: reviewResult.metadata.totalAdditions,
            deletions: reviewResult.metadata.totalDeletions ?? 0,
          }
        : undefined,
    fileList: reviewResult.metadata.fileList,
    // Prefer the human who triggered the review over the PR author.
    // This matters for bot-opened PRs (e.g., Dependabot) where prAuthor is a bot.
    prAuthor: job.data.reviewTriggeredBy ?? job.data.prAuthor,
  });
  commentBody += `\n<!-- reviewId: ${reviewId} -->`;

  // Strategy: delete all existing GHAGGA review comments, then post a fresh one at the bottom.
  // This ensures the review always appears at the most recent position in the PR thread,
  // which is better UX than editing in place (GitHub keeps edited comments at their original position).
  //
  // upsertSummaryComment folds find → delete-ALL([latestId, ...staleIds]) → post
  // into one adapter call, preserving the EXACT baseline ordering + best-effort
  // delete semantics. The marker passed MUST equal REVIEW_COMMENT_MARKER (the
  // GitHub adapter matches that fixed marker inside client.findExistingComment).
  //
  // P2 401-RECOVERY (in-job, bounded to exactly ONE retry): with P2 caching the
  // postback reuses the cached phase-1 token. If that token was REVOKED mid-job
  // (server-side, before its advertised expiry), the postback fails with a typed
  // ForgeAuthError (401/403). We then invalidate() the credential cache, re-mint
  // a fresh token, rebuild the adapter, and retry the postback ONCE. If the retry
  // ALSO 401s, we propagate (fail the job) — NO infinite loop. This restores P1's
  // in-job recovery cheaply (re-mint + retry the POSTBACK only, not the review).
  //
  // HAPPY PATH IS UNCHANGED: with no 401, the try-body runs exactly once with the
  // same single mint and same call sequence as before (the catch never fires).
  let upsertResult: Awaited<ReturnType<typeof adapter2.upsertSummaryComment>>;
  try {
    upsertResult = await adapter2.upsertSummaryComment(changeRef, commentBody, REVIEW_MARKER);
  } catch (error) {
    if (!isForgeAuthError(error)) throw error;
    // Token was rejected (revoked/rotated) — drop the cache, re-mint, retry ONCE.
    log.warn(
      { status: error.status },
      'Postback hit a forge auth failure (401/403) — invalidating credential cache and retrying once with a fresh token',
    );
    tokenSource.invalidate();
    const retryToken = await tokenSource.getToken();
    adapter2 = makeGitHubAdapter({ owner, repo, token: retryToken });
    // The retry is UNGUARDED: if it ALSO throws (auth or otherwise) it propagates
    // and fails the job. This is the bound — exactly one retry, never a loop.
    upsertResult = await adapter2.upsertSummaryComment(changeRef, commentBody, REVIEW_MARKER);
  }
  // BOX the GitHub-native numeric id review.ts-LOCAL (R-COMMENTID).
  const postedCommentId = githubCommentId(upsertResult.created);
  log.info({ commentId: postedCommentId.raw }, 'Review comment posted');
  await job.updateProgress(90);

  // Step 7: React with rocket to the trigger comment
  if (triggerCommentId) {
    try {
      // Box the trigger-comment id review.ts-LOCAL before crossing the adapter
      // seam (R-COMMENTID). Guard by method-presence (R-CAPABILITY).
      if ('addReaction' in adapter2) {
        await adapter2.addReaction(githubCommentId(triggerCommentId), REACTION_KIND.ROCKET);
      }
    } catch (error) {
      log.warn({ error: String(error) }, 'Failed to add completion reaction');
    }
  }

  log.info(
    {
      metrics: {
        durationMs: Date.now() - reviewStartTime,
        provider: reviewResult.metadata.provider,
        model: reviewResult.metadata.model,
        mode: reviewResult.metadata.mode,
        status: reviewResult.status,
        findingsCount: reviewResult.findings?.length ?? 0,
        filesAnalyzed: fileList?.length ?? 0,
        tokensUsed: reviewResult.metadata.tokensUsed,
        modelsUsed: reviewResult.metadata.modelsUsed,
      },
    },
    'Review completed',
  );

  await job.updateProgress(100);

  return { success: true, reviewId };
}

// ─── Queue Functions ───────────────────────────────────────────

/**
 * Enqueue a review job.
 */
export async function enqueueReview(
  data: ReviewJobData,
): Promise<Job<ReviewJobData, unknown, string>> {
  return reviewQueue.add('process-review', data, {
    jobId: data.reviewId,
    priority: 1,
  });
}

/**
 * Create a review worker with the specified concurrency.
 */
export function createReviewWorker(concurrency = 3): Worker<ReviewJobData, unknown, string> {
  return new Worker<ReviewJobData, unknown, string>('review', processReview, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: redisConnection as any,
    concurrency,
    lockDuration: 300_000, // 5 minutes — CLI bridge reviews can take 100-110s
  });
}

/**
 * Setup event handlers for queue monitoring.
 */
export function setupQueueEvents(): void {
  // Use the worker events instead of queue events for monitoring
  logger.info('Queue events setup complete');
}

export default reviewQueue;
