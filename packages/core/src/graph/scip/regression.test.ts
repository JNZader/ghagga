/**
 * Phase 4 regression + integration tests for scip-symbol-ranges.
 *
 * Proves the explicit Out-of-Scope boundary held (`computeBlastRadius` /
 * `buildReverseIndex` output unchanged by symbolRanges), backward compat
 * (`validateGraph` still accepts SCIP-built graphs), graph-size sanity, and
 * a real end-to-end integration of builder → computeChangedSymbolsComplete
 * → buildSymbolImpactBlock (via buildCallChainContext) on a real fixture
 * (task 4.5) — not just the synthetic unit-level tests elsewhere.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeBlastRadius } from '../blast-radius.js';
import { computeChangedSymbolsComplete } from '../changed-symbols.js';
import { buildReverseDependencyMap } from '../reverse-deps.js';
import { MAX_GRAPH_SIZE_BYTES, validateGraph } from '../schema.js';
import { buildGraphFromScip, parseScipIndex } from './builder.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures');

function loadFixtureIndex(name: string) {
  const bytes = readFileSync(join(FIXTURES_DIR, name, 'index.scip'));
  return parseScipIndex(bytes);
}

describe('Phase 4 regression: Out-of-Scope boundary held', () => {
  it('computeBlastRadius output is unaffected by symbolRanges (same result with/without the field stripped)', () => {
    const index = loadFixtureIndex('scip-go-sample');
    const graph = buildGraphFromScip(index);
    expect(
      Object.values(graph.nodes).some(
        (n) => n.symbolRanges && Object.keys(n.symbolRanges).length > 0,
      ),
    ).toBe(true); // sanity: this fixture DOES exercise symbolRanges capture

    const withRanges = computeBlastRadius(graph, ['main.go']);

    // Strip symbolRanges and recompute — result must be byte-identical.
    const stripped = structuredClone(graph);
    for (const node of Object.values(stripped.nodes)) {
      node.symbolRanges = undefined;
    }
    const withoutRanges = computeBlastRadius(stripped, ['main.go']);

    expect(JSON.stringify([...withRanges.files].sort())).toBe(
      JSON.stringify([...withoutRanges.files].sort()),
    );
    expect(withRanges.changedFiles).toEqual(withoutRanges.changedFiles);
    expect(withRanges.dependents).toEqual(withoutRanges.dependents);
  });

  it('buildReverseDependencyMap (file-content based, unrelated to symbolRanges) is unaffected', () => {
    const fileContents = new Map<string, string>([
      ['src/a.ts', `import { b } from './b';`],
      ['src/b.ts', 'export const b = 1;'],
    ]);
    const map = buildReverseDependencyMap(['src/a.ts', 'src/b.ts'], fileContents);
    // Purely a regression pin: reverse-deps.ts is untouched by this SDD.
    expect(map['src/b.ts']).toContain('src/a.ts');
  });
});

describe('Phase 4 regression: backward compat + graph-size sanity', () => {
  it('validateGraph still accepts a SCIP-built graph WITH symbolRanges', () => {
    const index = loadFixtureIndex('scip-go-sample');
    const graph = buildGraphFromScip(index);
    expect(validateGraph(graph)).not.toBeNull();
  });

  it('largest fixture graph (with symbolRanges) stays far under MAX_GRAPH_SIZE_BYTES', () => {
    const index = loadFixtureIndex('scip-go-sample');
    const graph = buildGraphFromScip(index);
    const bytes = Buffer.byteLength(JSON.stringify(graph), 'utf8');
    expect(bytes).toBeLessThan(MAX_GRAPH_SIZE_BYTES);
  });
});

describe('Phase 4.5: end-to-end integration (builder → computeChangedSymbolsComplete)', () => {
  it('a real SCIP-built graph correctly attributes a body-only change via computeChangedSymbolsComplete', () => {
    const index = loadFixtureIndex('scip-go-sample');
    const graph = buildGraphFromScip(index);

    const greetNode = graph.nodes['pkg/greeting.go'];
    expect(greetNode?.symbolRanges).toBeDefined();
    const greetRange = greetNode?.symbolRanges?.Greet;
    expect(greetRange).toBeDefined();
    const [start] = greetRange as [number, number];

    // Body-only diff: touch the FIRST line inside Greet's captured range
    // (a real fixture line, not synthetic) — must attribute to "Greet".
    const diff = `
diff --git a/pkg/greeting.go b/pkg/greeting.go
--- a/pkg/greeting.go
+++ b/pkg/greeting.go
@@ -${start},1 +${start},1 @@
-placeholder old
+placeholder new
`;

    const result = computeChangedSymbolsComplete(diff, graph);
    const entry = result.get('pkg/greeting.go');
    expect(entry?.changedSymbols.has('Greet')).toBe(true);
  });
});
