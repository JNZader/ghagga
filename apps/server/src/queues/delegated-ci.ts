/**
 * Delegated CI Queue - BullMQ implementation for delegated CI job processing.
 *
 * Dispatches approved CI jobs to the runner workflow after policy evaluation.
 * Models the same pattern as review.ts for consistency.
 */

import type { Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { createDatabaseFromEnv, createDelegatedCiRun, updateDelegatedCiRunState } from 'ghagga-db';
import Redis from 'ioredis';
import { getInstallationToken } from '../github/client.js';
import { buildDelegatedCiDescriptor, dispatchRunnerWorkflow } from '../github/runner.js';
import { logger as rootLogger } from '../lib/logger.js';

const logger = rootLogger.child({ module: 'delegated-ci-queue' });

// ─── Redis Connection ───────────────────────────────────────────

const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// ─── Types ──────────────────────────────────────────────────────

export interface DelegatedCiJobData {
  repositoryId: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseBranch: string;
  installationId: number;
  jobKey: string;
  profile: string;
  allowArtifacts: false | string[];
  allowCache: boolean;
  maxDurationMinutes: number;
}

// ─── Queue Configuration ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const delegatedCiQueue = new Queue<DelegatedCiJobData, unknown, string>('delegated-ci', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 50,
    removeOnFail: 25,
  },
});

// ─── Job Processor ──────────────────────────────────────────────

async function processDelegatedCi(
  job: Job<DelegatedCiJobData>,
): Promise<{ success: boolean; callbackId: string }> {
  const data = job.data;
  const log = logger.child({
    jobKey: data.jobKey,
    repoFullName: data.repoFullName,
    prNumber: data.prNumber,
  });

  log.info('Starting delegated CI job processing');

  // Step 1: Get installation token
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set');
  }

  const token = await getInstallationToken(data.installationId, appId, privateKey);

  // Step 2: Create DB record
  const db = createDatabaseFromEnv();
  const run = await createDelegatedCiRun(db, {
    repositoryId: data.repositoryId,
    prNumber: data.prNumber,
    jobKey: data.jobKey,
    classification: 'safe/delegable',
    state: 'approved',
    profile: data.profile,
  });

  try {
    // Step 3: Build descriptor
    const ownerLogin = data.repoFullName.split('/')[0] as string;
    const callbackUrl = `${process.env.SERVER_URL ?? 'https://api.javierzader.com'}/runner/callback`;

    const descriptor = buildDelegatedCiDescriptor({
      ownerLogin,
      repoFullName: data.repoFullName,
      prNumber: data.prNumber,
      headSha: data.headSha,
      baseBranch: data.baseBranch,
      callbackUrl,
      jobKey: data.jobKey,
      profile: data.profile,
      allowArtifacts: data.allowArtifacts,
      allowCache: data.allowCache,
      maxDurationMinutes: data.maxDurationMinutes,
      token,
    });

    // Step 4: Dispatch
    await dispatchRunnerWorkflow(descriptor, ownerLogin, token);

    // Step 5: Update DB record
    await updateDelegatedCiRunState(db, run.id, {
      state: 'dispatched',
      callbackId: descriptor.inputs.callbackId,
    });

    log.info(
      { callbackId: descriptor.inputs.callbackId, runId: run.id },
      'Delegated CI job dispatched',
    );

    return { success: true, callbackId: descriptor.inputs.callbackId };
  } catch (error) {
    // Update DB record to failed state
    await updateDelegatedCiRunState(db, run.id, {
      state: 'failed',
      reasonDetail: error instanceof Error ? error.message : String(error),
    });

    log.error({ err: error, runId: run.id }, 'Delegated CI job failed');
    throw error;
  }
}

// ─── Queue Functions ───────────────────────────────────────────

/**
 * Enqueue a delegated CI job.
 */
export async function enqueueDelegatedCiJob(data: DelegatedCiJobData): Promise<string> {
  const job = await delegatedCiQueue.add(`ci-${data.jobKey}-${data.prNumber}`, data);
  return job.id ?? 'unknown';
}

/**
 * Create a delegated CI worker with the specified concurrency.
 */
export function createDelegatedCiWorker(concurrency = 2): Worker<DelegatedCiJobData> {
  return new Worker<DelegatedCiJobData>('delegated-ci', processDelegatedCi, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: redisConnection as any,
    concurrency,
  });
}

export default delegatedCiQueue;
