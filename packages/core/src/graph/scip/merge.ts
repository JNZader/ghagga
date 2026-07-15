/**
 * Multi-`.scip` merge (D4).
 *
 * Merges 2+ parsed SCIP `Index` objects (one per successfully-run
 * per-{language,marker-directory} indexer run) into a single `Index` before
 * ONE `buildGraphFromScip` call. Pure/testable: no filesystem or console
 * access — the dispatcher (`index-cmd.ts`) is responsible for logging
 * `duplicatePaths`.
 *
 * `buildGraphFromScip` only reads `Index.documents` and
 * `Index.metadata.projectRoot`, so the merge:
 *   - for each input, POSIX-joins its `pathPrefix` (the marker directory,
 *     repo-relative) onto every document's own `relativePath` BEFORE the
 *     `byPath` insert — each indexer emits paths relative to the `dir` it
 *     ran in, so this makes every document key repo-relative, matching
 *     `buildGraphFromScip`'s node keys (which blast-radius/review match
 *     against git-diff paths)
 *   - keeps the FIRST input's `metadata` (arbitrary but stable choice —
 *     all indexers run against the same repoPath, so `projectRoot` should
 *     already agree)
 *   - drops `externalSymbols` (unused by the mapper)
 *
 * Collision policy: after prefixing, a `duplicatePath` is a GENUINE
 * same-subdirectory collision (real signal) — not a cross-subdir false
 * positive, since two different marker directories now produce distinct
 * keys even when their bare filenames match (e.g. two `main.py`). Warn +
 * last-registry-order wins — the merge stays pure, so it reports
 * `duplicatePaths` for the caller to log rather than logging itself.
 *
 * Path-escape guard: `posix.join(prefix, relativePath)` RESOLVES `..`
 * segments. An indexer emitting a `relativePath` containing `..` (only
 * `scip-typescript` is known to do this from a subdir cwd, which is why
 * `collapseTypescriptPairs` avoids per-subdir TS runs — but every other
 * per-subdir indexer has no such guard) could otherwise produce a merged
 * document key that escapes the marker directory / repo-relative root,
 * silently mis-keying or overwriting an unrelated graph node. Any document
 * whose joined path escapes the repo-relative root (starts with `..` after
 * normalization, or is absolute) is SKIPPED — not inserted — and reported
 * via `escapedPaths` for the caller to warn about. Skip+warn, not clamp: an
 * escaping path means that document's own metadata is untrustworthy.
 */

import { posix } from 'node:path';
import { create } from '@bufbuild/protobuf';
import type { Document, Index } from '@scip-code/scip';
import { IndexSchema } from '@scip-code/scip';

export interface MergeScipIndexesResult {
  index: Index;
  duplicatePaths: string[];
  /**
   * Documents dropped because their prefixed path escaped the
   * repo-relative root (e.g. an indexer-emitted `relativePath` with `..`
   * segments resolving outside the marker directory). Never inserted into
   * `index.documents` — the caller should warn about these.
   */
  escapedPaths: string[];
}

/** One successfully-run indexer's parsed output, plus its source marker directory. */
export interface MergeScipIndexesInput {
  index: Index;
  /**
   * The marker directory this index was produced from, relative to repo
   * root (POSIX or OS-native — normalized here). `''` (or `'.'`, as
   * produced by `path.relative(repoPath, repoPath)`) means repo root: no
   * prefixing applied.
   */
  pathPrefix: string;
}

/** Convert any OS-native separators to POSIX `/`. */
function toPosixPath(p: string): string {
  return p.split('\\').join('/');
}

/** Normalize a pathPrefix: POSIX-ify, and treat `.`/`''` as "no prefix". */
function normalizePrefix(prefix: string): string {
  const posixPrefix = toPosixPath(prefix);
  return posixPrefix === '.' ? '' : posixPrefix;
}

/**
 * Merge multiple parsed SCIP indexes into one, disambiguating each
 * document's path by the marker directory it was produced from.
 *
 * @param inputs - `{index, pathPrefix}` pairs, one per successfully-run
 *   indexer, in the order they should be merged (last wins on path
 *   collision after prefixing).
 */
/**
 * Whether `p` (already `posix.join`-resolved) escapes the repo-relative
 * root: it resolves to an absolute path, or its first segment is `..`
 * (meaning the join climbed above the root it started from).
 */
function escapesRoot(p: string): boolean {
  return posix.isAbsolute(p) || p === '..' || p.startsWith('../');
}

export function mergeScipIndexes(inputs: MergeScipIndexesInput[]): MergeScipIndexesResult {
  const byPath = new Map<string, Document>();
  const duplicatePaths: string[] = [];
  const escapedPaths: string[] = [];

  for (const { index, pathPrefix } of inputs) {
    const normalizedPrefix = normalizePrefix(pathPrefix);
    for (const doc of index.documents) {
      const relativePath = toPosixPath(doc.relativePath);
      const prefixedPath = normalizedPrefix
        ? posix.join(normalizedPrefix, relativePath)
        : relativePath;
      if (escapesRoot(prefixedPath)) {
        escapedPaths.push(prefixedPath);
        continue;
      }
      if (byPath.has(prefixedPath)) {
        duplicatePaths.push(prefixedPath);
      }
      byPath.set(prefixedPath, { ...doc, relativePath: prefixedPath });
    }
  }

  const merged = create(IndexSchema, {
    metadata: inputs[0]?.index.metadata,
    documents: Array.from(byPath.values()),
    externalSymbols: [],
  });

  return { index: merged, duplicatePaths, escapedPaths };
}
