/**
 * Integration test: mergeScipIndexes() + buildGraphFromScip() against REAL
 * captured multi-language `.scip` fixtures (spec "Poly-language merge").
 *
 * Unlike merge.test.ts (synthetic in-memory Documents) and builder.test.ts
 * (single-language fixtures), this exercises the actual merge path with two
 * independently-captured indexer outputs (scip-go + scip-typescript) to
 * prove: (1) documents from both languages survive the merge, (2) the
 * mapper resolves each language's own cross-file references correctly, and
 * (3) no false cross-language edges are introduced by the merge.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraphFromScip, parseScipIndex } from './builder.js';
import { mergeScipIndexes } from './merge.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures');

function loadFixture(name: string) {
  const bytes = readFileSync(join(FIXTURES_DIR, name, 'index.scip'));
  return parseScipIndex(bytes);
}

describe('mergeScipIndexes + buildGraphFromScip (real multi-language fixtures)', () => {
  it('merges scip-go and scip-typescript fixture indexes into one graph with nodes from both languages', () => {
    const goIndex = loadFixture('scip-go-sample');
    const tsIndex = loadFixture('scip-ts-sample');

    const { index: merged, duplicatePaths } = mergeScipIndexes([goIndex, tsIndex]);
    expect(duplicatePaths).toEqual([]);

    const graph = buildGraphFromScip(merged);

    // Go nodes present and resolve their own cross-file reference.
    expect(graph.nodes['main.go']).toBeDefined();
    expect(graph.nodes['main.go']?.language).toBe('go');
    expect(graph.nodes['main.go']?.imports).toContain('pkg/greeting.go');

    // TS nodes present and resolve their own cross-file reference.
    expect(graph.nodes['main.ts']).toBeDefined();
    expect(graph.nodes['main.ts']?.language).toBe('typescript');
    expect(graph.nodes['main.ts']?.imports).toContain('pkg/greeting.ts');

    // No cross-language false edges: Go's main.go must not import a TS
    // file, and TS's main.ts must not import a Go file.
    expect(graph.nodes['main.go']?.imports).not.toContain('pkg/greeting.ts');
    expect(graph.nodes['main.ts']?.imports).not.toContain('pkg/greeting.go');
  });

  it('merges scip-go and rust-analyzer fixture indexes into one graph with nodes from both languages', () => {
    const goIndex = loadFixture('scip-go-sample');
    const rustIndex = loadFixture('scip-rust-sample');

    const { index: merged, duplicatePaths } = mergeScipIndexes([goIndex, rustIndex]);
    expect(duplicatePaths).toEqual([]);

    const graph = buildGraphFromScip(merged);

    expect(graph.nodes['main.go']).toBeDefined();
    expect(graph.nodes['main.go']?.language).toBe('go');

    expect(graph.nodes['src/main.rs']).toBeDefined();
    expect(graph.nodes['src/main.rs']?.language).toBe('rust');
    expect(graph.nodes['src/main.rs']?.imports).toContain('src/greeting.rs');

    expect(graph.nodes['src/main.rs']?.imports).not.toContain('main.go');
    expect(graph.nodes['main.go']?.imports).not.toContain('src/main.rs');
  });

  it('merges all three fixtures (go+ts+rust) into a single graph with no cross-language false edges', () => {
    const goIndex = loadFixture('scip-go-sample');
    const tsIndex = loadFixture('scip-ts-sample');
    const rustIndex = loadFixture('scip-rust-sample');

    const { index: merged, duplicatePaths } = mergeScipIndexes([goIndex, tsIndex, rustIndex]);
    expect(duplicatePaths).toEqual([]);

    const graph = buildGraphFromScip(merged);
    const paths = Object.keys(graph.nodes).sort();
    expect(paths).toEqual(
      [
        'main.go',
        'pkg/greeting.go',
        'main.ts',
        'pkg/greeting.ts',
        'src/main.rs',
        'src/greeting.rs',
      ].sort(),
    );

    for (const [path, node] of Object.entries(graph.nodes)) {
      for (const imp of node.imports) {
        // Every import must resolve to another node with the SAME language
        // as this fixture set never shares symbols across languages.
        expect(graph.nodes[imp]?.language).toBe(node.language);
      }
      void path;
    }
  });
});
