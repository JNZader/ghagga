/**
 * Review Worker Entry Point
 *
 * Starts the BullMQ worker that processes review jobs from the queue.
 * This file is the entry point for the worker container in Docker.
 *
 * Usage:
 *   node dist/workers/review.js
 *
 * Environment:
 *   - REDIS_HOST, REDIS_PORT: Redis connection
 *   - DATABASE_URL: PostgreSQL connection
 *   - GITHUB_APP_ID, GITHUB_PRIVATE_KEY: GitHub App credentials
 *   - ENCRYPTION_KEY: For decrypting API keys
 */

import { logger } from '../lib/logger.js';
import { closeRedis } from '../lib/redis.js';
import { closeReviewQueue, createReviewWorker } from '../queues/review.js';

logger.info('🚀 Starting GHAGGA Review Worker...');

// SEC-006: fail fast at startup if STATE_SECRET is missing. Inline-runner jobs
// derive a callback secret from it (deriveCallbackSecret in github/runner.ts);
// without this gate a misconfigured worker would accept jobs and only fail LATE,
// mid-dispatch, after fetching context and burning a GitHub token mint. Checked
// inline (not via a runner import) so the worker entry stays lightweight.
if (!process.env.STATE_SECRET) {
  logger.error(
    'STATE_SECRET is not configured — the review worker cannot dispatch inline static analysis. Set STATE_SECRET and restart.',
  );
  process.exit(1);
}

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

const worker = createReviewWorker(WORKER_CONCURRENCY);

// Setup event handlers on worker
worker.on('completed', (job) => {
  logger.info(`✅ Review job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  // Log only the message — serializing the full error object can leak job
  // data attached to it (BullMQ jobs carry encryptedApiKey in their payload).
  logger.error(
    { jobId: job?.id, error: err instanceof Error ? err.message : String(err) },
    `❌ Review job ${job?.id} failed`,
  );
});

worker.on('progress', (job, progress) => {
  logger.debug(`📊 Review job ${job.id} progress: ${progress}%`);
});

logger.info(`✅ Worker started with concurrency: ${WORKER_CONCURRENCY}`);

// Graceful shutdown
let shutdownPromise: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  if (!shutdownPromise) {
    shutdownPromise = worker
      .close()
      .then(closeReviewQueue)
      .then(closeRedis)
      .then(() => {
        logger.info('Worker and Redis clients closed');
        process.exit(0);
      });
  }
  return shutdownPromise;
};

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, closing worker gracefully...');
  void shutdown();
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, closing worker gracefully...');
  void shutdown();
});

// Keep the process alive
process.stdin.resume();
