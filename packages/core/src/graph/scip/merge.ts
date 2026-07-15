/**
 * Multi-`.scip` merge (D4).
 *
 * Merges 2+ parsed SCIP `Index` objects (one per successfully-run
 * per-language indexer) into a single `Index` before ONE `buildGraphFromScip`
 * call. Pure/testable: no filesystem or console access — the dispatcher
 * (`index-cmd.ts`) is responsible for logging `duplicatePaths`.
 *
 * `buildGraphFromScip` only reads `Index.documents` and
 * `Index.metadata.projectRoot`, so the merge:
 *   - concatenates `documents` across all input indexes
 *   - keeps the FIRST index's `metadata` (arbitrary but stable choice —
 *     all indexers run against the same repoPath, so `projectRoot` should
 *     already agree)
 *   - drops `externalSymbols` (unused by the mapper)
 *
 * Collision policy: two indexers should never emit a document for the same
 * repo-relative path in a well-formed repo (each indexer only sees files of
 * its own language). If it happens anyway, warn + last-registry-order wins
 * — the merge stays pure, so it reports `duplicatePaths` for the caller to
 * log rather than logging itself.
 */

import { create } from '@bufbuild/protobuf';
import type { Document, Index } from '@scip-code/scip';
import { IndexSchema } from '@scip-code/scip';

export interface MergeScipIndexesResult {
  index: Index;
  duplicatePaths: string[];
}

/**
 * Merge multiple parsed SCIP indexes into one.
 *
 * @param indexes - Parsed `Index` objects, one per successfully-run indexer,
 *   in the order they should be merged (last wins on path collision).
 */
export function mergeScipIndexes(indexes: Index[]): MergeScipIndexesResult {
  const byPath = new Map<string, Document>();
  const duplicatePaths: string[] = [];

  for (const index of indexes) {
    for (const doc of index.documents) {
      if (byPath.has(doc.relativePath)) {
        duplicatePaths.push(doc.relativePath);
      }
      byPath.set(doc.relativePath, doc);
    }
  }

  const merged = create(IndexSchema, {
    metadata: indexes[0]?.metadata,
    documents: Array.from(byPath.values()),
    externalSymbols: [],
  });

  return { index: merged, duplicatePaths };
}
