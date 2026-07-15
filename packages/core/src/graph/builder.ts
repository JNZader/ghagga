/**
 * Graph Builder
 *
 * Builds a DependencyGraph from a map of file paths → file content.
 * Pure function: no filesystem access — the caller provides content.
 *
 * Two modes:
 * - `buildGraph()` — full build from scratch
 * - `buildGraphIncremental()` — updates only changed/deleted nodes
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { getExtractor } from './extractors/index.js';
import {
  type DependencyGraph,
  EXCLUDED_DIRS,
  GRAPH_VERSION,
  type GraphNode,
  isTestFile,
  LANGUAGE_EXTENSIONS,
  type SupportedLanguage,
} from './schema.js';

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Detect the language of a file based on its extension.
 * Returns undefined for unsupported extensions.
 */
export function detectLanguage(filePath: string): SupportedLanguage | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_EXTENSIONS[ext];
}

/**
 * Check if a file path traverses any excluded directory.
 */
export function isExcludedPath(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.some((seg) => EXCLUDED_DIRS.has(seg));
}

/**
 * Compute SHA-256 hash of content.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Resolve a relative import path to an absolute path within the project.
 *
 * Given the file doing the import and the import specifier, resolves
 * to a project-relative path. Only resolves relative imports (starting
 * with `.` or `..`). Non-relative imports (e.g., 'lodash') are returned
 * as-is since they refer to external packages.
 */
export function resolveImportPath(
  importerPath: string,
  importSpecifier: string,
  availableFiles: Set<string>,
): string {
  // Non-relative imports → return as-is
  if (!importSpecifier.startsWith('.')) {
    return importSpecifier;
  }

  const importerDir = path.dirname(importerPath);
  let resolved = path.posix.normalize(path.posix.join(importerDir, importSpecifier));

  // Remove leading ./
  if (resolved.startsWith('./')) {
    resolved = resolved.slice(2);
  }

  // Try exact match first
  if (availableFiles.has(resolved)) {
    return resolved;
  }

  // Try common extension resolutions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.java', '.rs'];
  for (const ext of extensions) {
    const withExt = `${resolved}${ext}`;
    if (availableFiles.has(withExt)) {
      return withExt;
    }
  }

  // Try index file resolution (TypeScript/JavaScript)
  const indexFiles = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
  for (const indexFile of indexFiles) {
    const withIndex = `${resolved}/${indexFile}`;
    if (availableFiles.has(withIndex)) {
      return withIndex;
    }
  }

  // Try .js → .ts resolution (common in TypeScript projects with .js extensions in imports)
  if (resolved.endsWith('.js')) {
    const tsPath = resolved.replace(/\.js$/, '.ts');
    if (availableFiles.has(tsPath)) {
      return tsPath;
    }
    const tsxPath = resolved.replace(/\.js$/, '.tsx');
    if (availableFiles.has(tsxPath)) {
      return tsxPath;
    }
  }

  // Return the original resolved path (without extension)
  return resolved;
}

// ─── Build Graph ────────────────────────────────────────────────

/**
 * Build a complete dependency graph from a map of file paths → file content.
 *
 * @param rootDir - Base directory for all paths (used in the graph metadata)
 * @param files - Map of relative file paths to their content
 * @returns Complete DependencyGraph
 */
export function buildGraph(rootDir: string, files: Map<string, string>): DependencyGraph {
  const nodes: Record<string, GraphNode> = {};
  const availableFiles = new Set(files.keys());

  // Staged rawSource -> symbols per file, keyed BEFORE Pass-2 path
  // resolution (`node.imports` still holds raw specifiers at this point).
  // Remapped to resolved paths in Pass 2, alongside `node.imports` itself,
  // so `importSymbols` ends up keyed in the SAME resolved-path space as
  // `imports` (required for Slice 2 lookups to work).
  const rawSymbolsByFile = new Map<string, Map<string, Set<string>>>();

  // Pass 1: Build nodes with raw imports
  for (const [filePath, content] of files) {
    // Skip excluded directories
    if (isExcludedPath(filePath)) continue;

    // Detect language
    const language = detectLanguage(filePath);
    if (!language) continue;

    // SCIP-only languages (kotlin/csharp/php) have no regex extractor —
    // the regex builder can't index them, so skip (no node, no throw).
    const extractor = getExtractor(language);
    if (!extractor) continue;

    try {
      const extractedImports = extractor.extractImports(content);
      const extractedExports = extractor.extractExports(content);

      nodes[filePath] = {
        hash: hashContent(content),
        language,
        imports: extractedImports.map((i) => i.source),
        exports: extractedExports.map((e) => e.name),
        calls: [],
        isTest: isTestFile(filePath),
      };

      stageImportSymbols(rawSymbolsByFile, filePath, extractedImports);
    } catch {
      // Parse errors in individual files don't abort the build
      // Create a minimal node so the file still appears in the graph
      nodes[filePath] = {
        hash: hashContent(content),
        language,
        imports: [],
        exports: [],
        calls: [],
        isTest: isTestFile(filePath),
      };
    }
  }

  // Pass 2: Resolve relative imports to project-relative paths
  for (const [filePath, node] of Object.entries(nodes)) {
    node.imports = node.imports.map((imp) => resolveImportPath(filePath, imp, availableFiles));

    const rawSymbols = rawSymbolsByFile.get(filePath);
    if (rawSymbols) {
      const resolved = remapImportSymbols(filePath, rawSymbols, availableFiles);
      if (resolved) node.importSymbols = resolved;
    }
  }

  return {
    version: GRAPH_VERSION,
    rootDir,
    nodes,
  };
}

// ─── importSymbols Helpers ──────────────────────────────────────

/**
 * Stage `rawSource -> symbols` for a file's extracted imports, BEFORE
 * Pass-2 path resolution. Only sources with at least one named symbol are
 * staged (omit-empty rule) — namespace/default/side-effect imports and
 * extractors without symbol data (Python/Rust, most Go) never populate
 * this map.
 */
function stageImportSymbols(
  rawSymbolsByFile: Map<string, Map<string, Set<string>>>,
  filePath: string,
  extractedImports: Array<{ source: string; symbols: string[] }>,
): void {
  for (const { source, symbols } of extractedImports) {
    if (symbols.length === 0) continue;

    let bySource = rawSymbolsByFile.get(filePath);
    if (!bySource) {
      bySource = new Map();
      rawSymbolsByFile.set(filePath, bySource);
    }
    let set = bySource.get(source);
    if (!set) {
      set = new Set();
      bySource.set(source, set);
    }
    for (const symbol of symbols) set.add(symbol);
  }
}

/**
 * Remap a file's staged `rawSource -> symbols` map to the SAME resolved
 * path space as `node.imports`, merging symbol sets when multiple raw
 * specifiers resolve to the same target (e.g. `./b` and `./b.ts`).
 * Returns `undefined` when there is nothing to record (omit-empty rule).
 */
function remapImportSymbols(
  filePath: string,
  rawSymbols: Map<string, Set<string>>,
  availableFiles: Set<string>,
): Record<string, string[]> | undefined {
  const result: Record<string, Set<string>> = {};
  for (const [rawSource, symbols] of rawSymbols) {
    const resolved = resolveImportPath(filePath, rawSource, availableFiles);
    const existing = result[resolved];
    if (existing) {
      for (const s of symbols) existing.add(s);
    } else {
      result[resolved] = new Set(symbols);
    }
  }

  if (Object.keys(result).length === 0) return undefined;

  const out: Record<string, string[]> = {};
  for (const [target, symbols] of Object.entries(result)) {
    out[target] = Array.from(symbols);
  }
  return out;
}

// ─── Incremental Build ──────────────────────────────────────────

/**
 * Update a dependency graph incrementally.
 *
 * Only re-processes changed files and removes deleted files.
 * Unchanged files keep their existing nodes.
 *
 * @param existing - The existing dependency graph
 * @param changedFiles - Map of changed file paths → new content
 * @param deletedFiles - Array of file paths that were deleted
 * @returns Updated DependencyGraph
 */
export function buildGraphIncremental(
  existing: DependencyGraph,
  changedFiles: Map<string, string>,
  deletedFiles: string[],
): DependencyGraph {
  // Start with a copy of existing nodes
  const nodes: Record<string, GraphNode> = { ...existing.nodes };

  // Remove deleted files
  for (const filePath of deletedFiles) {
    delete nodes[filePath];
  }

  // Collect all available files (existing + changed - deleted)
  const allFiles = new Set(Object.keys(nodes));
  for (const filePath of changedFiles.keys()) {
    allFiles.add(filePath);
  }
  for (const filePath of deletedFiles) {
    allFiles.delete(filePath);
  }

  // Process changed files
  for (const [filePath, content] of changedFiles) {
    if (isExcludedPath(filePath)) continue;

    const language = detectLanguage(filePath);
    if (!language) continue;

    // SCIP-only languages (kotlin/csharp/php) have no regex extractor.
    const extractor = getExtractor(language);
    if (!extractor) {
      delete nodes[filePath];
      continue;
    }

    try {
      const extractedImports = extractor.extractImports(content);
      const extractedExports = extractor.extractExports(content);

      nodes[filePath] = {
        hash: hashContent(content),
        language,
        imports: extractedImports.map((i) => resolveImportPath(filePath, i.source, allFiles)),
        exports: extractedExports.map((e) => e.name),
        calls: [],
        isTest: isTestFile(filePath),
      };

      // Resolves inline (no separate Pass 2 in the incremental path) —
      // remap raw source -> symbols directly to the resolved path space,
      // matching `node.imports` above.
      const rawSymbols = new Map<string, Set<string>>();
      for (const { source, symbols } of extractedImports) {
        if (symbols.length === 0) continue;
        let set = rawSymbols.get(source);
        if (!set) {
          set = new Set();
          rawSymbols.set(source, set);
        }
        for (const symbol of symbols) set.add(symbol);
      }
      const resolvedSymbols = remapImportSymbols(filePath, rawSymbols, allFiles);
      if (resolvedSymbols) nodes[filePath].importSymbols = resolvedSymbols;
    } catch {
      nodes[filePath] = {
        hash: hashContent(content),
        language,
        imports: [],
        exports: [],
        calls: [],
        isTest: isTestFile(filePath),
      };
    }
  }

  return {
    version: GRAPH_VERSION,
    rootDir: existing.rootDir,
    nodes,
  };
}
