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

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { logger as rootLogger } from '../lib/logger.js';

const logger = rootLogger.child({ module: 'oauth' });

/** GHAGGA GitHub App Client ID (public, overridable via env) */
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';

/** Server base URL for OAuth redirect_uri */
const SERVER_URL = process.env.SERVER_URL ?? 'https://api.javierzader.com';

/** Dashboard URL for redirects after OAuth callback */
const DASHBOARD_URL = 'https://ghagga.javierzader.com/app';

/** State expiration time: 5 minutes in milliseconds */
const STATE_TTL_MS = 5 * 60 * 1000;

/**
 * Domain-separation label for the OAuth state signing key (SEC-006). The OAuth
 * key and the runner-callback key are BOTH derived from STATE_SECRET but with
 * distinct domain labels, so a signature minted for one context can never be
 * replayed as a valid signature for the other.
 */
const OAUTH_STATE_DOMAIN = 'ghagga.oauth.state.v1';

/**
 * Name of the browser-binding cookie. It carries the state nonce so the
 * callback can prove the request originated from the SAME browser that started
 * the login (defeats login-CSRF / account confusion — SEC-002).
 */
const STATE_COOKIE = 'ghagga_oauth_state';

// ── State HMAC helpers (exported for testing) ───────────────────

/** Derive the domain-separated OAuth state signing key from STATE_SECRET. */
function oauthStateKey(secret: string): string {
  return createHmac('sha256', secret).update(OAUTH_STATE_DOMAIN).digest('hex');
}

/** Constant-time string comparison that never throws on length mismatch. */
function safeStrEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Generate a single-use, HMAC-signed state parameter for CSRF protection.
 * Format: `{timestamp_base36}.{nonce_hex}.{hmac_sha256_hex}`.
 *
 * The nonce is a 16-byte CSPRNG value. At /auth/login it is ALSO written to the
 * `HttpOnly Secure SameSite=Lax` state cookie, binding the callback to the
 * originating browser and making the state single-use (the cookie is cleared on
 * consume). The HMAC is computed over `timestamp.nonce` with the
 * domain-separated OAuth key.
 */
export function generateState(secret: string): string {
  const timestamp = Date.now().toString(36);
  const nonce = randomBytes(16).toString('hex');
  const hmac = createHmac('sha256', oauthStateKey(secret))
    .update(`${timestamp}.${nonce}`)
    .digest('hex');
  return `${timestamp}.${nonce}.${hmac}`;
}

/**
 * Validate a state parameter: format, HMAC signature, and expiration.
 *
 * Uses timingSafeEqual to prevent timing attacks. Rejects FUTURE timestamps
 * (`elapsed < 0`) as well as expired ones, so a validly-signed state with a
 * fabricated future timestamp can no longer stay acceptable past its real TTL.
 *
 * Returns the decoded `nonce` on success so the caller can enforce the
 * browser-binding cookie check.
 */
export function validateState(
  state: string,
  secret: string,
): { valid: boolean; error?: string; nonce?: string } {
  const parts = state.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'invalid_state' };
  }

  const [ts, nonce, sig] = parts;

  // Nonce must be a 16-byte hex value — a malformed nonce is a tampered state.
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { valid: false, error: 'invalid_state' };
  }

  // Recompute expected HMAC over `timestamp.nonce` with the domain-separated key.
  const expectedSig = createHmac('sha256', oauthStateKey(secret))
    .update(`${ts}.${nonce}`)
    .digest('hex');

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

  // Timestamp must parse and fall within [now - TTL, now]. A future timestamp
  // (elapsed < 0) is rejected outright.
  const issuedAt = parseInt(ts, 36);
  if (Number.isNaN(issuedAt)) {
    return { valid: false, error: 'invalid_state' };
  }
  const elapsed = Date.now() - issuedAt;
  if (elapsed < 0) {
    return { valid: false, error: 'invalid_state' };
  }
  if (elapsed > STATE_TTL_MS) {
    return { valid: false, error: 'state_expired' };
  }

  return { valid: true, nonce };
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
    // Bind the flow to THIS browser: the state nonce is mirrored into an
    // HttpOnly Secure SameSite=Lax cookie the callback must present (SEC-002).
    const nonce = state.split('.')[1] ?? '';
    setCookie(c, STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/auth',
      maxAge: Math.floor(STATE_TTL_MS / 1000),
    });

    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${SERVER_URL}/auth/callback`);
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

    // Browser binding + single-use (SEC-002): the state nonce MUST match the
    // HttpOnly cookie set at /auth/login, proving this callback belongs to the
    // browser that started the flow. Consume the cookie immediately so the same
    // state can never be replayed from this browser.
    const cookieNonce = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/auth' });
    if (!cookieNonce || !stateResult.nonce || !safeStrEqual(cookieNonce, stateResult.nonce)) {
      logger.warn('OAuth callback state failed browser-binding check');
      return c.redirect(`${DASHBOARD_URL}/#/auth/callback?error=invalid_state`, 302);
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
          // Send the SAME redirect_uri used in the authorize step — GitHub
          // requires it to match when it was supplied at authorize time.
          redirect_uri: `${SERVER_URL}/auth/callback`,
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
