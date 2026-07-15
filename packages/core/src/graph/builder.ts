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
import type { ExportInfo } from './extractors/index.js';
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
 * Move one directory level up from a repo-relative dir path (`''`/`'.'` at
 * the root, never past it). Used by the Python resolver below to walk
 * package levels (relative-import dot count) and ancestor dirs (absolute
 * import heuristic).
 */
function dirUp(dir: string): string {
  if (dir === '' || dir === '.') return '';
  const parent = path.posix.dirname(dir);
  return parent === '.' ? '' : parent;
}

/**
 * Try resolving a dotless, repo-relative Python module TARGET (already
 * dot-converted to `/`) against `availableFiles`: as a `.py`/`.pyi` module
 * file, then as a PACKAGE via its `__init__.py`/`__init__.pyi` barrel
 * (BL-SCIP-BARREL-PYTHON-RUST — the gap this fixes: `__init__.py` was
 * missing from index-file resolution entirely, on top of the dotted-import
 * mishandling below), then as an exact match (rare). Returns `undefined`
 * when nothing matches — the caller must NOT fabricate a path.
 */
function tryPythonTarget(target: string, availableFiles: Set<string>): string | undefined {
  // Root-level target ('' — e.g. `from . import x` at the repo root): the
  // barrel candidate is `__init__.py`, NOT `/__init__.py` (a leading slash
  // never matches a repo-relative path, so this case silently fell through
  // before this fix).
  const barrelPrefix = target ? `${target}/` : '';
  if (target && availableFiles.has(`${target}.py`)) return `${target}.py`;
  if (target && availableFiles.has(`${target}.pyi`)) return `${target}.pyi`;
  if (availableFiles.has(`${barrelPrefix}__init__.py`)) return `${barrelPrefix}__init__.py`;
  if (availableFiles.has(`${barrelPrefix}__init__.pyi`)) return `${barrelPrefix}__init__.pyi`;
  if (target && availableFiles.has(target)) return target;
  return undefined;
}

/**
 * Count how many distinct real files in `availableFiles` could satisfy an
 * ABSOLUTE Python import target (root-relative `target`, already
 * dot-converted to `/`) — either as `target` itself resolved via
 * `tryPythonTarget` (root-relative), OR as `target` resolved relative to
 * ANY ancestor directory anywhere in the repo (i.e. some OTHER file tree
 * also has a same-named package/module at `target`'s tail). Used to detect
 * package-name collisions (R3-001): a `utils` package that exists under
 * BOTH `services/billing/` and `shared/` must never be silently resolved to
 * whichever one happens to be nearest — that is a WRONG edge, worse than no
 * edge at all.
 */
function countPythonAbsoluteCandidates(target: string, availableFiles: Set<string>): Set<string> {
  const candidates = new Set<string>();

  const rootResolved = tryPythonTarget(target, availableFiles);
  if (rootResolved) candidates.add(rootResolved);

  const suffixes = target
    ? [`/${target}.py`, `/${target}.pyi`, `/${target}/__init__.py`, `/${target}/__init__.pyi`]
    : [];
  for (const f of availableFiles) {
    if (suffixes.some((suffix) => f.endsWith(suffix))) {
      candidates.add(f);
    }
  }

  return candidates;
}

/**
 * Resolve a Python import specifier to a repo-relative file path.
 *
 * Two forms, both mishandled before this fix:
 *
 * - RELATIVE (`from .sub import X`, `from ..sub import Y`): the leading dot
 *   COUNT is significant — one dot means "the importer's own containing
 *   package" (its dirname, whether the importer is `__init__.py` or a
 *   regular sibling module — both cases the dirname already IS the
 *   package), each additional dot climbs one more package level. The
 *   previous code passed the specifier through the TS-style `path.join`
 *   resolver, which treated `.sub` as a literal path SEGMENT (`pkg/.sub`)
 *   rather than "same dir, name sub" — never matching any real file.
 * - ABSOLUTE (`from pkg import X`, `import pkg.sub`): previously short-
 *   circuited by the non-relative-imports-return-as-is branch (correct for
 *   `lodash`-style external packages in OTHER languages, wrong for Python's
 *   dotted own-package imports). Resolved here ONLY when the target is
 *   UNAMBIGUOUS — exactly one file anywhere in `availableFiles` can satisfy
 *   it (root-relative, or nested under exactly one ancestor tree). A
 *   monorepo with duplicate package names (e.g. `services/billing/utils`
 *   AND `shared/utils`) must NOT silently guess the nearest one — a WRONG
 *   edge is worse than no edge (R3-001). Zero or multiple candidates fall
 *   through unresolved and are returned unchanged, same as genuinely
 *   external packages (e.g. `numpy`).
 *
 * Relative-import resolution failures (R3-002) return `undefined` — never a
 * fabricated non-existent path — since a relative specifier (`.`, `..sub`)
 * is never a meaningful external reference on its own; callers drop
 * unresolved imports rather than recording a dangling/fabricated edge.
 */
function resolvePythonImportPath(
  importerPath: string,
  importSpecifier: string,
  availableFiles: Set<string>,
): string | undefined {
  const dotMatch = importSpecifier.match(/^\.+/);
  const dotCount = dotMatch ? dotMatch[0].length : 0;
  const rest = importSpecifier.slice(dotCount);
  const restPath = rest ? rest.replace(/\./g, '/') : '';

  if (dotCount > 0) {
    let dir = path.posix.dirname(importerPath);
    if (dir === '.') dir = '';
    for (let i = 0; i < dotCount - 1; i++) {
      dir = dirUp(dir);
    }
    const target = restPath ? path.posix.join(dir, restPath) : dir;
    return tryPythonTarget(target, availableFiles);
  }

  // Absolute dotted import: resolve ONLY when unambiguous.
  const candidates = countPythonAbsoluteCandidates(restPath, availableFiles);
  if (candidates.size === 1) {
    const [only] = candidates;
    return only;
  }

  return importSpecifier;
}

/**
 * Resolve a relative import path to an absolute path within the project.
 *
 * Given the file doing the import and the import specifier, resolves
 * to a project-relative path. Only resolves relative imports (starting
 * with `.` or `..`). Non-relative imports (e.g., 'lodash') are returned
 * as-is since they refer to external packages.
 *
 * Python is special-cased (BL-SCIP-BARREL-PYTHON-RUST): both its relative
 * (`.sub`/`..sub`) AND absolute (`pkg`/`pkg.sub`) dotted-module import forms
 * are delegated to `resolvePythonImportPath` — see that function's doc
 * comment for what's actually resolved vs. left as a documented heuristic
 * gap. No other language's resolution changes.
 *
 * Returns `undefined` ONLY for the Python relative-import no-fabrication
 * case (R3-002) — every other path (including unresolved Python absolute
 * imports and non-Python external specifiers) always returns a string.
 * Callers MUST drop `undefined` results rather than substitute a fabricated
 * path.
 */
export function resolveImportPath(
  importerPath: string,
  importSpecifier: string,
  availableFiles: Set<string>,
): string | undefined {
  if (detectLanguage(importerPath) === 'python') {
    return resolvePythonImportPath(importerPath, importSpecifier, availableFiles);
  }

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

/**
 * Resolve a list of raw import specifiers, dropping any that
 * `resolveImportPath` leaves unresolved (R3-002 no-fabrication contract —
 * currently only the Python relative-import case can return `undefined`).
 */
function resolveImportPathList(
  importerPath: string,
  specifiers: string[],
  availableFiles: Set<string>,
): string[] {
  const out: string[] = [];
  for (const spec of specifiers) {
    const resolved = resolveImportPath(importerPath, spec, availableFiles);
    if (resolved !== undefined) out.push(resolved);
  }
  return out;
}

// ─── Export Buckets (D3, D6) ─────────────────────────────────────

/**
 * Split a file's extracted `ExportInfo[]` into locally-defined exports vs
 * the two re-export buckets (named/type-only symbols, and wildcard
 * sources). Shared by BOTH `buildGraph` and `buildGraphIncremental` (D6
 * parity) — factored out specifically so the barrel split can't drift
 * between the two builder paths the way `extractImports`/`extractExports`
 * calls historically have (see `stageImportSymbols`/`remapImportSymbols`
 * for the analogous import-side precedent).
 *
 * `reExportsAllRaw` sources are UNRESOLVED module specifiers — the caller
 * resolves them via `resolveImportPath` in whichever pass it already
 * resolves `imports` in (Pass 2 for `buildGraph`, inline for
 * `buildGraphIncremental`).
 */
function deriveExportBuckets(extractedExports: ExportInfo[]): {
  exports: string[];
  reExportedSymbols?: string[];
  reExportsAllRaw?: string[];
} {
  const exports: string[] = [];
  const reExportedSymbols: string[] = [];
  const reExportsAllRaw: string[] = [];

  for (const exp of extractedExports) {
    if (exp.source === undefined) {
      exports.push(exp.name);
    } else if (exp.name === '*') {
      reExportsAllRaw.push(exp.source);
    } else {
      reExportedSymbols.push(exp.name);
    }
  }

  return {
    exports,
    reExportedSymbols: reExportedSymbols.length > 0 ? reExportedSymbols : undefined,
    reExportsAllRaw: reExportsAllRaw.length > 0 ? reExportsAllRaw : undefined,
  };
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

  // Staged rawSource[] (wildcard re-export sources) per file, BEFORE Pass-2
  // path resolution — resolved into `reExportsAll` alongside `imports` in
  // Pass 2, mirroring `rawSymbolsByFile` above (D6).
  const rawWildcardSourcesByFile = new Map<string, string[]>();

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
      const buckets = deriveExportBuckets(extractedExports);

      nodes[filePath] = {
        hash: hashContent(content),
        language,
        imports: extractedImports.map((i) => i.source),
        exports: buckets.exports,
        ...(buckets.reExportedSymbols ? { reExportedSymbols: buckets.reExportedSymbols } : {}),
        calls: [],
        isTest: isTestFile(filePath),
      };

      if (buckets.reExportsAllRaw) {
        rawWildcardSourcesByFile.set(filePath, buckets.reExportsAllRaw);
      }

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
    node.imports = resolveImportPathList(filePath, node.imports, availableFiles);

    const rawSymbols = rawSymbolsByFile.get(filePath);
    if (rawSymbols) {
      const resolved = remapImportSymbols(filePath, rawSymbols, availableFiles);
      if (resolved) node.importSymbols = resolved;
    }

    const rawWildcardSources = rawWildcardSourcesByFile.get(filePath);
    if (rawWildcardSources) {
      node.reExportsAll = resolveImportPathList(filePath, rawWildcardSources, availableFiles);
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
    if (resolved === undefined) continue;
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
      const buckets = deriveExportBuckets(extractedExports);

      nodes[filePath] = {
        hash: hashContent(content),
        language,
        imports: resolveImportPathList(
          filePath,
          extractedImports.map((i) => i.source),
          allFiles,
        ),
        exports: buckets.exports,
        ...(buckets.reExportedSymbols ? { reExportedSymbols: buckets.reExportedSymbols } : {}),
        ...(buckets.reExportsAllRaw
          ? {
              reExportsAll: resolveImportPathList(filePath, buckets.reExportsAllRaw, allFiles),
            }
          : {}),
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
