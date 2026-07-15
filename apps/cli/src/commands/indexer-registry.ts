/**
 * Per-language SCIP indexer registry (D1) + marker-file language detection.
 *
 * Hand-rolled, not a scip-io orchestrator wrapper (D1): full control over
 * invocation flags, per-language degradation, and trivially mockable in
 * tests. Tier A shipped the Go entry (refactored from the previous
 * Go-hardcoded `index-cmd.ts`); Tier B added TS/JS, Python, and Rust. Tier C
 * (this PR) adds Java+Kotlin (shared `scip-java` indexer, `heavy` maturity)
 * and C# (`scip-dotnet`, `experimental` maturity — scip-dotnet 0.2.x is an
 * immature upstream indexer, not merely "heavy" like scip-java). Tier D
 * (this PR) adds PHP (`scip-php`, `experimental`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXCLUDED_DIRS, type SupportedLanguage } from 'ghagga-core';

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
   * Run the indexer against `dir`, writing its SCIP output to `outPath`
   * (an absolute path chosen by the DISPATCHER — D3: centralized under
   * `<repoPath>/.ghagga/scip/`, disambiguated per marker directory) and
   * returning `outPath`. Entries never compute their own output path —
   * once runs multiply (one dir → many possible marker dirs per entry),
   * the dispatcher owns the output namespace to avoid same-bin collisions
   * (e.g. two `scip-python` runs both wanting `scip-python.scip`).
   * Throws on runtime failure — the dispatcher catches and degrades.
   */
  run(dir: string, outPath: string): string;
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
  run(dir: string, outPath: string): string {
    const producedPath = join(dir, 'index.scip');
    // Guard against a stale root-level `index.scip` from a prior manual
    // `scip-go` run being mistaken for output from THIS run.
    if (existsSync(producedPath)) {
      rmSync(producedPath);
    }
    // scip-go always writes `index.scip` in its cwd — no native --output
    // flag — so run in cwd then move to the dispatcher-chosen path (D2/D3
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

// ─── TypeScript/JavaScript Entry ─────────────────────────────────

const SCIP_TYPESCRIPT_INSTALL_HINT = 'npm install -g @sourcegraph/scip-typescript';

const tsEntry: IndexerEntry = {
  bin: 'scip-typescript',
  languages: ['typescript', 'javascript'],
  markers: ['package.json', 'tsconfig.json'],
  toolchainCheck(): boolean {
    return commandExists('scip-typescript');
  },
  run(dir: string, outPath: string): string {
    mkdirSync(dirname(outPath), { recursive: true });
    // scip-typescript supports a native --output flag, unlike scip-go — no
    // run-then-move needed (D2: still isolated, just directly).
    execFileSync(
      'scip-typescript',
      ['index', '--cwd', dir, '--infer-tsconfig', '--output', outPath],
      {
        cwd: dir,
        stdio: 'inherit',
      },
    );
    if (!existsSync(outPath)) {
      throw new Error(`scip-typescript did not produce an index at ${outPath}`);
    }
    return outPath;
  },
  installHint: SCIP_TYPESCRIPT_INSTALL_HINT,
  maturity: 'stable',
};

// ─── Python Entry ─────────────────────────────────────────────────

const SCIP_PYTHON_INSTALL_HINT = 'npm install -g @sourcegraph/scip-python';

const pythonEntry: IndexerEntry = {
  bin: 'scip-python',
  languages: ['python'],
  markers: ['pyproject.toml', 'requirements.txt', 'setup.py'],
  toolchainCheck(): boolean {
    return commandExists('scip-python');
  },
  run(dir: string, outPath: string): string {
    mkdirSync(dirname(outPath), { recursive: true });
    // scip-python also supports a native --output flag.
    execFileSync('scip-python', ['index', '--cwd', dir, '--output', outPath], {
      cwd: dir,
      stdio: 'inherit',
    });
    if (!existsSync(outPath)) {
      throw new Error(`scip-python did not produce an index at ${outPath}`);
    }
    return outPath;
  },
  installHint: SCIP_PYTHON_INSTALL_HINT,
  maturity: 'stable',
};

// ─── Rust Entry ─────────────────────────────────────────────────

const RUST_ANALYZER_INSTALL_HINT = 'rustup component add rust-analyzer';

const rustEntry: IndexerEntry = {
  bin: 'rust-analyzer',
  languages: ['rust'],
  markers: ['Cargo.toml'],
  toolchainCheck(): boolean {
    return commandExists('rust-analyzer');
  },
  run(dir: string, outPath: string): string {
    mkdirSync(dirname(outPath), { recursive: true });
    // rust-analyzer's `scip` subcommand also supports a native --output flag.
    execFileSync('rust-analyzer', ['scip', dir, '--output', outPath], {
      cwd: dir,
      stdio: 'inherit',
    });
    if (!existsSync(outPath)) {
      throw new Error(`rust-analyzer did not produce an index at ${outPath}`);
    }
    return outPath;
  },
  installHint: RUST_ANALYZER_INSTALL_HINT,
  maturity: 'stable',
};

// ─── Java/Kotlin Entry ────────────────────────────────────────────

const SCIP_JAVA_INSTALL_HINT =
  'curl -fLo coursier https://git.io/coursier-cli && chmod +x coursier && ' +
  './coursier bootstrap --standalone -o scip-java org.scip-code:scip-java:latest.stable ' +
  '--main org.scip_code.scip_java.ScipJava (requires a JDK 17+ host JVM and a ' +
  'Gradle or Maven build in the target repo — Kotlin support is Gradle-only)';

const javaEntry: IndexerEntry = {
  bin: 'scip-java',
  languages: ['java', 'kotlin'],
  markers: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  toolchainCheck(): boolean {
    return commandExists('scip-java') && (commandExists('gradle') || commandExists('mvn'));
  },
  run(dir: string, outPath: string): string {
    mkdirSync(dirname(outPath), { recursive: true });
    // scip-java's `index` command supports a native --output flag (unlike
    // scip-go/scip-php) — it auto-detects Gradle vs Maven in `dir` and shells
    // out to it (D2: still isolated, just directly, like tsEntry/pythonEntry).
    execFileSync('scip-java', ['index', '--output', outPath], {
      cwd: dir,
      stdio: 'inherit',
    });
    if (!existsSync(outPath)) {
      throw new Error(`scip-java did not produce an index at ${outPath}`);
    }
    return outPath;
  },
  installHint: SCIP_JAVA_INSTALL_HINT,
  maturity: 'heavy',
};

// ─── C# Entry ─────────────────────────────────────────────────────

const SCIP_DOTNET_INSTALL_HINT =
  'dotnet tool install --global scip-dotnet (requires .NET 8.0+ SDK; experimental indexer)';

const csharpEntry: IndexerEntry = {
  bin: 'scip-dotnet',
  languages: ['csharp'],
  markers: ['*.csproj', '*.sln'],
  toolchainCheck(): boolean {
    return commandExists('scip-dotnet') && commandExists('dotnet');
  },
  run(dir: string, outPath: string): string {
    mkdirSync(dirname(outPath), { recursive: true });
    // scip-dotnet's `index` command supports a native --output flag plus
    // --working-directory (its own project/solution auto-discovery arg is
    // positional and optional — omitted here to let it self-discover).
    execFileSync('scip-dotnet', ['index', '--output', outPath, '--working-directory', dir], {
      cwd: dir,
      stdio: 'inherit',
    });
    if (!existsSync(outPath)) {
      throw new Error(`scip-dotnet did not produce an index at ${outPath}`);
    }
    return outPath;
  },
  installHint: SCIP_DOTNET_INSTALL_HINT,
  maturity: 'experimental',
};

// ─── PHP Entry ────────────────────────────────────────────────────

const SCIP_PHP_INSTALL_HINT =
  'composer require --dev davidrjenni/scip-php && composer dump-autoload ' +
  '(requires a composer.json with autoload psr-4/classmap entries covering ' +
  'the sources to index; experimental, solo-maintained indexer)';

const phpEntry: IndexerEntry = {
  bin: 'scip-php',
  languages: ['php'],
  markers: ['composer.json'],
  toolchainCheck(): boolean {
    return commandExists('scip-php');
  },
  run(dir: string, outPath: string): string {
    const producedPath = join(dir, 'index.scip');
    // Guard against a stale root-level `index.scip` from a prior manual run
    // (same rationale as goEntry).
    if (existsSync(producedPath)) {
      rmSync(producedPath);
    }
    // scip-php has no --output flag — it always writes `index.scip` to its
    // cwd (verified against davidrjenni/scip-php's bin/scip-php source,
    // which hardcodes `file_put_contents('index.scip', ...)`). Run-then-move
    // (D2 fallback), same pattern as scip-go.
    execFileSync('scip-php', [], { cwd: dir, stdio: 'inherit' });
    if (!existsSync(producedPath)) {
      throw new Error(`scip-php did not produce an index at ${producedPath}`);
    }
    mkdirSync(dirname(outPath), { recursive: true });
    renameSync(producedPath, outPath);
    return outPath;
  },
  installHint: SCIP_PHP_INSTALL_HINT,
  maturity: 'experimental',
};

// ─── Registry ───────────────────────────────────────────────────

/**
 * Tier A shipped the Go entry; Tier B added TS/JS, Python, Rust. Tier C/D
 * (this PR) add Java+Kotlin, C#, and PHP — the dispatcher (`index-cmd.ts`)
 * and `detectPresentLanguages` already generalize over N entries.
 */
export const INDEXER_REGISTRY: IndexerEntry[] = [
  goEntry,
  tsEntry,
  pythonEntry,
  rustEntry,
  javaEntry,
  csharpEntry,
  phpEntry,
];

// ─── Language Detection ─────────────────────────────────────────

/**
 * Match a single marker against the repo root's entries. Most markers are
 * exact filenames (`Set.has`); a marker starting with `*.` is a minimal
 * glob — any-present file with that extension (e.g. C#'s `*.csproj`/`*.sln`,
 * which have no fixed name).
 */
function markerPresent(marker: string, present: Set<string>, rootEntries: string[]): boolean {
  if (marker.startsWith('*.')) {
    const ext = marker.slice(1);
    return rootEntries.some((f) => f.endsWith(ext));
  }
  return present.has(marker);
}

// ─── Nested Marker Walk (D1, D2) ──────────────────────────────────

/** One `{indexer entry, marker directory}` pair discovered by the marker walk. */
export interface MarkerDirPair {
  entry: IndexerEntry;
  /** Absolute path to the directory the marker was found in. */
  dir: string;
}

export interface DetectMarkerDirectoriesOptions {
  /** Maximum depth (repo root = 0) the walk descends to. Default `DEFAULT_MARKER_DEPTH`. */
  maxDepth?: number;
  /** Directory names to skip, IN ADDITION TO `EXCLUDED_DIRS`. */
  extraExcludedDirs?: Set<string>;
}

/**
 * Default marker-walk depth bound (D2). biogas-scale monorepos put
 * `apps/*` and `services/*` marker dirs at depth 2; depth 4 gives headroom
 * for `packages/x/y`-shaped nesting while bounding pathological repos'
 * walk time. Configurable via `opts.maxDepth`.
 */
export const DEFAULT_MARKER_DEPTH = 4;

/**
 * Walk `repoPath` depth-bounded (default `DEFAULT_MARKER_DEPTH`), evaluating
 * every `INDEXER_REGISTRY` entry's markers against EVERY visited directory's
 * entries (not just repo root) — reusing `markerPresent` per dir. Skips
 * `EXCLUDED_DIRS` (plus `opts.extraExcludedDirs`). Root = depth 0.
 *
 * One pair is emitted per (entry that matches, directory) — this is how
 * multi-lang-per-dir and same-lang-multi-dir both fall out naturally,
 * deduped structurally (a Set keyed by `bin:dir`) so an entry with multiple
 * matching markers in the same dir (e.g. `package.json` + `tsconfig.json`)
 * still yields exactly one pair for that dir.
 *
 * Does not check toolchain availability — that remains the dispatcher's job.
 */
export function detectMarkerDirectories(
  repoPath: string,
  opts: DetectMarkerDirectoriesOptions = {},
): MarkerDirPair[] {
  const maxDepth = opts.maxDepth ?? DEFAULT_MARKER_DEPTH;
  const excluded = opts.extraExcludedDirs
    ? new Set<string>([...EXCLUDED_DIRS, ...opts.extraExcludedDirs])
    : EXCLUDED_DIRS;

  const pairs: MarkerDirPair[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = dirents.map((d) => d.name);
    const present = new Set(names);

    for (const entry of INDEXER_REGISTRY) {
      if (!entry.markers.some((marker) => markerPresent(marker, present, names))) continue;
      const key = `${entry.bin}:${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ entry, dir });
    }

    if (depth >= maxDepth) return;

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (excluded.has(dirent.name)) continue;
      walk(join(dir, dirent.name), depth + 1);
    }
  }

  walk(repoPath, 0);
  return pairs;
}

/**
 * Detect which registry entries are "present" in `repoPath`, based on
 * marker files at the repo root only (depth 0 wrapper over
 * `detectMarkerDirectories`, kept for back-compat with callers that only
 * care about "which languages", not "in which directories").
 * Does not check toolchain availability — that's a separate step so the
 * dispatcher can warn about missing toolchains for detected-but-unavailable
 * languages instead of silently skipping them.
 */
export function detectPresentLanguages(repoPath: string): IndexerEntry[] {
  const pairs = detectMarkerDirectories(repoPath, { maxDepth: 0 });
  const entries: IndexerEntry[] = [];
  const seen = new Set<IndexerEntry>();
  for (const { entry } of pairs) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries;
}
