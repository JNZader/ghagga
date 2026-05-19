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
import { createReviewWorker } from '../queues/review.js';

logger.info('🚀 Starting GHAGGA Review Worker...');

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3', 10);

const worker = createReviewWorker(WORKER_CONCURRENCY);

// Setup event handlers on worker
worker.on('completed', (job) => {
  logger.info(`✅ Review job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, error: err }, `❌ Review job ${job?.id} failed`);
});

worker.on('progress', (job, progress) => {
  logger.debug(`📊 Review job ${job.id} progress: ${progress}%`);
});

logger.info(`✅ Worker started with concurrency: ${WORKER_CONCURRENCY}`);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing worker gracefully...');
  await worker.close();
  logger.info('Worker closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing worker gracefully...');
  await worker.close();
  logger.info('Worker closed');
  process.exit(0);
});

// Keep the process alive
process.stdin.resume();
