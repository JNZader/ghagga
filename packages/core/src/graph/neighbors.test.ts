/**
 * Tests for collectFileNeighborhoods — the pure depth-1 neighborhood
 * query over a DependencyGraph (graph-context-retrieval Slice 1).
 *
 * Table-driven over synthetic graphs: directions (importers incl. call
 * edges, importees), caps, truncation flags, cycles, isTest propagation,
 * files missing from the graph, and empty input.
 */

import { describe, expect, it } from 'vitest';
import { collectFileNeighborhoods, type FileNeighborhood } from './neighbors.js';
import type { DependencyGraph, GraphNode } from './schema.js';

// ─── Fixture helpers ────────────────────────────────────────────

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: 'hash',
    language: 'typescript',
    imports: [],
    exports: [],
    calls: [],
    isTest: false,
    ...overrides,
  };
}

function makeGraph(nodes: Record<string, GraphNode>): DependencyGraph {
  return { version: 1, rootDir: '/repo', nodes };
}

/** Importer/importee lists must be compared order-insensitively via sorted copies. */
function sorted(values: string[]): string[] {
  return [...values].sort();
}

// ─── Tests ──────────────────────────────────────────────────────

describe('collectFileNeighborhoods', () => {
  it('returns [] for empty input', () => {
    const graph = makeGraph({
      'src/a.ts': makeNode(),
    });
    expect(collectFileNeighborhoods(graph, [])).toEqual([]);
  });

  it.each([
    {
      name: 'importers via imports edges',
      graph: makeGraph({
        'src/a.ts': makeNode(),
        'src/b.ts': makeNode({ imports: ['src/a.ts'] }),
        'src/c.ts': makeNode({ imports: ['src/a.ts', 'src/b.ts'] }),
      }),
      files: ['src/a.ts'],
      expected: { file: 'src/a.ts', importers: ['src/b.ts', 'src/c.ts'], importees: [] },
    },
    {
      name: 'importers via call edges',
      graph: makeGraph({
        'src/a.ts': makeNode(),
        'src/caller.ts': makeNode({ calls: [{ target: 'src/a.ts', symbol: 'doThing' }] }),
      }),
      files: ['src/a.ts'],
      expected: { file: 'src/a.ts', importers: ['src/caller.ts'], importees: [] },
    },
    {
      name: 'importees via node.imports',
      graph: makeGraph({
        'src/a.ts': makeNode({ imports: ['src/dep1.ts', 'src/dep2.ts'] }),
        'src/dep1.ts': makeNode(),
        'src/dep2.ts': makeNode(),
      }),
      files: ['src/a.ts'],
      expected: { file: 'src/a.ts', importers: [], importees: ['src/dep1.ts', 'src/dep2.ts'] },
    },
    {
      name: 'both directions at once',
      graph: makeGraph({
        'src/a.ts': makeNode({ imports: ['src/dep.ts'] }),
        'src/dep.ts': makeNode(),
        'src/consumer.ts': makeNode({ imports: ['src/a.ts'] }),
      }),
      files: ['src/a.ts'],
      expected: {
        file: 'src/a.ts',
        importers: ['src/consumer.ts'],
        importees: ['src/dep.ts'],
      },
    },
    {
      name: 'cycle: a imports b, b imports a (depth-1, no traversal)',
      graph: makeGraph({
        'src/a.ts': makeNode({ imports: ['src/b.ts'] }),
        'src/b.ts': makeNode({ imports: ['src/a.ts'] }),
      }),
      files: ['src/a.ts'],
      expected: {
        file: 'src/a.ts',
        importers: ['src/b.ts'],
        importees: ['src/b.ts'],
      },
    },
    {
      name: 'self-import is excluded from both directions',
      graph: makeGraph({
        'src/a.ts': makeNode({ imports: ['src/a.ts'] }),
      }),
      files: ['src/a.ts'],
      expected: { file: 'src/a.ts', importers: [], importees: [] },
    },
    {
      name: 'exports surface as exportedSymbols (capped at 10)',
      graph: makeGraph({
        'src/a.ts': makeNode({
          exports: Array.from({ length: 14 }, (_, i) => `sym${i}`),
        }),
      }),
      files: ['src/a.ts'],
      expected: {
        file: 'src/a.ts',
        exportedSymbols: Array.from({ length: 10 }, (_, i) => `sym${i}`),
        truncated: true,
      },
    },
    {
      name: 'isTest flag propagates from the node',
      graph: makeGraph({
        'src/a.test.ts': makeNode({ isTest: true }),
      }),
      files: ['src/a.test.ts'],
      expected: { file: 'src/a.test.ts', isTest: true, truncated: false },
    },
  ])('$name', ({ graph, files, expected }) => {
    const result = collectFileNeighborhoods(graph, files);
    expect(result).toHaveLength(1);
    const hood = result[0] as FileNeighborhood;
    expect(hood.file).toBe(expected.file);
    if (expected.importers !== undefined) {
      expect(sorted(hood.importers)).toEqual(sorted(expected.importers));
    }
    if (expected.importees !== undefined) {
      expect(sorted(hood.importees)).toEqual(sorted(expected.importees));
    }
    if (expected.exportedSymbols !== undefined) {
      expect(hood.exportedSymbols).toEqual(expected.exportedSymbols);
    }
    if (expected.isTest !== undefined) {
      expect(hood.isTest).toBe(expected.isTest);
    }
    if (expected.truncated !== undefined) {
      expect(hood.truncated).toBe(expected.truncated);
    }
  });

  it('omits files missing from the graph', () => {
    const graph = makeGraph({
      'src/a.ts': makeNode(),
    });
    const result = collectFileNeighborhoods(graph, ['src/a.ts', 'src/gone.ts']);
    expect(result.map((n) => n.file)).toEqual(['src/a.ts']);
  });

  it('caps importers at 10 per file and sets truncated', () => {
    const nodes: Record<string, GraphNode> = { 'src/a.ts': makeNode() };
    for (let i = 0; i < 15; i++) {
      nodes[`src/consumer${i}.ts`] = makeNode({ imports: ['src/a.ts'] });
    }
    const result = collectFileNeighborhoods(makeGraph(nodes), ['src/a.ts']);
    expect(result).toHaveLength(1);
    const hood = result[0] as FileNeighborhood;
    expect(hood.importers).toHaveLength(10);
    expect(hood.truncated).toBe(true);
  });

  it('caps importees at 10 per file and sets truncated', () => {
    const imports = Array.from({ length: 12 }, (_, i) => `src/dep${i}.ts`);
    const nodes: Record<string, GraphNode> = {
      'src/a.ts': makeNode({ imports }),
    };
    for (const dep of imports) {
      nodes[dep] = makeNode();
    }
    const result = collectFileNeighborhoods(makeGraph(nodes), ['src/a.ts']);
    expect(result[0]?.importees).toHaveLength(10);
    expect(result[0]?.truncated).toBe(true);
  });

  it('does not set truncated when everything fits', () => {
    const graph = makeGraph({
      'src/a.ts': makeNode({ imports: ['src/b.ts'], exports: ['one'] }),
      'src/b.ts': makeNode(),
    });
    const result = collectFileNeighborhoods(graph, ['src/a.ts']);
    expect(result[0]?.truncated).toBe(false);
    expect(result[0]?.exportedSymbols).toEqual(['one']);
  });

  it('caps total files at 30 (default), omitting the rest', () => {
    const nodes: Record<string, GraphNode> = {};
    const files: string[] = [];
    for (let i = 0; i < 35; i++) {
      const path = `src/file${i}.ts`;
      nodes[path] = makeNode();
      files.push(path);
    }
    const result = collectFileNeighborhoods(makeGraph(nodes), files);
    expect(result).toHaveLength(30);
    expect(result.map((n) => n.file)).toEqual(files.slice(0, 30));
  });

  it('honors opts.maxPerFile and opts.maxTotalFiles overrides', () => {
    const nodes: Record<string, GraphNode> = {};
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = `src/f${i}.ts`;
      nodes[path] = makeNode({ imports: ['src/dep.ts'] });
      files.push(path);
    }
    nodes['src/dep.ts'] = makeNode();
    const result = collectFileNeighborhoods(makeGraph(nodes), files, {
      maxPerFile: 2,
      maxTotalFiles: 3,
    });
    expect(result).toHaveLength(3);
    expect(result[0]?.importees).toEqual(['src/dep.ts']);
  });

  it('counts importedSymbolEdges from importSymbols data on importee edges', () => {
    const graph = makeGraph({
      'src/a.ts': makeNode({
        imports: ['src/b.ts', 'src/c.ts'],
        importSymbols: {
          'src/b.ts': ['beta'],
          // src/c.ts intentionally absent (regex Python/Rust-style gap)
        },
      }),
      'src/b.ts': makeNode(),
      'src/c.ts': makeNode(),
    });
    const result = collectFileNeighborhoods(graph, ['src/a.ts']);
    expect(result[0]?.importedSymbolEdges).toBe(1);
  });

  it('neighborhood defaults: isTest false, no symbols, not truncated', () => {
    const graph = makeGraph({ 'src/plain.ts': makeNode() });
    const hood = collectFileNeighborhoods(graph, ['src/plain.ts'])[0] as FileNeighborhood;
    expect(hood).toEqual({
      file: 'src/plain.ts',
      importers: [],
      importees: [],
      exportedSymbols: [],
      importedSymbolEdges: 0,
      isTest: false,
      truncated: false,
    });
  });
});
