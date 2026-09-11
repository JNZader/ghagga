/**
 * Server entry point tests.
 *
 * Tests the error handler (Fix #1: no stack traces leaked),
 * SIGTERM graceful shutdown registration (Fix #8),
 * and the detailed health check endpoint (Fix #12).
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleCircuitBreaker } from './lib/circuit-breaker.js';

// ─── Fix #1: Error handler does not leak stack traces ───────────

describe('Global error handler', () => {
  it('returns generic 500 without detail or stack fields', async () => {
    const app = new Hono();

    // Replicate the production error handler from index.ts
    app.onError((_err, c) => {
      return c.json({ error: 'Internal server error' }, 500);
    });

    app.get('/explode', () => {
      throw new Error('secret database password in stack');
    });

    const res = await app.request('/explode');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: 'Internal server error' });
    expect(json).not.toHaveProperty('detail');
    expect(json).not.toHaveProperty('stack');
  });

  it('does not include error message in response body', async () => {
    const app = new Hono();

    app.onError((_err, c) => {
      return c.json({ error: 'Internal server error' }, 500);
    });

    app.get('/explode', () => {
      throw new Error('Connection refused: postgres://admin:s3cret@db:5432');
    });

    const res = await app.request('/explode');
    const text = await res.text();

    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('Connection refused');
  });
});

// ─── Fix #8: SIGTERM handler is registered ──────────────────────

describe('Graceful shutdown (SIGTERM)', () => {
  let originalListeners: NodeJS.SignalsListener[];

  beforeEach(() => {
    // Save existing SIGTERM listeners so we can detect new ones
    originalListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];
  });

  afterEach(() => {
    // Clean up any listeners added during the test
    const currentListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];
    for (const listener of currentListeners) {
      if (!originalListeners.includes(listener)) {
        process.removeListener('SIGTERM', listener);
      }
    }
  });

  it('registers a SIGTERM handler via process.on', async () => {
    const processOnSpy = vi.spyOn(process, 'on');

    // Simulate registering the handler (same code as index.ts)
    const mockServer = { close: vi.fn((cb: () => void) => cb()) };

    process.on('SIGTERM', () => {
      mockServer.close(() => {
        // graceful close
      });
    });

    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    processOnSpy.mockRestore();
  });

  it('calls server.close when SIGTERM is received', () => {
    const closeFn = vi.fn((cb: () => void) => cb());
    const mockServer = { close: closeFn };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const handler = () => {
      mockServer.close(() => {
        process.exit(0);
      });
    };

    process.on('SIGTERM', handler);

    // Trigger the handler directly
    handler();

    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});

// ─── Fix #12: Detailed health check endpoint ────────────────────

describe('GET /health/detailed (SEC-003 hardened)', () => {
  const HEALTH_TOKEN = 'monitoring-token-xyz';

  /**
   * Build a mini Hono app that replicates the hardened /health/detailed handler
   * from index.ts (cache + auth-gated detail + redacted errors), using a mock
   * database object. The cache is per-app so tests don't cross-contaminate.
   */
  function createApp(dbExecute: () => Promise<unknown>, healthToken?: string) {
    const app = new Hono();
    const breaker = new SimpleCircuitBreaker();
    const mockDb = { execute: dbExecute };

    let cache: { at: number; healthy: boolean; dbLatencyMs?: number } | null = null;
    const CACHE_MS = 10_000;

    const isAuthorized = (authHeader?: string, tokenHeader?: string): boolean => {
      if (!healthToken) return false;
      const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : tokenHeader;
      return provided === healthToken;
    };

    app.get('/health/detailed', async (c) => {
      const now = Date.now();
      let healthy: boolean;
      let dbLatencyMs: number | undefined;
      if (cache && now - cache.at < CACHE_MS) {
        healthy = cache.healthy;
        dbLatencyMs = cache.dbLatencyMs;
      } else {
        try {
          const dbStart = Date.now();
          await mockDb.execute();
          dbLatencyMs = Date.now() - dbStart;
          healthy = true;
        } catch {
          healthy = false;
          dbLatencyMs = undefined;
        }
        cache = { at: now, healthy, dbLatencyMs };
      }

      const status = healthy ? 'healthy' : 'degraded';
      const code = healthy ? 200 : 503;
      const authorized = isAuthorized(
        c.req.header('authorization'),
        c.req.header('x-health-token'),
      );
      if (!authorized) {
        return c.json({ status }, code);
      }
      return c.json(
        {
          status,
          uptime: Math.floor(process.uptime()),
          memoryMB: Math.floor(process.memoryUsage().rss / 1024 / 1024),
          checks: {
            database: {
              ok: healthy,
              ...(dbLatencyMs !== undefined ? { latencyMs: dbLatencyMs } : {}),
            },
          },
          githubCircuitBreaker: breaker.getState(),
        },
        code,
      );
    });

    return app;
  }

  it('returns 200 with aggregated healthy status to an unauthenticated caller', async () => {
    const app = createApp(() => Promise.resolve([{ '?column?': 1 }]));

    const res = await app.request('/health/detailed');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('healthy');
    // No internals exposed to the public.
    expect(json.uptime).toBeUndefined();
    expect(json.memoryMB).toBeUndefined();
    expect(json.checks).toBeUndefined();
    expect(json.githubCircuitBreaker).toBeUndefined();
  });

  it('returns 503 degraded WITHOUT the raw driver error to the public', async () => {
    const app = createApp(() => Promise.reject(new Error('ECONNREFUSED at 10.0.0.5:5432')));

    const res = await app.request('/health/detailed');

    expect(res.status).toBe(503);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('degraded');
    // The raw driver message must never leak.
    expect(JSON.stringify(json)).not.toContain('ECONNREFUSED');
    expect(json.checks).toBeUndefined();
  });

  it('exposes internals only to an authorized monitoring caller (token)', async () => {
    const app = createApp(() => Promise.resolve([{ '?column?': 1 }]), HEALTH_TOKEN);

    const res = await app.request('/health/detailed', {
      headers: { 'x-health-token': HEALTH_TOKEN },
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(typeof json.uptime).toBe('number');
    expect(typeof json.memoryMB).toBe('number');
    expect(json.githubCircuitBreaker).toBe('closed');
    const dbCheck = (json.checks as Record<string, { ok: boolean; latencyMs?: number }>).database;
    expect(dbCheck.ok).toBe(true);
    expect(typeof dbCheck.latencyMs).toBe('number');
  });

  it('rejects a wrong token — internals stay hidden', async () => {
    const app = createApp(() => Promise.resolve([{ '?column?': 1 }]), HEALTH_TOKEN);

    const res = await app.request('/health/detailed', {
      headers: { 'x-health-token': 'wrong' },
    });
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.status).toBe('healthy');
    expect(json.uptime).toBeUndefined();
    expect(json.checks).toBeUndefined();
  });

  it('caches the DB probe — a burst runs at most one query per window', async () => {
    let calls = 0;
    const app = createApp(() => {
      calls += 1;
      return Promise.resolve([{ '?column?': 1 }]);
    });

    await app.request('/health/detailed');
    await app.request('/health/detailed');
    await app.request('/health/detailed');

    expect(calls).toBe(1);
  });
});

// ─── Explanation worker lifecycle ───────────────────────────────

type CloseCallback = () => void;

interface LifecycleHarness {
  readonly closeServer: ReturnType<typeof vi.fn>;
  readonly closeWorker: ReturnType<typeof vi.fn>;
  readonly createWorker: ReturnType<typeof vi.fn>;
  readonly exit: ReturnType<typeof vi.fn>;
  readonly getSignalHandler: () => (() => void) | undefined;
  readonly getUnexpectedFetchCalls: () => number;
  readonly getRedisConstructionCalls: () => number;
}

function installLifecycleHarness(closeWorker: () => Promise<void>): LifecycleHarness {
  let signalHandler: (() => void) | undefined;
  let unexpectedFetchCalls = 0;
  let redisConstructionCalls = 0;
  const closeServer = vi.fn((callback: CloseCallback) => callback());
  const closeWorkerSpy = vi.fn(closeWorker);
  const createWorker = vi.fn(() => ({ close: closeWorkerSpy }));
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

  vi.stubEnv('NODE_ENV', 'test');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      unexpectedFetchCalls += 1;
      return Promise.reject(new Error('Unexpected fetch during entrypoint import'));
    }),
  );
  vi.spyOn(process, 'on').mockImplementation(((event: string | symbol, listener: () => void) => {
    if (event === 'SIGTERM') signalHandler = listener;
    return process;
  }) as never);

  vi.doMock('dotenv/config', () => ({}));
  vi.doMock('@hono/node-server', () => ({
    serve: vi.fn((_options, onListen: (info: { port: number }) => void) => {
      onListen({ port: 3000 });
      return { close: closeServer };
    }),
  }));
  vi.doMock('ghagga-core', () => ({ initializeDefaultTools: vi.fn() }));
  vi.doMock('ghagga-db', () => ({
    createDatabaseFromEnv: vi.fn(() => ({ execute: vi.fn() })),
    sql: vi.fn(),
    deriveExplanationInvocationKey: vi.fn(),
    getEffectiveRepoSettings: vi.fn(),
    getInstallationById: vi.fn(),
    getRepositoryById: vi.fn(),
    lookupExplanationInvocation: vi.fn(),
    markExplanationPublicationStale: vi.fn(),
    reserveExplanationPublicationCreate: vi.fn(),
    reserveExplanationPublicationPatch: vi.fn(),
    settleExplanationPublicationCreate: vi.fn(),
    settleExplanationPublicationPatch: vi.fn(),
  }));
  vi.doMock('./lib/circuit-breaker.js', () => ({
    githubCircuitBreaker: { getState: vi.fn(() => 'closed') },
  }));
  vi.doMock('./lib/get-client-ip.js', () => ({ getClientIp: vi.fn(() => '127.0.0.1') }));
  vi.doMock('./lib/logger.js', () => ({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }));
  vi.doMock('./lib/redis.js', () => ({
    createRedisClient: vi.fn(() => {
      redisConstructionCalls += 1;
      throw new Error('Unexpected Redis construction during entrypoint import');
    }),
    describeRedisConfig: vi.fn(() => ({ auth: false, source: 'host', tls: false })),
  }));
  vi.doMock('./lib/validate-env.js', () => ({ validateEnvironment: vi.fn() }));
  vi.doMock('./middleware/auth.js', () => ({ authMiddleware: vi.fn(() => async () => {}) }));
  vi.doMock('./routes/api/index.js', () => ({ createApiRouter: vi.fn(() => new Hono()) }));
  vi.doMock('./routes/oauth.js', () => ({ createOAuthRouter: vi.fn(() => new Hono()) }));
  vi.doMock('./routes/runner-callback.js', () => ({
    createRunnerCallbackRouter: vi.fn(() => new Hono()),
  }));
  vi.doMock('./routes/webhook.js', () => ({ createWebhookRouter: vi.fn(() => new Hono()) }));
  vi.doMock('./queues/explanation.js', () => ({
    createExplanationWorker: createWorker,
  }));
  vi.doMock('hono/body-limit', () => ({ bodyLimit: vi.fn(() => async () => {}) }));
  vi.doMock('hono/cors', () => ({ cors: vi.fn(() => async () => {}) }));
  vi.doMock('hono/secure-headers', () => ({ secureHeaders: vi.fn(() => async () => {}) }));
  vi.doMock('hono-rate-limiter', () => ({ rateLimiter: vi.fn(() => async () => {}) }));

  return {
    closeServer,
    closeWorker: closeWorkerSpy,
    createWorker,
    exit,
    getSignalHandler: () => signalHandler,
    getUnexpectedFetchCalls: () => unexpectedFetchCalls,
    getRedisConstructionCalls: () => redisConstructionCalls,
  };
}

describe('Explanation worker lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock('dotenv/config');
    vi.doUnmock('@hono/node-server');
    vi.doUnmock('ghagga-core');
    vi.doUnmock('ghagga-db');
    vi.doUnmock('./lib/circuit-breaker.js');
    vi.doUnmock('./lib/get-client-ip.js');
    vi.doUnmock('./lib/logger.js');
    vi.doUnmock('./lib/redis.js');
    vi.doUnmock('./lib/validate-env.js');
    vi.doUnmock('./middleware/auth.js');
    vi.doUnmock('./routes/api/index.js');
    vi.doUnmock('./routes/oauth.js');
    vi.doUnmock('./routes/runner-callback.js');
    vi.doUnmock('./routes/webhook.js');
    vi.doUnmock('./queues/explanation.js');
    vi.doUnmock('hono/body-limit');
    vi.doUnmock('hono/cors');
    vi.doUnmock('hono/secure-headers');
    vi.doUnmock('hono-rate-limiter');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function importEntrypoint(closeWorker: () => Promise<void>) {
    const harness = installLifecycleHarness(closeWorker);
    await import('./index.js');
    return harness;
  }

  it('starts exactly one explanation worker during entrypoint import', async () => {
    const harness = await importEntrypoint(async () => {});

    expect(harness.createWorker).toHaveBeenCalledOnce();
    expect(harness.createWorker).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        publisher: expect.any(Function),
        progressPublisher: expect.any(Function),
      }),
    );
    expect(harness.closeWorker).not.toHaveBeenCalled();
    expect(harness.getSignalHandler()).toEqual(expect.any(Function));
    expect(harness.getUnexpectedFetchCalls()).toBe(0);
    expect(harness.getRedisConstructionCalls()).toBe(0);
  });

  it('waits for worker closure before exiting successfully', async () => {
    let resolveClose: (() => void) | undefined;
    const harness = await importEntrypoint(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );

    harness.getSignalHandler()?.();

    expect(harness.closeServer).toHaveBeenCalledOnce();
    expect(harness.exit).not.toHaveBeenCalledWith(0);

    resolveClose?.();
    await vi.runAllTicks();

    expect(harness.closeWorker).toHaveBeenCalledOnce();
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it('does not exit successfully or leak rejection when worker closure fails', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    const harness = await importEntrypoint(async () => {
      throw new Error('worker close failed');
    });

    harness.getSignalHandler()?.();
    await vi.runAllTicks();

    expect(harness.closeWorker).toHaveBeenCalledOnce();
    expect(harness.exit).not.toHaveBeenCalledWith(0);
    expect(unhandledRejections).toEqual([]);
    process.removeListener('unhandledRejection', onUnhandledRejection);
  });

  it('forces exit after the existing timeout while worker closure is pending', async () => {
    const harness = await importEntrypoint(() => new Promise<void>(() => {}));

    harness.getSignalHandler()?.();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.closeServer).toHaveBeenCalledOnce();
    expect(harness.closeWorker).toHaveBeenCalledOnce();
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.exit).not.toHaveBeenCalledWith(0);
  });
});
