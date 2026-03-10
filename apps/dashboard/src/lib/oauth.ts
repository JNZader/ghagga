/**
 * GitHub OAuth helpers for the Dashboard (browser).
 *
 * The primary login flow is OAuth Web Flow — the user clicks
 * "Sign in with GitHub" and is redirected to the server's
 * `/auth/login` endpoint which handles the GitHub OAuth dance.
 *
 * When no server is available, the dashboard falls back to manual
 * PAT (Personal Access Token) entry.
 *
 * Note: Device Flow endpoints remain on the server for CLI use,
 * but the Dashboard no longer uses them directly.
 */

/** GHAGGA GitHub App Client ID (public, overridable via env) */
export const GITHUB_CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID ?? 'Iv23liP63ERrlq0eMUfk';

/** Server base URL — used for OAuth and API endpoints */
export const API_URL =
  import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://ghagga.onrender.com');

// ─── Types ──────────────────────────────────────────────────────

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
}

// ─── Server Availability ────────────────────────────────────────

/**
 * Check if the GHAGGA backend server is reachable.
 * Returns true if the server responds to /health within 3 seconds.
 */
export async function isServerAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${API_URL}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

// ─── GitHub API (direct — api.github.com supports CORS) ─────────

/**
 * Fetch the authenticated user's GitHub profile.
 * This calls api.github.com directly (supports CORS).
 */
export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error('Invalid or expired token');
  }

  return response.json() as Promise<GitHubUser>;
}
