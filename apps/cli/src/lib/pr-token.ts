/**
 * Token resolution for the CLI PR post-back (`ghagga review --pr N`).
 *
 * Resolution order (CI/Jenkins-first, interactive fallback):
 *   1. env GITHUB_TOKEN   — the GitHub Actions / standard CI convention.
 *   2. env GH_TOKEN       — the `gh` CLI / alternate CI convention.
 *   3. getStoredToken()   — the interactive `ghagga login` stored token.
 *
 * Returns `null` when no token resolves; the caller turns that into an
 * actionable error ONLY when `--pr` was actually requested (no token is fine
 * otherwise).
 */

import { getStoredToken } from './config.js';

/** Resolve a GitHub token: env GITHUB_TOKEN > env GH_TOKEN > stored login. */
export function resolvePrToken(
  env: NodeJS.ProcessEnv = process.env,
  storedTokenFn: () => string | null = getStoredToken,
): string | null {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = storedTokenFn();
  return stored?.trim() ? stored : null;
}
