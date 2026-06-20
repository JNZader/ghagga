/**
 * Sanctioned projection helpers (task 0.6).
 *
 * These three functions are the ONLY blessed way to project forge-agnostic
 * domain objects into the shapes the core review engine consumes. Centralizing
 * the projections keeps the wrong-field bug class (R-PROJECTION) in exactly one
 * auditable place.
 *
 * R-PROJECTION (load-bearing): {@link toCommitMessages} MUST map each commit's
 * `.message`, NEVER its `.sha`. A `.sha` projection type-checks perfectly
 * (both are `string`) yet silently feeds 40-char hashes to the LLM instead of
 * commit messages — a correctness bug invisible to the type system. The unit
 * test in `project.test.ts` pins `.message !== .sha` to catch any regression.
 */

import type { ReviewContext } from 'ghagga-core';
import type { ChangedFile, Commit } from './types.js';

/**
 * Project commits into the commit-message strings the engine reviews.
 *
 * R-PROJECTION: maps `.message` (NOT `.sha`).
 */
export function toCommitMessages(commits: Commit[]): string[] {
  return commits.map((commit) => commit.message);
}

/** Project changed files into the flat path list the engine consumes. */
export function toFileList(files: ChangedFile[]): string[] {
  return files.map((file) => file.path);
}

/**
 * Assemble the core {@link ReviewContext} from forge-agnostic inputs.
 *
 * Uses {@link toCommitMessages} and {@link toFileList} internally so the
 * projection rules are applied consistently.
 */
export function toReviewContext(
  repoFullName: string,
  prNumber: number,
  commits: Commit[],
  files: ChangedFile[],
): ReviewContext {
  return {
    repoFullName,
    prNumber,
    commitMessages: toCommitMessages(commits),
    fileList: toFileList(files),
  };
}
