/**
 * Index command — builds the dependency graph consumed by blast-radius/review.
 *
 * Registry dispatcher (D1): detects present languages via marker files,
 * checks per-language toolchain availability, runs each available indexer
 * to an isolated `.scip` output (D2), merges the results (D4), and builds
 * ONE graph. Per-language failures degrade gracefully (D6) — a missing
 * toolchain or a runtime crash for one language warns and skips it rather
 * than aborting the whole run. The regex-based indexer remains available
 * as an explicit opt-in fallback (`--fallback-regex`) for when NO detected
 * language could be indexed via SCIP.
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
  type Index,
  mergeScipIndexes,
  parseScipIndex,
} from 'ghagga-core';
import * as tui from '../ui/tui.js';
import { detectPresentLanguages, type IndexerEntry } from './indexer-registry.js';

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
  opts: { repoPath: string; skippedLanguages: string[]; indexDurationMs: number },
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
  };

  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

// ─── Per-Language Dispatch (D1, D6) ──────────────────────────────

interface DispatchResult {
  indexes: Index[];
  /** Languages successfully indexed, for the success message. */
  indexedLanguages: string[];
  /** Entries that were detected but could not be indexed, with why — for the hard-fail message. */
  skipped: Array<{ entry: IndexerEntry; reason: string }>;
}

/**
 * Run every detected+available indexer, collecting parsed SCIP indexes.
 * Missing toolchains and runtime failures warn and are skipped (D6) —
 * this function never throws for a single language's failure.
 */
async function dispatchIndexers(
  repoPath: string,
  detected: IndexerEntry[],
): Promise<DispatchResult> {
  const indexes: Index[] = [];
  const indexedLanguages: string[] = [];
  const skipped: Array<{ entry: IndexerEntry; reason: string }> = [];

  for (const entry of detected) {
    const languageLabel = entry.languages.join('/');

    if (!entry.toolchainCheck()) {
      const reason = `toolchain not found (${entry.bin})`;
      tui.log.warn(`⚠️  ${languageLabel}: ${reason} — skipping.\n   ${entry.installHint}`);
      skipped.push({ entry, reason });
      continue;
    }

    try {
      const scipPath = await entry.run(repoPath);
      const bytes = readFileSync(scipPath);
      const index = parseScipIndex(new Uint8Array(bytes));
      indexes.push(index);
      indexedLanguages.push(...entry.languages);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tui.log.warn(
        `⚠️  ${languageLabel}: ${entry.bin} failed at runtime — skipping.\n   ${message}`,
      );
      skipped.push({ entry, reason: message });
    }
  }

  return { indexes, indexedLanguages, skipped };
}

// ─── Main Command ───────────────────────────────────────────────

export async function indexCommand(
  targetPath: string,
  options: IndexCommandOptions,
): Promise<void> {
  const repoPath = resolve(targetPath || '.');
  const outPath = resolve(repoPath, options.out ?? DEFAULT_OUT);
  const startedAt = Date.now();

  const detected = detectPresentLanguages(repoPath);
  const { indexes, indexedLanguages, skipped } = await dispatchIndexers(repoPath, detected);
  const skippedLanguages = skipped.flatMap((s) => s.entry.languages);

  if (indexes.length === 0) {
    if (!options.fallbackRegex) {
      const triedLines =
        detected.length === 0
          ? '   No supported language markers were detected in this repo.'
          : skipped
              .map((s) => `   - ${s.entry.languages.join('/')} (${s.entry.bin}): ${s.reason}`)
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
    });
    tui.log.success(
      `✅ Wrote ${Object.keys(graph.nodes).length} node(s) to ${outPath} (regex fallback).`,
    );
    return;
  }

  const { index: mergedIndex, duplicatePaths } = mergeScipIndexes(indexes);
  for (const duplicatePath of duplicatePaths) {
    tui.log.warn(
      `⚠️  Duplicate SCIP document path across indexers: ${duplicatePath} — last indexer wins.`,
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
  });
  tui.log.success(
    `✅ Wrote ${Object.keys(graph.nodes).length} node(s) to ${outPath} ` +
      `(SCIP: ${indexedLanguages.join(', ')}).`,
  );
}
