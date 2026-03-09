/**
 * Runner callback route.
 *
 * Receives results from the GitHub Actions runner workflow.
 * Authenticates via per-dispatch HMAC signatures
 * (not the user session auth middleware).
 *
 * Supports two callback types:
 *   - Static analysis (default): payloads without executionKind
 *   - Delegated CI: payloads with executionKind: 'delegated-ci'
 *
 * POST /runner/callback
 *
 * Headers:
 *   x-ghagga-signature: sha256=<hex>   — HMAC of raw body using per-dispatch secret
 *
 * Body (JSON):
 *   Static analysis:
 *     callbackId: string
 *     repoFullName: string
 *     prNumber: number
 *     headSha: string
 *     staticAnalysis: StaticAnalysisResult
 *
 *   Delegated CI:
 *     executionKind: 'delegated-ci'
 *     callbackId: string
 *     repoFullName: string
 *     jobKey: string
 *     state: 'running' | 'completed' | 'failed'
 *     startedAt?: string
 *     completedAt?: string
 *     durationMs?: number
 *     summary?: string
 *     outcome?: 'success' | 'failure'
 *     errorCode?: string
 *     errorMessage?: string
 */

import type { StaticAnalysisResult } from 'ghagga-core';
import { Hono } from 'hono';
import { verifyCallbackSignature } from '../github/runner.js';
import { inngest } from '../inngest/client.js';
import { logger as rootLogger } from '../lib/logger.js';

const logger = rootLogger.child({ module: 'runner-callback' });

// ─── Payload Types ──────────────────────────────────────────────

interface StaticAnalysisCallbackPayload {
  executionKind?: undefined;
  callbackId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  staticAnalysis: StaticAnalysisResult;
}

interface DelegatedCiCallbackPayload {
  executionKind: 'delegated-ci';
  callbackId: string;
  repoFullName: string;
  jobKey: string;
  state: 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  summary?: string;
  outcome?: 'success' | 'failure';
  errorCode?: string;
  errorMessage?: string;
}

type CallbackPayload = StaticAnalysisCallbackPayload | DelegatedCiCallbackPayload;

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

    // Validate common required fields
    const { callbackId, repoFullName } = payload;

    if (payload.executionKind === 'delegated-ci') {
      // ── Delegated CI callback ──
      if (!callbackId || !repoFullName || !payload.jobKey || !payload.state) {
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

      // Emit delegated CI callback event
      await inngest.send({
        name: 'ghagga/delegated-ci.callback',
        data: {
          callbackId: payload.callbackId,
          repoFullName: payload.repoFullName,
          jobKey: payload.jobKey,
          state: payload.state,
          startedAt: payload.startedAt,
          completedAt: payload.completedAt,
          durationMs: payload.durationMs,
          summary: payload.summary,
          outcome: payload.outcome,
          errorCode: payload.errorCode,
          errorMessage: payload.errorMessage,
        },
      });

      logger.info(
        { callbackId, repoFullName, jobKey: payload.jobKey, state: payload.state },
        'Delegated CI callback accepted — dispatched Inngest event',
      );
    } else {
      // ── Static analysis callback (existing behavior) ──
      const saPayload = payload as StaticAnalysisCallbackPayload;
      const { prNumber, headSha, staticAnalysis } = saPayload;

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

      // Send Inngest event to resume the waiting review function
      await inngest.send({
        name: 'ghagga/runner.completed',
        data: {
          callbackId,
          repoFullName,
          prNumber,
          headSha,
          staticAnalysis,
        },
      });

      logger.info(
        { callbackId, repoFullName, prNumber },
        'Runner callback accepted — dispatched Inngest event',
      );
    }

    return c.json({ ok: true });
  });

  return router;
}
