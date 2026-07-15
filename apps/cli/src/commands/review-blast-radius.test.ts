/**
 * Unit tests for the blast-radius pure seams extracted from `reviewCommand`
 * (design v2 D9): `resolveBlastRadiusEnabled`, `checkGraphStaleness`,
 * `computeUncoveredLanguages`.
 *
 * `resolveBlastRadiusEnabled` touches the real filesystem (existsSync) — a
 * REAL temp dir (mkdtempSync) is used, NOT a mocked `node:fs`, so the actual
 * repoPath-relative resolution is exercised (CRITICAL-2 regression guard).
 * This file deliberately does NOT `vi.mock('node:fs')` (unlike review.test.ts)
 * to keep that guarantee honest.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DependencyGraph, GraphMetadata } from 'ghagga-core';
import { GRAPH_VERSION } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkGraphStaleness,
  computeUncoveredLanguages,
  resolveBlastRadiusEnabled,
} from './review.js';

// ─── resolveBlastRadiusEnabled ───────────────────────────────────

describe('resolveBlastRadiusEnabled', () => {
  let repoPath: string;
  let otherCwd: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'ghagga-blast-radius-repo-'));
    otherCwd = mkdtempSync(join(tmpdir(), 'ghagga-blast-radius-cwd-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  });

  function withGraph(): void {
    mkdirSync(join(repoPath, '.ghagga'), { recursive: true });
    writeFileSync(join(repoPath, '.ghagga', 'graph.json'), '{}');
  }

  it('auto-enables when .ghagga/graph.json exists under repoPath', () => {
    withGraph();
    const result = resolveBlastRadiusEnabled(repoPath, {}, {});
    expect(result).toBe(true);
  });

  it('stays off when no graph.json exists', () => {
    const result = resolveBlastRadiusEnabled(repoPath, {}, {});
    expect(result).toBe(false);
  });

  it('resolves against repoPath, NOT process.cwd() (CRITICAL-2)', () => {
    withGraph();
    const originalCwd = process.cwd();
    try {
      process.chdir(otherCwd);
      // The graph lives under repoPath, not the (different) current cwd —
      // the v1 bug used resolve('.') and would have returned false here.
      const result = resolveBlastRadiusEnabled(repoPath, {}, {});
      expect(result).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('--no-blast-radius (blastRadius: false) wins over an existing graph', () => {
    withGraph();
    const result = resolveBlastRadiusEnabled(repoPath, { blastRadius: false }, {});
    expect(result).toBe(false);
  });

  it('.ghagga.json enableBlastRadius: false wins over an existing graph', () => {
    withGraph();
    const result = resolveBlastRadiusEnabled(repoPath, {}, { enableBlastRadius: false });
    expect(result).toBe(false);
  });

  it('.ghagga.json enableBlastRadius: true wins even without a graph', () => {
    const result = resolveBlastRadiusEnabled(repoPath, {}, { enableBlastRadius: true });
    expect(result).toBe(true);
  });

  it('explicit --no-blast-radius overrides .ghagga.json enableBlastRadius: true', () => {
    const result = resolveBlastRadiusEnabled(
      repoPath,
      { blastRadius: false },
      { enableBlastRadius: true },
    );
    expect(result).toBe(false);
  });
});

// ─── checkGraphStaleness ──────────────────────────────────────────

describe('checkGraphStaleness', () => {
  function makeMetadata(overrides: Partial<GraphMetadata> = {}): GraphMetadata {
    return {
      lastIndexedCommit: 'abc123',
      lastIndexedAt: new Date().toISOString(),
      schemaVersion: GRAPH_VERSION,
      fileCount: 1,
      languages: ['typescript'],
      indexDurationMs: 10,
      ...overrides,
    };
  }

  it('returns no warnings when metadata is fresh and HEAD matches', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    expect(checkGraphStaleness(metadata, 'abc123')).toEqual([]);
  });

  it('warns on HEAD mismatch', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    const warnings = checkGraphStaleness(metadata, 'def456');
    expect(warnings.some((w) => w.kind === 'head-mismatch')).toBe(true);
  });

  it('skips the HEAD-mismatch check when currentHead is empty (non-git/detached)', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123' });
    const warnings = checkGraphStaleness(metadata, '');
    expect(warnings.some((w) => w.kind === 'head-mismatch')).toBe(false);
  });

  it('warns on age > 7 days', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123', lastIndexedAt: thirtyDaysAgo });
    const warnings = checkGraphStaleness(metadata, 'abc123');
    expect(warnings.some((w) => w.kind === 'stale-age')).toBe(true);
  });

  it('warns distinctly when metadata is null (B-005)', () => {
    const warnings = checkGraphStaleness(null, 'abc123');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe('no-metadata');
  });

  it('warns on graphVersion mismatch (B-003)', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123', graphVersion: GRAPH_VERSION + 1 });
    const warnings = checkGraphStaleness(metadata, 'abc123');
    expect(warnings.some((w) => w.kind === 'version-mismatch')).toBe(true);
  });

  it('does not warn on graphVersion match', () => {
    const metadata = makeMetadata({ lastIndexedCommit: 'abc123', graphVersion: GRAPH_VERSION });
    const warnings = checkGraphStaleness(metadata, 'abc123');
    expect(warnings.some((w) => w.kind === 'version-mismatch')).toBe(false);
  });
});

// ─── computeUncoveredLanguages ────────────────────────────────────

describe('computeUncoveredLanguages', () => {
  function makeGraph(nodeLanguages: Record<string, string>): DependencyGraph {
    return {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: Object.fromEntries(
        Object.entries(nodeLanguages).map(([path, language]) => [
          path,
          {
            hash: 'h',
            // biome-ignore lint/suspicious/noExplicitAny: fixture language is dynamic
            language: language as any,
            imports: [],
            exports: [],
            calls: [],
            isTest: false,
          },
        ]),
      ),
    };
  }

  it('flags a changed file whose language has zero graph coverage', () => {
    const graph = makeGraph({ 'src/main.go': 'go' });
    const uncovered = computeUncoveredLanguages(graph, ['app.py']);
    expect(uncovered).toContain('python');
  });

  it('does not flag a changed file whose language IS covered', () => {
    const graph = makeGraph({ 'src/main.go': 'go' });
    const uncovered = computeUncoveredLanguages(graph, ['src/other.go']);
    expect(uncovered).not.toContain('go');
  });

  it('regex-fallback graph (languages populated from real nodes) is NOT all-flagged (CRITICAL-1)', () => {
    // A regex-fallback-built graph still has real per-file `language` on
    // every node (unlike dispatch's `indexedLanguages`, which is empty for
    // the regex path) — so coverage must be computed from graph CONTENTS.
    const graph = makeGraph({ 'src/a.ts': 'typescript', 'src/b.py': 'python' });
    const uncovered = computeUncoveredLanguages(graph, ['src/a.ts', 'src/b.py']);
    expect(uncovered).toEqual([]);
  });

  it('flags a subpackage-only language not present anywhere in the graph', () => {
    const graph = makeGraph({ 'src/main.go': 'go' });
    const uncovered = computeUncoveredLanguages(graph, [
      'packages/api/requirements.txt',
      'src/main.go',
    ]);
    // requirements.txt has no detectable language extension — must not crash
    // and must not be spuriously flagged as a language.
    expect(uncovered).toEqual([]);
  });

  it('flags multiple distinct uncovered languages without duplicates', () => {
    const graph = makeGraph({ 'src/main.go': 'go' });
    const uncovered = computeUncoveredLanguages(graph, ['a.py', 'b.py', 'c.rs']);
    expect(uncovered.sort()).toEqual(['python', 'rust']);
  });
});
