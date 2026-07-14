/**
 * Index command — builds the dependency graph consumed by blast-radius/review.
 *
 * Toolchain-gated: prefers the SCIP backend (compiler-grade resolution, Go-first
 * via scip-go) when `go` and `scip-go` are both on PATH. Falls back to the
 * regex-based indexer only when explicitly opted in via `--fallback-regex`,
 * since it can't resolve non-relative (module-path) imports.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  buildGraph,
  buildGraphFromScip,
  type DependencyGraph,
  EXCLUDED_DIRS,
  parseScipIndex,
} from 'ghagga-core';
import * as tui from '../ui/tui.js';

// ─── Types ──────────────────────────────────────────────────────

export interface IndexCommandOptions {
  /** Output path for graph.json, relative to the target repo. */
  out?: string;
  /** Fall back to the regex-based indexer when the SCIP toolchain is absent. */
  fallbackRegex?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_OUT = '.ghagga/graph.json';
const SCIP_GO_INSTALL_HINT = 'go install github.com/scip-code/scip-go/cmd/scip-go@latest';

// ─── Toolchain Detection ────────────────────────────────────────

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

/** Detect whether both `go` and `scip-go` are available on PATH. */
export function detectScipGoToolchain(): boolean {
  return commandExists('go') && commandExists('scip-go');
}

/** Run scip-go against the target directory, producing `index.scip` there. */
export function runScipGo(cwd: string): void {
  execFileSync('scip-go', [], { cwd, stdio: 'inherit' });
}

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

// ─── Main Command ───────────────────────────────────────────────

export async function indexCommand(
  targetPath: string,
  options: IndexCommandOptions,
): Promise<void> {
  const repoPath = resolve(targetPath || '.');
  const outPath = resolve(repoPath, options.out ?? DEFAULT_OUT);

  const hasToolchain = detectScipGoToolchain();

  if (!hasToolchain) {
    if (!options.fallbackRegex) {
      tui.log.error(
        '❌ SCIP toolchain not found (requires "go" and "scip-go" on PATH).\n' +
          `   Install scip-go: ${SCIP_GO_INSTALL_HINT}\n` +
          '   Or pass --fallback-regex to use the regex-based indexer instead\n' +
          '   (note: it cannot resolve non-relative/module-path imports).',
      );
      process.exit(1);
      return;
    }

    tui.log.warn('⚠️  SCIP toolchain not found — falling back to regex-based indexing.');
    const files = collectFiles(repoPath);
    const graph = buildGraph(repoPath, files);
    writeGraph(outPath, graph);
    tui.log.success(
      `✅ Wrote ${Object.keys(graph.nodes).length} node(s) to ${outPath} (regex fallback).`,
    );
    return;
  }

  tui.log.step('Running scip-go...');
  runScipGo(repoPath);

  const scipPath = join(repoPath, 'index.scip');
  if (!existsSync(scipPath)) {
    tui.log.error(`❌ scip-go did not produce an index at ${scipPath}`);
    process.exit(1);
    return;
  }

  const bytes = readFileSync(scipPath);
  const index = parseScipIndex(new Uint8Array(bytes));
  const graph = buildGraphFromScip(index);
  writeGraph(outPath, graph);
  tui.log.success(`✅ Wrote ${Object.keys(graph.nodes).length} node(s) to ${outPath} (SCIP).`);
}
