/**
 * EXPAND (LOCATE stage 2) — widen the LLM-reranked seed set into a bounded
 * code-context file pool for the TRIAGE stage.
 *
 * Three strategies, tried in order when `config.graphExpand` is on:
 *  1. SCIP graph (`.ghagga/graph.json`, built by `ghagga index`): when
 *     present at `config.codeRoot`, `computeBlastRadius` runs against it
 *     directly. This graph is multi-language and symbol-aware (#317-#328),
 *     so the `GRAPH_RESOLVABLE_LANGUAGES` ts/js-only gate does NOT apply
 *     here — a Go/Python/Rust/Java seed resolves real dependents whenever
 *     `ghagga index` captured that language.
 *  2. regex graph (`buildGraph('.', files)`, the pre-SCIP fallback): used
 *     when no SCIP graph is available (absent/malformed/oversize —
 *     `FilesystemGraphLoader` degrades to `null` for all three). ONLY
 *     reliable for languages in `GRAPH_RESOLVABLE_LANGUAGES` — see
 *     graph-resolution.test.ts (task 4.5) for the empirical proof. Go is
 *     EXCLUDED unconditionally on this path (its module-path imports never
 *     resolve to a file node — confirmed by the biogas PoC and re-confirmed
 *     here).
 *  3. dir-sibling (default, always available, and the fallback of the
 *     fallback): for every seed file, pull in files that live in the same
 *     directory, up to a cap. This is the PoC's proven pragmatic approach —
 *     no graph resolution required.
 */

import path from 'node:path';
import {
  buildGraph,
  computeBlastRadius,
  type DependencyGraph,
  FilesystemGraphLoader,
} from 'ghagga-core';
import type { TriageConfig } from '../config/schema.js';

/**
 * Languages for which `resolveImportPath` (ghagga-core builder.ts) actually
 * resolves an import specifier to a project-relative file path, making
 * `computeBlastRadius` meaningful ON THE REGEX GRAPH. Empirically confirmed
 * in graph-resolution.test.ts — do NOT add a language here without a
 * passing seed->dependent resolution test backing it.
 *
 * This gate ONLY applies to the regex `buildGraph` fallback path. When a
 * SCIP graph (`.ghagga/graph.json`) is available, `expandViaGraph` uses it
 * directly and this language restriction does NOT apply — the SCIP graph
 * resolves whatever languages `ghagga index` captured.
 */
export const GRAPH_RESOLVABLE_LANGUAGES: ReadonlySet<TriageConfig['language']> = new Set([
  'ts',
  'js',
]);

export interface ExpandOptions {
  /** Absolute cap on the number of files returned. Default: 10. */
  maxFiles?: number;
  /** BFS depth for graph-mode expansion. Default: 2. */
  graphDepth?: number;
}

/**
 * Expand a multi-seed candidate set into a bounded context file pool.
 *
 * @param seeds - relative file paths chosen by rerank (LOCATE stage 1.5)
 * @param files - the full scanned pool (relative path -> content), used both
 *   for dir-sibling lookup and as the regex graph build input
 * @param config - resolved TriageConfig (graphExpand + language gate the
 *   strategy; codeRoot locates an optional `.ghagga/graph.json`)
 * @param options - caps
 */
export async function expand(
  seeds: string[],
  files: Map<string, string>,
  config: Pick<TriageConfig, 'graphExpand' | 'language'> & Partial<Pick<TriageConfig, 'codeRoot'>>,
  options?: ExpandOptions,
): Promise<string[]> {
  const maxFiles = options?.maxFiles ?? 10;
  if (seeds.length === 0) return [];

  if (!config.graphExpand) {
    return expandViaDirSiblings(seeds, files, maxFiles);
  }

  const scipGraph = config.codeRoot
    ? await new FilesystemGraphLoader(config.codeRoot).load()
    : null;

  if (scipGraph) {
    // SCIP graph found — gate lifts, all languages it indexed are eligible.
    return expandViaGraph(scipGraph, seeds, files, maxFiles, options?.graphDepth ?? 2);
  }

  const regexResolvable =
    config.language !== 'go' && GRAPH_RESOLVABLE_LANGUAGES.has(config.language);
  if (regexResolvable) {
    const regexGraph = buildGraph('.', files);
    return expandViaGraph(regexGraph, seeds, files, maxFiles, options?.graphDepth ?? 2);
  }

  return expandViaDirSiblings(seeds, files, maxFiles);
}

function expandViaDirSiblings(
  seeds: string[],
  files: Map<string, string>,
  maxFiles: number,
): string[] {
  const expanded = new Set<string>(seeds.filter((s) => files.has(s)));
  const seedDirs = new Set(seeds.map((s) => path.dirname(s)));
  for (const rel of files.keys()) {
    if (expanded.size >= maxFiles) break;
    if (seedDirs.has(path.dirname(rel))) expanded.add(rel);
  }
  return [...expanded].slice(0, maxFiles);
}

function expandViaGraph(
  graph: DependencyGraph,
  seeds: string[],
  files: Map<string, string>,
  maxFiles: number,
  depth: number,
): string[] {
  const validSeeds = seeds.filter((s) => files.has(s));
  if (validSeeds.length === 0) return [];

  const result = computeBlastRadius(graph, validSeeds, {
    maxDepth: depth,
    maxFiles,
    includeTests: false,
  });

  const combined = new Set<string>(validSeeds);
  for (const f of result.files) combined.add(f);

  // Graph expansion alone can be sparse (e.g. a seed with no reverse deps in
  // this scan scope) — fall back to dir-sibling to top up to maxFiles, same
  // pragmatic blend the PoC used implicitly via its always-on dir-sibling pass.
  if (combined.size < maxFiles) {
    for (const f of expandViaDirSiblings(validSeeds, files, maxFiles)) {
      if (combined.size >= maxFiles) break;
      combined.add(f);
    }
  }

  return [...combined].slice(0, maxFiles);
}
