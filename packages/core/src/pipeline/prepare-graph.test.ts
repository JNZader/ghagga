/**
 * Unit tests for `buildCallChainContext` step 2.6 — specifically the
 * additive `## Symbol Impact` block (Slice 2 of symbol-precise-context).
 *
 * These tests call `buildCallChainContext` directly with a minimal
 * `ReviewInput`, avoiding the full `reviewPipeline` orchestration. The
 * `graph` param mirrors what step 2.5 (`applyBlastRadius`) would have
 * ALREADY loaded and threaded through — `buildCallChainContext` itself
 * never calls `graphLoader.load()` (see `BlastRadiusOutcome.graph`).
 */

import { describe, expect, it } from 'vitest';
import type { DependencyGraph } from '../graph/schema.js';
import { GRAPH_VERSION } from '../graph/schema.js';
import type { ReviewInput } from '../types.js';
import { buildCallChainContext } from './prepare-graph.js';

// ─── Helpers ────────────────────────────────────────────────────

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
    },
    ...overrides,
  };
}

const NOOP_EMIT = () => {};

async function runStep(args: {
  input: ReviewInput;
  fileList: string[];
  filteredDiff: string;
  graph?: DependencyGraph;
}): Promise<{ context: string; failedSteps: unknown[]; warnOnlyDegradations: string[] }> {
  const failedSteps: never[] = [];
  const warnOnlyDegradations: string[] = [];
  const context = await buildCallChainContext({
    input: args.input,
    emit: NOOP_EMIT,
    failedSteps,
    warnOnlyDegradations,
    fileList: args.fileList,
    filteredDiff: args.filteredDiff,
    graph: args.graph,
  });
  return { context, failedSteps, warnOnlyDegradations };
}

// ─── Fixtures ───────────────────────────────────────────────────

const DIFF_CHANGES_X = `
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,3 +1,3 @@ const X
-export const X = 1;
+export const X = 2;
export const Y = 1;
`;

// ─── Symbol Impact block ────────────────────────────────────────

describe('buildCallChainContext — Symbol Impact block (Slice 2)', () => {
  it('reports symbol-level impact: A uses {X,Y} from B; diff changes only X', async () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'src/a.ts': {
          hash: 'h1',
          language: 'typescript',
          imports: ['src/b.ts'],
          importSymbols: { 'src/b.ts': ['X', 'Y'] },
          exports: [],
          calls: [],
          isTest: false,
        },
        'src/b.ts': {
          hash: 'h2',
          language: 'typescript',
          imports: [],
          exports: ['X', 'Y'],
          calls: [],
          isTest: false,
        },
      },
    };

    const input = makeInput();
    const { context } = await runStep({
      input,
      fileList: ['src/b.ts'],
      filteredDiff: DIFF_CHANGES_X,
      graph,
    });

    expect(context).toContain('## Symbol Impact');
    expect(context).toContain('src/a.ts uses {X, Y} from src/b.ts');
    expect(context).toContain('changed: X');
  });

  it('degrades to file-level phrasing when no importSymbols data for a specific edge (Go/Python case) — no error, file still included', async () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        // src/a.ts HAS importSymbols data (so anySymbolData is true globally)
        'src/a.ts': {
          hash: 'h1',
          language: 'typescript',
          imports: ['src/b.ts'],
          importSymbols: { 'src/b.ts': ['X'] },
          exports: [],
          calls: [],
          isTest: false,
        },
        // scripts/deploy.py imports src/b.ts but has NO importSymbols data
        // for that edge (Python module-level import case).
        'scripts/deploy.py': {
          hash: 'h3',
          language: 'python',
          imports: ['src/b.ts'],
          exports: [],
          calls: [],
          isTest: false,
        },
        'src/b.ts': {
          hash: 'h2',
          language: 'typescript',
          imports: [],
          exports: ['X'],
          calls: [],
          isTest: false,
        },
      },
    };

    const input = makeInput();
    const { context, failedSteps } = await runStep({
      input,
      fileList: ['src/b.ts'],
      filteredDiff: DIFF_CHANGES_X,
      graph,
    });

    expect(context).toContain('## Symbol Impact');
    expect(context).toContain('scripts/deploy.py depends on src/b.ts');
    expect(context).not.toContain('scripts/deploy.py uses {'); // no symbol claim
    expect(failedSteps).toHaveLength(0);
  });

  it('is conservative on barrel/no-data edges — never claims a dependent is "unaffected"', async () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'src/a.ts': {
          hash: 'h1',
          language: 'typescript',
          imports: ['src/b.ts'],
          importSymbols: { 'src/b.ts': ['X'] },
          exports: [],
          calls: [],
          isTest: false,
        },
        'src/b.ts': {
          hash: 'h2',
          language: 'typescript',
          imports: [],
          exports: ['X', 'Y'],
          calls: [],
          isTest: false,
        },
      },
    };

    // Diff with no symbol-level change markers extractChangedSymbolsFromDiff
    // can pick up for src/b.ts (empty hunk context) — simulates the
    // conservative "changed: unknown" path.
    const opaqueDiff = `
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-x
+y
`;

    const input = makeInput();
    const { context } = await runStep({
      input,
      fileList: ['src/b.ts'],
      filteredDiff: opaqueDiff,
      graph,
    });

    expect(context).toContain('## Symbol Impact');
    expect(context.toLowerCase()).not.toContain('unaffected');
    expect(context.toLowerCase()).not.toContain('not affected');
  });

  it('produces NO Symbol Impact content when the graph has no importSymbols data anywhere (no regression)', async () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'src/a.ts': {
          hash: 'h1',
          language: 'go',
          imports: ['src/b.go'],
          exports: [],
          calls: [],
          isTest: false,
        },
        'src/b.go': {
          hash: 'h2',
          language: 'go',
          imports: [],
          exports: [],
          calls: [],
          isTest: false,
        },
      },
    };

    const input = makeInput();
    const { context } = await runStep({
      input,
      fileList: ['src/b.go'],
      filteredDiff: DIFF_CHANGES_X,
      graph,
    });

    expect(context).not.toContain('## Symbol Impact');
  });

  it('produces NO Symbol Impact content when no graph is available (blast-radius disabled, no loader, or unavailable graph)', async () => {
    const input = makeInput(); // no graphLoader configured upstream
    const { context } = await runStep({
      input,
      fileList: ['src/b.ts'],
      filteredDiff: DIFF_CHANGES_X,
      // graph: undefined — mirrors what applyBlastRadius returns when
      // blast-radius is disabled/no loader/graph unavailable/load errored.
    });

    expect(context).not.toContain('## Symbol Impact');
  });

  it('never filters fileList / diff review file-set based on Symbol Impact data (grep guard: purely additive text)', async () => {
    const graph: DependencyGraph = {
      version: GRAPH_VERSION,
      rootDir: '.',
      nodes: {
        'src/a.ts': {
          hash: 'h1',
          language: 'typescript',
          imports: ['src/b.ts'],
          importSymbols: { 'src/b.ts': ['UnusedSymbol'] },
          exports: [],
          calls: [],
          isTest: false,
        },
        'src/b.ts': {
          hash: 'h2',
          language: 'typescript',
          imports: [],
          exports: ['X', 'UnusedSymbol'],
          calls: [],
          isTest: false,
        },
      },
    };

    const input = makeInput();
    const fileList = ['src/b.ts'];
    const { context } = await runStep({ input, fileList, filteredDiff: DIFF_CHANGES_X, graph });

    // fileList itself is untouched by this step — the function signature
    // takes it by value and buildCallChainContext returns only a string.
    expect(fileList).toEqual(['src/b.ts']);
    expect(context).toContain('## Symbol Impact');
  });
});
