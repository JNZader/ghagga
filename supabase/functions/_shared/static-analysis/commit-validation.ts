/**
 * Commit Message Validation (in-process)
 *
 * Validates commit messages against conventional commits format.
 * Produces suggestion-level findings for non-conforming messages.
 * Runs entirely in-process (~5ms).
 */

import type { StaticAnalysisFinding } from './types.ts';

/** Conventional commit pattern */
const CONVENTIONAL_COMMIT_PATTERN =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?: .{1,72}/;

/** Commit info for validation */
export interface CommitInfo {
  sha: string;
  message: string;
}

/**
 * Validate commit messages against conventional commits format.
 *
 * Returns suggestion-level findings for non-conforming messages.
 * Merge commits (starting with "Merge") are skipped.
 */
export function validateCommitMessages(
  commits: CommitInfo[]
): { findings: StaticAnalysisFinding[]; valid: number; invalid: number } {
  const findings: StaticAnalysisFinding[] = [];
  let valid = 0;
  let invalid = 0;

  for (const commit of commits) {
    const firstLine = commit.message.split('\n')[0];
    const shortSha = commit.sha.slice(0, 7);

    // Skip merge commits
    if (firstLine.startsWith('Merge')) {
      valid++;
      continue;
    }

    if (CONVENTIONAL_COMMIT_PATTERN.test(firstLine)) {
      valid++;
    } else {
      invalid++;
      findings.push({
        severity: 'suggestion',
        category: 'commit-message',
        message: `Commit \`${shortSha}\` doesn't follow conventional commits: "${firstLine}"`,
        suggestion:
          'Expected format: `type(scope): message` (e.g., `feat(auth): add login`, `fix(api): handle timeout`)',
        source: 'static-analysis',
        ruleId: 'commit-message-format',
      });
    }
  }

  return { findings, valid, invalid };
}
