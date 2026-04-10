/**
 * Reverse Dependency Graph
 *
 * Computes which files DEPEND ON a given module (reverse direction of blast-radius).
 * The blast-radius finds what a changed file affects; this finds what imports/uses a given module.
 */

import { posix } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface ReverseDependencyMap {
  [filePath: string]: string[];
}

export interface ReverseDepsResult {
  target: string;
  dependents: string[];
  transitiveCount: number;
}

// ─── Regex Patterns ─────────────────────────────────────────────

/** ES module: import ... from "..." */
const ES_IMPORT_RE = /import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g;

/** CommonJS: require("...") */
const REQUIRE_RE = /require\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Dynamic import: import("...") */
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extract all import paths from a file's content.
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];

  for (const m of content.matchAll(ES_IMPORT_RE)) {
    if (m[1]) imports.push(m[1]);
  }
  for (const m of content.matchAll(REQUIRE_RE)) {
    if (m[1]) imports.push(m[1]);
  }
  for (const m of content.matchAll(DYNAMIC_IMPORT_RE)) {
    if (m[1]) imports.push(m[1]);
  }

  return imports;
}

/**
 * Normalize an import path relative to the importing file's directory.
 *
 * Only resolves relative paths (starting with ./ or ../).
 * Bare module specifiers (e.g., "react", "@scope/pkg") are returned as-is.
 */
function resolveImport(importerPath: string, importPath: string): string {
  if (!importPath.startsWith('.')) {
    return importPath;
  }

  const importerDir = importerPath.includes('/')
    ? importerPath.slice(0, importerPath.lastIndexOf('/'))
    : '.';

  const resolved = posix.normalize(`${importerDir}/${importPath}`);

  // Strip known extensions for matching against bare file paths
  return resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

/**
 * Normalize a file path for comparison (strip common extensions).
 */
function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

// ─── Main Exports ─────────────────────────────────────────────────

/**
 * Build a reverse dependency map from a set of file paths and their contents.
 *
 * For each import statement found in a file, the target module gets an entry
 * pointing back to the importing file.
 *
 * @param filePaths - List of all file paths in the project
 * @param fileContents - Map of filePath → file content
 * @returns ReverseDependencyMap where key = imported path, value = array of importing files
 */
export function buildReverseDependencyMap(
  filePaths: string[],
  fileContents: Map<string, string>,
): ReverseDependencyMap {
  const reverseMap: ReverseDependencyMap = {};

  // Initialize all known file paths with empty arrays
  for (const fp of filePaths) {
    reverseMap[fp] = [];
  }

  for (const importerPath of filePaths) {
    const content = fileContents.get(importerPath);
    if (!content) continue;

    const imports = extractImports(content);

    for (const rawImport of imports) {
      const resolved = resolveImport(importerPath, rawImport);
      const normalizedResolved = normalizeFilePath(resolved);

      // Match resolved path against known files (with and without extension)
      for (const knownPath of filePaths) {
        if (knownPath === importerPath) continue; // skip self

        const normalizedKnown = normalizeFilePath(knownPath);

        if (normalizedResolved === normalizedKnown || normalizedResolved === knownPath) {
          if (!reverseMap[knownPath]) {
            reverseMap[knownPath] = [];
          }
          if (!reverseMap[knownPath]?.includes(importerPath)) {
            reverseMap[knownPath]?.push(importerPath);
          }
          break;
        }
      }
    }
  }

  return reverseMap;
}

/**
 * Find all files that depend on a target file, up to a given depth.
 *
 * Uses BFS traversal through the reverse dependency map.
 *
 * @param targetPath - The file to find dependents for
 * @param depMap - Reverse dependency map from buildReverseDependencyMap
 * @param maxDepth - Maximum BFS depth (default: 2)
 * @returns ReverseDepsResult with all dependents and transitive count
 */
export function findDependents(
  targetPath: string,
  depMap: ReverseDependencyMap,
  maxDepth = 2,
): ReverseDepsResult {
  const visited = new Set<string>([targetPath]);
  const dependents: string[] = [];

  let queue = [targetPath];

  for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
    const nextQueue: string[] = [];

    for (const current of queue) {
      const directDeps = depMap[current] ?? [];

      for (const dep of directDeps) {
        if (!visited.has(dep)) {
          visited.add(dep);
          dependents.push(dep);
          nextQueue.push(dep);
        }
      }
    }

    queue = nextQueue;
  }

  return {
    target: targetPath,
    dependents,
    transitiveCount: dependents.length,
  };
}
