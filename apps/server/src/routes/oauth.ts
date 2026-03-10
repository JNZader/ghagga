/**
 * OAuth routes for the dashboard.
 *
 * Two flows are supported:
 *
 * 1. **Device Flow** (for CLI and fallback): The dashboard cannot call
 *    github.com directly due to CORS restrictions. These endpoints proxy
 *    the GitHub Device Flow requests through the GHAGGA server.
 *
 * 2. **Web Flow** (primary for Dashboard): Standard OAuth Web Flow where
 *    the server acts as callback endpoint. `/auth/login` redirects to
 *    GitHub, `/auth/callback` exchanges the code for a token and redirects
 *    back to the Dashboard with the token in the URL fragment.
 *
 * No auth middleware — these are public endpoints used BEFORE
 * the user is authenticated.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { logger as rootLogger } from '../lib/logger.js';

const logger = rootLogger.child({ module: 'oauth' });

/** GHAGGA GitHub App Client ID (public, overridable via env) */
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv23liP63ERrlq0eMUfk';

/** Dashboard URL for redirects after OAuth callback */
const DASHBOARD_URL = 'https://jnzader.github.io/ghagga/app';

/** State expiration time: 5 minutes in milliseconds */
const STATE_TTL_MS = 5 * 60 * 1000;

// ── State HMAC helpers (exported for testing) ───────────────────

/**
 * Generate a stateless HMAC-signed state parameter for CSRF protection.
 * Format: `{timestamp_base36}.{hmac_sha256_hex}`
 */
export function generateState(secret: string): string {
  const timestamp = Date.now().toString(36);
  const hmac = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${hmac}`;
}

/**
 * Validate a state parameter: check format, HMAC signature, and expiration.
 * Uses timingSafeEqual to prevent timing attacks.
 */
export function validateState(state: string, secret: string): { valid: boolean; error?: string } {
  const parts = state.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'invalid_state' };
  }

  const [ts, sig] = parts;

  // Recompute expected HMAC
  const expectedSig = createHmac('sha256', secret).update(ts).digest('hex');

  // Timing-safe comparison (throws if buffer lengths differ)
  try {
    const sigBuffer = Buffer.from(sig, 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');
    if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
      return { valid: false, error: 'invalid_state' };
    }
  } catch {
    return { valid: false, error: 'invalid_state' };
  }

  // Check expiration
  const elapsed = Date.now() - parseInt(ts, 36);
  if (elapsed > STATE_TTL_MS) {
    return { valid: false, error: 'state_expired' };
  }

  return { valid: true };
}

export function createOAuthRouter() {
  const router = new Hono();

  // ── POST /auth/device/code ──────────────────────────────────
  // Proxy: request device + user verification codes from GitHub
  router.post('/auth/device/code', async (c) => {
    try {
      const response = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          scope: 'public_repo',
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return c.json({ error: 'github_error', message: text }, response.status as 400 | 500);
      }

      const data = await response.json();
      return c.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'proxy_error', message }, 502);
    }
  });

  // ── POST /auth/device/token ─────────────────────────────────
  // Proxy: poll for access token after user enters the code
  router.post('/auth/device/token', async (c) => {
    let body: { device_code?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'Invalid JSON body' }, 400);
    }

    if (!body.device_code) {
      return c.json({ error: 'missing_field', message: 'device_code is required' }, 400);
    }

    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: body.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return c.json({ error: 'github_error', message: text }, response.status as 400 | 500);
      }

      const data = await response.json();
      return c.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'proxy_error', message }, 502);
    }
  });

  // ── GET /auth/login ──────────────────────────────────────────
  // Web Flow: redirect user to GitHub authorize URL with HMAC state
  router.get('/auth/login', (c) => {
    const STATE_SECRET = process.env.STATE_SECRET;
    if (!STATE_SECRET) {
      const errorId = randomUUID().slice(0, 8);
      logger.error({ errorId }, 'STATE_SECRET is not configured');
      return c.json(
        {
          error: 'INTERNAL_ERROR',
          message: 'STATE_SECRET is not configured',
          errorId,
        },
        500,
      );
    }

    const state = generateState(STATE_SECRET);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', 'https://ghagga.onrender.com/auth/callback');
    url.searchParams.set('scope', 'public_repo');
    url.searchParams.set('state', state);

    return c.redirect(url.toString(), 302);
  });

  // ── GET /auth/callback ─────────────────────────────────────────
  // Web Flow: validate state, exchange code for token, redirect to Dashboard
  router.get('/auth/callback', async (c) => {
    const state = c.req.query('state');
    const code = c.req.query('code');

    // Missing state
    if (!state) {
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=missing_state`, 302);
    }

    // Missing code — check if GitHub sent access_denied
    if (!code) {
      const ghError = c.req.query('error');
      if (ghError === 'access_denied') {
        return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=access_denied`, 302);
      }
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=missing_code`, 302);
    }

    // Validate state HMAC + expiration
    const STATE_SECRET = process.env.STATE_SECRET;
    if (!STATE_SECRET) {
      logger.error('STATE_SECRET is not configured');
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=server_error`, 302);
    }
    const stateResult = validateState(state, STATE_SECRET);
    if (!stateResult.valid) {
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=${stateResult.error}`, 302);
    }

    // Check CLIENT_SECRET
    const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
    if (!GITHUB_CLIENT_SECRET) {
      logger.error('GITHUB_CLIENT_SECRET is not configured');
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=server_error`, 302);
    }

    // Exchange code for access token
    let data: { access_token?: string; error?: string };
    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          client_secret: GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      if (!response.ok) {
        return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=exchange_failed`, 302);
      }

      data = (await response.json()) as { access_token?: string; error?: string };
    } catch {
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=github_unavailable`, 302);
    }

    // GitHub returns 200 with error field for invalid codes
    if (data.error || !data.access_token) {
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=exchange_failed`, 302);
    }

    // Success — redirect to Dashboard with token in fragment
    return c.redirect(`${DASHBOARD_URL}/#/auth/callback?token=${data.access_token}`, 302);
  });

  return router;
}
