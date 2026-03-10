/**
 * @ghagga/server — Hono API server entry point.
 *
 * Serves the GitHub webhook endpoint, Inngest durable functions,
 * and the dashboard REST API.
 */

import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { initializeDefaultTools } from 'ghagga-core';
import { createDatabaseFromEnv, sql } from 'ghagga-db';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { rateLimiter } from 'hono-rate-limiter';
import { githubCircuitBreaker } from './lib/circuit-breaker.js';
import { getClientIp } from './lib/get-client-ip.js';
import { logger } from './lib/logger.js';
import { validateEnvironment } from './lib/validate-env.js';
import { authMiddleware } from './middleware/auth.js';
import { createApiRouter } from './routes/api/index.js';
import { createOAuthRouter } from './routes/oauth.js';
import { createRunnerCallbackRouter } from './routes/runner-callback.js';
import { createWebhookRouter } from './routes/webhook.js';

// ─── Validate required env vars (fail-fast) ────────────────────

validateEnvironment();

// ─── Tool Registry ─────────────────────────────────────────────
// Populate the singleton registry so GET /api/settings returns
// the full tool list and the dashboard renders ToolGrid instead
// of the legacy 3-checkbox UI.
initializeDefaultTools();

// ─── Database ───────────────────────────────────────────────────

const db = createDatabaseFromEnv();

// ─── App ────────────────────────────────────────────────────────

const app = new Hono();

// ── Global error handler ────────────────────────────────────────
// Catches any unhandled error in routes/middleware and logs it.
// Includes an errorId for support correlation.
app.onError((err, c) => {
  const errorId = randomUUID().slice(0, 8);
  logger.error(
    { err, errorId, method: c.req.method, path: new URL(c.req.url).pathname },
    'Unhandled error',
  );

  return c.json({ error: 'INTERNAL_ERROR', message: 'Internal server error', errorId }, 500);
});

// ── Request logging middleware ───────────────────────────────────
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const path = new URL(c.req.url).pathname;
  const status = c.res.status;

  // Skip noisy health checks from keepalive
  if (path === '/health') return;

  const logData = { method: c.req.method, path, status, ms };
  if (status >= 500) {
    logger.error(logData, `${c.req.method} ${path} ${status} (${ms}ms)`);
  } else if (status >= 400) {
    logger.warn(logData, `${c.req.method} ${path} ${status} (${ms}ms)`);
  } else {
    logger.info(logData, `${c.req.method} ${path} ${status} (${ms}ms)`);
  }
});

// ── Security headers ────────────────────────────────────────────
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    referrerPolicy: 'strict-origin-when-cross-origin',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
    },
  }),
);

// ── Body size limits ────────────────────────────────────────────
// Webhook gets 5MB (GitHub payloads can be large); everything else gets 1MB.
// Applied as a conditional middleware to avoid double-matching on /webhook.
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const maxSize = path === '/webhook' ? 5 * 1024 * 1024 : 1024 * 1024;
  const limiter = bodyLimit({ maxSize });
  return limiter(c, next);
});

// ── CORS — restricted origins ───────────────────────────────────
function getAllowedOrigins(): string[] {
  const envOrigins = process.env.ALLOWED_ORIGINS;
  if (envOrigins) {
    return envOrigins.split(',').map((o) => o.trim());
  }
  const defaults = ['https://jnzader.github.io', 'https://ghagga.onrender.com'];
  if (process.env.NODE_ENV !== 'production') {
    defaults.push('http://localhost:3000', 'http://localhost:5173');
  }
  return defaults;
}

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

// ── Rate limiting ───────────────────────────────────────────────
const apiLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  keyGenerator: (c) => getClientIp(c),
  standardHeaders: 'draft-6',
});

const oauthLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: (c) => getClientIp(c),
  standardHeaders: 'draft-6',
});

const webhookLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 200,
  keyGenerator: (c) => getClientIp(c),
  standardHeaders: 'draft-6',
});

app.use('/api/*', apiLimiter);
app.use('/auth/*', oauthLimiter);
app.use('/webhook', webhookLimiter);

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Detailed health check — reports database, uptime, memory, and circuit breaker state
app.get('/health/detailed', async (c) => {
  const startTime = Date.now();

  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  // Database check
  try {
    const dbStart = Date.now();
    await db.execute(sql`SELECT 1`);
    checks.database = { ok: true, latencyMs: Date.now() - dbStart };
  } catch (e) {
    checks.database = { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }

  const healthy = Object.values(checks).every((check) => check.ok);

  return c.json(
    {
      status: healthy ? 'healthy' : 'degraded',
      uptime: Math.floor(process.uptime()),
      memoryMB: Math.floor(process.memoryUsage().rss / 1024 / 1024),
      checks,
      githubCircuitBreaker: githubCircuitBreaker.getState(),
      responseTimeMs: Date.now() - startTime,
    },
    healthy ? 200 : 503,
  );
});

// Static analysis tools run locally in the GitHub Action (not on this server)
app.get('/health/tools', (c) => {
  return c.json({
    architecture: 'github-action-local',
    note: 'Static analysis tools (Semgrep, Trivy, PMD/CPD) run locally in the GitHub Action on the PR runner.',
    tools: ['semgrep', 'trivy', 'cpd'],
  });
});

// Webhook routes (no auth required — verified by signature)
const webhookRouter = createWebhookRouter(db);
app.route('/', webhookRouter);

// OAuth proxy routes (no auth required — used during login)
const oauthRouter = createOAuthRouter();
app.route('/', oauthRouter);

// Runner callback route — intentionally outside /api/* namespace to avoid the
// session auth middleware at app.use('/api/*', authMiddleware). Uses per-dispatch HMAC auth.
const runnerCallbackRouter = createRunnerCallbackRouter();
app.route('/', runnerCallbackRouter);

// Dashboard API routes (auth required)
app.use('/api/*', authMiddleware(db));
const apiRouter = createApiRouter(db);
app.route('/', apiRouter);

// ─── Start Server ───────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? '3000', 10);

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, `Server running on http://localhost:${info.port}`);

  // Keepalive: self-ping every 5 minutes to prevent Render free tier cold starts.
  // Render spins down after 15 min of inactivity — webhooks would fail on cold start.
  if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
    const url = `${process.env.RENDER_EXTERNAL_URL}/health`;
    const FIVE_MINUTES = 5 * 60 * 1000;

    setInterval(async () => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(5_000) });
      } catch {
        // Silently ignore — if we can't reach ourselves, something else is wrong
      }
    }, FIVE_MINUTES);

    logger.info({ url, intervalMs: FIVE_MINUTES }, 'Keepalive enabled');
  }
});

// ─── Graceful Shutdown ──────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 30_000;

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, draining connections...');
  server.close(() => {
    logger.info('Server closed gracefully');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
});
