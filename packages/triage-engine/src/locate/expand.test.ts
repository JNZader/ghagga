import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DependencyGraph, GraphNode } from 'ghagga-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expand, GRAPH_RESOLVABLE_LANGUAGES } from './expand.js';

/** Minimal valid GraphNode — fills every field validateGraph() checks. */
function node(overrides: Partial<GraphNode> & Pick<GraphNode, 'language'>): GraphNode {
  return {
    hash: 'deadbeef',
    imports: [],
    exports: [],
    calls: [],
    isTest: false,
    ...overrides,
  };
}

/** Writes a valid `.ghagga/graph.json` fixture under `repoRoot`. */
function writeGraphFixture(repoRoot: string, nodes: Record<string, GraphNode>): void {
  const graph: DependencyGraph = { version: 1, rootDir: repoRoot, nodes };
  mkdirSync(path.join(repoRoot, '.ghagga'), { recursive: true });
  writeFileSync(path.join(repoRoot, '.ghagga', 'graph.json'), JSON.stringify(graph));
}

describe('expand', () => {
  it('returns [] for an empty seed set', async () => {
    expect(await expand([], new Map(), { graphExpand: false, language: 'go' })).toEqual([]);
  });

  it('dir-sibling: expands multi-seed dir-siblings up to the cap', async () => {
    const files = new Map<string, string>([
      ['pkg/a/one.go', 'x'],
      ['pkg/a/two.go', 'x'],
      ['pkg/a/three.go', 'x'],
      ['pkg/b/four.go', 'x'],
      ['pkg/b/five.go', 'x'],
      ['pkg/c/unrelated.go', 'x'],
    ]);
    const result = await expand(['pkg/a/one.go', 'pkg/b/four.go'], files, {
      graphExpand: false,
      language: 'go',
    });

    expect(result).toContain('pkg/a/one.go');
    expect(result).toContain('pkg/a/two.go');
    expect(result).toContain('pkg/a/three.go');
    expect(result).toContain('pkg/b/four.go');
    expect(result).toContain('pkg/b/five.go');
    expect(result).not.toContain('pkg/c/unrelated.go');
  });

  it('dir-sibling: caps total returned files at maxFiles', async () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 20; i++) files.set(`pkg/a/f${i}.go`, 'x');
    const result = await expand(
      ['pkg/a/f0.go'],
      files,
      { graphExpand: false, language: 'go' },
      { maxFiles: 5 },
    );
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('Go: ALWAYS uses dir-sibling, even if graphExpand=true, when no SCIP graph is available (regression guard)', async () => {
    const files = new Map<string, string>([
      ['pkg/seed/seed.go', 'package seed\n\nfunc Seed() int { return 1 }\n'],
      [
        'pkg/dependent/dependent.go',
        'package dependent\n\nimport "example.com/mod/pkg/seed"\n\nfunc Dependent() int { return seed.Seed() }\n',
      ],
      ['pkg/seed/sibling.go', 'package seed\n\nfunc Sibling() int { return 2 }\n'],
    ]);
    // No codeRoot -> SCIP load is skipped -> falls back to the regex graph,
    // which does not resolve Go -> dir-sibling only.
    const result = await expand(['pkg/seed/seed.go'], files, {
      graphExpand: true,
      language: 'go',
    });

    // dir-sibling picks up the same-dir sibling...
    expect(result).toContain('pkg/seed/sibling.go');
    // ...but never the cross-package dependent, because Go isn't regex-graph-resolvable.
    expect(result).not.toContain('pkg/dependent/dependent.go');
  });

  it('TS: graphExpand=true resolves a real dependent via computeBlastRadius (regex fallback, no SCIP graph)', async () => {
    const files = new Map<string, string>([
      ['src/seed.ts', 'export function seed(): number { return 1; }\n'],
      ['src/dependent.ts', "import { seed } from './seed';\nexport const x = seed();\n"],
      ['src/other/unrelated.ts', 'export const y = 1;\n'],
    ]);
    const result = await expand(['src/seed.ts'], files, { graphExpand: true, language: 'ts' });

    expect(result).toContain('src/dependent.ts');
  });

  it('TS: graphExpand=false stays dir-sibling only (does not pull cross-dir dependents)', async () => {
    const files = new Map<string, string>([
      ['src/a/seed.ts', 'export function seed(): number { return 1; }\n'],
      ['src/b/dependent.ts', "import { seed } from '../a/seed';\nexport const x = seed();\n"],
    ]);
    const result = await expand(['src/a/seed.ts'], files, { graphExpand: false, language: 'ts' });

    expect(result).not.toContain('src/b/dependent.ts');
  });

  it('GRAPH_RESOLVABLE_LANGUAGES is exactly {ts, js}', () => {
    expect([...GRAPH_RESOLVABLE_LANGUAGES].sort()).toEqual(['js', 'ts']);
  });
});

describe('expand — SCIP graph integration (Phase B, BL-SCIP-LOCATE-INTEGRATION)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'ghagga-expand-scip-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('multi-language win: a SCIP graph resolves a Go dependent the regex path would miss', async () => {
    // Same fixture as the regex-fallback Go regression test above, but this
    // time a `.ghagga/graph.json` exists — proving the SCIP path lifts the
    // ts/js-only gate for languages the regex builder never resolves.
    writeGraphFixture(repoRoot, {
      'pkg/seed/seed.go': node({ language: 'go' }),
      'pkg/dependent/dependent.go': node({ language: 'go', imports: ['pkg/seed/seed.go'] }),
    });

    const files = new Map<string, string>([
      ['pkg/seed/seed.go', 'package seed\n\nfunc Seed() int { return 1 }\n'],
      [
        'pkg/dependent/dependent.go',
        'package dependent\n\nimport "example.com/mod/pkg/seed"\n\nfunc Dependent() int { return seed.Seed() }\n',
      ],
    ]);

    const result = await expand(['pkg/seed/seed.go'], files, {
      graphExpand: true,
      language: 'go',
      codeRoot: repoRoot,
    });

    expect(result).toContain('pkg/dependent/dependent.go');
  });

  it('multi-language win: a SCIP graph resolves a Python dependent too', async () => {
    writeGraphFixture(repoRoot, {
      'pkg/seed.py': node({ language: 'python' }),
      'pkg/dependent.py': node({ language: 'python', imports: ['pkg/seed.py'] }),
    });

    const files = new Map<string, string>([
      ['pkg/seed.py', 'def seed():\n    return 1\n'],
      ['pkg/dependent.py', 'from .seed import seed\n\nx = seed()\n'],
    ]);

    const result = await expand(['pkg/seed.py'], files, {
      graphExpand: true,
      language: 'py',
      codeRoot: repoRoot,
    });

    expect(result).toContain('pkg/dependent.py');
  });

  it('no `.ghagga/graph.json`: falls back to regex graph, ts/js behavior unchanged', async () => {
    // repoRoot exists but has no .ghagga/graph.json -> FilesystemGraphLoader
    // returns null -> regex fallback, same as the no-codeRoot TS test above.
    const files = new Map<string, string>([
      ['src/seed.ts', 'export function seed(): number { return 1; }\n'],
      ['src/dependent.ts', "import { seed } from './seed';\nexport const x = seed();\n"],
    ]);

    const result = await expand(['src/seed.ts'], files, {
      graphExpand: true,
      language: 'ts',
      codeRoot: repoRoot,
    });

    expect(result).toContain('src/dependent.ts');
  });

  it('no `.ghagga/graph.json`: Go stays unresolved via the regex fallback (gate not lifted)', async () => {
    const files = new Map<string, string>([
      ['pkg/seed/seed.go', 'package seed\n\nfunc Seed() int { return 1 }\n'],
      [
        'pkg/dependent/dependent.go',
        'package dependent\n\nimport "example.com/mod/pkg/seed"\n\nfunc Dependent() int { return seed.Seed() }\n',
      ],
    ]);

    const result = await expand(['pkg/seed/seed.go'], files, {
      graphExpand: true,
      language: 'go',
      codeRoot: repoRoot,
    });

    expect(result).not.toContain('pkg/dependent/dependent.go');
  });

  it('malformed graph.json: FilesystemGraphLoader returns null, falls back to regex (no crash)', async () => {
    mkdirSync(path.join(repoRoot, '.ghagga'), { recursive: true });
    writeFileSync(path.join(repoRoot, '.ghagga', 'graph.json'), '{ not valid json');

    const files = new Map<string, string>([
      ['src/seed.ts', 'export function seed(): number { return 1; }\n'],
      ['src/dependent.ts', "import { seed } from './seed';\nexport const x = seed();\n"],
    ]);

    const result = await expand(['src/seed.ts'], files, {
      graphExpand: true,
      language: 'ts',
      codeRoot: repoRoot,
    });

    // Malformed graph does not crash and the regex fallback still resolves.
    expect(result).toContain('src/dependent.ts');
  });

  it('oversized/schema-invalid graph.json: falls back to regex without throwing', async () => {
    mkdirSync(path.join(repoRoot, '.ghagga'), { recursive: true });
    // Valid JSON, but fails validateGraph() schema checks (wrong version).
    writeFileSync(
      path.join(repoRoot, '.ghagga', 'graph.json'),
      JSON.stringify({ version: 999, rootDir: repoRoot, nodes: {} }),
    );

    const files = new Map<string, string>([
      ['pkg/seed/seed.go', 'package seed\n\nfunc Seed() int { return 1 }\n'],
      ['pkg/seed/sibling.go', 'package seed\n\nfunc Sibling() int { return 2 }\n'],
    ]);

    const result = await expand(['pkg/seed/seed.go'], files, {
      graphExpand: true,
      language: 'go',
      codeRoot: repoRoot,
    });

    // No throw; regex path doesn't resolve Go either, so dir-sibling kicks in.
    expect(result).toContain('pkg/seed/sibling.go');
  });

  it('path-space alignment: SCIP node keys must match seed/file relative-path space, or resolution silently no-ops', async () => {
    // Node keyed with a DIFFERENT path space (leading './' + backslash-style)
    // than the seed/file map keys ('pkg/seed/seed.go') -> computeBlastRadius
    // finds no match -> zero dependents, even though a graph was loaded.
    // This documents the exact silent-no-op failure mode the design flagged.
    writeGraphFixture(repoRoot, {
      './pkg/seed/seed.go': node({ language: 'go' }),
      './pkg/dependent/dependent.go': node({ language: 'go', imports: ['./pkg/seed/seed.go'] }),
    });

    const files = new Map<string, string>([
      ['pkg/seed/seed.go', 'package seed\n\nfunc Seed() int { return 1 }\n'],
      [
        'pkg/dependent/dependent.go',
        'package dependent\n\nimport "example.com/mod/pkg/seed"\n\nfunc Dependent() int { return seed.Seed() }\n',
      ],
    ]);

    const result = await expand(['pkg/seed/seed.go'], files, {
      graphExpand: true,
      language: 'go',
      codeRoot: repoRoot,
    });

    // Mismatched key space -> computeBlastRadius has no seed hit -> the
    // dependent is NOT found via the graph. (dir-sibling still applies —
    // there is no sibling here, so the pool is just the seed itself.)
    expect(result).not.toContain('pkg/dependent/dependent.go');
  });
});
