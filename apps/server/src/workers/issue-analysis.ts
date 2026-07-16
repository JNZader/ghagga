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
 *   - ENCRYPTION_KEY: For decrypting API keys
 */

import { logger } from '../lib/logger.js';
import { createIssueAnalysisWorker } from '../queues/issue-analysis.js';

logger.info('🚀 Starting GHAGGA Issue-Analysis Worker...');

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

const worker = createIssueAnalysisWorker(WORKER_CONCURRENCY);

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
  await worker.close();
  logger.info('Issue-analysis worker closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing issue-analysis worker gracefully...');
  await worker.close();
  logger.info('Issue-analysis worker closed');
  process.exit(0);
});

// Keep the process alive
process.stdin.resume();
