/**
 * RepoRef identity helpers.
 *
 * R-COMMENTID family / IDENTITY RULE: two repositories are the same iff their
 * `kind` AND `nativeId` match. `path` is a mutable human-friendly label (repos
 * get renamed/transferred) and MUST NOT participate in identity comparison.
 */

import type { RepoRef } from './types.js';

/**
 * Structural identity for {@link RepoRef}.
 *
 * Keys on `kind` + `nativeId` and DELIBERATELY ignores `path` (mutable label).
 * This is the contract every consumer (registry, dedup, caching) relies on.
 *
 * @param a first repo reference.
 * @param b second repo reference.
 * @returns true iff `a` and `b` denote the same repository.
 */
export function repoRefEquals(a: RepoRef, b: RepoRef): boolean {
  return a.kind === b.kind && a.nativeId === b.nativeId;
}
