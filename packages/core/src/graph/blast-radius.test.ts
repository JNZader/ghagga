/**
 * Unit tests for blast-radius BFS computation.
 *
 * Uses a test fixture graph:
 *
 *   a.ts → b.ts → c.ts → d.ts
 *                     ↘ e.ts
 *   f.test.ts → c.ts
 *   g.test.ts → a.ts
 *   h.ts (isolated — no dependencies)
 *
 * Arrow = "imports from". So a.ts imports b.ts, b.ts imports c.ts, etc.
 * Reverse: if d.ts changes, c.ts is a dependent (c imports d),
 *          then b.ts (b imports c), then a.ts (a imports b).
 */

import { describe, expect, it } from 'vitest';
import { buildReverseIndex, computeBlastRadius } from './blast-radius.js';
import type { DependencyGraph, GraphNode } from './schema.js';
import { GRAPH_VERSION } from './schema.js';

// ─── Test Fixture ───────────────────────────────────────────────

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: 'deadbeef',
    language: 'typescript',
    imports: [],
    exports: [],
    calls: [],
    isTest: false,
    ...overrides,
  };
}

/**
 * Build the standard test graph:
 *   a.ts imports b.ts
 *   b.ts imports c.ts
 *   c.ts imports d.ts, e.ts
 *   f.test.ts imports c.ts (test file)
 *   g.test.ts imports a.ts (test file)
 *   h.ts (isolated)
 */
function makeTestGraph(): DependencyGraph {
  return {
    version: GRAPH_VERSION,
    rootDir: '.',
    nodes: {
      'a.ts': makeNode({ imports: ['b.ts'] }),
      'b.ts': makeNode({ imports: ['c.ts'] }),
      'c.ts': makeNode({ imports: ['d.ts', 'e.ts'] }),
      'd.ts': makeNode(),
      'e.ts': makeNode(),
      'f.test.ts': makeNode({ imports: ['c.ts'], isTest: true }),
      'g.test.ts': makeNode({ imports: ['a.ts'], isTest: true }),
      'h.ts': makeNode(),
    },
  };
}

// ─── buildReverseIndex ──────────────────────────────────────────

describe('buildReverseIndex', () => {
  it('builds correct reverse edges for imports', () => {
    const graph = makeTestGraph();
    const index = buildReverseIndex(graph);

    // b.ts is imported by a.ts
    expect(index.get('b.ts')?.has('a.ts')).toBe(true);

    // c.ts is imported by b.ts and f.test.ts
    expect(index.get('c.ts')?.has('b.ts')).toBe(true);
    expect(index.get('c.ts')?.has('f.test.ts')).toBe(true);

    // d.ts is imported by c.ts
    expect(index.get('d.ts')?.has('c.ts')).toBe(true);

    // e.ts is imported by c.ts
    expect(index.get('e.ts')?.has('c.ts')).toBe(true);

    // a.ts is imported by g.test.ts
    expect(index.get('a.ts')?.has('g.test.ts')).toBe(true);
  });

  it('builds reverse edges for calls', () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'caller.ts': makeNode({ calls: [{ target: 'utils.ts', symbol: 'helper' }] }),
        'utils.ts': makeNode(),
      },
    };

    const index = buildReverseIndex(graph);
    expect(index.get('utils.ts')?.has('caller.ts')).toBe(true);
  });

  it('returns empty map for graph with no edges', () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'a.ts': makeNode(),
        'b.ts': makeNode(),
      },
    };

    const index = buildReverseIndex(graph);
    expect(index.size).toBe(0);
  });
});

// ─── computeBlastRadius ─────────────────────────────────────────

describe('computeBlastRadius', () => {
  it('returns empty result for empty changedFiles', () => {
    const graph = makeTestGraph();
    const result = computeBlastRadius(graph, []);

    expect(result.files.size).toBe(0);
    expect(result.changedFiles).toEqual([]);
    expect(result.dependents).toEqual([]);
    expect(result.testFiles).toEqual([]);
    expect(result.depth).toBe(0);
    expect(result.exceededCap).toBe(false);
  });

  it('returns only the changed file when it has no reverse deps (isolated)', () => {
    const graph = makeTestGraph();
    const result = computeBlastRadius(graph, ['h.ts']);

    expect(result.files).toContain('h.ts');
    expect(result.files.size).toBe(1);
    expect(result.dependents).toEqual([]);
    expect(result.testFiles).toEqual([]);
  });

  it('finds direct dependents (depth 1)', () => {
    const graph = makeTestGraph();
    // d.ts is imported by c.ts. With depth 1, only c.ts should be a dependent.
    const result = computeBlastRadius(graph, ['d.ts'], { maxDepth: 1 });

    expect(result.files).toContain('d.ts'); // changed
    expect(result.files).toContain('c.ts'); // direct dependent
    expect(result.dependents).toContain('c.ts');
    expect(result.depth).toBe(1);
  });

  it('finds transitive dependents (depth 3)', () => {
    const graph = makeTestGraph();
    // d.ts → c.ts imports d.ts → b.ts imports c.ts → a.ts imports b.ts
    const result = computeBlastRadius(graph, ['d.ts']);

    expect(result.files).toContain('d.ts');
    expect(result.files).toContain('c.ts');
    expect(result.files).toContain('b.ts');
    expect(result.files).toContain('a.ts');
    expect(result.depth).toBe(3);
  });

  it('includes test files that import impacted files', () => {
    const graph = makeTestGraph();
    // d.ts changes → c.ts dependent → f.test.ts imports c.ts
    const result = computeBlastRadius(graph, ['d.ts']);

    expect(result.testFiles).toContain('f.test.ts');
    expect(result.files).toContain('f.test.ts');
  });

  it('includes test for a.ts when a.ts is in blast radius', () => {
    const graph = makeTestGraph();
    // d.ts → c.ts → b.ts → a.ts → g.test.ts imports a.ts
    const result = computeBlastRadius(graph, ['d.ts']);

    expect(result.files).toContain('a.ts');
    expect(result.testFiles).toContain('g.test.ts');
    expect(result.files).toContain('g.test.ts');
  });

  it('respects maxDepth limit', () => {
    const graph = makeTestGraph();
    // With maxDepth=1: d.ts → c.ts only (not b.ts or a.ts)
    const result = computeBlastRadius(graph, ['d.ts'], { maxDepth: 1 });

    expect(result.files).toContain('d.ts');
    expect(result.files).toContain('c.ts');
    expect(result.files).not.toContain('b.ts');
    expect(result.files).not.toContain('a.ts');
    expect(result.depth).toBe(1);
  });

  it('handles changed file with no reverse deps but has a test', () => {
    const graph = makeTestGraph();
    // a.ts has no reverse deps (no one imports a.ts except g.test.ts)
    const result = computeBlastRadius(graph, ['a.ts']);

    expect(result.changedFiles).toContain('a.ts');
    expect(result.dependents).toEqual([]);
    expect(result.testFiles).toContain('g.test.ts');
    expect(result.files).toContain('g.test.ts');
  });

  it('handles circular dependencies without infinite loop', () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'a.ts': makeNode({ imports: ['b.ts'] }),
        'b.ts': makeNode({ imports: ['c.ts'] }),
        'c.ts': makeNode({ imports: ['a.ts'] }), // cycle: c → a → b → c
      },
    };

    const result = computeBlastRadius(graph, ['a.ts']);

    expect(result.files).toContain('a.ts');
    expect(result.files).toContain('c.ts'); // c imports a → c is dependent
    expect(result.files).toContain('b.ts'); // b imports c → b is dependent
    expect(result.exceededCap).toBe(false);
  });

  it('sets exceededCap when blast radius exceeds maxFiles', () => {
    // Create a long chain: node0 → node1 → node2 → ... → node59
    const nodes: Record<string, GraphNode> = {};
    for (let i = 0; i < 60; i++) {
      nodes[`node${i}.ts`] = makeNode({
        imports: i > 0 ? [`node${i - 1}.ts`] : [],
      });
    }

    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes,
    };

    // Change node0 — all 59 other nodes depend on it transitively
    const result = computeBlastRadius(graph, ['node0.ts'], {
      maxFiles: 50,
      maxDepth: 100,
    });

    expect(result.exceededCap).toBe(true);
    expect(result.files.size).toBeGreaterThan(50);
  });

  it('does NOT set exceededCap when within limit', () => {
    const graph = makeTestGraph();
    const result = computeBlastRadius(graph, ['d.ts'], { maxFiles: 50 });

    expect(result.exceededCap).toBe(false);
  });

  it('includes changed file even if not in graph', () => {
    const graph = makeTestGraph();
    // new-file.ts is not in graph.nodes
    const result = computeBlastRadius(graph, ['new-file.ts']);

    expect(result.changedFiles).toContain('new-file.ts');
    expect(result.files).toContain('new-file.ts');
    expect(result.dependents).toEqual([]);
  });

  it('handles multiple changed files', () => {
    const graph = makeTestGraph();
    const result = computeBlastRadius(graph, ['d.ts', 'e.ts']);

    // Both d.ts and e.ts are imported by c.ts
    expect(result.files).toContain('d.ts');
    expect(result.files).toContain('e.ts');
    expect(result.files).toContain('c.ts');
    expect(result.files).toContain('b.ts');
    expect(result.files).toContain('a.ts');
  });

  it('handles diamond dependency pattern', () => {
    //   d.ts
    //  /    \
    // b.ts  c.ts
    //  \    /
    //   a.ts
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'a.ts': makeNode({ imports: ['b.ts', 'c.ts'] }),
        'b.ts': makeNode({ imports: ['d.ts'] }),
        'c.ts': makeNode({ imports: ['d.ts'] }),
        'd.ts': makeNode(),
      },
    };

    const result = computeBlastRadius(graph, ['d.ts']);

    expect(result.files).toContain('d.ts');
    expect(result.files).toContain('b.ts');
    expect(result.files).toContain('c.ts');
    expect(result.files).toContain('a.ts');
    // a.ts should appear only once in dependents
    expect(result.dependents.filter((d) => d === 'a.ts')).toHaveLength(1);
  });

  it('excludes tests when includeTests is false', () => {
    const graph = makeTestGraph();
    const result = computeBlastRadius(graph, ['d.ts'], { includeTests: false });

    expect(result.testFiles).toEqual([]);
    expect(result.files).not.toContain('f.test.ts');
    expect(result.files).not.toContain('g.test.ts');
  });

  it('completes quickly for a large graph (performance)', () => {
    // Create a 5000-node graph with linear chain
    const nodes: Record<string, GraphNode> = {};
    for (let i = 0; i < 5000; i++) {
      nodes[`file${i}.ts`] = makeNode({
        imports: i > 0 ? [`file${i - 1}.ts`] : [],
      });
    }

    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes,
    };

    const start = performance.now();
    const result = computeBlastRadius(graph, ['file0.ts'], { maxDepth: 3, maxFiles: 50 });
    const elapsed = performance.now() - start;

    // Should complete quickly even on slow CI runners
    expect(elapsed).toBeLessThan(500);
    expect(result.files.size).toBeGreaterThan(0);
  });

  it('returns correct depth for shallow traversal', () => {
    const graph = makeTestGraph();
    // a.ts → no reverse deps (depth 0)
    const result = computeBlastRadius(graph, ['a.ts']);
    expect(result.depth).toBe(0);
  });

  it('does not count changed files as dependents', () => {
    const graph = makeTestGraph();
    const result = computeBlastRadius(graph, ['c.ts']);

    // c.ts is the changed file, not a dependent
    expect(result.changedFiles).toContain('c.ts');
    expect(result.dependents).not.toContain('c.ts');
  });
});

// ─── Regression guard: importSymbols is IGNORED (Phase 4) ─────────

describe('importSymbols regression guard', () => {
  /**
   * `buildReverseIndex`/`computeBlastRadius` read ONLY `node.imports` and
   * `node.calls`. This pins that adding the new additive `importSymbols`
   * field never changes their output — the field must be byte-identical
   * dead weight from their point of view.
   */
  it('buildReverseIndex is byte-identical with vs without importSymbols populated', () => {
    const withoutField = makeTestGraph();
    const withField: DependencyGraph = {
      ...withoutField,
      nodes: {
        ...withoutField.nodes,
        'a.ts': { ...withoutField.nodes['a.ts']!, importSymbols: { 'b.ts': ['X', 'Y'] } },
        'c.ts': {
          ...withoutField.nodes['c.ts']!,
          importSymbols: { 'd.ts': ['Z'], 'e.ts': ['W'] },
        },
      },
    };

    const reverseA = buildReverseIndex(withoutField);
    const reverseB = buildReverseIndex(withField);

    const normalize = (m: Map<string, Set<string>>) =>
      Object.fromEntries([...m.entries()].map(([k, v]) => [k, [...v].sort()]));
    expect(normalize(reverseB)).toEqual(normalize(reverseA));
  });

  it('computeBlastRadius output is identical with vs without importSymbols populated', () => {
    const withoutField = makeTestGraph();
    const withField: DependencyGraph = {
      ...withoutField,
      nodes: {
        ...withoutField.nodes,
        'a.ts': { ...withoutField.nodes['a.ts']!, importSymbols: { 'b.ts': ['X'] } },
      },
    };

    const resultA = computeBlastRadius(withoutField, ['d.ts']);
    const resultB = computeBlastRadius(withField, ['d.ts']);

    expect([...resultB.files].sort()).toEqual([...resultA.files].sort());
    expect(resultB.dependents.sort()).toEqual(resultA.dependents.sort());
    expect(resultB.testFiles.sort()).toEqual(resultA.testFiles.sort());
    expect(resultB.depth).toBe(resultA.depth);
    expect(resultB.exceededCap).toBe(resultA.exceededCap);
  });
});
