/**
 * CORS restriction middleware tests.
 *
 * Verifies that CORS middleware only allows configured origins,
 * handles preflight requests, respects ALLOWED_ORIGINS env var,
 * and allows localhost in dev mode.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ─── Helper to build app with CORS ─────────────────────────────

function getAllowedOrigins(): string[] {
  const envOrigins = process.env.ALLOWED_ORIGINS;
  if (envOrigins) {
    return envOrigins.split(',').map((o) => o.trim());
  }
  const defaults = ['https://jnzader.github.io', 'https://api.javierzader.com'];
  if (process.env.NODE_ENV !== 'production') {
    defaults.push('http://localhost:3000', 'http://localhost:5173');
  }
  return defaults;
}

function createApp() {
  const app = new Hono();

  app.use(
    '*',
    cors({
      origin: (origin) => {
        const allowed = getAllowedOrigins();
        return allowed.includes(origin) ? origin : '';
      },
      credentials: true,
    }),
  );

  app.get('/api/reviews', (c) => c.json({ data: [] }));

  return app;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('CORS Restriction', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;
    savedEnv.NODE_ENV = process.env.NODE_ENV;
    delete process.env.ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (savedEnv.ALLOWED_ORIGINS !== undefined) {
      process.env.ALLOWED_ORIGINS = savedEnv.ALLOWED_ORIGINS;
    } else {
      delete process.env.ALLOWED_ORIGINS;
    }
    if (savedEnv.NODE_ENV !== undefined) {
      process.env.NODE_ENV = savedEnv.NODE_ENV;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  describe('Request from allowed origin', () => {
    it('should include Access-Control-Allow-Origin for allowed origin', async () => {
      const app = createApp();
      const res = await app.request('/api/reviews', {
        headers: { Origin: 'https://jnzader.github.io' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://jnzader.github.io');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });
  });

  describe('Request from non-allowed origin', () => {
    it('should NOT include Access-Control-Allow-Origin for blocked origin', async () => {
      const app = createApp();
      const res = await app.request('/api/reviews', {
        headers: { Origin: 'https://evil.example.com' },
      });

      expect(res.status).toBe(200);
      // Hono sets empty string when origin is rejected — browser blocks it
      const acao = res.headers.get('access-control-allow-origin');
      expect(acao === null || acao === '').toBe(true);
    });
  });

  describe('Preflight OPTIONS request from allowed origin', () => {
    it('should return 204 with correct CORS headers', async () => {
      const app = createApp();
      const res = await app.request('/api/reviews', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://jnzader.github.io',
          'Access-Control-Request-Method': 'GET',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://jnzader.github.io');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      expect(res.headers.get('access-control-allow-methods')).toBeTruthy();
    });
  });

  describe('ALLOWED_ORIGINS env var overrides defaults', () => {
    it('should allow custom origin and block default origin', async () => {
      process.env.ALLOWED_ORIGINS = 'https://custom.example.com,https://other.example.com';

      const app = createApp();

      // Custom origin should be allowed
      const resCustom = await app.request('/api/reviews', {
        headers: { Origin: 'https://custom.example.com' },
      });
      expect(resCustom.headers.get('access-control-allow-origin')).toBe(
        'https://custom.example.com',
      );

      // Default origin should be blocked
      const resDefault = await app.request('/api/reviews', {
        headers: { Origin: 'https://jnzader.github.io' },
      });
      const acao = resDefault.headers.get('access-control-allow-origin');
      expect(acao === null || acao === '').toBe(true);
    });
  });

  describe('Dev mode allows localhost origins', () => {
    it('should allow localhost:5173 when NODE_ENV is not production', async () => {
      process.env.NODE_ENV = 'development';

      const app = createApp();
      const res = await app.request('/api/reviews', {
        headers: { Origin: 'http://localhost:5173' },
      });

      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('should NOT allow localhost:5173 when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';

      const app = createApp();
      const res = await app.request('/api/reviews', {
        headers: { Origin: 'http://localhost:5173' },
      });

      const acao = res.headers.get('access-control-allow-origin');
      expect(acao === null || acao === '').toBe(true);
    });
  });
});
