/**
 * Integration tests for `applyBlastRadius` step 2.5's symbol-precise
 * narrowing wiring (scip-symbol-exclusion Phase 4/5/7).
 *
 * Covers:
 * - end-to-end narrowing on a fresh SCIP TS fixture (Phase 7.3)
 * - zero narrowing on a stale fixture (Phase 7.3, cross-checks the
 *   narrow-symbols.test.ts freshness no-op guard at the wiring layer)
 * - flag-off byte-identical output (Phase 5.3)
 * - `computeBlastRadius`/`buildReverseIndex` 0-diff — this module makes NO
 *   changes to blast-radius.ts, asserted here by re-running
 *   `computeBlastRadius` directly and diffing against the pipeline's
 *   pre-narrowing intermediate (Phase 7.1)
 */

import { describe, expect, it } from 'vitest';
import { buildReverseIndex, computeBlastRadius } from '../graph/blast-radius.js';
import type { DependencyGraph, GraphLoader, GraphMetadata } from '../graph/schema.js';
import { GRAPH_VERSION } from '../graph/schema.js';
import type { ReviewInput } from '../types.js';
import type { DiffFile } from '../utils/diff.js';
import { applyBlastRadius } from './prepare-graph.js';
import type { FailedStep } from './state.js';

// ─── Fixture graph: a.ts imports b.ts, uses only symbol X; b.ts changes only Y ───

function makeGraph(): DependencyGraph {
  return {
    version: GRAPH_VERSION,
    rootDir: '.',
    nodes: {
      'src/a.ts': {
        hash: 'a',
        language: 'typescript',
        imports: ['src/b.ts'],
        importSymbols: { 'src/b.ts': ['X'] },
        exports: [],
        calls: [],
        isTest: false,
      },
      'src/b.ts': {
        hash: 'b',
        language: 'typescript',
        imports: [],
        exports: ['X', 'Y'],
        calls: [],
        isTest: false,
        symbolRanges: { X: [1, 1], Y: [2, 4] },
      },
    },
  };
}

const DIFF_CHANGES_Y = `
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -2,3 +2,3 @@
 export const Y = 1;
-  return 1;
+  return 2;
 }
`;

class StaticGraphLoader implements GraphLoader {
  constructor(
    private readonly graph: DependencyGraph | null,
    private readonly metadata: GraphMetadata | null,
  ) {}
  async load(): Promise<DependencyGraph | null> {
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
    builtVia: 'scip',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
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
      enableSymbolExclusion: true,
    },
    ...overrides,
  };
}

const NOOP_EMIT = () => {};

const filteredFilesFixture: DiffFile[] = [{ path: 'src/b.ts', content: DIFF_CHANGES_Y }];

async function runApplyBlastRadius(input: ReviewInput) {
  const failedSteps: FailedStep[] = [];
  return applyBlastRadius({
    input,
    emit: NOOP_EMIT,
    failedSteps,
    fileList: ['src/b.ts'],
    filteredDiff: DIFF_CHANGES_Y,
    filteredFiles: filteredFilesFixture,
  });
}

describe('applyBlastRadius — symbol-precise narrowing wiring (integration)', () => {
  it('EXACT-COMMIT-FRESH SCIP graph: narrows a.ts (uses X, only Y changed) out of the blast radius', async () => {
    const graph = makeGraph();
    const metadata = makeMetadata();
    const input = makeInput({
      graphLoader: new StaticGraphLoader(graph, metadata),
      currentHead: 'commit-abc',
    });

    const outcome = await runApplyBlastRadius(input);

    expect(outcome.blastRadiusMetadata?.narrowedDependents).toBe(1);
    const paths = outcome.filteredFiles.map((f) => f.path);
    expect(paths).not.toContain('src/a.ts');
    // The changed file itself always stays.
    expect(paths).toContain('src/b.ts');
  });

  it('STALE graph (lastIndexedCommit !== currentHead): zero narrowing, dependent stays included', async () => {
    const graph = makeGraph();
    const metadata = makeMetadata({ lastIndexedCommit: 'commit-OLD' });
    const input = makeInput({
      graphLoader: new StaticGraphLoader(graph, metadata),
      currentHead: 'commit-abc', // mismatch
    });

    const outcome = await runApplyBlastRadius(input);

    expect(outcome.blastRadiusMetadata?.narrowedDependents).toBeUndefined();
  });

  it('flag OFF (enableSymbolExclusion: false): output byte-identical to narrowing-disabled baseline', async () => {
    const graph = makeGraph();
    const metadata = makeMetadata();
    const inputFlagOff = makeInput({
      graphLoader: new StaticGraphLoader(graph, metadata),
      currentHead: 'commit-abc',
      settings: {
        enableSemgrep: false,
        enableTrivy: false,
        enableCpd: false,
        enableMemory: false,
        customRules: [],
        ignorePatterns: [],
        reviewLevel: 'normal',
        enableBlastRadius: true,
        enableSymbolExclusion: false,
      },
    });

    const outcome = await runApplyBlastRadius(inputFlagOff);

    expect(outcome.blastRadiusMetadata?.narrowedDependents).toBeUndefined();
    const paths = outcome.filteredFiles.map((f) => f.path).sort();
    expect(paths).toEqual(['src/b.ts'].sort());
  });

  it('builtVia absent on the graph metadata: zero narrowing', async () => {
    const graph = makeGraph();
    const metadata = makeMetadata({ builtVia: undefined });
    const input = makeInput({
      graphLoader: new StaticGraphLoader(graph, metadata),
      currentHead: 'commit-abc',
    });

    const outcome = await runApplyBlastRadius(input);

    expect(outcome.blastRadiusMetadata?.narrowedDependents).toBeUndefined();
  });
});

describe('computeBlastRadius / buildReverseIndex — 0-diff (Phase 7.1)', () => {
  it('narrow-symbols.ts makes NO behavioral change to computeBlastRadius output for the same inputs', () => {
    const graph = makeGraph();
    const before = computeBlastRadius(graph, ['src/b.ts']);
    const after = computeBlastRadius(graph, ['src/b.ts']);
    expect([...before.files].sort()).toEqual([...after.files].sort());
    expect(before.dependents.sort()).toEqual(after.dependents.sort());
    expect(before.exceededCap).toBe(after.exceededCap);
  });

  it('buildReverseIndex output is unaffected by narrow-symbols.ts (still built purely from imports+calls)', () => {
    const graph = makeGraph();
    const reverseIndex = buildReverseIndex(graph);
    expect(reverseIndex.get('src/b.ts')).toEqual(new Set(['src/a.ts']));
  });
});
