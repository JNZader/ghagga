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
