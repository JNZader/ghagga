/**
 * Per-language SCIP indexer registry (D1) + marker-file language detection.
 *
 * Hand-rolled, not a scip-io orchestrator wrapper (D1): full control over
 * invocation flags, per-language degradation, and trivially mockable in
 * tests. Tier A ships ONLY the Go entry (refactored from the previous
 * Go-hardcoded `index-cmd.ts`); the other apigen-language entries land in
 * later PRs (Tier B/C/D) on top of this registry shape.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SupportedLanguage } from 'ghagga-core';

// ─── Types ──────────────────────────────────────────────────────

export type IndexerMaturity = 'stable' | 'heavy' | 'experimental';

export interface IndexerEntry {
  /** The underlying SCIP indexer binary, e.g. `scip-go`. */
  bin: string;
  /** Languages this indexer produces documents for (scip-java → java+kotlin). */
  languages: SupportedLanguage[];
  /** Marker files whose presence (any one) triggers detection for this entry. */
  markers: string[];
  /** True when the indexer binary (and any required toolchain) is on PATH. */
  toolchainCheck(): boolean;
  /**
   * Run the indexer against `dir`, producing an isolated `.scip` file
   * (D2: `.ghagga/scip/<bin>.scip`) and returning its absolute path.
   * Throws on runtime failure — the dispatcher catches and degrades.
   */
  run(dir: string): string;
  /** Human-readable install instructions, shown when the toolchain is absent. */
  installHint: string;
  maturity: IndexerMaturity;
}

// ─── Output Isolation Helpers (D2) ───────────────────────────────

/** Directory (relative to repo root) where isolated per-indexer `.scip` outputs live. */
export const SCIP_OUTPUT_DIR = '.ghagga/scip';

/** Absolute isolated output path for a given indexer bin name, under `dir`. */
export function scipOutputPath(dir: string, bin: string): string {
  return join(dir, SCIP_OUTPUT_DIR, `${bin}.scip`);
}

// ─── Go Entry ───────────────────────────────────────────────────

const SCIP_GO_INSTALL_HINT = 'go install github.com/scip-code/scip-go/cmd/scip-go@latest';

/** Check whether a command is resolvable on PATH. */
function commandExists(cmd: string): boolean {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(finder, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const goEntry: IndexerEntry = {
  bin: 'scip-go',
  languages: ['go'],
  markers: ['go.mod'],
  toolchainCheck(): boolean {
    return commandExists('go') && commandExists('scip-go');
  },
  run(dir: string): string {
    const outPath = scipOutputPath(dir, 'scip-go');
    const producedPath = join(dir, 'index.scip');
    // Guard against a stale root-level `index.scip` from a prior manual
    // `scip-go` run being mistaken for output from THIS run.
    if (existsSync(producedPath)) {
      rmSync(producedPath);
    }
    // scip-go always writes `index.scip` in its cwd — no native --output
    // flag — so run in cwd then move to the isolated per-indexer path (D2
    // run-then-move fallback).
    execFileSync('scip-go', [], { cwd: dir, stdio: 'inherit' });
    if (!existsSync(producedPath)) {
      throw new Error(`scip-go did not produce an index at ${producedPath}`);
    }
    // The isolated output dir (.ghagga/scip/) is not guaranteed to exist on
    // a fresh repo — create it before moving the produced file into it.
    mkdirSync(dirname(outPath), { recursive: true });
    renameSync(producedPath, outPath);
    return outPath;
  },
  installHint: SCIP_GO_INSTALL_HINT,
  maturity: 'stable',
};

// ─── Registry ───────────────────────────────────────────────────

/**
 * Tier A: the Go entry only. Later PRs append entries for TS/JS, Python,
 * Rust, Java+Kotlin, C#, and PHP — the dispatcher (`index-cmd.ts`) and
 * `detectPresentLanguages` already generalize over N entries.
 */
export const INDEXER_REGISTRY: IndexerEntry[] = [goEntry];

// ─── Language Detection ─────────────────────────────────────────

/**
 * Detect which registry entries are "present" in `repoPath`, based on
 * marker files at the repo root (any one marker present → detected).
 * Does not check toolchain availability — that's a separate step so the
 * dispatcher can warn about missing toolchains for detected-but-unavailable
 * languages instead of silently skipping them.
 */
export function detectPresentLanguages(repoPath: string): IndexerEntry[] {
  let rootEntries: string[];
  try {
    rootEntries = readdirSync(repoPath);
  } catch {
    return [];
  }
  const present = new Set(rootEntries);

  return INDEXER_REGISTRY.filter((entry) => entry.markers.some((marker) => present.has(marker)));
}
