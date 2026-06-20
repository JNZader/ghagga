/**
 * Token resolution for the CLI GitLab MR post-back (`ghagga review --mr N`).
 *
 * Resolution order (CI-first, interactive fallback) — mirrors `pr-token.ts`:
 *   1. env GITLAB_TOKEN   — the GitLab CI / standard convention.
 *   2. env GL_TOKEN       — the `glab` CLI / alternate convention.
 *   3. getStoredToken()   — the interactive `ghagga login` stored token.
 *
 * Returns `null` when no token resolves; the caller turns that into an
 * actionable error ONLY when `--mr` was actually requested.
 */

import { getStoredToken } from './config.js';

/** Resolve a GitLab token: env GITLAB_TOKEN > env GL_TOKEN > stored login. */
export function resolveMrToken(
  env: NodeJS.ProcessEnv = process.env,
  storedTokenFn: () => string | null = getStoredToken,
): string | null {
  const fromEnv = env.GITLAB_TOKEN?.trim() || env.GL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = storedTokenFn();
  return stored?.trim() ? stored : null;
}
