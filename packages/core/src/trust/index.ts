/**
 * Author Trust Scoring
 *
 * Computes a trust score (0–1) for a PR author based on their git history
 * in the repository. High-trust authors (well-known contributors) receive
 * lightweight "simple" review; new/unknown authors receive deep "workflow" review.
 *
 * Score formula:
 *   commit_count_score : min(commitCount / 50, 1.0) * 0.6
 *   tenure_score       : min(daysSinceFirstCommit / 365, 1.0) * 0.3
 *   recency_score      : daysSinceLastCommit < 90 ? 0.1 : 0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthorTrustScore, AuthorTrustTier } from '../types.js';

const execFileAsync = promisify(execFile);

export interface TrustScoringOptions {
  /** Path to the git repository directory. */
  cwd: string;
  /** Score threshold to classify an author as "trusted". Default: 0.7 */
  trustedThreshold?: number;
  /** Score threshold below which an author is classified as "new". Default: 0.3 */
  newThreshold?: number;
}

/**
 * Compute a trust score (0–1) for a given author using git log stats.
 * Falls back to score=0 / tier="new" when git is unavailable or no history found.
 */
export async function computeAuthorTrustScore(
  author: string,
  options: TrustScoringOptions,
): Promise<AuthorTrustScore> {
  const { cwd, trustedThreshold = 0.7, newThreshold = 0.3 } = options;

  let commitCount = 0;
  let firstSeenDaysAgo = 0;
  let lastSeenDaysAgo = 999;

  try {
    // Count commits by author
    const { stdout: countOut } = await execFileAsync(
      'git',
      ['log', '--oneline', '--author', author, '--'],
      { cwd },
    );
    commitCount = countOut.trim().split('\n').filter(Boolean).length;

    if (commitCount > 0) {
      // Get all commit timestamps (Unix epoch seconds), sorted ascending
      const { stdout: datesOut } = await execFileAsync(
        'git',
        ['log', '--format=%at', '--author', author, '--'],
        { cwd },
      );
      const timestamps = datesOut
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b);

      if (timestamps.length > 0) {
        const nowSec = Date.now() / 1000;
        firstSeenDaysAgo = Math.floor((nowSec - timestamps[0]!) / (60 * 60 * 24));
        lastSeenDaysAgo = Math.floor(
          (nowSec - timestamps[timestamps.length - 1]!) / (60 * 60 * 24),
        );
      }
    }
  } catch {
    // git unavailable or not a repo — treat as new author (score=0)
  }

  const commitScore = Math.min(commitCount / 50, 1.0) * 0.6;
  const tenureScore = Math.min(firstSeenDaysAgo / 365, 1.0) * 0.3;
  const recencyScore = lastSeenDaysAgo < 90 ? 0.1 : 0;
  const score = Math.round((commitScore + tenureScore + recencyScore) * 100) / 100;

  const tier: AuthorTrustTier =
    score >= trustedThreshold ? 'trusted' : score >= newThreshold ? 'standard' : 'new';

  return {
    author,
    score,
    tier,
    commitCount,
    firstSeenDaysAgo,
    lastUpdated: new Date(),
  };
}

/**
 * Map a trust tier to a recommended review mode.
 * - trusted → simple (lightweight, lower LLM cost)
 * - new     → workflow (deep multi-specialist review)
 * - standard → unchanged (use the caller's default mode)
 */
export function getReviewModeForTier(tier: AuthorTrustTier, defaultMode: string): string {
  switch (tier) {
    case 'trusted':
      return 'simple';
    case 'new':
      return 'workflow';
    default:
      return defaultMode;
  }
}
