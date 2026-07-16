/**
 * Issue-Analysis Worker Entry Point
 *
 * Starts the BullMQ worker that consumes issue-triage jobs from the
 * `issue-analysis` queue. This is the SEPARATE counterpart to the review worker
 * (workers/review.ts): the review worker posts a PR comment immediately, while
 * THIS worker persists a DRAFT and NEVER posts a GitHub comment — a human
 * approves it later in the Phase 6 dashboard.
 *
 * Without this entry point the jobs enqueued onto the `issue-analysis` queue
 * sit in Redis unconsumed (the feature would be dead on arrival). start.sh
 * launches it alongside review.js in worker mode.
 *
 * Usage:
 *   node dist/workers/issue-analysis.js
 *
 * Environment:
 *   - REDIS_HOST, REDIS_PORT: Redis connection
 *   - DATABASE_URL: PostgreSQL connection
 *   - GITHUB_APP_ID, GITHUB_PRIVATE_KEY: GitHub App credentials
 *   - GITHUB_APP_SLUG: (optional) app slug used to derive the bot login
 *     (`${slug}[bot]`) so the reaper can verify a marked comment's author exactly
 *   - ENCRYPTION_KEY: For decrypting API keys
 */

import { createDatabaseFromEnv } from 'ghagga-db';
import { getInstallationToken, listIssueComments } from '../github/client.js';
import { logger } from '../lib/logger.js';
import { createIssueAnalysisWorker } from '../queues/issue-analysis.js';
import { startIssueDraftReaper } from '../queues/issue-draft-reaper.js';

logger.info('🚀 Starting GHAGGA Issue-Analysis Worker...');

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

const worker = createIssueAnalysisWorker(WORKER_CONCURRENCY);

// ── Stuck-APPROVED issue-draft REAPER (in-process periodic sweep) ──
// Single-box deployment: recovery runs as a setInterval inside THIS worker (not
// a separate BullMQ repeatable job). It recovers drafts stuck APPROVED when a
// process crashed mid-approve — recording POSTED if the comment is live, or
// releasing the claim if the crash was pre-post. See queues/issue-draft-reaper.ts.
const REAPER_ENABLED = (process.env.ISSUE_DRAFT_REAPER_ENABLED ?? 'true') !== 'false';
const REAPER_INTERVAL_MS = parseInt(
  process.env.ISSUE_DRAFT_REAPER_INTERVAL_MS || '300000', // 5 min
  10,
);
// 15 min — safely above the approve route's worst-case (~40s) so no in-flight
// legit approve is reaped.
const REAPER_STALE_MS = parseInt(process.env.ISSUE_DRAFT_REAPER_STALE_MS || '900000', 10);

let stopReaper: (() => void) | undefined;
if (REAPER_ENABLED) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) {
    logger.warn(
      'Issue-draft reaper is ENABLED but GITHUB_APP_ID / GITHUB_PRIVATE_KEY are not set — reaper NOT started',
    );
  } else {
    const reaperLog = logger.child({ module: 'issue-draft-reaper' });
    // Derive the app's bot login (`${slug}[bot]`) for exact author verification of
    // marked comments. Unset → the reaper falls back to an `endsWith('[bot]')` check.
    const appSlug = process.env.GITHUB_APP_SLUG;
    const botLogin = appSlug ? `${appSlug}[bot]` : undefined;
    stopReaper = startIssueDraftReaper({
      db: createDatabaseFromEnv(),
      intervalMs: REAPER_INTERVAL_MS,
      log: reaperLog,
      deps: {
        getInstallationToken,
        listIssueComments,
        appId,
        privateKey,
        botLogin,
        staleMs: REAPER_STALE_MS,
        log: reaperLog,
      },
    });
    logger.info(
      { intervalMs: REAPER_INTERVAL_MS, staleMs: REAPER_STALE_MS },
      `✅ Issue-draft reaper ENABLED (every ${REAPER_INTERVAL_MS}ms, stale threshold ${REAPER_STALE_MS}ms)`,
    );
  }
} else {
  logger.info('Issue-draft reaper DISABLED (ISSUE_DRAFT_REAPER_ENABLED=false)');
}

// Setup event handlers on worker
worker.on('completed', (job) => {
  logger.info(`✅ Issue-analysis job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  // Log only the message — serializing the full error object can leak job
  // data attached to it (BullMQ jobs carry repository identifiers + payload).
  logger.error(
    { jobId: job?.id, error: err instanceof Error ? err.message : String(err) },
    `❌ Issue-analysis job ${job?.id} failed`,
  );
});

worker.on('error', (err) => {
  logger.error(
    { error: err instanceof Error ? err.message : String(err) },
    '❌ Issue-analysis worker error',
  );
});

worker.on('progress', (job, progress) => {
  logger.debug(`📊 Issue-analysis job ${job.id} progress: ${progress}%`);
});

logger.info(`✅ Issue-analysis worker started with concurrency: ${WORKER_CONCURRENCY}`);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing issue-analysis worker gracefully...');
  stopReaper?.();
  await worker.close();
  logger.info('Issue-analysis worker closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing issue-analysis worker gracefully...');
  stopReaper?.();
  await worker.close();
  logger.info('Issue-analysis worker closed');
  process.exit(0);
});

// Keep the process alive
process.stdin.resume();
