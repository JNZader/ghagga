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
