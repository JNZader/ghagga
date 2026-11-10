/**
 * Graph-neighborhood context gather step (graph-context-retrieval Slice 3).
 *
 * Parametrized degradation matrix over the FULL reviewPipeline (T3.1):
 * every rung of the design's staleness ladder, each row asserting the
 * `graphContextMetadata` outcome on `ReviewMetadata` (or its deliberate
 * absence for the byte-stable no-graph/disabled states) plus the
 * graph-context progress events.
 *
 * Budget-neutrality (T3.3): the same diff reviewed twice — feature on
 * with a fresh exact-commit graph vs. off — must produce byte-identical
 * 70/30 split inputs (truncated diff + static/memory context layers).
 *
 * All offline and model-free: agents, tools and memory are mocked.
 */

import { beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';

// ─── Mock external dependencies (pipeline.test.ts pattern) ───────

vi.mock('../agents/simple.js', () => ({
  runSimpleReview: vi.fn(),
}));

vi.mock('../tools/runner.js', () => ({
  runStaticAnalysis: vi.fn(),
  formatStaticAnalysisContext: vi.fn(),
  isToolRegistryEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../tools/plugins/index.js', () => ({
  initializeDefaultTools: vi.fn(),
}));

vi.mock('../tools/registry.js', () => ({
  toolRegistry: {
    getAll: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
  },
}));

vi.mock('../memory/search.js', () => ({
  searchMemoryForContext: vi.fn(),
}));

vi.mock('../memory/persist.js', () => ({
  persistReviewObservations: vi.fn().mockResolvedValue(undefined),
}));

// Partial mock (real impl by default): the formatter-throw row forces ONE
// formatGraphNeighborhood throw via mockImplementationOnce. Keeping the
// module real preserves DEFAULT_GRAPH_CONTEXT_MAX_TOKENS for the wiring.
vi.mock('../graph/neighborhood-format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph/neighborhood-format.js')>();
  return { ...actual, formatGraphNeighborhood: vi.fn(actual.formatGraphNeighborhood) };
});

// Partial mock (real impl by default, same pattern): the ranker-throw row
// forces ONE rankNeighborhoods throw; real ranking stays on for the order
// assertions (context-hybrid-ranking T1.3).
vi.mock('../graph/neighborhood-rank.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph/neighborhood-rank.js')>();
  return { ...actual, rankNeighborhoods: vi.fn(actual.rankNeighborhoods) };
});

import { runSimpleReview } from '../agents/simple.js';
import { formatGraphNeighborhood } from '../graph/neighborhood-format.js';
import { rankNeighborhoods } from '../graph/neighborhood-rank.js';
import type { DependencyGraph, GraphLoader, GraphMetadata, GraphNode } from '../graph/schema.js';
import { reviewPipeline } from '../pipeline.js';
import { formatStaticAnalysisContext, runStaticAnalysis } from '../tools/runner.js';
import type { ProgressEvent, ReviewInput, ReviewResult } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────

const TWO_FILE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export function indexFn() {}
diff --git a/src/unrelated.ts b/src/unrelated.ts
index 1234567..abcdefg 100644
--- a/src/unrelated.ts
+++ b/src/unrelated.ts
@@ -1,2 +1,3 @@
 // unrelated to the graph
+// still changed
`;

const HEAD_SHA = 'a'.repeat(40);

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: 'hash',
    language: 'typescript',
    imports: [],
    exports: ['indexFn'],
    calls: [],
    isTest: false,
    ...overrides,
  };
}

/** src/index.ts is imported by utils + a test; imports dep. */
const GRAPH: DependencyGraph = {
  version: 1,
  rootDir: '/repo',
  nodes: {
    'src/index.ts': makeNode({ imports: ['src/dep.ts'] }),
    'src/dep.ts': makeNode(),
    'src/utils.ts': makeNode({ imports: ['src/index.ts'] }),
    'src/index.test.ts': makeNode({ isTest: true, imports: ['src/index.ts'] }),
    // src/unrelated.ts deliberately NOT in the graph (missing-file row).
  },
};

function makeMetadata(overrides: Partial<GraphMetadata> = {}): GraphMetadata {
  return {
    lastIndexedCommit: HEAD_SHA,
    lastIndexedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days old
    schemaVersion: 1,
    fileCount: Object.keys(GRAPH.nodes).length,
    languages: ['typescript'],
    indexDurationMs: 10,
    ...overrides,
  };
}

function makeGraphLoader(
  load: GraphLoader['load'],
  loadMetadata: GraphLoader['loadMetadata'],
): GraphLoader {
  return { load: vi.fn(load), loadMetadata: vi.fn(loadMetadata) };
}

const SKIPPED_STATIC = () => ({
  semgrep: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
  trivy: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
  cpd: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
});

/**
 * Fresh agent result per call. MUST be a factory, not a shared const:
 * enrich MUTATES result.metadata in place, so a shared nested metadata
 * object would leak graphContextMetadata/blastRadius between rows —
 * the degradation matrix would read the PREVIOUS row's metadata.
 */
function makeSimpleResult(): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'Code looks good.',
    findings: [],
    staticAnalysis: SKIPPED_STATIC(),
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 100,
      executionTimeMs: 500,
      toolsRun: [],
      toolsSkipped: [],
    },
  };
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: TWO_FILE_DIFF,
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
    context: {
      repoFullName: 'test/repo',
      prNumber: 42,
      commitMessages: [],
      fileList: [],
    },
    memoryStorage: undefined,
    currentHead: HEAD_SHA,
    ...overrides,
  };
}

interface RunOutcome {
  result: ReviewResult;
  events: ProgressEvent[];
  agentArgs: Record<string, unknown>;
}

async function run(input: ReviewInput): Promise<RunOutcome> {
  const events: ProgressEvent[] = [];
  const result = await reviewPipeline({
    ...input,
    onProgress: (e) => {
      events.push(e);
    },
  });
  // LAST call — the budget test runs the pipeline twice and must compare
  // each run against its own agent invocation, not the first one.
  const calls = (runSimpleReview as MockedFunction<typeof runSimpleReview>).mock.calls;
  const agentArgs = calls[calls.length - 1]?.[0];
  return { result, events, agentArgs: (agentArgs ?? {}) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  (runSimpleReview as MockedFunction<typeof runSimpleReview>).mockImplementation(async () =>
    makeSimpleResult(),
  );
  (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockResolvedValue(
    SKIPPED_STATIC(),
  );
  (
    formatStaticAnalysisContext as MockedFunction<typeof formatStaticAnalysisContext>
  ).mockReturnValue('');
});

// ─── Degradation matrix (T3.1) ──────────────────────────────────

describe('graph-context degradation ladder', () => {
  it('disabled: no context step, no metadata, review completes identically', async () => {
    const loader = makeGraphLoader(
      async () => GRAPH,
      async () => makeMetadata(),
    );
    const { result, events } = await run(
      makeInput({
        graphLoader: loader,
        settings: { ...makeInput().settings, enableGraphContext: false },
      }),
    );

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toBeUndefined();
    expect(events.filter((e) => e.step === 'graph-context')).toEqual([]);
  });

  it('no graph (auto): silent skip — no events, no metadata, byte-stable result', async () => {
    const { result, events } = await run(makeInput({ graphLoader: undefined }));

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toBeUndefined();
    expect(events.filter((e) => e.step === 'graph-context')).toEqual([]);
  });

  it('no graph (explicit true): visible skip with skippedReason no-graph', async () => {
    const { result, events } = await run(
      makeInput({
        graphLoader: undefined,
        settings: { ...makeInput().settings, enableGraphContext: true },
      }),
    );

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toEqual({
      skippedReason: 'no-graph',
      filesCovered: 0,
      truncatedFiles: 0,
    });
    expect(events.some((e) => e.step === 'graph-context' && /no graph/i.test(e.message))).toBe(
      true,
    );
  });

  it('oversize graph (loader refuses → null): same as no-graph', async () => {
    const loader = makeGraphLoader(
      async () => null, // loader refuses (MAX_GRAPH_SIZE_BYTES path)
      async () => null,
    );
    const { result } = await run(
      makeInput({
        graphLoader: loader,
        settings: { ...makeInput().settings, enableGraphContext: true },
      }),
    );

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toEqual({
      skippedReason: 'no-graph',
      filesCovered: 0,
      truncatedFiles: 0,
    });
  });

  it('stale graph (>7d): skipped with skippedReason stale-graph', async () => {
    const loader = makeGraphLoader(
      async () => GRAPH,
      async () =>
        makeMetadata({
          lastIndexedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        }),
    );
    const { result, events } = await run(makeInput({ graphLoader: loader }));

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toEqual({
      skippedReason: 'stale-graph',
      filesCovered: 0,
      truncatedFiles: 0,
    });
    expect(events.some((e) => e.step === 'graph-context' && /stale/i.test(e.message))).toBe(true);
  });

  it('fresh exact-commit graph: exact tier, file missing from graph omitted (filesCovered < changed)', async () => {
    const loader = makeGraphLoader(
      async () => GRAPH,
      async () => makeMetadata(),
    );
    const { result, events } = await run(makeInput({ graphLoader: loader }));

    expect(result.status).toBe('PASSED');
    // 2 changed files, only src/index.ts is in the graph.
    expect(result.metadata.graphContextMetadata).toEqual({
      filesCovered: 1,
      truncatedFiles: 0,
      freshness: 'exact',
      rankingMode: 'lexical',
    });
    expect(events.some((e) => e.step === 'graph-context' && /1\/2/.test(e.message))).toBe(true);
  });

  it('not exact-commit-fresh (head mismatch): file-level tier metadata', async () => {
    const loader = makeGraphLoader(
      async () => GRAPH,
      async () => makeMetadata({ lastIndexedCommit: 'b'.repeat(40) }),
    );
    const { result } = await run(makeInput({ graphLoader: loader }));

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toEqual({
      filesCovered: 1,
      truncatedFiles: 0,
      freshness: 'file-level',
      rankingMode: 'lexical',
    });
  });

  it('formatter throw: caught, failedStep recorded, review continues', async () => {
    (
      formatGraphNeighborhood as MockedFunction<typeof formatGraphNeighborhood>
    ).mockImplementationOnce(() => {
      throw new Error('boom: formatter exploded');
    });
    const loader = makeGraphLoader(
      async () => GRAPH,
      async () => makeMetadata(),
    );
    const { result, events } = await run(makeInput({ graphLoader: loader }));

    // Review completed (downgraded to PARTIAL because a tracked step failed).
    expect(['PARTIAL', 'PASSED']).toContain(result.status);
    expect(result.failedSteps?.some((s) => s.step === 'graph-context')).toBe(true);
    expect(result.metadata.graphContextMetadata).toBeUndefined();
    expect(events.some((e) => e.step === 'graph-context' && /failed/i.test(e.message))).toBe(true);
  });
});

// ─── Budget neutrality (T3.3) ────────────────────────────────────

describe('graph-context budget neutrality', () => {
  it('feature on (fresh graph) vs off: byte-identical 70/30 split inputs and truncated diff', async () => {
    const loader = makeGraphLoader(
      async () => GRAPH,
      async () => makeMetadata(),
    );

    const on = await run(makeInput({ graphLoader: loader })); // auto-on with loaded graph
    const off = await run(
      makeInput({
        graphLoader: loader,
        settings: { ...makeInput().settings, enableGraphContext: false },
      }),
    );

    // The graph-context step ran for ON and skipped for OFF.
    expect(on.result.metadata.graphContextMetadata?.freshness).toBe('exact');
    expect(off.result.metadata.graphContextMetadata).toBeUndefined();

    // 70/30 split inputs to the agent are byte-identical: the truncated
    // diff, static context, memory context and stack hints. The
    // neighborhood rides a DEDICATED sidecar — never the diff budget.
    expect(on.agentArgs.diff).toBe(off.agentArgs.diff);
    expect(on.agentArgs.staticContext).toBe(off.agentArgs.staticContext);
    expect(on.agentArgs.memoryContext).toBe(off.agentArgs.memoryContext);
    expect(on.agentArgs.stackHints).toBe(off.agentArgs.stackHints);
    expect(on.agentArgs.diff).toContain('src/index.ts');
  });
});

// ─── Lexical ranking at the gather seam (context-hybrid-ranking T1.3) ──

/**
 * Two changed files, both in the graph, FIRST in diff order lexically weak:
 *
 *   aaa: w1 = 3·|{src,aaa,ts}| = 9, w2 = 0 → 9  (echo floor only)
 *   bbb: w1 = 9, w2 = 5·|{tweak,bbbfn}| = 10 → 19 (own changed symbol
 *        `tweak` + export `bbbFn` mentioned in aaa's hunk body)
 *
 * Diff order is [aaa, bbb]; score-desc order is [bbb, aaa] — the rendered
 * section must flip, proving the ranker sits between collect and format.
 */
const RANKED_DIFF = `diff --git a/src/aaa.ts b/src/aaa.ts
--- a/src/aaa.ts
+++ b/src/aaa.ts
@@ -1,2 +1,3 @@
+out = bbbFn(x)
diff --git a/src/bbb.ts b/src/bbb.ts
--- a/src/bbb.ts
+++ b/src/bbb.ts
@@ -1,2 +1,3 @@
+const tweak = 1
`;

const RANKED_GRAPH: DependencyGraph = {
  version: 1,
  rootDir: '/repo',
  nodes: {
    'src/aaa.ts': makeNode({ exports: [] }),
    'src/bbb.ts': makeNode({ exports: ['bbbFn'] }),
  },
};

describe('graph-context lexical ranking', () => {
  it('exact tier: rendered order is score-desc (bbb before aaa) and metadata reports rankingMode lexical', async () => {
    const loader = makeGraphLoader(
      async () => RANKED_GRAPH,
      async () => makeMetadata(),
    );
    const { result, agentArgs } = await run(makeInput({ diff: RANKED_DIFF, graphLoader: loader }));

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toEqual({
      filesCovered: 2,
      truncatedFiles: 0,
      freshness: 'exact',
      rankingMode: 'lexical',
    });

    const context = agentArgs.graphNeighborhoodContext as string;
    expect(context).toContain('src/bbb.ts');
    expect(context).toContain('src/aaa.ts');
    expect(context.indexOf('src/bbb.ts')).toBeLessThan(context.indexOf('src/aaa.ts'));
  });

  it('file-level tier: same score-desc order, per-tier entry rendering unchanged', async () => {
    const loader = makeGraphLoader(
      async () => RANKED_GRAPH,
      async () => makeMetadata({ lastIndexedCommit: 'b'.repeat(40) }),
    );
    const { result, agentArgs } = await run(makeInput({ diff: RANKED_DIFF, graphLoader: loader }));

    expect(result.status).toBe('PASSED');
    expect(result.metadata.graphContextMetadata).toEqual({
      filesCovered: 2,
      truncatedFiles: 0,
      freshness: 'file-level',
      rankingMode: 'lexical',
    });

    const context = agentArgs.graphNeighborhoodContext as string;
    expect(context.indexOf('src/bbb.ts')).toBeLessThan(context.indexOf('src/aaa.ts'));
    // File-level entries are paths+counts only — no symbol names leak.
    expect(context).not.toContain('bbbFn');
    expect(context).toContain('importer(s)');
  });

  it('ranker throw: caught by the existing catch → failedStep, no metadata, review continues', async () => {
    (rankNeighborhoods as MockedFunction<typeof rankNeighborhoods>).mockImplementationOnce(() => {
      throw new Error('boom: ranker exploded');
    });
    const loader = makeGraphLoader(
      async () => RANKED_GRAPH,
      async () => makeMetadata(),
    );
    const { result, events, agentArgs } = await run(
      makeInput({ diff: RANKED_DIFF, graphLoader: loader }),
    );

    expect(['PARTIAL', 'PASSED']).toContain(result.status);
    expect(result.failedSteps?.some((s) => s.step === 'graph-context')).toBe(true);
    expect(result.metadata.graphContextMetadata).toBeUndefined();
    expect(agentArgs.graphNeighborhoodContext).toBe('');
    expect(events.some((e) => e.step === 'graph-context' && /failed/i.test(e.message))).toBe(true);
  });

  it.each([
    {
      name: 'disabled',
      input: () => makeInput({ settings: { ...makeInput().settings, enableGraphContext: false } }),
    },
    { name: 'no graph (auto)', input: () => makeInput({ graphLoader: undefined }) },
    {
      name: 'stale graph (>7d)',
      input: () =>
        makeInput({
          graphLoader: makeGraphLoader(
            async () => RANKED_GRAPH,
            async () =>
              makeMetadata({
                lastIndexedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
              }),
          ),
        }),
    },
  ])('skip path ($name): ranker NEVER invoked, no rankingMode on metadata', async ({ input }) => {
    await run(input());

    expect(rankNeighborhoods).not.toHaveBeenCalled();
  });
});
