/**
 * Wiring tests for the blast-radius diagram inside step 2.5
 * (blast-radius-diagram T2.3).
 *
 * Asserts the SINGLE-GRAPH rule (one loader call per review), the in-cap
 * gate (diagram only when the radius fit the cap), the no-graph state, the
 * swallowed builder-throw degradation (counts-only metadata + failedSteps
 * entry, review continues), and stale propagation — plus 0-diff on the
 * `computeBlastRadius` invocation (the original prepare-graph /
 * prepare-graph-narrow suites stay green, run alongside).
 */

import { describe, expect, it, vi } from 'vitest';
import type { DependencyGraph, GraphLoader, GraphMetadata, GraphNode } from '../graph/schema.js';
import { GRAPH_VERSION, MAX_BLAST_RADIUS_FILES } from '../graph/schema.js';
import type { ReviewInput } from '../types.js';
import { applyBlastRadius } from './prepare-graph.js';
import type { FailedStep } from './state.js';

// ─── Builder mock (throw toggle only — real builder otherwise) ────

const builderThrower = { armed: false };
vi.mock('../graph/diagram-summary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph/diagram-summary.js')>();
  return {
    ...actual,
    buildBlastRadiusDiagramSummary: (
      ...args: Parameters<typeof actual.buildBlastRadiusDiagramSummary>
    ) => {
      if (builderThrower.armed) throw new Error('diagram builder exploded');
      return actual.buildBlastRadiusDiagramSummary(...args);
    },
  };
});

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

class StaticGraphLoader implements GraphLoader {
  loadCalls = 0;
  constructor(
    private readonly graph: DependencyGraph | null,
    private readonly metadata: GraphMetadata | null,
  ) {}
  async load(): Promise<DependencyGraph | null> {
    this.loadCalls++;
    return this.graph;
  }
  async loadMetadata(): Promise<GraphMetadata | null> {
    return this.metadata;
  }
}

function makeMetadata(overrides: Partial<GraphMetadata> = {}): GraphMetadata {
  return {
    lastIndexedCommit: 'commit-abc',
    lastIndexedAt: new Date().toISOString(),
    schemaVersion: GRAPH_VERSION,
    fileCount: 2,
    languages: ['typescript'],
    indexDurationMs: 5,
    ...overrides,
  };
}

function makeInput(loader: GraphLoader, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: '',
    mode: 'simple',
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-api-key',
    settings: {
      enableSemgrep: false,
      enableTrivy: false,
      enableCpd: false,
      enableMemory: false,
      customRules: [],
      ignorePatterns: [],
      reviewLevel: 'normal',
      enableBlastRadius: true,
    },
    graphLoader: loader,
    ...overrides,
  };
}

const DIFF = `
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-export const A = 1;
+export const A = 2;
`;

async function runApply(input: ReviewInput, fileList: string[]) {
  const failedSteps: FailedStep[] = [];
  const events: string[] = [];
  const outcome = await applyBlastRadius({
    input,
    emit: (event) => events.push(event.message),
    failedSteps,
    fileList,
    filteredDiff: DIFF,
    filteredFiles: fileList.map((path) => ({ path, content: DIFF })),
  });
  return { outcome, failedSteps, events };
}

/** a.ts imports lib/util.ts; page.ts imports a.ts. */
function makeSmallGraph(): DependencyGraph {
  return {
    version: GRAPH_VERSION,
    rootDir: '.',
    nodes: {
      'src/a.ts': tsNode({ imports: ['lib/util.ts'] }),
      'lib/util.ts': tsNode(),
      'src/page.ts': tsNode({ imports: ['src/a.ts'] }),
    },
  };
}

// ─── Scenarios ──────────────────────────────────────────────────

describe('applyBlastRadius — diagram wiring (blast-radius-diagram T2.3)', () => {
  it('in-cap graph-backed review → metadata carries the diagram (single graph load)', async () => {
    const loader = new StaticGraphLoader(makeSmallGraph(), makeMetadata());
    const { outcome, failedSteps } = await runApply(makeInput(loader), ['src/a.ts']);

    expect(failedSteps).toEqual([]);
    const meta = outcome.blastRadiusMetadata;
    expect(meta).toBeDefined();
    expect(meta!.diagram).toBeDefined();
    const labels = meta!.diagram!.nodes.map((n) => n.label);
    expect(labels).toContain('src/a.ts');
    expect(labels).toContain('lib/util.ts');
    expect(labels).toContain('src/page.ts');
    // New diagram contract: LR header, theme-adaptive amber classDef, and
    // the first-two-segments cluster rule (these single-slash fixture
    // paths are therefore their own clusters — cluster == label).
    expect(meta!.diagram!.mermaid).toContain('flowchart LR');
    expect(meta!.diagram!.mermaid).toContain(
      'classDef changed fill:#d97706,stroke:#92400e,stroke-width:2px,color:#ffffff',
    );
    expect(meta!.diagram!.nodes.map((n) => n.cluster)).toEqual(labels);
    // SINGLE-GRAPH rule: the graph loads ONCE per review — the diagram
    // builder is a pure consumer of the in-hand instance.
    expect(loader.loadCalls).toBe(1);
  });

  it('threads graph staleness into diagram.meta.stale', async () => {
    const staleMetadata = makeMetadata({
      lastIndexedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const loader = new StaticGraphLoader(makeSmallGraph(), staleMetadata);
    const { outcome } = await runApply(makeInput(loader), ['src/a.ts']);
    expect(outcome.blastRadiusMetadata?.diagram?.meta.stale).toBe(true);
  });

  it('exceededCap → counts-only metadata, NO diagram (spec oversize fallback)', async () => {
    const nodes: Record<string, GraphNode> = { 'hub.ts': tsNode() };
    for (let i = 1; i <= MAX_BLAST_RADIUS_FILES; i++) {
      nodes[`d${String(i).padStart(2, '0')}.ts`] = tsNode({ imports: ['hub.ts'] });
    }
    const graph: DependencyGraph = { version: GRAPH_VERSION, rootDir: '.', nodes }; // 51 files
    const loader = new StaticGraphLoader(graph, makeMetadata());
    const { outcome, failedSteps } = await runApply(makeInput(loader), ['hub.ts']);

    expect(failedSteps).toEqual([]);
    const meta = outcome.blastRadiusMetadata;
    expect(meta).toBeDefined();
    expect(meta!.fallbackReason).toContain('exceeds');
    expect('diagram' in meta!).toBe(false);
  });

  it('no graph available → no diagram, counts-only with fallbackReason', async () => {
    const loader = new StaticGraphLoader(null, null);
    const { outcome } = await runApply(makeInput(loader), ['src/a.ts']);
    const meta = outcome.blastRadiusMetadata;
    expect(meta?.graphAvailable).toBe(false);
    expect('diagram' in (meta ?? {})).toBe(false);
  });

  it('builder throw → failedSteps entry, counts-only metadata intact, review continues', async () => {
    builderThrower.armed = true;
    try {
      const loader = new StaticGraphLoader(makeSmallGraph(), makeMetadata());
      const { outcome, failedSteps } = await runApply(makeInput(loader), ['src/a.ts']);
      const meta = outcome.blastRadiusMetadata;
      expect(meta).toBeDefined();
      // Counts-only fields survive untouched.
      expect(meta).toMatchObject({
        enabled: true,
        graphAvailable: true,
        totalFiles: 1,
        blastRadiusFiles: 2,
      });
      expect('diagram' in meta!).toBe(false);
      expect(failedSteps).toHaveLength(1);
      expect(failedSteps[0]).toMatchObject({ step: 'blast-radius-diagram' });
      expect(failedSteps[0]?.error).toContain('exploded');
    } finally {
      builderThrower.armed = false;
    }
  });

  it('diagram absent when blast radius is disabled (byte-identical legacy path)', async () => {
    const loader = new StaticGraphLoader(makeSmallGraph(), makeMetadata());
    const input = makeInput(loader);
    input.settings.enableBlastRadius = false;
    const { outcome } = await runApply(input, ['src/a.ts']);
    expect(outcome.blastRadiusMetadata).toBeUndefined();
  });
});
