/**
 * File Neighborhood Query (graph-context-retrieval Slice 1)
 *
 * Pure, synchronous depth-1 neighborhood lookup over a `DependencyGraph`:
 * for each changed file, its direct importers (via `buildReverseIndex`,
 * which includes call edges) and importees (via `node.imports`), plus a
 * capped exported-symbol list. NO traversal — transitive dependents are
 * blast-radius's job (`blast-radius.ts`, depth 3/cap 50, golden-pinned;
 * do not churn its semantics).
 *
 * Caps mirror the review-context precedents: 10 per file per direction
 * (export symbols likewise, `gather-safe.ts` code-intel pattern) and 30
 * files total. Every cap hit surfaces as `truncated: true` on the file's
 * record so the formatter can label the section honestly.
 */

import { buildReverseIndex } from './blast-radius.js';
import type { DependencyGraph } from './schema.js';

// ─── Types ──────────────────────────────────────────────────────

/** Direct (depth-1) semantic neighborhood of one changed file. */
export interface FileNeighborhood {
  /** The changed file this record describes (relative path, as in the graph). */
  file: string;

  /** Files that import or call this file (reverse edges, imports + calls). */
  importers: string[];

  /** Files this file imports (forward edges, `node.imports`). */
  importees: string[];

  /** Locally-defined exported symbols of this file, capped at 10. */
  exportedSymbols: string[];

  /**
   * Number of import edges (to direct importees) that carry named-symbol
   * data (`node.importSymbols`). 0 for symbol-sparse extractors (regex
   * Python/Rust) — the formatter degrades those to paths-only.
   */
  importedSymbolEdges?: number;

  /** Whether this file matches the graph's test-file patterns. */
  isTest: boolean;

  /** True when any per-file cap clamped this record's lists. */
  truncated: boolean;
}

export interface CollectFileNeighborhoodsOptions {
  /** Max entries per direction per file. Default: 10. */
  maxPerFile?: number;
  /** Max changed files returned. Default: 30. */
  maxTotalFiles?: number;
}

// ─── Constants ──────────────────────────────────────────────────

/** Max importer/importee entries per direction per file. */
export const MAX_NEIGHBORS_PER_FILE = 10;

/** Max changed files with a neighborhood section. */
export const MAX_NEIGHBORHOOD_FILES = 30;

/** Max exported symbols listed per file. */
export const MAX_EXPORTED_SYMBOLS_PER_FILE = 10;

// ─── Query ──────────────────────────────────────────────────────

/**
 * Collect depth-1 neighborhoods for the given files.
 *
 * - Importers come from the reverse index (import edges AND call edges —
 *   same edge space `computeBlastRadius` traverses).
 * - Importees come from `node.imports`.
 * - Files missing from the graph are omitted (caller compares input
 *   length vs. result length for `filesCovered`).
 * - Files beyond `maxTotalFiles` are omitted (input order preserved).
 * - Self-edges are excluded from both directions.
 *
 * Pure and synchronous — no I/O, no traversal, no mutation of the graph.
 */
export function collectFileNeighborhoods(
  graph: DependencyGraph,
  files: string[],
  opts?: CollectFileNeighborhoodsOptions,
): FileNeighborhood[] {
  if (files.length === 0) return [];

  const maxPerFile = opts?.maxPerFile ?? MAX_NEIGHBORS_PER_FILE;
  const maxTotalFiles = opts?.maxTotalFiles ?? MAX_NEIGHBORHOOD_FILES;

  const reverseIndex = buildReverseIndex(graph);
  const result: FileNeighborhood[] = [];

  for (const file of files) {
    if (result.length >= maxTotalFiles) break;

    const node = graph.nodes[file];
    if (!node) continue; // file missing from the graph — omit

    const importersRaw = [...(reverseIndex.get(file) ?? [])].filter((p) => p !== file);
    const importeesRaw = node.imports.filter((p) => p !== file);

    const importers = importersRaw.slice(0, maxPerFile);
    const importees = importeesRaw.slice(0, maxPerFile);
    const exportedSymbols = node.exports.slice(0, MAX_EXPORTED_SYMBOLS_PER_FILE);

    const truncated =
      importersRaw.length > importers.length ||
      importeesRaw.length > importees.length ||
      node.exports.length > exportedSymbols.length;

    // Count importee edges with named-symbol data (over the CAPPED list —
    // the same edges the formatter may render symbols for).
    let importedSymbolEdges = 0;
    for (const importee of importees) {
      const symbols = node.importSymbols?.[importee];
      if (symbols && symbols.length > 0) importedSymbolEdges += 1;
    }

    result.push({
      file,
      importers,
      importees,
      exportedSymbols,
      importedSymbolEdges,
      isTest: node.isTest,
      truncated,
    });
  }

  return result;
}
