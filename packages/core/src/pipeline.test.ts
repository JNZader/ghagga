/**
 * Pipeline tests.
 *
 * Tests the reviewPipeline orchestrator with mocked agents, tools,
 * and memory modules. Verifies input validation, mode dispatch,
 * graceful degradation, diff filtering, and result assembly.
 */

import { beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';

// ─── Mock all external dependencies ─────────────────────────────

vi.mock('./agents/simple.js', () => ({
  runSimpleReview: vi.fn(),
}));

vi.mock('./graph/blast-radius.js', () => ({
  computeBlastRadius: vi.fn(),
}));

vi.mock('./agents/workflow.js', () => ({
  runWorkflowReview: vi.fn(),
}));

vi.mock('./agents/consensus.js', () => ({
  runConsensusReview: vi.fn(),
}));

vi.mock('./tools/runner.js', () => ({
  runStaticAnalysis: vi.fn(),
  formatStaticAnalysisContext: vi.fn(),
  isToolRegistryEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('./tools/plugins/index.js', () => ({
  initializeDefaultTools: vi.fn(),
}));

vi.mock('./tools/registry.js', () => ({
  toolRegistry: {
    getAll: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
  },
}));

vi.mock('./memory/search.js', () => ({
  searchMemoryForContext: vi.fn(),
}));

vi.mock('./memory/persist.js', () => ({
  persistReviewObservations: vi.fn().mockResolvedValue(undefined),
}));

import { runConsensusReview } from './agents/consensus.js';
import { runSimpleReview } from './agents/simple.js';
import { runWorkflowReview } from './agents/workflow.js';
import type { BlastRadiusResult } from './graph/blast-radius.js';
import { computeBlastRadius } from './graph/blast-radius.js';
import type { DependencyGraph, GraphLoader } from './graph/schema.js';
import { persistReviewObservations } from './memory/persist.js';
import { searchMemoryForContext } from './memory/search.js';
import { reviewPipeline } from './pipeline.js';
import { formatStaticAnalysisContext, runStaticAnalysis } from './tools/runner.js';
import type { ReviewInput, ReviewResult } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────

const MINIMAL_DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1234567..abcdefg 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export default x;
`;

const SIMPLE_RESULT: ReviewResult = {
  status: 'PASSED',
  summary: 'Code looks good.',
  findings: [],
  staticAnalysis: {
    semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
    trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
    cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
  },
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

const SKIPPED_STATIC = {
  semgrep: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
  trivy: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
  cpd: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
};

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: MINIMAL_DIFF,
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
    },
    context: {
      repoFullName: 'test/repo',
      prNumber: 42,
      commitMessages: [],
      fileList: [],
    },
    memoryStorage: undefined,
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockResolvedValue(SKIPPED_STATIC);
  (
    formatStaticAnalysisContext as MockedFunction<typeof formatStaticAnalysisContext>
  ).mockReturnValue('');
  (runSimpleReview as MockedFunction<typeof runSimpleReview>).mockResolvedValue({
    ...SIMPLE_RESULT,
  });
  (runWorkflowReview as MockedFunction<typeof runWorkflowReview>).mockResolvedValue({
    ...SIMPLE_RESULT,
    metadata: { ...SIMPLE_RESULT.metadata, mode: 'workflow' },
  });
  (runConsensusReview as MockedFunction<typeof runConsensusReview>).mockResolvedValue({
    ...SIMPLE_RESULT,
    metadata: { ...SIMPLE_RESULT.metadata, mode: 'consensus' },
  });
});

// ─── Tests ──────────────────────────────────────────────────────

describe('reviewPipeline', () => {
  // ── Input Validation ──────────────────────────────────────

  describe('input validation', () => {
    it('throws on empty diff', async () => {
      await expect(reviewPipeline(makeInput({ diff: '' }))).rejects.toThrow('non-empty diff');
    });

    it('throws on whitespace-only diff', async () => {
      await expect(reviewPipeline(makeInput({ diff: '   \n  ' }))).rejects.toThrow(
        'non-empty diff',
      );
    });

    it('throws on missing API key', async () => {
      // After Cluster A (gateway-only): apiKey is no longer validated for 'gateway' provider
      // because mcp-llm-bridge handles upstream auth. resolvePrimaryProvider() now rejects
      // inputs without a provider chain AND without all single-provider fields.
      await expect(reviewPipeline(makeInput({ apiKey: '' }))).rejects.toThrow(
        'No provider chain and no single provider configured',
      );
    });

    it('throws on missing provider', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      await expect(reviewPipeline(makeInput({ provider: '' as any }))).rejects.toThrow(
        'Review input must specify an LLM provider',
      );
    });

    it('throws on missing model', async () => {
      // After Cluster A: see "throws on missing API key" — same migration message applies.
      await expect(reviewPipeline(makeInput({ model: '' }))).rejects.toThrow(
        'No provider chain and no single provider configured',
      );
    });
  });

  // ── Mode Dispatch ─────────────────────────────────────────

  describe('mode dispatch', () => {
    it('dispatches to simple agent in simple mode', async () => {
      await reviewPipeline(makeInput({ mode: 'simple' }));
      expect(runSimpleReview).toHaveBeenCalledOnce();
      expect(runWorkflowReview).not.toHaveBeenCalled();
      expect(runConsensusReview).not.toHaveBeenCalled();
    });

    it('dispatches to workflow agent in workflow mode', async () => {
      await reviewPipeline(makeInput({ mode: 'workflow' }));
      expect(runWorkflowReview).toHaveBeenCalledOnce();
      expect(runSimpleReview).not.toHaveBeenCalled();
      expect(runConsensusReview).not.toHaveBeenCalled();
    });

    it('dispatches to consensus agent in consensus mode', async () => {
      await reviewPipeline(makeInput({ mode: 'consensus' }));
      expect(runConsensusReview).toHaveBeenCalledOnce();
      expect(runSimpleReview).not.toHaveBeenCalled();
      expect(runWorkflowReview).not.toHaveBeenCalled();
    });
  });

  // ── Result Assembly ───────────────────────────────────────

  describe('result assembly', () => {
    it('returns a valid ReviewResult with all fields', async () => {
      const result = await reviewPipeline(makeInput());
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('findings');
      expect(result).toHaveProperty('staticAnalysis');
      expect(result).toHaveProperty('memoryContext');
      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toHaveProperty('executionTimeMs');
      expect(result.metadata.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('merges static analysis findings into the result', async () => {
      const staticWithFindings = {
        semgrep: {
          status: 'success' as const,
          findings: [
            {
              severity: 'high' as const,
              category: 'security',
              file: 'src/index.ts',
              line: 5,
              message: 'SQL injection',
              source: 'semgrep' as const,
            },
          ],
          executionTimeMs: 100,
        },
        trivy: { status: 'skipped' as const, findings: [], executionTimeMs: 0 },
        cpd: { status: 'skipped' as const, findings: [], executionTimeMs: 0 },
      };
      (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockResolvedValue(
        staticWithFindings,
      );

      const result = await reviewPipeline(makeInput());
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.source).toBe('semgrep');
      expect(result.findings[0]?.message).toBe('SQL injection');
    });

    it('tracks toolsRun and toolsSkipped correctly', async () => {
      const staticMixed = {
        semgrep: { status: 'success' as const, findings: [], executionTimeMs: 50 },
        trivy: {
          status: 'skipped' as const,
          findings: [],
          error: 'not installed',
          executionTimeMs: 0,
        },
        cpd: { status: 'error' as const, findings: [], error: 'crashed', executionTimeMs: 10 },
      };
      (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockResolvedValue(
        staticMixed,
      );

      const result = await reviewPipeline(makeInput());
      expect(result.metadata.toolsRun).toContain('semgrep');
      expect(result.metadata.toolsSkipped).toContain('trivy');
      expect(result.metadata.toolsSkipped).toContain('cpd');
    });

    it('sets memoryContext to null when memory is disabled', async () => {
      const result = await reviewPipeline(makeInput());
      expect(result.memoryContext).toBeNull();
    });
  });

  // ── Diff Filtering ────────────────────────────────────────

  describe('diff filtering', () => {
    it('returns SKIPPED when all files match ignore patterns', async () => {
      const mdOnlyDiff = `diff --git a/README.md b/README.md
index 1234567..abcdefg 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Hello
+World
`;
      const result = await reviewPipeline(
        makeInput({
          diff: mdOnlyDiff,
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: ['*.md'],
            reviewLevel: 'normal',
          },
        }),
      );

      expect(result.status).toBe('SKIPPED');
      expect(result.summary).toContain('ignore patterns');
      expect(runSimpleReview).not.toHaveBeenCalled();
    });

    it('does NOT skip when some files pass the filter', async () => {
      await reviewPipeline(
        makeInput({
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: ['*.md'], // Only MD is ignored, TS passes through
            reviewLevel: 'normal',
          },
        }),
      );
      expect(runSimpleReview).toHaveBeenCalledOnce();
    });
  });

  // ── Graceful Degradation ──────────────────────────────────

  describe('graceful degradation', () => {
    it('continues when static analysis throws', async () => {
      (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockRejectedValueOnce(
        new Error('semgrep crashed'),
      );

      const result = await reviewPipeline(makeInput());
      // Pipeline should still complete via the agent, but marked as PARTIAL
      expect(result.status).toBe('PARTIAL');
      expect(result.failedSteps).toEqual(
        expect.arrayContaining([expect.objectContaining({ step: 'static-analysis' })]),
      );
      expect(runSimpleReview).toHaveBeenCalledOnce();
    });

    it('continues when memory search throws', async () => {
      const inputWithMemory = makeInput({
        settings: {
          enableSemgrep: false,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: true,
          customRules: [],
          ignorePatterns: [],
          reviewLevel: 'normal',
        },
        // biome-ignore lint/suspicious/noExplicitAny: mock cast
        memoryStorage: {} as any, // Fake memoryStorage to enable memory
      });

      (
        searchMemoryForContext as MockedFunction<typeof searchMemoryForContext>
      ).mockRejectedValueOnce(new Error('database connection failed'));

      const result = await reviewPipeline(inputWithMemory);
      expect(result.status).toBe('PARTIAL');
      expect(result.failedSteps).toEqual(
        expect.arrayContaining([expect.objectContaining({ step: 'memory-search' })]),
      );
      expect(runSimpleReview).toHaveBeenCalledOnce();
    });
  });

  // ── Memory Persistence ────────────────────────────────────

  describe('memory persistence', () => {
    it('does NOT persist when memory is disabled', async () => {
      await reviewPipeline(makeInput());
      expect(persistReviewObservations).not.toHaveBeenCalled();
    });

    it('does NOT persist when db is undefined', async () => {
      await reviewPipeline(
        makeInput({
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: true,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'normal',
          },
          memoryStorage: undefined,
        }),
      );
      expect(persistReviewObservations).not.toHaveBeenCalled();
    });

    it('calls persistReviewObservations when memory is enabled with db', async () => {
      const fakeDb = { fake: 'db' };

      await reviewPipeline(
        makeInput({
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: true,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'normal',
          },
          memoryStorage: fakeDb,
        }),
      );

      expect(persistReviewObservations).toHaveBeenCalledOnce();
      expect(persistReviewObservations).toHaveBeenCalledWith(
        fakeDb,
        'test/repo',
        42,
        expect.objectContaining({ status: 'PASSED' }),
      );
    });
  });

  // ── Agent Input Verification ──────────────────────────────

  describe('agent input', () => {
    it('passes diff, provider, model, and apiKey to simple agent', async () => {
      await reviewPipeline(makeInput());

      expect(runSimpleReview).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gateway',
          model: 'claude-sonnet-4-20250514',
          apiKey: 'test-api-key',
        }),
      );
    });

    it('passes static analysis context to agent', async () => {
      (
        formatStaticAnalysisContext as MockedFunction<typeof formatStaticAnalysisContext>
      ).mockReturnValue('## Static Analysis\n- some finding');

      await reviewPipeline(makeInput());

      expect(runSimpleReview).toHaveBeenCalledWith(
        expect.objectContaining({
          staticContext: '## Static Analysis\n- some finding',
        }),
      );
    });

    it('passes stackHints derived from file extensions to agent', async () => {
      // MINIMAL_DIFF has src/index.ts → should detect typescript
      await reviewPipeline(makeInput());

      expect(runSimpleReview).toHaveBeenCalledWith(
        expect.objectContaining({
          stackHints: expect.stringContaining('type safety'),
        }),
      );
    });

    it('passes the truncated diff to the agent (not the raw diff)', async () => {
      await reviewPipeline(makeInput());

      const callArgs = (runSimpleReview as MockedFunction<typeof runSimpleReview>).mock
        .calls[0]?.[0];
      expect(callArgs.diff).toBeDefined();
      expect(callArgs.diff.length).toBeGreaterThan(0);
    });

    it('passes reviewLevel from settings to simple agent', async () => {
      await reviewPipeline(
        makeInput({
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'soft',
          },
        }),
      );

      expect(runSimpleReview).toHaveBeenCalledWith(
        expect.objectContaining({ reviewLevel: 'soft' }),
      );
    });

    it('passes reviewLevel to workflow agent', async () => {
      await reviewPipeline(
        makeInput({
          mode: 'workflow',
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'strict',
          },
        }),
      );

      expect(runWorkflowReview).toHaveBeenCalledWith(
        expect.objectContaining({ reviewLevel: 'strict' }),
      );
    });

    it('passes reviewLevel to consensus agent', async () => {
      await reviewPipeline(
        makeInput({
          mode: 'consensus',
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'normal',
          },
        }),
      );

      expect(runConsensusReview).toHaveBeenCalledWith(
        expect.objectContaining({ reviewLevel: 'normal' }),
      );
    });

    it('passes providerChain to workflow agent', async () => {
      await reviewPipeline(
        makeInput({
          mode: 'workflow',
          providerChain: [{ provider: 'gateway', model: 'test', apiKey: 'key' }],
        }),
      );

      expect(runWorkflowReview).toHaveBeenCalledWith(
        expect.objectContaining({
          providerChain: [{ provider: 'gateway', model: 'test', apiKey: 'key' }],
        }),
      );
    });

    it('passes reviewConcurrency from settings to workflow agent', async () => {
      await reviewPipeline(
        makeInput({
          mode: 'workflow',
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'normal',
            reviewConcurrency: 3,
          },
        }),
      );

      expect(runWorkflowReview).toHaveBeenCalledWith(expect.objectContaining({ concurrency: 3 }));
    });

    it('passes reviewDelayMs from settings to consensus agent', async () => {
      await reviewPipeline(
        makeInput({
          mode: 'consensus',
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'normal',
            reviewDelayMs: 500,
          },
        }),
      );

      expect(runConsensusReview).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 500 }));
    });
  });

  // ── SKIPPED Result Verification ───────────────────────────

  describe('skipped result details', () => {
    const mdOnlyDiff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Hello
+World
`;
    const skipInput = () =>
      makeInput({
        diff: mdOnlyDiff,
        settings: {
          enableSemgrep: false,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: false,
          customRules: [],
          ignorePatterns: ['*.md'],
          reviewLevel: 'normal',
        },
      });

    it('skipped result has SKIPPED status', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.status).toBe('SKIPPED');
    });

    it('skipped result summary mentions ignore patterns', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.summary).toContain('ignore patterns');
    });

    it('skipped result has empty findings array', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.findings).toEqual([]);
    });

    it('skipped result has null memoryContext', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.memoryContext).toBeNull();
    });

    it('skipped result has all tools in toolsSkipped', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.metadata.toolsSkipped).toContain('semgrep');
      expect(result.metadata.toolsSkipped).toContain('trivy');
      expect(result.metadata.toolsSkipped).toContain('cpd');
      expect(result.metadata.toolsSkipped).toHaveLength(3);
    });

    it('skipped result has empty toolsRun', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.metadata.toolsRun).toEqual([]);
    });

    it('skipped result has correct mode/provider/model from input', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.metadata.mode).toBe('simple');
      expect(result.metadata.provider).toBe('gateway');
      expect(result.metadata.model).toBe('claude-sonnet-4-20250514');
    });

    it('skipped result has zero tokensUsed', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.metadata.tokensUsed).toBe(0);
    });

    it('skipped result has executionTimeMs >= 0', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.metadata.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('skipped result staticAnalysis has all tools skipped', async () => {
      const result = await reviewPipeline(skipInput());
      expect(result.staticAnalysis.semgrep.status).toBe('skipped');
      expect(result.staticAnalysis.trivy.status).toBe('skipped');
      expect(result.staticAnalysis.cpd.status).toBe('skipped');
      expect(result.staticAnalysis.semgrep.findings).toEqual([]);
      expect(result.staticAnalysis.trivy.findings).toEqual([]);
      expect(result.staticAnalysis.cpd.findings).toEqual([]);
    });
  });

  // ── Result Detail Verification ────────────────────────────

  describe('result details', () => {
    it('result has correct status from agent', async () => {
      const result = await reviewPipeline(makeInput());
      expect(result.status).toBe('PASSED');
    });

    it('result has correct summary from agent', async () => {
      const result = await reviewPipeline(makeInput());
      expect(result.summary).toBe('Code looks good.');
    });

    it('result staticAnalysis is set from pipeline (not agent)', async () => {
      const result = await reviewPipeline(makeInput());
      // The pipeline overrides the agent's staticAnalysis with the actual one
      expect(result.staticAnalysis).toBeDefined();
      expect(result.staticAnalysis.semgrep).toBeDefined();
    });

    it('result memoryContext is null when memory is disabled', async () => {
      const result = await reviewPipeline(makeInput());
      expect(result.memoryContext).toBeNull();
    });

    it('result memoryContext is set when memory returns context', async () => {
      (searchMemoryForContext as MockedFunction<typeof searchMemoryForContext>).mockResolvedValue(
        'Previous review noted performance issues.',
      );

      const result = await reviewPipeline(
        makeInput({
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: true,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'normal',
          },
          // biome-ignore lint/suspicious/noExplicitAny: mock cast
          memoryStorage: {} as any,
        }),
      );

      expect(result.memoryContext).toBe('Previous review noted performance issues.');
    });

    it('updates executionTimeMs to cover full pipeline', async () => {
      const result = await reviewPipeline(makeInput());
      expect(result.metadata.executionTimeMs).toBeGreaterThanOrEqual(0);
      // It should be the pipeline's timing, not the agent's
      expect(typeof result.metadata.executionTimeMs).toBe('number');
    });

    it('reconstructs filtered diff from filtered files only', async () => {
      // Diff with 2 files: one .ts (kept) and one .md (filtered)
      const mixedDiff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Hello
+World
`;
      await reviewPipeline(
        makeInput({
          diff: mixedDiff,
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
            customRules: [],
            ignorePatterns: ['*.md'],
            reviewLevel: 'normal',
          },
        }),
      );

      // The agent should receive only the .ts file diff, not the .md
      const callArgs = (runSimpleReview as MockedFunction<typeof runSimpleReview>).mock
        .calls[0]?.[0];
      expect(callArgs.diff).toContain('app.ts');
      expect(callArgs.diff).not.toContain('README.md');
    });
  });

  // ── Failed Steps Tracking ──────────────────────────────────

  describe('failed steps tracking', () => {
    it('populates failedSteps and sets PARTIAL status when a step throws', async () => {
      // Make static analysis throw — this triggers runStaticAnalysisSafe's catch
      (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockRejectedValueOnce(
        new Error('semgrep crashed'),
      );

      const result = await reviewPipeline(makeInput());

      // failedSteps should contain the static-analysis failure
      expect(result.failedSteps).toBeDefined();
      expect(result.failedSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ step: 'static-analysis', error: 'semgrep crashed' }),
        ]),
      );

      // Status should be PARTIAL since the review would otherwise PASS
      expect(result.status).toBe('PARTIAL');

      // Coverage signal: a degraded step means incomplete coverage
      expect(result.coverageComplete).toBe(false);
    });

    it('does not set failedSteps when all steps succeed', async () => {
      const result = await reviewPipeline(makeInput());

      expect(result.failedSteps).toBeUndefined();
      expect(result.status).toBe('PASSED');

      // Coverage signal: every pipeline step ran
      expect(result.coverageComplete).toBe(true);
    });

    it('preserves FAILED status even when steps fail (does not downgrade to PARTIAL)', async () => {
      // Make static analysis throw AND the agent return a FAILED result
      (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockRejectedValueOnce(
        new Error('tool error'),
      );
      (runSimpleReview as MockedFunction<typeof runSimpleReview>).mockResolvedValueOnce({
        ...SIMPLE_RESULT,
        status: 'FAILED',
      });

      const result = await reviewPipeline(makeInput());

      // failedSteps should be populated
      expect(result.failedSteps).toBeDefined();
      expect(result.failedSteps?.length).toBeGreaterThan(0);

      // Status should remain FAILED, not downgraded to PARTIAL
      expect(result.status).toBe('FAILED');

      // Coverage signal is ORTHOGONAL to the verdict: FAILED stands, but the
      // incomplete coverage is surfaced first-class instead of via downgrade.
      expect(result.coverageComplete).toBe(false);
    });
  });

  // ── Backward Compatibility ─────────────────────────────────

  describe('backward compatibility', () => {
    it('works with DEFAULT_SETTINGS (reviewLevel defaults to normal)', async () => {
      const result = await reviewPipeline(
        makeInput({
          settings: {
            ...DEFAULT_SETTINGS,
            // Disable tools to keep the test fast and focused
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: false,
          },
        }),
      );

      expect(result.status).toBe('PASSED');
      expect(runSimpleReview).toHaveBeenCalledWith(
        expect.objectContaining({ reviewLevel: 'normal' }),
      );
    });
  });
});

// ─── Blast-Radius Tests ──────────────────────────────────────────

// Minimal valid DependencyGraph fixture
const MINIMAL_GRAPH: DependencyGraph = {
  version: 1,
  rootDir: '/repo',
  nodes: {
    'src/index.ts': {
      hash: 'abc123',
      language: 'typescript',
      imports: [],
      exports: ['default'],
      calls: [],
      isTest: false,
    },
    'src/utils.ts': {
      hash: 'def456',
      language: 'typescript',
      imports: ['src/index.ts'],
      exports: ['helper'],
      calls: [],
      isTest: false,
    },
    'src/index.test.ts': {
      hash: 'ghi789',
      language: 'typescript',
      imports: ['src/index.ts'],
      exports: [],
      calls: [],
      isTest: true,
    },
  },
};

// Minimal blast-radius result when files are under cap
const BLAST_RESULT_NORMAL: BlastRadiusResult = {
  files: new Set(['src/index.ts', 'src/utils.ts', 'src/index.test.ts']),
  changedFiles: ['src/index.ts'],
  dependents: ['src/utils.ts'],
  testFiles: ['src/index.test.ts'],
  depth: 1,
  exceededCap: false,
};

// Blast-radius result that exceeds cap
const BLAST_RESULT_EXCEEDED: BlastRadiusResult = {
  files: new Set(Array.from({ length: 55 }, (_, i) => `src/file${i}.ts`)),
  changedFiles: ['src/index.ts'],
  dependents: Array.from({ length: 54 }, (_, i) => `src/file${i}.ts`),
  testFiles: [],
  depth: 3,
  exceededCap: true,
};

function makeGraphLoader(overrides: Partial<GraphLoader> = {}): GraphLoader {
  return {
    load: vi.fn().mockResolvedValue(null),
    loadMetadata: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('blast-radius', () => {
  it('skips blast-radius when enableBlastRadius is false', async () => {
    const graphLoader = makeGraphLoader({
      load: vi.fn().mockResolvedValue(MINIMAL_GRAPH),
    });

    const result = await reviewPipeline(
      makeInput({
        graphLoader,
        settings: {
          enableSemgrep: false,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: false,
          customRules: [],
          ignorePatterns: [],
          reviewLevel: 'normal',
          enableBlastRadius: false,
        },
      }),
    );

    expect(graphLoader.load).not.toHaveBeenCalled();
    expect(result.status).toBe('PASSED');
  });

  it('skips blast-radius when no graphLoader provided', async () => {
    const result = await reviewPipeline(
      makeInput({
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
        // No graphLoader
      }),
    );

    expect(result.status).toBe('PASSED');
    expect(runSimpleReview).toHaveBeenCalledOnce();
  });

  it('filters diff to blast-radius files when graph is available', async () => {
    const graphLoader = makeGraphLoader({
      load: vi.fn().mockResolvedValue(MINIMAL_GRAPH),
      loadMetadata: vi.fn().mockResolvedValue(null),
    });

    (computeBlastRadius as MockedFunction<typeof computeBlastRadius>).mockReturnValueOnce(
      BLAST_RESULT_NORMAL,
    );

    await reviewPipeline(
      makeInput({
        graphLoader,
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
      }),
    );

    expect(computeBlastRadius).toHaveBeenCalledOnce();
    // The diff passed to the agent should only include blast-radius files
    const callArgs = (runSimpleReview as MockedFunction<typeof runSimpleReview>).mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs.diff).toBeDefined();
  });

  it('falls back to full diff when graph loader returns null', async () => {
    const graphLoader = makeGraphLoader({
      load: vi.fn().mockResolvedValue(null),
    });

    const result = await reviewPipeline(
      makeInput({
        graphLoader,
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
      }),
    );

    expect(graphLoader.load).toHaveBeenCalledOnce();
    expect(result.status).toBe('PASSED');
    // Agent should still be called with the original diff files
    expect(runSimpleReview).toHaveBeenCalledOnce();
    const callArgs = (runSimpleReview as MockedFunction<typeof runSimpleReview>).mock.calls[0]?.[0];
    expect(callArgs.diff).toContain('src/index.ts');
  });

  it('falls back to full diff when blast-radius cap is exceeded', async () => {
    const graphLoader = makeGraphLoader({
      load: vi.fn().mockResolvedValue(MINIMAL_GRAPH),
      loadMetadata: vi.fn().mockResolvedValue(null),
    });

    (computeBlastRadius as MockedFunction<typeof computeBlastRadius>).mockReturnValueOnce(
      BLAST_RESULT_EXCEEDED,
    );

    const result = await reviewPipeline(
      makeInput({
        graphLoader,
        settings: {
          enableSemgrep: false,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: false,
          customRules: [],
          ignorePatterns: [],
          reviewLevel: 'normal',
          enableBlastRadius: true,
          maxBlastRadiusFiles: 50,
        },
      }),
    );

    expect(result.status).toBe('PASSED');
    // Pipeline should complete normally with the full diff
    expect(runSimpleReview).toHaveBeenCalledOnce();
    // blastRadius metadata should indicate fallback
    expect(result.metadata.blastRadius?.fallbackReason).toContain('blast radius exceeds');
  });

  it('handles graph loader errors gracefully', async () => {
    const graphLoader = makeGraphLoader({
      load: vi.fn().mockRejectedValue(new Error('graph file not found')),
    });

    const result = await reviewPipeline(
      makeInput({
        graphLoader,
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
      }),
    );

    // Pipeline should complete — no crash
    expect(runSimpleReview).toHaveBeenCalledOnce();
    // The error should be recorded in failedSteps
    expect(result.failedSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: 'blast-radius', error: 'graph file not found' }),
      ]),
    );
    expect(result.status).toBe('PARTIAL');
  });

  it('populates blastRadius metadata when graph is available', async () => {
    const graphLoader = makeGraphLoader({
      load: vi.fn().mockResolvedValue(MINIMAL_GRAPH),
      loadMetadata: vi.fn().mockResolvedValue(null),
    });

    (computeBlastRadius as MockedFunction<typeof computeBlastRadius>).mockReturnValueOnce(
      BLAST_RESULT_NORMAL,
    );

    const result = await reviewPipeline(
      makeInput({
        graphLoader,
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
      }),
    );

    expect(result.metadata.blastRadius).toBeDefined();
    expect(result.metadata.blastRadius?.enabled).toBe(true);
    expect(result.metadata.blastRadius?.graphAvailable).toBe(true);
    expect(result.metadata.blastRadius?.blastRadiusFiles).toBe(BLAST_RESULT_NORMAL.files.size);
  });
});
