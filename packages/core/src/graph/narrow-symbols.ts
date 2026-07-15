/**
 * Symbol-Precise Blast-Radius Narrowing (scip-symbol-exclusion, design v3 SAFE)
 *
 * A PURE SUBTRACTIVE POST-FILTER over `computeBlastRadius` — never an
 * alternative inclusion path. `computeBlastRadius`/`buildReverseIndex`
 * (blast-radius.ts) stay BYTE-IDENTICAL; this module only removes
 * provably-unaffected DIRECT (depth-1) dependents from that result.
 *
 * Three fail-closed pillars, each independently load-bearing:
 * - Pillar 0 (`isExactCommitFresh`): symbol-line attribution is only valid
 *   when the graph was indexed at the EXACT SAME commit as the diff's
 *   post-image — a stale graph shifts lines and silently maps changed
 *   lines to the WRONG symbol (Pillar 1 cannot catch this: a symbol WAS
 *   found, just the wrong one). ANY doubt about freshness ⇒ no exclusion.
 * - Pillar 1 (`hasUnattributedChanges`): changed-symbol data always comes
 *   from `computeChangedSymbolsComplete`; any changed file with even one
 *   unattributed line forces conservative-include of every dependent
 *   reaching it.
 * - Pillar 2 (`canExcludeEdge`): a pure, fail-closed ENUMERATED WHITELIST
 *   on B's (the changed file's) language + builtVia. DEFAULT false — only
 *   explicitly enumerated cells return true. This is a whitelist, not a
 *   `!== python` blacklist (that was JD-001, a confirmed BLOCKER: it
 *   wrongly allowed go/kotlin/csharp/php under SCIP).
 *
 * Any single uncertainty at any layer resolves to INCLUDE. Never narrows a
 * directly-changed file, and — because condition (2) below forces include
 * on ANY transitive hop — only ever prunes DIRECT (depth-1) dependents;
 * transitive dependents are always included (documented, not a bug).
 */

import type { ChangedSymbolsResult } from './changed-symbols.js';
import type { DependencyGraph, GraphMetadata, GraphNode, SupportedLanguage } from './schema.js';
import { isGraphStale } from './schema.js';

// ─── Pillar 2: canExcludeEdge — fail-closed enumerated whitelist ────

/**
 * SCIP-dense whitelist (D2/spec): languages where SCIP symbol extraction is
 * empirically dense enough to trust for exclusion. Go has partial SCIP
 * fidelity (JD-001 guard: must stay excluded from this set). Python's
 * scip-python fidelity is unverified. Any language NOT in this set —
 * including future/unknown languages — resolves to conservative-include.
 */
const SCIP_DENSE_LANGUAGES: ReadonlySet<SupportedLanguage> = new Set([
  'typescript',
  'javascript',
  'rust',
  'java',
]);

/**
 * Regex-dense whitelist: languages where the regex extractor's
 * `importSymbols` is dense enough to trust for exclusion WITHOUT an
 * additional per-edge precondition.
 */
const REGEX_DENSE_LANGUAGES: ReadonlySet<SupportedLanguage> = new Set([
  'typescript',
  'javascript',
  'java',
]);

/**
 * Regex languages where `importSymbols` is sparse/alias-only in general,
 * but MAY be trusted for exclusion IF the specific edge A→B happens to
 * carry a populated `importSymbols[B]` entry (already enforced by the
 * universal precondition below — this set just says "these two languages
 * are eligible for that precondition-gated allowance", Go is NOT).
 */
const REGEX_CONDITIONAL_LANGUAGES: ReadonlySet<SupportedLanguage> = new Set(['python', 'rust']);

/**
 * Pure, fail-closed gate for a single edge A→B (A depends on changed file
 * B). DEFAULT return is `false`; only the explicitly enumerated cells in
 * the D2 table return `true`. Gates on B's language — NEVER A's — because
 * the carve-out is about B's extracted-symbol fidelity, not A's.
 */
export function canExcludeEdge(
  aNode: GraphNode,
  bPath: string,
  bNode: GraphNode,
  builtVia: 'scip' | 'regex' | undefined,
): boolean {
  // Universal preconditions — any false ⇒ false immediately.
  if (builtVia !== 'scip' && builtVia !== 'regex') return false;
  if (bNode.reExportsAll && bNode.reExportsAll.length > 0) return false;

  const usedSymbols = aNode.importSymbols?.[bPath];
  if (!usedSymbols || usedSymbols.length === 0) return false;

  if (!bNode.symbolRanges || Object.keys(bNode.symbolRanges).length === 0) return false;

  const bLang = bNode.language;

  if (builtVia === 'scip') {
    return SCIP_DENSE_LANGUAGES.has(bLang);
  }

  // builtVia === 'regex'
  if (REGEX_DENSE_LANGUAGES.has(bLang)) return true;
  if (REGEX_CONDITIONAL_LANGUAGES.has(bLang)) {
    // Universal precondition already enforced aNode.importSymbols[bPath]
    // is present and non-empty above — that IS the "importSymbols[B]
    // present on edge A→B" requirement from the spec for python/rust.
    return true;
  }
  return false;
}

// ─── Pillar 0: isExactCommitFresh ───────────────────────────────

/**
 * True ONLY when `metadata.lastIndexedCommit` is present, EQUALS
 * `currentHead`, and the graph is not stale-by-age. ANY doubt (absent
 * metadata, head mismatch, empty currentHead, stale-by-age) ⇒ false —
 * fails safe, never assumes freshness.
 */
export function isExactCommitFresh(
  metadata: GraphMetadata | null,
  currentHead: string | undefined,
): boolean {
  if (!metadata) return false;
  if (!metadata.lastIndexedCommit) return false;
  if (!currentHead) return false;
  if (metadata.lastIndexedCommit !== currentHead) return false;
  if (isGraphStale(metadata)) return false;
  return true;
}

// ─── narrowBySymbols — the post-filter ──────────────────────────

/**
 * Compute the set of dependents to EXCLUDE from the blast radius.
 *
 * For each candidate dependent A (never a directly-changed file), A is
 * excluded ONLY if, for EVERY direct import target B of A that is itself
 * a changed file:
 * - `changedByFile` has a complete entry for B with `hasUnattributedChanges === false`, AND
 * - `canExcludeEdge(A, B)` is true, AND
 * - `importSymbols[A][B] ∩ changedSymbols[B]` is empty.
 *
 * A is included (never excluded) on ANY of:
 * - transitive-only reach (some blast-radius file M ∈ A's reachable set
 *   is NOT one of A's DIRECT imports and is a changed file — approximated
 *   here by A having no direct changed-file import at all while still
 *   being in the BFS-derived `dependents` list, i.e. reached only via an
 *   intermediate),
 * - any reached direct-changed-file B with unattributed changes,
 * - an empty `importSymbols[A][B]` (side-effect/namespace import — treated
 *   as "uncertain", never as "uses nothing"),
 * - any gating uncertainty at all.
 *
 * `dependents` MUST NOT include any file in `changedFileSet` — narrowing
 * never touches directly-changed files (callers must filter/verify this;
 * this function additionally defends by skipping any candidate that is
 * itself in `changedFileSet`).
 */
export function narrowBySymbols(
  dependents: string[],
  changedByFile: Map<string, ChangedSymbolsResult>,
  graph: DependencyGraph,
  builtVia: 'scip' | 'regex' | undefined,
  _blastFiles: Set<string>,
  changedFileSet: Set<string>,
): Set<string> {
  const excluded = new Set<string>();

  if (builtVia !== 'scip' && builtVia !== 'regex') return excluded;

  for (const aPath of dependents) {
    // Never narrow a directly-changed file, even if passed in by mistake.
    if (changedFileSet.has(aPath)) continue;

    const aNode = graph.nodes[aPath];
    if (!aNode) continue;

    // Direct import targets of A that are themselves changed files.
    const directChangedTargets = aNode.imports.filter((target) => changedFileSet.has(target));

    // Transitive-only reach: A is a dependent (per BFS) but has NO direct
    // import edge into any changed file — it must have been reached via an
    // intermediate hop. Per D3 cond (2), always include.
    if (directChangedTargets.length === 0) continue;

    let allEdgesSafe = true;

    for (const bPath of directChangedTargets) {
      const bNode = graph.nodes[bPath];
      if (!bNode) {
        allEdgesSafe = false;
        break;
      }

      const complete = changedByFile.get(bPath);
      if (!complete || complete.hasUnattributedChanges) {
        allEdgesSafe = false;
        break;
      }

      if (!canExcludeEdge(aNode, bPath, bNode, builtVia)) {
        allEdgesSafe = false;
        break;
      }

      const used = aNode.importSymbols?.[bPath];
      if (!used || used.length === 0) {
        // Empty-set-safe rule: an empty importSymbols entry is uncertain
        // (side-effect/namespace import), never "uses nothing".
        allEdgesSafe = false;
        break;
      }

      const usesChangedSymbol = used.some((s) => complete.changedSymbols.has(s));
      if (usesChangedSymbol) {
        allEdgesSafe = false;
        break;
      }
    }

    if (allEdgesSafe) {
      excluded.add(aPath);
    }
  }

  return excluded;
}
