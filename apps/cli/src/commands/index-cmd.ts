/**
 * Index command — builds the dependency graph consumed by blast-radius/review.
 *
 * Registry dispatcher (D1, nested-marker-detection D3): walks the repo for
 * marker directories at any depth (`detectMarkerDirectories`), checks
 * per-entry toolchain availability ONCE (dir-independent), runs each
 * available indexer once per `{entry, dir}` pair to a centralized,
 * per-dir-disambiguated `.scip` output (D3), merges the results with each
 * document's path prefixed by its source marker directory (D4), and builds
 * ONE graph. Per-pair failures degrade gracefully (D6) — a missing
 * toolchain skips ALL of that entry's dirs (one warning); a runtime crash
 * in one marker directory warns and skips only THAT pair, never aborting
 * the whole run. A run-count cap (D5) bounds pathological monorepos. The
 * regex-based indexer remains available as an explicit opt-in fallback
 * (`--fallback-regex`) for when NO detected language could be indexed via
 * SCIP.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  buildGraph,
  buildGraphFromScip,
  type DependencyGraph,
  EXCLUDED_DIRS,
  GRAPH_VERSION,
  type GraphMetadata,
  type MergeScipIndexesInput,
  mergeScipIndexes,
  parseScipIndex,
} from 'ghagga-core';
import * as tui from '../ui/tui.js';
import {
  detectMarkerDirectories,
  type IndexerEntry,
  type IndexerMaturity,
  type MarkerDirPair,
  scipOutputPath,
} from './indexer-registry.js';

// ─── Types ──────────────────────────────────────────────────────

export interface IndexCommandOptions {
  /** Output path for graph.json, relative to the target repo. */
  out?: string;
  /** Fall back to the regex-based indexer when no language could be SCIP-indexed. */
  fallbackRegex?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_OUT = '.ghagga/graph.json';

// ─── Regex Fallback: File Collection ────────────────────────────

/** Recursively collect readable text files under rootDir, skipping excluded dirs. */
function collectFiles(rootDir: string): Map<string, string> {
  const files = new Map<string, string>();

  function walk(dir: string): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        try {
          const content = readFileSync(full, 'utf-8');
          files.set(relative(rootDir, full), content);
        } catch {
          // Skip unreadable/binary files
        }
      }
    }
  }

  walk(rootDir);
  return files;
}

// ─── Output ─────────────────────────────────────────────────────

function writeGraph(outPath: string, graph: DependencyGraph): void {
  const dir = dirname(outPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outPath, JSON.stringify(graph, null, 2));
}

/**
 * Resolve the current git HEAD SHA for `repoPath`. Returns `''` on any
 * failure (not a git repo, detached-without-HEAD edge cases, git not on
 * PATH) — non-git repos degrade gracefully rather than aborting `ghagga
 * index` (design v2 D1).
 */
function resolveGitHead(repoPath: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Write `.ghagga/metadata.json` ALONGSIDE `.ghagga/graph.json` (design v2
 * D1). MUST be called AFTER `writeGraph` (B-003 write ordering) — a crash
 * between the two writes leaves graph-without-metadata, which
 * `checkGraphStaleness` reports as a distinct "cannot verify staleness"
 * warning, never metadata newer than (or inconsistent with) the graph.
 *
 * `languages` is DERIVED FROM THE GRAPH'S ACTUAL NODE CONTENTS (CRITICAL-1)
 * — NOT dispatch's `indexedLanguages` — because the regex-fallback path sets
 * `indexedLanguages: []` while every node still has a real `language`.
 * `skippedLanguages` is informational only (languages detected but not
 * indexed) and is never used to drive a warning.
 */
function writeMetadata(
  graphOutPath: string,
  graph: DependencyGraph,
  opts: {
    repoPath: string;
    skippedLanguages: string[];
    indexDurationMs: number;
    builtVia: 'scip' | 'regex';
  },
): void {
  const metadataPath = join(dirname(graphOutPath), 'metadata.json');
  const languages = [...new Set(Object.values(graph.nodes).map((node) => node.language))];

  const metadata: GraphMetadata = {
    lastIndexedCommit: resolveGitHead(opts.repoPath),
    lastIndexedAt: new Date().toISOString(),
    schemaVersion: GRAPH_VERSION,
    fileCount: Object.keys(graph.nodes).length,
    languages,
    indexDurationMs: opts.indexDurationMs,
    skippedLanguages: opts.skippedLanguages,
    graphVersion: graph.version,
    builtVia: opts.builtVia,
  };

  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

// ─── Per-Marker-Directory Dispatch (D1, D3, D5, D6) ──────────────

interface DispatchResult {
  indexes: MergeScipIndexesInput[];
  /** Languages successfully indexed (deduped), for the success message. */
  indexedLanguages: string[];
  /** Pairs that were detected but could not be indexed, with why — for the hard-fail message. */
  skipped: Array<{ entry: IndexerEntry; dir: string; reason: string }>;
}

/**
 * Run-count guard default (D5): biogas-scale monorepos have ~5 marker
 * dirs; 25 gives headroom while bounding pathological monorepans ×
 * `heavy`/`experimental` wall-clock. Overridable via `opts.maxRuns`.
 */
export const DEFAULT_MAX_NESTED_RUNS = 25;

const MATURITY_ORDER: Record<IndexerMaturity, number> = { stable: 0, heavy: 1, experimental: 2 };

/** Depth of `dir` relative to `repoPath` (repo root = 0). */
function pairDepth(repoPath: string, dir: string): number {
  const rel = relative(repoPath, dir);
  if (!rel || rel === '.') return 0;
  return rel.split(/[\\/]/).filter(Boolean).length;
}

/**
 * Deterministic string hash (FNV-1a, 32-bit → 8 lowercase hex chars). Pure
 * and reproducible run-to-run for the same input — NOT `Math.random`/`Date`
 * — so the same marker directory always maps to the same `.scip` output
 * path across runs.
 */
function hash8(input: string): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Sanitize a relative path into a filesystem-safe, collision-free slug.
 *
 * The human-readable sanitized prefix alone is NOT collision-stable: e.g.
 * `apps/a_b` and `apps_a/b` both sanitize to `apps_a_b`, which would
 * silently clobber one indexer run's `.scip` output with another's. A
 * deterministic hash of the RAW `relPath` is appended as a suffix so two
 * distinct relPaths can never produce the same slug, while keeping the
 * sanitized prefix for debuggability.
 */
export function slugifyRelPath(relPath: string): string {
  const sanitized = relPath
    .split(/[\\/]/)
    .filter(Boolean)
    .join('_')
    .replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `${sanitized}__${hash8(relPath)}`;
}

/**
 * Sort pairs (maturity stable→heavy→experimental, then depth ascending =
 * root-first) BEFORE capping (D5) — cheap high-value indexers run before
 * expensive ones get dropped, deterministically, root-first.
 *
 * Root-level pairs (depth 0) are EXEMPT from the cap and ALWAYS run — before
 * nested-marker-detection, `ghagga index` unconditionally indexed every
 * root-level language, so a root marker silently vanishing under the cap
 * would be a regression. The cap (`maxRuns`) applies only to NESTED pairs,
 * using the existing maturity→depth sort; if root pairs alone exceed
 * `maxRuns`, they STILL all run (never dropped), matching pre-cap behavior.
 */
function sortAndCapPairs(
  repoPath: string,
  pairs: MarkerDirPair[],
  maxRuns: number,
): { toRun: MarkerDirPair[]; dropped: MarkerDirPair[] } {
  const rootPairs = pairs.filter((p) => pairDepth(repoPath, p.dir) === 0);
  const nestedPairs = pairs.filter((p) => pairDepth(repoPath, p.dir) !== 0);

  const sortedNested = [...nestedPairs].sort((a, b) => {
    const maturityDiff = MATURITY_ORDER[a.entry.maturity] - MATURITY_ORDER[b.entry.maturity];
    if (maturityDiff !== 0) return maturityDiff;
    return pairDepth(repoPath, a.dir) - pairDepth(repoPath, b.dir);
  });

  const nestedBudget = Math.max(0, maxRuns - rootPairs.length);
  return {
    toRun: [...rootPairs, ...sortedNested.slice(0, nestedBudget)],
    dropped: sortedNested.slice(nestedBudget),
  };
}

/**
 * Run every {entry, dir} pair whose entry's toolchain is available,
 * collecting parsed SCIP indexes + their source marker directory (for
 * merge path-prefixing). Missing toolchains warn ONCE per entry and skip
 * ALL its dirs; runtime failures warn and skip only THAT pair (D6) — this
 * function never throws for a single pair's failure. The output path per
 * pair is CENTRALIZED here (not computed by the entry — D3): repo root
 * pairs use the bare bin name, nested pairs get a `__<dir-slug>` suffix so
 * two marker dirs of the SAME bin (e.g. two `scip-python` dirs) never
 * collide on the same `.scip` output file.
 */
async function dispatchIndexers(
  repoPath: string,
  pairs: MarkerDirPair[],
  opts: { maxRuns?: number } = {},
): Promise<DispatchResult> {
  const maxRuns = opts.maxRuns ?? DEFAULT_MAX_NESTED_RUNS;
  const { toRun, dropped } = sortAndCapPairs(repoPath, pairs, maxRuns);

  if (dropped.length > 0) {
    const names = dropped
      .map((p) => `${p.entry.languages.join('/')} @ ${relative(repoPath, p.dir) || '.'}`)
      .join(', ');
    tui.log.warn(
      `⚠️  Run-count cap (${maxRuns}) reached — skipped ${dropped.length} ` +
        `marker director${dropped.length === 1 ? 'y' : 'ies'}: ${names}`,
    );
  }

  const indexes: MergeScipIndexesInput[] = [];
  const indexedLanguages = new Set<string>();
  const skipped: Array<{ entry: IndexerEntry; dir: string; reason: string }> = [];
  const toolchainAvailable = new Map<IndexerEntry, boolean>();

  for (const { entry, dir } of toRun) {
    const languageLabel = entry.languages.join('/');
    const dirLabel = relative(repoPath, dir) || '.';

    let available = toolchainAvailable.get(entry);
    if (available === undefined) {
      available = entry.toolchainCheck();
      toolchainAvailable.set(entry, available);
      if (!available) {
        tui.log.warn(
          `⚠️  ${languageLabel}: toolchain not found (${entry.bin}) — skipping.\n   ${entry.installHint}`,
        );
      }
    }

    if (!available) {
      skipped.push({ entry, dir, reason: `toolchain not found (${entry.bin})` });
      continue;
    }

    const relPath = relative(repoPath, dir);
    const outName = dir === repoPath ? entry.bin : `${entry.bin}__${slugifyRelPath(relPath)}`;
    const outPath = scipOutputPath(repoPath, outName);

    try {
      const scipPath = await entry.run(dir, outPath);
      const bytes = readFileSync(scipPath);
      const index = parseScipIndex(new Uint8Array(bytes));
      indexes.push({ index, pathPrefix: dir === repoPath ? '' : relPath });
      for (const lang of entry.languages) indexedLanguages.add(lang);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tui.log.warn(
        `⚠️  ${languageLabel} @ ${dirLabel}: ${entry.bin} failed at runtime — skipping.\n   ${message}`,
      );
      skipped.push({ entry, dir, reason: message });
    }
  }

  return { indexes, indexedLanguages: [...indexedLanguages], skipped };
}

// ─── scip-typescript Root-Umbrella Collapse (D6, empirical spike) ───

/**
 * RESOLVED (2026-07-15, empirical spike against a synthetic 2-package
 * TypeScript project-references fixture — apps/web + packages/utils, with
 * apps/web importing from packages/utils via `tsconfig.json` `paths`):
 * `scip-typescript index --cwd <repoPath> --infer-tsconfig` run FROM REPO
 * ROOT already recursively discovers and indexes EVERY nested TS/JS
 * package — this held even with NO tsconfig.json/package.json at repo
 * root at all. The root run produced clean repo-relative paths for BOTH
 * packages (`apps/web/src/main.ts`, `packages/utils/src/index.ts`) and
 * correctly resolved the cross-package symbol reference (`main.ts`'s
 * `greet()` call resolved to `packages/utils/src/index.ts`'s definition,
 * not left dangling as an external/unresolved symbol).
 *
 * By contrast, running scip-typescript with `cwd` set to a SUBPACKAGE
 * directory (the per-subroot approach every other indexer needs) still
 * auto-discovered the referenced sibling project, but emitted its path as
 * `../../packages/utils/src/index.ts` — a `..`-escaping relative path
 * outside the run's own cwd tree, which is fragile to prefix-join
 * correctly for arbitrary nesting depths (unlike every other indexer,
 * which never emits paths outside the directory it was pointed at).
 *
 * Conclusion: unlike go/rust/java/dotnet/php (which cannot self-discover
 * nested modules from an ancestor cwd — per-subroot dispatch is mandatory
 * for them, per D1), scip-typescript's own project-reference/tsconfig
 * auto-discovery makes per-subroot dispatch actively WORSE (double-indexes
 * + `..`-escaping paths). So: collapse every TS/JS marker-dir pair to
 * exactly ONE root-cwd run, regardless of how many TS/JS marker
 * directories `detectMarkerDirectories` found.
 */
const TS_ROOT_UMBRELLA = true;

/**
 * Collapse all `scip-typescript` pairs down to a single root-cwd run (D6).
 * No-op for every other entry. If TS/JS was detected ANYWHERE (root or
 * nested), the collapsed pair always runs with `dir = repoPath` — the
 * indexer's own `--infer-tsconfig` walk covers nested tsconfigs from
 * there, so the specific nested `dir` that triggered detection doesn't
 * matter once collapsed.
 */
function collapseTypescriptPairs(repoPath: string, pairs: MarkerDirPair[]): MarkerDirPair[] {
  if (!TS_ROOT_UMBRELLA) return pairs;

  const tsPairs = pairs.filter((p) => p.entry.bin === 'scip-typescript');
  if (tsPairs.length === 0) return pairs;

  const nonTsPairs = pairs.filter((p) => p.entry.bin !== 'scip-typescript');
  const firstTs = tsPairs[0];
  if (!firstTs) return pairs;
  return [...nonTsPairs, { entry: firstTs.entry, dir: repoPath }];
}

// ─── Main Command ───────────────────────────────────────────────

export async function indexCommand(
  targetPath: string,
  options: IndexCommandOptions,
): Promise<void> {
  const repoPath = resolve(targetPath || '.');
  const outPath = resolve(repoPath, options.out ?? DEFAULT_OUT);
  const startedAt = Date.now();

  const rawPairs = detectMarkerDirectories(repoPath);
  const pairs = collapseTypescriptPairs(repoPath, rawPairs);
  const { indexes, indexedLanguages, skipped } = await dispatchIndexers(repoPath, pairs);
  const skippedLanguages = [...new Set(skipped.flatMap((s) => s.entry.languages))];

  if (indexes.length === 0) {
    if (!options.fallbackRegex) {
      const triedLines =
        pairs.length === 0
          ? '   No supported language markers were detected in this repo.'
          : skipped
              .map(
                (s) =>
                  `   - ${s.entry.languages.join('/')} @ ${relative(repoPath, s.dir) || '.'} (${s.entry.bin}): ${s.reason}`,
              )
              .join('\n');
      tui.log.error(
        '❌ No language could be indexed via SCIP.\n' +
          `${triedLines}\n` +
          '   Pass --fallback-regex to use the regex-based indexer instead\n' +
          '   (note: it cannot resolve non-relative/module-path imports).',
      );
      process.exit(1);
      return;
    }

    tui.log.warn(
      '⚠️  No language could be indexed via SCIP — falling back to regex-based indexing.',
    );
    const files = collectFiles(repoPath);
    const graph = buildGraph(repoPath, files);
    // Write ORDER (B-003): graph.json FIRST, THEN metadata.json — a crash
    // between the two leaves graph-without-metadata, never the reverse.
    writeGraph(outPath, graph);
    writeMetadata(outPath, graph, {
      repoPath,
      skippedLanguages,
      indexDurationMs: Date.now() - startedAt,
      builtVia: 'regex',
    });
    tui.log.success(
      `✅ Wrote ${Object.keys(graph.nodes).length} node(s) to ${outPath} (regex fallback).`,
    );
    return;
  }

  const { index: mergedIndex, duplicatePaths, escapedPaths } = mergeScipIndexes(indexes);
  for (const duplicatePath of duplicatePaths) {
    tui.log.warn(
      `⚠️  Duplicate SCIP document path across indexers: ${duplicatePath} — last indexer wins.`,
    );
  }
  for (const escapedPath of escapedPaths) {
    tui.log.warn(
      `⚠️  SCIP document path escaped the repo-relative root: ${escapedPath} — dropped from graph.`,
    );
  }

  const graph = buildGraphFromScip(mergedIndex, {
    onUnmappedDoc: (relativePath, language) => {
      tui.log.warn(
        `⚠️  Unmapped SCIP document ${relativePath} (language: ${language}) — dropped from graph.`,
      );
    },
  });
  // Write ORDER (B-003): graph.json FIRST, THEN metadata.json.
  writeGraph(outPath, graph);
  writeMetadata(outPath, graph, {
    repoPath,
    skippedLanguages,
    indexDurationMs: Date.now() - startedAt,
    builtVia: 'scip',
  });
  tui.log.success(
    `✅ Wrote ${Object.keys(graph.nodes).length} node(s) to ${outPath} ` +
      `(SCIP: ${indexedLanguages.join(', ')}).`,
  );
}
