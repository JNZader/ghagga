/**
 * Review Queue - BullMQ implementation for review processing.
 *
 * BullMQ durable job queue for self-hosted deployment.
 * Processes code review jobs asynchronously with retry support.
 */

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
  formatReviewComment,
  PreloadedGraphLoader,
  REVIEW_COMMENT_MARKER,
  reviewPipeline,
} from 'ghagga-core';
import type { Database, DbProviderChainEntry } from 'ghagga-db';
import { createDatabaseFromEnv, decrypt, saveReview } from 'ghagga-db';
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
  updateComment,
} from '../github/client.js';
import { discoverRunnerRepo, dispatchWorkflow } from '../github/runner.js';
import { logger as rootLogger } from '../lib/logger.js';
import { PostgresMemoryStorage } from '../memory/postgres.js';

const logger = rootLogger.child({ module: 'review-queue' });

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

  // Step 2: Dispatch static analysis to runner (if available)
  const runnerResult: RunnerResult = await (async (): Promise<RunnerResult> => {
    const anyToolEnabled =
      settings.enabledTools !== undefined ||
      settings.disabledTools !== undefined ||
      settings.enableSemgrep ||
      settings.enableTrivy ||
      settings.enableCpd;

    if (!anyToolEnabled) {
      log.info('No static analysis tools enabled — skipping runner');
      return { dispatched: false, callbackId: null };
    }

    const runner = await discoverRunnerRepo(owner, token);
    if (!runner) {
      log.info('No ghagga-runner repo found — static analysis will run locally on server');
      return { dispatched: false, callbackId: null };
    }

    const headSha = eventHeadSha ?? 'unknown';
    const baseBranch = eventBaseBranch ?? 'main';
    const serverUrl = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;
    const callbackUrl = `${serverUrl}/runner/callback`;

    try {
      const callbackId = await dispatchWorkflow({
        ownerLogin: owner,
        repoFullName,
        prNumber,
        headSha,
        baseBranch,
        callbackUrl,
        enableSemgrep: settings.enableSemgrep,
        enableTrivy: settings.enableTrivy,
        enableCpd: settings.enableCpd,
        enabledTools: settings.enabledTools,
        disabledTools: settings.disabledTools,
        enableBlastRadius: settings.enableBlastRadius,
        token,
      });

      log.info({ callbackId, runner: runner.fullName }, 'Runner workflow dispatched');
      return { dispatched: true, callbackId };
    } catch (error) {
      log.warn(
        { error: String(error) },
        'Failed to dispatch runner workflow — static analysis will run locally',
      );
      return { dispatched: false, callbackId: null };
    }
  })();

  await job.updateProgress(30);

  // Step 3: Wait for runner callback or use local static analysis
  let precomputedStaticAnalysis: StaticAnalysisResult | undefined;

  if (runnerResult.dispatched) {
    log.info(
      { callbackId: runnerResult.callbackId },
      'Runner dispatched - proceeding without precomputed analysis',
    );
  }

  await job.updateProgress(40);

  // Step 4: Run the core review pipeline
  const reviewResult = await (async () => {
    const stepStart = Date.now();

    // Build the provider chain (decrypt API keys)
    const dbChain = (rawProviderChain ?? []) as DbProviderChainEntry[];
    let providerChain: ProviderChainEntry[] | undefined;

    if (dbChain.length > 0) {
      providerChain = dbChain
        .filter((entry) => {
          if (entry.provider === 'github' && !entry.encryptedApiKey) {
            log.warn(
              { provider: 'github' },
              'Skipping "github" provider — requires explicit API key',
            );
            return false;
          }
          return true;
        })
        .map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          apiKey: entry.encryptedApiKey ? decrypt(entry.encryptedApiKey) : '',
        }));

      if (providerChain.length === 0) {
        providerChain = undefined;
      }
    }

    // Fallback: legacy single provider
    let legacyApiKey: string | undefined;
    let legacyProvider: LLMProvider | undefined;
    let legacyModel: string | undefined;

    if (!providerChain || providerChain.length === 0) {
      legacyProvider = llmProvider as LLMProvider;
      legacyModel = llmModel;

      if (legacyProvider === 'github' && !encryptedApiKey) {
        log.warn(
          { provider: 'github' },
          'Provider "github" (GitHub Models) not available without explicit API key',
        );
        legacyProvider = undefined;
        legacyApiKey = undefined;
      } else if (encryptedApiKey) {
        legacyApiKey = decrypt(encryptedApiKey);
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
