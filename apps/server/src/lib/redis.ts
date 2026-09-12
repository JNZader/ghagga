/**
 * Redis client configuration for BullMQ.
 *
 * Provides a singleton Redis connection instance used by BullMQ
 * for queue operations. Configured for BullMQ compatibility.
 *
 * ─── Connection source (SEC-004 / PRODOPS-003) ──────────────────────────────
 *
 * `REDIS_URL` is the PRIMARY, documented connection source and is honoured by
 * EVERY client (this singleton AND the BullMQ connection in queues/review.ts).
 * A URL carries auth (`redis://user:pass@host`) and TLS (`rediss://`) so managed
 * Redis (with ACL/TLS) connects correctly instead of silently falling back to an
 * unauthenticated host/port. When `REDIS_URL` is absent, the client is built from
 * `REDIS_HOST`/`REDIS_PORT` with optional `REDIS_USERNAME`/`REDIS_PASSWORD`/
 * `REDIS_TLS=true`. Startup logs the effective mode (never secrets) so an operator
 * can confirm auth/TLS actually apply.
 */

import Redis, { type RedisOptions } from 'ioredis';
import { logger } from './logger.js';

/** Options every ghagga Redis client needs (BullMQ compatibility). */
const BASE_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const applicationClients = new Set<Redis>();
let closePromise: Promise<void> | undefined;

function registerRedisClient(client: Redis): Redis {
  applicationClients.add(client);
  // Keep lightweight test doubles compatible while real ioredis clients get
  // lifecycle observability from their EventEmitter interface.
  if (typeof client.on === 'function') {
    client.on('error', (error: Error) => {
      logger.warn({ error: error.message }, 'Redis client error');
    });
    client.on('reconnecting', (delay: number) => {
      logger.info({ delay }, 'Redis client reconnecting');
    });
  }
  return client;
}

/**
 * Describe how the Redis connection is being built, WITHOUT leaking secrets.
 * Used for the one-time startup log so operators can verify auth/TLS apply.
 */
export function describeRedisConfig(env: NodeJS.ProcessEnv = process.env): {
  source: 'url' | 'host-port';
  tls: boolean;
  auth: boolean;
} {
  const url = env.REDIS_URL;
  if (url) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    return {
      source: 'url',
      tls: parsed?.protocol === 'rediss:',
      auth: Boolean(parsed?.username || parsed?.password),
    };
  }
  return {
    source: 'host-port',
    tls: env.REDIS_TLS === 'true',
    auth: Boolean(env.REDIS_USERNAME || env.REDIS_PASSWORD),
  };
}

/**
 * Create an ioredis client from the environment.
 *
 * Prefers `REDIS_URL` (auth + TLS aware); otherwise builds from host/port with
 * optional username/password/TLS. `overrides` are merged last so callers can
 * tune per-connection options.
 */
export function createRedisClient(
  overrides: RedisOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Redis {
  const url = env.REDIS_URL;
  if (url) {
    // ioredis parses username/password/db from the URL and enables TLS for
    // rediss://. BASE_OPTIONS/overrides tune BullMQ behaviour without dropping
    // the URL's credentials.
    return registerRedisClient(new Redis(url, { ...BASE_OPTIONS, ...overrides }));
  }

  const options: RedisOptions = {
    host: env.REDIS_HOST || 'redis',
    port: parseInt(env.REDIS_PORT || '6379', 10),
    ...BASE_OPTIONS,
    ...overrides,
  };
  if (env.REDIS_USERNAME) options.username = env.REDIS_USERNAME;
  if (env.REDIS_PASSWORD) options.password = env.REDIS_PASSWORD;
  if (env.REDIS_TLS === 'true') options.tls = {};
  return registerRedisClient(new Redis(options));
}

/**
 * Redis connection instance configured for BullMQ.
 * Uses maxRetriesPerRequest: null as required by BullMQ.
 */
export const redis = createRedisClient();

/**
 * Gracefully close the Redis connection.
 * Should be called on shutdown to prevent connection leaks.
 */
export async function closeRedis(): Promise<void> {
  if (!closePromise) {
    const clients = [...applicationClients];
    closePromise = Promise.all(
      clients.map((client) => (client.status === 'end' ? Promise.resolve() : client.quit())),
    ).then(() => {
      logger.info({ clients: clients.length }, 'Redis clients closed');
    });
  }
  await closePromise;
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
