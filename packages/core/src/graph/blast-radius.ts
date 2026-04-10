/**
 * Blast-Radius Computation
 *
 * Given a dependency graph and a set of changed files, computes the
 * "blast radius" — the set of files transitively affected by the changes.
 *
 * Uses BFS reverse traversal: for each changed file, find all files that
 * import/call it, up to a configurable depth limit. Test files that depend
 * on any impacted file are automatically included.
 */

import { DEFAULT_TRAVERSAL_DEPTH, type DependencyGraph, MAX_BLAST_RADIUS_FILES } from './schema.js';

// ─── Types ──────────────────────────────────────────────────────

export interface BlastRadiusOptions {
  /** Maximum BFS traversal depth. Default: DEFAULT_TRAVERSAL_DEPTH (3) */
  maxDepth?: number;

  /** Maximum files before declaring "exceeded cap". Default: MAX_BLAST_RADIUS_FILES (50) */
  maxFiles?: number;

  /** Whether to include test files in the result. Default: true */
  includeTests?: boolean;
}

export interface BlastRadiusResult {
  /** All files in the blast radius (changed + dependents + tests) */
  files: Set<string>;

  /** Only the changed files from the input that exist in the graph */
  changedFiles: string[];

  /** Files that depend on changed files (not including the changed files themselves) */
  dependents: string[];

  /** Test files added to the blast radius */
  testFiles: string[];

  /** Max depth actually reached during BFS */
  depth: number;

  /** Whether the blast radius exceeded the file cap */
  exceededCap: boolean;
}

// ─── Reverse Index ──────────────────────────────────────────────

/**
 * Build a reverse adjacency map from the dependency graph.
 *
 * For each edge A → B (A imports B), creates a reverse edge B → A.
 * This allows efficient lookup of "who depends on this file?"
 * Also includes reverse edges for `calls[].target`.
 */
export function buildReverseIndex(graph: DependencyGraph): Map<string, Set<string>> {
  const reverseIndex = new Map<string, Set<string>>();

  for (const [filePath, node] of Object.entries(graph.nodes)) {
    // Reverse edges for imports: if filePath imports target, then target → filePath
    for (const importPath of node.imports) {
      if (!reverseIndex.has(importPath)) {
        reverseIndex.set(importPath, new Set());
      }
      reverseIndex.get(importPath)?.add(filePath);
    }

    // Reverse edges for calls: if filePath calls target, then target → filePath
    for (const call of node.calls) {
      if (!reverseIndex.has(call.target)) {
        reverseIndex.set(call.target, new Set());
      }
      reverseIndex.get(call.target)?.add(filePath);
    }
  }

  return reverseIndex;
}

// ─── BFS Computation ────────────────────────────────────────────

/**
 * Compute the blast radius for a set of changed files.
 *
 * Algorithm:
 * 1. Build reverse index (who depends on whom)
 * 2. BFS from changed files through reverse dependencies, up to maxDepth
 * 3. Collect test files that import any file in the blast radius
 * 4. If total exceeds maxFiles, set exceededCap flag
 *
 * @param graph - The dependency graph
 * @param changedFiles - File paths that were modified in the PR
 * @param options - Traversal limits
 * @returns BlastRadiusResult with all impacted files
 */
export function computeBlastRadius(
  graph: DependencyGraph,
  changedFiles: string[],
  options?: BlastRadiusOptions,
): BlastRadiusResult {
  const maxDepth = options?.maxDepth ?? DEFAULT_TRAVERSAL_DEPTH;
  const maxFiles = options?.maxFiles ?? MAX_BLAST_RADIUS_FILES;
  const includeTests = options?.includeTests ?? true;

  // Handle empty input
  if (changedFiles.length === 0) {
    return {
      files: new Set(),
      changedFiles: [],
      dependents: [],
      testFiles: [],
      depth: 0,
      exceededCap: false,
    };
  }

  const reverseIndex = buildReverseIndex(graph);

  // Track all visited non-test nodes (for cycle detection and BFS)
  const visited = new Set<string>();
  const dependentsSet = new Set<string>();
  const testFilesSet = new Set<string>();

  // Include changed files in visited (but not in dependents)
  for (const file of changedFiles) {
    visited.add(file);
  }

  // BFS traversal — only follows non-test files
  // Test files are collected separately after BFS
  let queue = [...changedFiles];
  let actualDepth = 0;

  for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
    const nextQueue: string[] = [];

    for (const file of queue) {
      const reverseDeps = reverseIndex.get(file);
      if (!reverseDeps) continue;

      for (const dependent of reverseDeps) {
        if (visited.has(dependent) || testFilesSet.has(dependent)) continue;

        const node = graph.nodes[dependent];
        if (node?.isTest) {
          // Test files are collected but not traversed further
          if (includeTests) {
            testFilesSet.add(dependent);
          }
        } else {
          visited.add(dependent);
          dependentsSet.add(dependent);
          nextQueue.push(dependent);
        }
      }
    }

    if (nextQueue.length > 0) {
      actualDepth = depth + 1;
    }
    queue = nextQueue;
  }

  // Post-BFS: find additional test files that import any file in the blast radius
  // This catches tests that weren't direct reverse deps during BFS
  if (includeTests) {
    for (const file of visited) {
      const reverseDeps = reverseIndex.get(file);
      if (!reverseDeps) continue;

      for (const dependent of reverseDeps) {
        if (visited.has(dependent) || testFilesSet.has(dependent)) continue;
        const node = graph.nodes[dependent];
        if (node?.isTest) {
          testFilesSet.add(dependent);
        }
      }
    }
  }

  // Build the full file set
  const allFiles = new Set<string>(visited);
  for (const testFile of testFilesSet) {
    allFiles.add(testFile);
  }

  const dependents = [...dependentsSet];

  // Check cap
  const exceededCap = allFiles.size > maxFiles;

  return {
    files: allFiles,
    changedFiles: changedFiles.filter((f) => visited.has(f)),
    dependents,
    testFiles: [...testFilesSet],
    depth: actualDepth,
    exceededCap,
  };
}
