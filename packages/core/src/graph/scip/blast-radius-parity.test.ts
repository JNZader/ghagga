/**
 * Blast-Radius Parity Regression (Phase 3)
 *
 * Proves `computeBlastRadius` requires ZERO changes to consume a
 * SCIP-produced `DependencyGraph` (from `buildGraphFromScip`) identically to
 * a regex-produced one.
 *
 * The payoff: the fixture's cross-file edge (`main.go` -> `pkg/greeting.go`
 * via Go's full module-path import `example.com/fixture/pkg`) is exactly
 * the kind of reference the regex-based extractor structurally cannot
 * resolve (see `builder.test.ts`). This test asserts that once SCIP
 * resolves that edge, `computeBlastRadius` correctly uses it to flag
 * `main.go` as impacted when `pkg/greeting.go` (the definition file)
 * changes — with the same shape/semantics contract (seeds, depth,
 * maxFiles) it already honors for regex-produced graphs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeBlastRadius } from '../blast-radius.js';
import type { DependencyGraph } from '../schema.js';
import { buildGraphFromScip, parseScipIndex } from './builder.js';

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/scip-go-sample/index.scip',
);

function loadScipGraph(): DependencyGraph {
  const bytes = readFileSync(FIXTURE_PATH);
  const index = parseScipIndex(bytes);
  return buildGraphFromScip(index);
}

/**
 * Hand-built regex-shaped graph with the SAME nodes/edges as the SCIP
 * fixture graph, but constructed the way `../builder.ts` (regex path)
 * would shape it: same field values, no SCIP involvement at all. Used to
 * assert `computeBlastRadius` output is byte-for-byte identical regardless
 * of which builder produced the graph.
 */
function buildRegexShapedEquivalent(): DependencyGraph {
  return {
    version: 1,
    rootDir: '',
    nodes: {
      'main.go': {
        hash: 'irrelevant-hash-main',
        language: 'go',
        imports: ['pkg/greeting.go'],
        exports: ['main'],
        calls: [],
        isTest: false,
      },
      'pkg/greeting.go': {
        hash: 'irrelevant-hash-greeting',
        language: 'go',
        imports: [],
        exports: ['Greet'],
        calls: [],
        isTest: false,
      },
    },
  };
}

describe('blast-radius parity: SCIP-produced graph vs regex-produced graph', () => {
  it('SCIP graph: changing the definition file (pkg/greeting.go) flags the referencing file (main.go) as impacted', () => {
    const graph = loadScipGraph();

    // Sanity: the cross-file edge SCIP resolved is present (regex could not
    // produce this for a Go full-module-path import).
    expect(graph.nodes['main.go']?.imports).toContain('pkg/greeting.go');

    const result = computeBlastRadius(graph, ['pkg/greeting.go']);

    expect(result.changedFiles).toEqual(['pkg/greeting.go']);
    expect(result.dependents).toContain('main.go');
    expect(result.files.has('main.go')).toBe(true);
    expect(result.files.has('pkg/greeting.go')).toBe(true);
    expect(result.exceededCap).toBe(false);
  });

  it('honors maxDepth / maxFiles / includeTests options identically on a SCIP-produced graph (shape contract)', () => {
    const graph = loadScipGraph();

    // depth=0 means no BFS expansion beyond the changed files themselves.
    const shallow = computeBlastRadius(graph, ['pkg/greeting.go'], { maxDepth: 0 });
    expect(shallow.dependents).toEqual([]);
    expect(shallow.depth).toBe(0);
    expect(shallow.files.has('pkg/greeting.go')).toBe(true);
    expect(shallow.files.has('main.go')).toBe(false);

    // maxFiles=1 with a 2-node blast radius must set exceededCap.
    const capped = computeBlastRadius(graph, ['pkg/greeting.go'], { maxFiles: 1 });
    expect(capped.exceededCap).toBe(true);

    // Empty changedFiles short-circuits identically regardless of graph origin.
    const empty = computeBlastRadius(graph, []);
    expect(empty.files.size).toBe(0);
    expect(empty.depth).toBe(0);
    expect(empty.exceededCap).toBe(false);
  });

  it('parity: computeBlastRadius output is structurally identical for a SCIP graph and a regex-shaped graph with the same edge', () => {
    const scipGraph = loadScipGraph();
    const regexGraph = buildRegexShapedEquivalent();

    const scipResult = computeBlastRadius(scipGraph, ['pkg/greeting.go']);
    const regexResult = computeBlastRadius(regexGraph, ['pkg/greeting.go']);

    // Node sets, dependents, depth, and cap behavior must match exactly —
    // computeBlastRadius does not know or care which builder produced the
    // graph it's fed.
    expect([...scipResult.files].sort()).toEqual([...regexResult.files].sort());
    expect(scipResult.dependents.sort()).toEqual(regexResult.dependents.sort());
    expect(scipResult.changedFiles).toEqual(regexResult.changedFiles);
    expect(scipResult.testFiles).toEqual(regexResult.testFiles);
    expect(scipResult.depth).toBe(regexResult.depth);
    expect(scipResult.exceededCap).toBe(regexResult.exceededCap);
  });
});
