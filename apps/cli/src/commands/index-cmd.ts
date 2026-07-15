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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  buildGraph,
  buildGraphFromScip,
  type DependencyGraph,
  EXCLUDED_DIRS,
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

  const detected = detectPresentLanguages(repoPath);
  const { indexes, indexedLanguages, skipped } = await dispatchIndexers(repoPath, detected);

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
    writeGraph(outPath, graph);
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
  writeGraph(outPath, graph);
  tui.log.success(
    `✅ Wrote ${Object.keys(graph.nodes).length} node(s) to ${outPath} ` +
      `(SCIP: ${indexedLanguages.join(', ')}).`,
  );
}
