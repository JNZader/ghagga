/**
 * EXPAND (LOCATE stage 2) — widen the LLM-reranked seed set into a bounded
 * code-context file pool for the TRIAGE stage.
 *
 * Two strategies:
 *  - dir-sibling (default, always available): for every seed file, pull in
 *    files that live in the same directory, up to a cap. This is the PoC's
 *    proven pragmatic approach — no graph resolution required.
 *  - graph (opt-in via `config.graphExpand`): use ghagga-core's
 *    `buildGraph`/`computeBlastRadius` to pull in actual dependents of each
 *    seed. ONLY reliable for languages in `GRAPH_RESOLVABLE_LANGUAGES` — see
 *    graph-resolution.test.ts (task 4.5) for the empirical proof. Go is
 *    EXCLUDED unconditionally (its module-path imports never resolve to a
 *    file node — confirmed by the biogas PoC and re-confirmed here).
 */

import path from 'node:path';
import { buildGraph, computeBlastRadius } from 'ghagga-core';
import type { TriageConfig } from '../config/schema.js';

/**
 * Languages for which `resolveImportPath` (ghagga-core builder.ts) actually
 * resolves an import specifier to a project-relative file path, making
 * `computeBlastRadius` meaningful. Empirically confirmed in
 * graph-resolution.test.ts — do NOT add a language here without a passing
 * seed->dependent resolution test backing it.
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
 *   for dir-sibling lookup and as the graph build input
 * @param config - resolved TriageConfig (graphExpand + language gate the strategy)
 * @param options - caps
 */
export function expand(
  seeds: string[],
  files: Map<string, string>,
  config: Pick<TriageConfig, 'graphExpand' | 'language'>,
  options?: ExpandOptions,
): string[] {
  const maxFiles = options?.maxFiles ?? 10;
  if (seeds.length === 0) return [];

  const useGraph =
    config.graphExpand &&
    config.language !== 'go' &&
    GRAPH_RESOLVABLE_LANGUAGES.has(config.language);

  if (useGraph) {
    return expandViaGraph(seeds, files, maxFiles, options?.graphDepth ?? 2);
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
  seeds: string[],
  files: Map<string, string>,
  maxFiles: number,
  depth: number,
): string[] {
  const validSeeds = seeds.filter((s) => files.has(s));
  if (validSeeds.length === 0) return [];

  const graph = buildGraph('.', files);
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
