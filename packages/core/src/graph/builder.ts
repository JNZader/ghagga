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

  // Pass 1: Build nodes with raw imports
  for (const [filePath, content] of files) {
    // Skip excluded directories
    if (isExcludedPath(filePath)) continue;

    // Detect language
    const language = detectLanguage(filePath);
    if (!language) continue;

    try {
      const extractor = getExtractor(language);
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
  }

  return {
    version: GRAPH_VERSION,
    rootDir,
    nodes,
  };
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

    try {
      const extractor = getExtractor(language);
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
