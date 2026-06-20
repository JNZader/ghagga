/**
 * Token resolution for the CLI GitLab MR post-back (`ghagga review --mr N`).
 *
 * Resolution order (CI-first, interactive fallback):
 *   1. env GITLAB_TOKEN           — the GitLab CI / standard convention.
 *   2. env GL_TOKEN               — the `glab` CLI / alternate convention.
 *   3. a GitLab-SPECIFIC stored token (config `gitlabToken`), if one exists.
 *
 * CRITICAL: this does NOT fall back to the GitHub stored login token
 * ({@link getStoredToken}). A GitHub token against the GitLab API yields a 401 /
 * nonsense — a GitHub credential is NOT a GitLab credential. When no GitLab token
 * resolves, return `null`; the caller turns that into an actionable error ONLY
 * when `--mr` was actually requested (non-zero exit, P3/P4 exit semantics).
 */

import { getStoredGitLabToken } from './config.js';

/** Resolve a GitLab token: env GITLAB_TOKEN > GL_TOKEN > GitLab-specific stored. */
export function resolveMrToken(
  env: NodeJS.ProcessEnv = process.env,
  storedTokenFn: () => string | null = getStoredGitLabToken,
): string | null {
  const fromEnv = env.GITLAB_TOKEN?.trim() || env.GL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = storedTokenFn();
  return stored?.trim() ? stored : null;
}
