/**
 * Redis client configuration for BullMQ.
 *
 * Provides a singleton Redis connection instance used by BullMQ
 * for queue operations. Configured for BullMQ compatibility.
 */

import Redis from 'ioredis';

/**
 * Redis connection instance configured for BullMQ.
 * Uses maxRetriesPerRequest: null as required by BullMQ.
 */
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/**
 * Gracefully close the Redis connection.
 * Should be called on shutdown to prevent connection leaks.
 */
export async function closeRedis(): Promise<void> {
  await redis.quit();
}

export default redis;

// ─── Inline Workflow Callback Keys ──────────────────────────────────────────

/**
 * Key that maps a callbackId to the owning BullMQ job ID.
 * Written by the review worker after dispatching the workflow.
 * Read by runner-callback.ts to verify the job exists before writing results.
 *
 * Pattern: ghagga:callback:{callbackId}
 */
export const callbackResultKey = (callbackId: string): string => `ghagga:callback:${callbackId}`;

/**
 * TTL for callback result keys (seconds).
 * 720 s = 12 minutes — slightly longer than the 11-minute poll window
 * so the key outlives the poller and can be inspected after timeout.
 */
export const CALLBACK_RESULT_TTL = 720;
