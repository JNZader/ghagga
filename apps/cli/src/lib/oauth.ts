/**
 * GitHub OAuth Device Flow for CLI authentication.
 *
 * Implements RFC 8628 (Device Authorization Grant) against GitHub's
 * OAuth endpoints. The user visits github.com/login/device, enters
 * a short code, and the CLI receives an access token.
 *
 * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

/** GHAGGA GitHub App Client ID (public — safe to embed in code) */
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv23liP63ERrlq0eMUfk';

// ─── Types ──────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

export interface DeviceFlowError {
  error: string;
  error_description?: string;
  interval?: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
}

// ─── Device Flow Steps ──────────────────────────────────────────

/**
 * Step 1: Request device and user verification codes from GitHub.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: '', // No scopes needed — GitHub Models uses the token as-is
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to request device code: ${response.status} ${text}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

/**
 * Step 3: Poll GitHub for the access token until the user authorizes.
 *
 * Respects the polling interval and handles slow_down errors by
 * increasing the interval as required by the spec.
 *
 * @param deviceCode - The device_code from Step 1
 * @param interval - Polling interval in seconds from Step 1
 * @param expiresIn - Expiration time in seconds from Step 1
 * @returns The access token on success
 * @throws On timeout, access_denied, or other fatal errors
 */
export async function pollForAccessToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<AccessTokenResponse> {
  let currentInterval = interval;
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    // Wait for the polling interval
    await sleep(currentInterval * 1000);

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = (await response.json()) as AccessTokenResponse | DeviceFlowError;

    // Check if we got a token
    if ('access_token' in data && data.access_token) {
      return data as AccessTokenResponse;
    }

    // Handle error responses
    const error = data as DeviceFlowError;

    switch (error.error) {
      case 'authorization_pending':
        // User hasn't entered the code yet — keep polling
        continue;

      case 'slow_down':
        // GitHub wants us to slow down — add 5 seconds
        currentInterval = (error.interval ?? currentInterval) + 5;
        continue;

      case 'expired_token':
        throw new Error('Device code expired. Please try logging in again.');

      case 'access_denied':
        throw new Error('Authorization was denied. The user cancelled the login.');

      default:
        throw new Error(
          `OAuth error: ${error.error}${error.error_description ? ` — ${error.error_description}` : ''}`,
        );
    }
  }

  throw new Error('Device code expired (timeout). Please try logging in again.');
}

// ─── GitHub API ─────────────────────────────────────────────────

/**
 * Fetch the authenticated user's profile from GitHub API.
 */
export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'GHAGGA-CLI/2.0.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub user: ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}

// ─── Helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
