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
import { formatReviewComment, PreloadedGraphLoader, reviewPipeline } from 'ghagga-core';
import type { Database, DbProviderChainEntry } from 'ghagga-db';
import { createDatabaseFromEnv, decrypt, eq, repositories, saveReview } from 'ghagga-db';
import Redis from 'ioredis';
import {
  addCommentReaction,
  deleteComment,
  fetchGraphFromBranch,
  fetchPRDiff,
  findExistingComment,
  getInstallationToken,
  getPRCommitMessages,
  getPRFileList,
  postComment,
} from '../github/client.js';
import { deriveCallbackSecret, dispatchWorkflow, injectWorkflow } from '../github/runner.js';
import { logger as rootLogger } from '../lib/logger.js';
import { callbackResultKey, redis } from '../lib/redis.js';
import { validateOutboundUrl } from '../lib/safe-url.js';
import { PostgresMemoryStorage } from '../memory/postgres.js';

const logger = rootLogger.child({ module: 'review-queue' });

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
    if (entry.provider === 'gateway' && entry.gatewayUrl) {
      const check = await validateOutboundUrl(entry.gatewayUrl);
      if (!check.ok) {
        // Generic warn — never echo the URL (it is the SSRF target itself).
        log.warn(
          { reason: check.reason },
          'Dropping gateway chain entry: URL failed SSRF re-validation at execution time',
        );
        continue;
      }
    }
    out.push(entry);
  }
  return out;
}

// ─── Redis Connection ───────────────────────────────────────────

const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

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
  /** HEAD commit SHA for the PR */
  headSha?: string;
  /** Base branch name */
  baseBranch?: string;
  /** Ordered provider chain from DB (entries have encrypted keys) */
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
  /** Encrypted API key (will be decrypted at runtime) */
  encryptedApiKey: string | null;
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
function normalizeLegacyProvider(
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
    headSha: eventHeadSha,
    baseBranch: eventBaseBranch,
    triggerCommentId,
    providerChain: rawProviderChain,
    aiReviewEnabled,
    llmProvider,
    llmModel,
    reviewMode,
    encryptedApiKey,
    settings,
  } = data;

  const log = logger.child({ reviewId, repoFullName, prNumber });
  const [owner, repo] = repoFullName.split('/') as [string, string];

  log.info(`Starting review processing for ${repoFullName}#${prNumber}`);
  await job.updateProgress(10);

  // Step 1: Fetch context from GitHub
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set');
  }

  const token = await getInstallationToken(installationId, appId, privateKey);

  const [diff, commitMessages, fileList] = await Promise.all([
    fetchPRDiff(owner, repo, prNumber, token),
    getPRCommitMessages(owner, repo, prNumber, token),
    getPRFileList(owner, repo, prNumber, token),
  ]);

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
        if (entry.gatewayUrl) mapped.gatewayUrl = entry.gatewayUrl;
        mappedChain.push(mapped);
      }

      providerChain = mappedChain.length > 0 ? mappedChain : undefined;
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

    let db: Database | undefined;
    try {
      db = createDatabaseFromEnv();
    } catch {
      log.warn('Database unavailable for memory features');
    }

    const memoryStorage = db ? new PostgresMemoryStorage(db, installationId) : undefined;

    // Fetch dependency graph for blast-radius analysis (if enabled)
    let graphLoader: GraphLoader | undefined;
    log.info({ enableBlastRadius: settings.enableBlastRadius ?? false }, 'Blast-radius check');
    if (settings.enableBlastRadius) {
      try {
        const graph = await fetchGraphFromBranch(owner, repo, token);
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

  // Step 5: Save review to database
  const db = createDatabaseFromEnv();
  await saveReview(db, {
    repositoryId,
    prNumber,
    status: reviewResult.status,
    mode: reviewResult.metadata.mode,
    summary: reviewResult.summary,
    findings: reviewResult.findings,
    tokensUsed: reviewResult.metadata.tokensUsed,
    executionTimeMs: reviewResult.metadata.executionTimeMs,
    metadata: reviewResult.metadata,
  });

  await job.updateProgress(80);

  // Step 6: Post or update comment on GitHub PR (idempotent)
  const freshToken = await getInstallationToken(installationId, appId, privateKey);
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
  const existing = await findExistingComment(owner, repo, prNumber, freshToken);
  if (existing) {
    // Delete ALL previous GHAGGA comments (latest + any stale duplicates)
    const allIds = [existing.latestId, ...existing.staleIds];
    for (const commentId of allIds) {
      try {
        await deleteComment(owner, repo, commentId, freshToken);
        log.info({ commentId }, 'Deleted previous GHAGGA review comment');
      } catch (error) {
        log.warn({ commentId, error: String(error) }, 'Failed to delete previous comment');
      }
    }
  }

  // Always post a fresh comment at the bottom of the PR thread
  const postedComment = await postComment(owner, repo, prNumber, commentBody, freshToken);
  log.info({ commentId: postedComment?.id }, 'Review comment posted');
  await job.updateProgress(90);

  // Step 7: React with rocket to the trigger comment
  if (triggerCommentId) {
    try {
      await addCommentReaction(owner, repo, triggerCommentId, 'rocket', freshToken);
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
