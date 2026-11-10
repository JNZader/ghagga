/**
 * Blast-Radius Diagram Summary Builder (blast-radius-diagram Slice 2)
 *
 * Pure, synchronous assembly of the `BlastRadiusDiagram` from the graph
 * ALREADY loaded by the pipeline (single-load rule) plus the untouched
 * `BlastRadiusResult`. NO additional graph loads, NO I/O — the builder is
 * a pure consumer of `(graph, result, graphStale)`.
 *
 * Design decisions (design.md D1/D2/D5/D7 + spec resolutions):
 *
 * - Eligible pool = the blast-radius file set (changed + dependents +
 *   tests, post-narrowing — narrowing runs before the builder in step
 *   2.5) UNION the changed files' direct depth-1 neighborhood in BOTH
 *   directions (importers via reverse edges, importees via
 *   `node.imports`), derived through the merged `collectFileNeighborhoods`
 *   API (neighbors.ts) — the same edge space `computeBlastRadius`
 *   traverses. Only files present as graph nodes participate (a changed
 *   file the graph never indexed has no edges to show).
 * - Survivor selection (D5): ALL changed files first (path asc), then the
 *   remaining files by (edge degree desc, path asc). Degree is computed
 *   over the FULL pool before selection (stable ranking regardless of
 *   the cap), from ONE `collectFileNeighborhoods` query with
 *   `maxTotalFiles` raised to the pool size. The default per-direction
 *   cap (10) is accepted for ranking.
 * - Edges: internal to the survivor set only (both endpoints survivors),
 *   `from` = importer, `to` = importee. Derived from the same single
 *   neighborhood query — `collectFileNeighborhoods` re-runs
 *   `buildReverseIndex` once (O(V+E) CPU, accepted per design).
 * - Roles (precedence): changed > test > dependent.
 * - Caps + the 10k JSON invariant are enforced HERE at BUILD time
 *   (renderMermaidDiagram caps defensively; format.ts and the dashboard
 *   are render-only and never truncate). An oversize artifact throws —
 *   the pipeline catches, records a failed step, and keeps counts-only
 *   metadata (review continues).
 * - `exceededCap` result → `undefined` (spec wins over the design's
 *   degradation table: NO node/edge lists when the radius exceeded the
 *   cap — counts-only fallback, prepare-graph never calls the builder
 *   from the exceededCap branch; this gate is defense in depth).
 */

import type { BlastRadiusResult } from './blast-radius.js';
import {
  assertDiagramJsonBudget,
  clusterOfPath,
  type MermaidEdgeInput,
  type MermaidNodeInput,
  renderMermaidDiagram,
} from './diagram.js';
import { collectFileNeighborhoods } from './neighbors.js';
import {
  type BlastRadiusDiagram,
  type BlastRadiusDiagramNodeRole,
  type DependencyGraph,
  MAX_DIAGRAM_NODES,
} from './schema.js';

/** Locale-independent ordering — same comparator as the renderer (D7). */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the capped, sanitized blast-radius diagram.
 *
 * @param graph - the dependency graph the pipeline already loaded
 *   (single-load rule — the builder never loads anything itself).
 * @param result - the UNTOUCHED `computeBlastRadius` result (the builder
 *   reads it; it never mutates it).
 * @param graphStale - staleness flag from the graph metadata (7-day rule).
 * @returns the diagram, or `undefined` when there is nothing to diagram:
 *   no changed files in the graph, or an `exceededCap` result (counts-only
 *   fallback — no lists).
 */
export function buildBlastRadiusDiagramSummary(
  graph: DependencyGraph,
  result: BlastRadiusResult,
  graphStale: boolean,
): BlastRadiusDiagram | undefined {
  // Oversize radius → counts-only, NEVER lists (spec resolution).
  if (result.exceededCap) return undefined;

  // Only graph-backed changed files are diagrammable. `BlastRadiusResult
  // .changedFiles` echoes the diff input (files the graph never indexed
  // included); they have no node record, no edges, no cluster — skip them.
  const changed = [...new Set(result.changedFiles)]
    .filter((f) => graph.nodes[f] !== undefined)
    .sort(comparePaths);
  if (changed.length === 0) return undefined;

  // ── Eligible pool: blast-radius set ∪ changed files' depth-1
  // neighborhood in BOTH directions (importers + importees). Discovery
  // query #1 runs over the changed files only — the spec's "queried over
  // the changed files' direct neighborhood" — pulling upstream importees
  // (never in `result.files`: `computeBlastRadius` traverses downstream
  // only) and any importer the traversal might have missed.
  const changedSet = new Set(changed);
  const pool = new Set<string>(result.files);
  for (const file of changed) pool.add(file);
  const changedHoods = collectFileNeighborhoods(graph, changed, {
    maxTotalFiles: changed.length,
  });
  for (const hood of changedHoods) {
    for (const importer of hood.importers) pool.add(importer);
    for (const importee of hood.importees) pool.add(importee);
  }

  const testSet = new Set(result.testFiles);

  // Neighborhood query #2 over the whole pool: feeds BOTH the degree
  // ranking (full pool) and, filtered to survivors, the edge derivation.
  // `maxTotalFiles` raised to the pool size so no member is skipped; the
  // default per-direction cap (10) is accepted — ranking + bounded edges.
  // Each query re-runs `buildReverseIndex` once (O(V+E) CPU, no I/O —
  // accepted per design).
  const poolFiles = [...pool].filter((f) => graph.nodes[f] !== undefined).sort(comparePaths);
  const hoods = collectFileNeighborhoods(graph, poolFiles, { maxTotalFiles: poolFiles.length });
  const hoodByFile = new Map(hoods.map((h) => [h.file, h]));
  const degreeByFile = new Map<string, number>();
  for (const hood of hoods) {
    degreeByFile.set(hood.file, hood.importers.length + hood.importees.length);
  }

  // ── Survivor selection (D5): changed first (path asc), then the rest
  // by (degree desc, path asc) — degree over the FULL pool. ───────────
  const rest = poolFiles
    .filter((f) => !changedSet.has(f))
    .sort((a, b) => (degreeByFile.get(b) ?? 0) - (degreeByFile.get(a) ?? 0) || comparePaths(a, b));
  const survivors = [...changed, ...rest].slice(0, MAX_DIAGRAM_NODES);
  const survivorSet = new Set(survivors);
  const omitted = rest.slice(Math.max(0, MAX_DIAGRAM_NODES - changed.length));

  // ── Roles (precedence changed > test > dependent). ─────────────────
  const roleOf = (path: string): BlastRadiusDiagramNodeRole => {
    if (changedSet.has(path)) return 'changed';
    if (testSet.has(path)) return 'test';
    return 'dependent';
  };
  const nodeInputs: MermaidNodeInput[] = survivors.map((path) => ({
    path,
    role: roleOf(path),
  }));

  // ── Edges: internal to survivors, from = importer, to = importee.
  // An internal edge is visible from BOTH endpoints' records; dedupe at
  // the renderer. Any edge with an endpoint outside survivors is dropped.
  const edgeInputs: MermaidEdgeInput[] = [];
  for (const file of survivors) {
    const hood = hoodByFile.get(file);
    if (!hood) continue;
    for (const importer of hood.importers) {
      if (survivorSet.has(importer)) edgeInputs.push({ from: importer, to: file });
    }
    for (const importee of hood.importees) {
      if (survivorSet.has(importee)) edgeInputs.push({ from: file, to: importee });
    }
  }

  // ── Cap + render + build-time budget (D2). The renderer enforces the
  // 25/40 caps deterministically; the budget guard throws on the (never
  // expected, mathematically unreachable with the caps) oversize case so
  // the pipeline degrades to counts-only instead of persisting it.
  const diagram = renderMermaidDiagram(nodeInputs, edgeInputs, {
    stale: graphStale,
    exceededCap: false,
  });

  // Survivor selection above dropped `omitted` files BEFORE the renderer
  // ever saw them — the renderer's own node cap cannot fire on pre-capped
  // input, so the builder records the selection truncation itself
  // (`truncated` + omitted-per-cluster `clusterCounts`). A defensive
  // renderer-side node cap (never in production) would merge in.
  if (omitted.length > 0) {
    diagram.meta.truncated = true;
    const merged: Record<string, number> = { ...(diagram.meta.clusterCounts ?? {}) };
    for (const file of omitted) {
      const cluster = clusterOfPath(file);
      merged[cluster] = (merged[cluster] ?? 0) + 1;
    }
    diagram.meta.clusterCounts = merged;
  }

  assertDiagramJsonBudget(diagram);
  return diagram;
}
