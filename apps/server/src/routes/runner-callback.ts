/**
 * Runner callback route.
 *
 * Receives static-analysis results from the GitHub Actions runner workflow.
 * Authenticates via per-dispatch HMAC signatures
 * (not the user session auth middleware).
 *
 * POST /runner/callback
 *
 * Headers:
 *   x-ghagga-signature: sha256=<hex>   — HMAC of raw body using per-dispatch secret
 *
 * Body (JSON):
 *   callbackId: string
 *   repoFullName: string
 *   prNumber: number
 *   headSha: string
 *   staticAnalysis: StaticAnalysisResult
 */

import type { StaticAnalysisResult } from 'ghagga-core';
import { Hono } from 'hono';
import { verifyCallbackSignature } from '../github/runner.js';
import { logger as rootLogger } from '../lib/logger.js';
import { CALLBACK_RESULT_TTL, callbackResultKey, redis } from '../lib/redis.js';

const logger = rootLogger.child({ module: 'runner-callback' });

// ─── Payload Types ──────────────────────────────────────────────

interface StaticAnalysisCallbackPayload {
  callbackId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  staticAnalysis: StaticAnalysisResult;
}

type CallbackPayload = StaticAnalysisCallbackPayload;

export function createRunnerCallbackRouter() {
  const router = new Hono();

  router.post('/runner/callback', async (c) => {
    // Read raw body for HMAC verification
    const rawBody = await c.req.text();

    // Parse the body
    let payload: CallbackPayload;
    try {
      payload = JSON.parse(rawBody) as CallbackPayload;
    } catch {
      logger.warn('Runner callback: invalid JSON body');
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // Validate required fields
    const { callbackId, repoFullName, prNumber, headSha, staticAnalysis } = payload;

    if (!callbackId || !repoFullName || !prNumber || !headSha || !staticAnalysis) {
      logger.warn({ callbackId }, 'Runner callback: missing required fields');
      return c.json({ error: 'Missing required fields' }, 400);
    }

    // Verify HMAC signature
    const signature = c.req.header('x-ghagga-signature');
    if (!signature) {
      logger.warn({ callbackId }, 'Runner callback: missing x-ghagga-signature header');
      return c.json({ error: 'Missing signature' }, 401);
    }

    const valid = verifyCallbackSignature(callbackId, rawBody, signature);
    if (!valid) {
      logger.warn({ callbackId }, 'Runner callback: HMAC verification failed');
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Write static analysis results to Redis for the BullMQ worker to pick up
    await redis.set(
      callbackResultKey(callbackId),
      JSON.stringify(staticAnalysis),
      'EX',
      CALLBACK_RESULT_TTL,
    );

    logger.info(
      { callbackId, repoFullName, prNumber, staticAnalysisTools: Object.keys(staticAnalysis) },
      'Runner callback accepted — static analysis results stored in Redis',
    );

    return c.json({ ok: true });
  });

  return router;
}
