/**
 * Blast-radius diagram summary builder tests (blast-radius-diagram T2.1).
 *
 * Synthetic graphs only — offline, model-free, deterministic. Covers the
 * core-engine delta scenarios: both-direction edge derivation via the
 * merged `collectFileNeighborhoods` API, survivor determinism (changed
 * first → degree desc → path asc, degree over the FULL set), internal-edge
 * filtering, the 25-node render cap with directory-clustered truncation,
 * the 50-file blast-radius cap boundary, the oversize (exceededCap →
 * undefined) fallback, stale propagation, and the empty-changed gate.
 */

import { describe, expect, it } from 'vitest';
import { computeBlastRadius } from './blast-radius.js';
import { buildBlastRadiusDiagramSummary } from './diagram-summary.js';
import type { DependencyGraph, GraphNode } from './schema.js';
import { GRAPH_VERSION, MAX_BLAST_RADIUS_FILES, MAX_DIAGRAM_NODES } from './schema.js';

// ─── Helpers ────────────────────────────────────────────────────

function tsNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: 'h',
    language: 'typescript',
    imports: [],
    exports: [],
    calls: [],
    isTest: false,
    ...overrides,
  };
}

function makeGraph(nodes: Record<string, GraphNode>): DependencyGraph {
  return { version: GRAPH_VERSION, rootDir: '.', nodes };
}

/** graph → blast radius (UNTOUCHED semantics) → diagram builder. */
function build(
  graph: DependencyGraph,
  changed: string[],
  graphStale = false,
  maxFiles = MAX_BLAST_RADIUS_FILES,
) {
  const result = computeBlastRadius(graph, changed, { maxFiles });
  return {
    result,
    diagram: buildBlastRadiusDiagramSummary(graph, result, graphStale),
  };
}

// ─── Spec scenario: edges in both directions ────────────────────

describe('buildBlastRadiusDiagramSummary — both-direction edges (core-engine scenario)', () => {
  const graph = makeGraph({
    'src/a.ts': tsNode({ imports: ['lib/util.ts'] }),
    'src/b.ts': tsNode(),
    'src/page.ts': tsNode({ imports: ['src/a.ts'] }),
    'lib/util.ts': tsNode(),
  });

  it('nodes = changed + importee + importer; edges carry upstream and downstream', () => {
    const { diagram } = build(graph, ['src/a.ts', 'src/b.ts']);
    expect(diagram).toBeDefined();
    const labels = diagram!.nodes.map((n) => n.label);
    expect(labels).toContain('src/a.ts');
    expect(labels).toContain('src/b.ts');
    expect(labels).toContain('lib/util.ts'); // importee (upstream)
    expect(labels).toContain('src/page.ts'); // importer (downstream)

    const edgePairs = diagram!.edges.map((e) => {
      const from = diagram!.nodes.find((n) => n.id === e.from)?.label;
      const to = diagram!.nodes.find((n) => n.id === e.to)?.label;
      return `${from} -> ${to}`;
    });
    // from = importer, to = importee.
    expect(edgePairs).toContain('src/a.ts -> lib/util.ts');
    expect(edgePairs).toContain('src/page.ts -> src/a.ts');
  });

  it('every edge references two listed nodes (no dangling edges)', () => {
    const { diagram } = build(graph, ['src/a.ts', 'src/b.ts']);
    const ids = new Set(diagram!.nodes.map((n) => n.id));
    for (const edge of diagram!.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it('roles: changed > test > dependent precedence (pool tests collapse into summary nodes)', () => {
    const graphWithTest = makeGraph({
      'src/a.ts': tsNode({ imports: ['lib/util.ts'] }),
      'lib/util.ts': tsNode(),
      'src/a.test.ts': tsNode({ imports: ['src/a.ts'], isTest: true }),
    });
    const { diagram } = build(graphWithTest, ['src/a.ts']);
    const byLabel = new Map(diagram!.nodes.map((n) => [n.label, n.role]));
    expect(byLabel.get('src/a.ts')).toBe('changed');
    expect(byLabel.get('lib/util.ts')).toBe('dependent');
    // Test files no longer render individually (they do not consume the
    // node budget): the pool's one test file collapses into a per-cluster
    // summary node — role 'test', cluster and count folded into the
    // label ('src/a.test.ts' is its own cluster: single-slash path).
    expect(byLabel.get('src/a.test.ts')).toBeUndefined();
    expect(byLabel.get('test files src/a.test.ts x1')).toBe('test');
    expect(diagram!.nodes).toHaveLength(3); // a.ts + util.ts + test summary
    // The individual test file never appears as a NODE line (`n<digits>
    // ["src/a.test.ts"]`) — only the summary label does. The SUBGRAPH
    // title may still carry the cluster name (`c<digits>["src/a.test.ts"]` —
    // a root-level test file IS its own cluster), which is correct.
    expect(diagram!.mermaid).not.toMatch(/\bn\d+\["src\/a\.test\.ts"\]/);
    expect(diagram!.mermaid).toContain('["test files src/a.test.ts x1"]');
  });
});

// ─── Survivor determinism + caps ────────────────────────────────

describe('buildBlastRadiusDiagramSummary — survivor selection + caps', () => {
  /**
   * 40-file eligible pool, all root-level: hub0.ts (changed) imported by
   * f01..f39; each fXX (XX≥2) also imports f(XX-1). Degrees: hub0 = 10
   * (per-direction neighborhood cap 10 accepted — ranking only), f02..f38
   * = 3, f01/f39 = 2. Survivors = hub0 (changed) + the 24 highest-degree
   * files (degree 3, path asc) = f02..f25. Omitted = f01, f26..f39 (15).
   */
  function makePoolGraph(): DependencyGraph {
    const nodes: Record<string, GraphNode> = { 'hub0.ts': tsNode() };
    for (let i = 1; i <= 39; i++) {
      const name = `f${String(i).padStart(2, '0')}.ts`;
      const imports = ['hub0.ts'];
      if (i >= 2) imports.push(`f${String(i - 1).padStart(2, '0')}.ts`);
      nodes[name] = tsNode({ imports });
    }
    return makeGraph(nodes);
  }

  it('40 eligible / 25 cap → exactly 25 nodes, truncated + clusterCounts, omitted names absent', () => {
    const graph = makePoolGraph();
    const { result, diagram } = build(graph, ['hub0.ts']);
    expect(result.exceededCap).toBe(false);
    expect(result.files.size).toBe(40);

    expect(diagram).toBeDefined();
    expect(diagram!.nodes).toHaveLength(MAX_DIAGRAM_NODES);
    expect(diagram!.meta.truncated).toBe(true);
    expect(diagram!.meta.clusterCounts).toEqual({ '(root)': 15 });

    const labels = new Set(diagram!.nodes.map((n) => n.label));
    expect(labels.has('hub0.ts')).toBe(true); // changed file always first
    expect(labels.has('f02.ts')).toBe(true); // degree-3, path-asc survivors
    expect(labels.has('f25.ts')).toBe(true);
    // Omitted files never reach mermaid or the node list.
    expect(labels.has('f01.ts')).toBe(false); // degree 2 loses to degree 3
    expect(labels.has('f26.ts')).toBe(false);
    expect(diagram!.mermaid).not.toContain('f26.ts');
    expect(diagram!.mermaid).not.toContain('f39.ts');
  });

  it('drops edges with an endpoint outside survivors (internal-edge filter)', () => {
    const graph = makePoolGraph();
    const { diagram } = build(graph, ['hub0.ts']);
    const survivorIds = new Set(diagram!.nodes.map((n) => n.id));
    for (const edge of diagram!.edges) {
      expect(survivorIds.has(edge.from)).toBe(true);
      expect(survivorIds.has(edge.to)).toBe(true);
    }
    // f26 (omitted) imports f25 (survivor) in the graph — that edge must
    // not appear. Map ids back to labels and assert the pair is absent.
    const labelById = new Map(diagram!.nodes.map((n) => [n.id, n.label]));
    const pairs = diagram!.edges.map((e) => `${labelById.get(e.from)}|${labelById.get(e.to)}`);
    expect(pairs).not.toContain('f26.ts|f25.ts');
    expect(pairs).not.toContain('f01.ts|hub0.ts');
    expect(pairs).toContain('f10.ts|hub0.ts'); // capped importer list, survivor
  });

  it('ranks by degree over the FULL pool before selection (deterministic ties → path asc)', () => {
    const graph = makePoolGraph();
    const first = build(graph, ['hub0.ts']).diagram!;
    const second = build(graph, ['hub0.ts']).diagram!;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // degree-3 files f02..f25 all survived; the degree-2 f01 did not.
    const labels = first.nodes.map((n) => n.label);
    expect(labels.filter((l) => /^f\d+\.ts$/.test(l))).toEqual([
      'f02.ts',
      'f03.ts',
      'f04.ts',
      'f05.ts',
      'f06.ts',
      'f07.ts',
      'f08.ts',
      'f09.ts',
      'f10.ts',
      'f11.ts',
      'f12.ts',
      'f13.ts',
      'f14.ts',
      'f15.ts',
      'f16.ts',
      'f17.ts',
      'f18.ts',
      'f19.ts',
      'f20.ts',
      'f21.ts',
      'f22.ts',
      'f23.ts',
      'f24.ts',
      'f25.ts',
    ]);
  });
});

// ─── 50-file blast-radius cap boundary ──────────────────────────

describe('buildBlastRadiusDiagramSummary — MAX_BLAST_RADIUS_FILES boundary', () => {
  function graphWithNDependents(dependents: number): DependencyGraph {
    const nodes: Record<string, GraphNode> = { 'hub.ts': tsNode() };
    for (let i = 1; i <= dependents; i++) {
      nodes[`d${String(i).padStart(2, '0')}.ts`] = tsNode({ imports: ['hub.ts'] });
    }
    return makeGraph(nodes);
  }

  it('49 files (in-cap) → diagram present, node list capped at 25', () => {
    const { result, diagram } = build(graphWithNDependents(48), ['hub.ts']); // 49 total
    expect(result.files.size).toBe(49);
    expect(result.exceededCap).toBe(false);
    expect(diagram).toBeDefined();
    expect(diagram!.nodes).toHaveLength(MAX_DIAGRAM_NODES);
    expect(diagram!.meta.truncated).toBe(true);
  });

  it('50 files (exactly at cap, NOT exceeded) → diagram present', () => {
    const { result, diagram } = build(graphWithNDependents(49), ['hub.ts']); // 50 total
    expect(result.files.size).toBe(50);
    expect(result.exceededCap).toBe(false);
    expect(diagram).toBeDefined();
    expect(diagram!.nodes).toHaveLength(MAX_DIAGRAM_NODES);
  });

  it('51 files (exceededCap) → undefined (counts-only, spec oversize scenario)', () => {
    const { result, diagram } = build(graphWithNDependents(50), ['hub.ts']); // 51 total
    expect(result.files.size).toBe(51);
    expect(result.exceededCap).toBe(true);
    expect(diagram).toBeUndefined();
  });
});

// ─── Flags + gates ──────────────────────────────────────────────

describe('buildBlastRadiusDiagramSummary — flags and gates', () => {
  const graph = makeGraph({
    'src/a.ts': tsNode({ imports: ['lib/util.ts'] }),
    'lib/util.ts': tsNode(),
  });

  it('threads graphStale into meta.stale', () => {
    const diagram = buildBlastRadiusDiagramSummary(
      graph,
      computeBlastRadius(graph, ['src/a.ts']),
      true,
    );
    expect(diagram!.meta.stale).toBe(true);
  });

  it('graphStale=false → meta.stale false', () => {
    const { diagram } = build(graph, ['src/a.ts'], false);
    expect(diagram!.meta.stale).toBe(false);
  });

  it('zero changed files → undefined', () => {
    const result = computeBlastRadius(graph, []);
    expect(buildBlastRadiusDiagramSummary(graph, result, false)).toBeUndefined();
  });

  it('changed files none of which are in the graph → undefined', () => {
    const result = computeBlastRadius(graph, ['elsewhere/x.ts']);
    expect(buildBlastRadiusDiagramSummary(graph, result, false)).toBeUndefined();
  });

  it('a changed file missing from the graph is skipped, in-graph ones still diagrammed', () => {
    const { diagram } = build(graph, ['src/a.ts', 'not-in-graph.ts']);
    expect(diagram).toBeDefined();
    const labels = diagram!.nodes.map((n) => n.label);
    expect(labels).toContain('src/a.ts');
    expect(labels).not.toContain('not-in-graph.ts');
  });

  it('never mutates the passed BlastRadiusResult', () => {
    const result = computeBlastRadius(graph, ['src/a.ts']);
    const before = JSON.stringify({
      changed: result.changedFiles,
      dependents: result.dependents,
      tests: result.testFiles,
      files: [...result.files],
      exceededCap: result.exceededCap,
    });
    buildBlastRadiusDiagramSummary(graph, result, false);
    const after = JSON.stringify({
      changed: result.changedFiles,
      dependents: result.dependents,
      tests: result.testFiles,
      files: [...result.files],
      exceededCap: result.exceededCap,
    });
    expect(after).toBe(before);
  });
});

// ─── 4R fix-round regressions ───────────────────────────────────

describe('buildBlastRadiusDiagramSummary — 4R fix-round regressions', () => {
  it('REL-001: hub edges between survivors survive beyond the neighborhood per-direction cap', () => {
    // app.ts imports the hub PLUS 12 decoys (hub beyond slice 10 of
    // app's importees); 12 other files import the hub (app beyond
    // slice 10 of the hub's importers). Both survive; the internal
    // app→hub edge must be present — derived from `imports` records,
    // never from capped hoods.
    const nodes: Record<string, GraphNode> = {
      'app.ts': tsNode({
        imports: [
          ...Array.from({ length: 12 }, (_, i) => `d${String(i + 1).padStart(2, '0')}/e.ts`),
          'src/hub.ts',
        ],
      }),
      'src/hub.ts': tsNode({ imports: ['app.ts'] }),
    };
    for (let i = 1; i <= 12; i++) {
      nodes[`d${String(i).padStart(2, '0')}/e.ts`] = tsNode();
    }
    for (let i = 1; i <= 12; i++) {
      nodes[`y${String(i).padStart(2, '0')}/f.ts`] = tsNode({ imports: ['src/hub.ts'] });
    }
    const { diagram } = build(makeGraph(nodes), ['app.ts']);
    expect(diagram).toBeDefined();
    const labels = diagram!.nodes.map((n) => n.label);
    expect(labels).toContain('app.ts');
    expect(labels).toContain('src/hub.ts');
    const edgePairs = diagram!.edges.map((e) => {
      const from = diagram!.nodes.find((n) => n.id === e.from)?.label;
      const to = diagram!.nodes.find((n) => n.id === e.to)?.label;
      return `${from} -> ${to}`;
    });
    expect(edgePairs).toContain('app.ts -> src/hub.ts');
  });

  it('RES-001: budget overrun degrades to undefined instead of throwing into failedSteps', () => {
    // 25 survivors (1 changed + 24 dependents), each in a distinct
    // ~78-char top-level directory: serialized diagram exceeds the 10k
    // budget with every cap respected. The builder must return
    // undefined (counts-only fallback), never throw — the old throw
    // path landed in failedSteps and finalize downgraded PASSED→PARTIAL.
    const dirName = (i: number) => `pkg${String(i).padStart(2, '0')}${'x'.repeat(70)}`;
    const nodes: Record<string, GraphNode> = {
      'app.ts': tsNode(),
    };
    const changed = ['app.ts'];
    for (let i = 1; i <= 24; i++) {
      const file = `${dirName(i)}/dep.ts`;
      nodes[file] = tsNode({ imports: ['app.ts'] });
    }
    // Dependents discover via radius; ensure the radius covers them.
    const { diagram } = build(makeGraph(nodes), changed);
    expect(diagram).toBeUndefined();
  });

  it('RISK-001: more changed files than the node cap still flags truncation and counts omissions', () => {
    // 26 changed files (cap 25): the dropped 26th used to vanish without
    // setting truncated — the legend claimed completeness.
    const nodes: Record<string, GraphNode> = {};
    const changed: string[] = [];
    for (let i = 1; i <= 26; i++) {
      const file = `c${String(i).padStart(2, '0')}/f.ts`;
      nodes[file] = tsNode();
      changed.push(file);
    }
    const { diagram } = build(makeGraph(nodes), changed);
    expect(diagram).toBeDefined();
    expect(diagram!.nodes).toHaveLength(MAX_DIAGRAM_NODES);
    expect(diagram!.meta.truncated).toBe(true);
    const omittedCount = Object.values(diagram!.meta.clusterCounts ?? {}).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(omittedCount).toBeGreaterThanOrEqual(1);
  });
});
