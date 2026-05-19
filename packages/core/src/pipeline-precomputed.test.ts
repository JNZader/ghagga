/**
 * Pipeline precomputed static analysis tests.
 *
 * Tests the branch in reviewPipeline() Step 5 that checks
 * `input.precomputedStaticAnalysis`:
 *   - When provided → uses precomputed results directly (skips local tools)
 *   - When undefined → runs `runStaticAnalysisSafe()` as before
 *
 * Also verifies that metadata.toolsRun / toolsSkipped are correctly
 * populated from precomputed results.
 */

import { beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';

// ─── Mock all external dependencies ─────────────────────────────

vi.mock('./agents/simple.js', () => ({
  runSimpleReview: vi.fn(),
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

import { runSimpleReview } from './agents/simple.js';
import { reviewPipeline } from './pipeline.js';
import { formatStaticAnalysisContext, runStaticAnalysis } from './tools/runner.js';
import type { ReviewFinding, ReviewInput, ReviewResult, StaticAnalysisResult } from './types.js';

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

const SKIPPED_STATIC: StaticAnalysisResult = {
  semgrep: { status: 'skipped', findings: [], error: 'not installed', executionTimeMs: 0 },
  trivy: { status: 'skipped', findings: [], error: 'not installed', executionTimeMs: 0 },
  cpd: { status: 'skipped', findings: [], error: 'not installed', executionTimeMs: 0 },
};

/** A mock finding from Semgrep, as if precomputed in a runner. */
const PRECOMPUTED_SEMGREP_FINDING: ReviewFinding = {
  severity: 'high',
  category: 'security',
  file: 'src/index.ts',
  line: 10,
  message: 'SQL injection detected (precomputed)',
  source: 'semgrep',
};

/** A mock finding from Trivy, as if precomputed in a runner. */
const PRECOMPUTED_TRIVY_FINDING: ReviewFinding = {
  severity: 'critical',
  category: 'vulnerability',
  file: 'Dockerfile',
  line: 3,
  message: 'Vulnerable base image (precomputed)',
  source: 'trivy',
};

/** Precomputed static analysis results mimicking a GitHub Actions runner. */
const PRECOMPUTED_STATIC: StaticAnalysisResult = {
  semgrep: {
    status: 'success',
    findings: [PRECOMPUTED_SEMGREP_FINDING],
    executionTimeMs: 1200,
  },
  trivy: {
    status: 'success',
    findings: [PRECOMPUTED_TRIVY_FINDING],
    executionTimeMs: 800,
  },
  cpd: {
    status: 'skipped',
    findings: [],
    error: 'CPD not enabled',
    executionTimeMs: 0,
  },
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
});

// ─── Tests ──────────────────────────────────────────────────────

describe('reviewPipeline — precomputed static analysis', () => {
  // ── Test 1: Uses precomputed results when provided ────────

  describe('when precomputedStaticAnalysis is provided', () => {
    it('does NOT call runStaticAnalysis', async () => {
      await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      expect(runStaticAnalysis).not.toHaveBeenCalled();
    });

    it('includes precomputed findings in result.findings', async () => {
      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      // The pipeline merges static findings into result.findings (Step 7)
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'SQL injection detected (precomputed)',
            source: 'semgrep',
          }),
          expect.objectContaining({
            message: 'Vulnerable base image (precomputed)',
            source: 'trivy',
          }),
        ]),
      );
      expect(result.findings).toHaveLength(2);
    });

    it('passes precomputed results to formatStaticAnalysisContext', async () => {
      await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      expect(formatStaticAnalysisContext).toHaveBeenCalledWith(PRECOMPUTED_STATIC);
    });

    it('sets result.staticAnalysis to the precomputed results', async () => {
      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      expect(result.staticAnalysis).toBe(PRECOMPUTED_STATIC);
    });

    it('still runs the agent (LLM review)', async () => {
      await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      expect(runSimpleReview).toHaveBeenCalledOnce();
    });
  });

  // ── Test 2: Runs local tools when precomputed is undefined ─

  describe('when precomputedStaticAnalysis is undefined', () => {
    it('calls runStaticAnalysis for local tool execution', async () => {
      await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: undefined,
        }),
      );

      expect(runStaticAnalysis).toHaveBeenCalledOnce();
    });

    it('calls runStaticAnalysis when field is absent entirely', async () => {
      // makeInput() does NOT set precomputedStaticAnalysis, so it's absent
      await reviewPipeline(makeInput());

      expect(runStaticAnalysis).toHaveBeenCalledOnce();
    });
  });

  // ── Test 3: Metadata reflects precomputed results ─────────

  describe('metadata.toolsRun and metadata.toolsSkipped', () => {
    it('tracks successful precomputed tools in toolsRun', async () => {
      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      // semgrep and trivy have status: 'success'
      expect(result.metadata.toolsRun).toContain('semgrep');
      expect(result.metadata.toolsRun).toContain('trivy');
    });

    it('tracks skipped/errored precomputed tools in toolsSkipped', async () => {
      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      // cpd has status: 'skipped'
      expect(result.metadata.toolsSkipped).toContain('cpd');
    });

    it('does not include skipped tools in toolsRun', async () => {
      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      expect(result.metadata.toolsRun).not.toContain('cpd');
    });

    it('does not include successful tools in toolsSkipped', async () => {
      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
        }),
      );

      expect(result.metadata.toolsSkipped).not.toContain('semgrep');
      expect(result.metadata.toolsSkipped).not.toContain('trivy');
    });

    it('handles all-success precomputed results correctly', async () => {
      const allSuccess: StaticAnalysisResult = {
        semgrep: { status: 'success', findings: [], executionTimeMs: 100 },
        trivy: { status: 'success', findings: [], executionTimeMs: 200 },
        cpd: { status: 'success', findings: [], executionTimeMs: 50 },
      };

      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: allSuccess,
        }),
      );

      expect(result.metadata.toolsRun).toEqual(['semgrep', 'trivy', 'cpd']);
      expect(result.metadata.toolsSkipped).toEqual([]);
    });

    it('handles all-error precomputed results correctly', async () => {
      const allError: StaticAnalysisResult = {
        semgrep: { status: 'error', findings: [], error: 'failed', executionTimeMs: 0 },
        trivy: { status: 'error', findings: [], error: 'failed', executionTimeMs: 0 },
        cpd: { status: 'error', findings: [], error: 'failed', executionTimeMs: 0 },
      };

      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: allError,
        }),
      );

      expect(result.metadata.toolsRun).toEqual([]);
      expect(result.metadata.toolsSkipped).toEqual(['semgrep', 'trivy', 'cpd']);
    });
  });

  // ── Memory search still runs in parallel ──────────────────

  describe('memory search independence', () => {
    it('memory search runs even when precomputed results are provided', async () => {
      const { searchMemoryForContext } = await import('./memory/search.js');
      (searchMemoryForContext as MockedFunction<typeof searchMemoryForContext>).mockResolvedValue(
        'Past review context',
      );

      const result = await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
          settings: {
            enableSemgrep: false,
            enableTrivy: false,
            enableCpd: false,
            enableMemory: true,
            customRules: [],
            ignorePatterns: [],
            reviewLevel: 'normal',
          },
          memoryStorage: {} as unknown,
        }),
      );

      expect(searchMemoryForContext).toHaveBeenCalledOnce();
      expect(result.memoryContext).toBe('Past review context');
    });
  });

  // ── Progress callback reports precomputed mode ────────────

  describe('progress callback', () => {
    it('emits "Using precomputed" message when precomputed results are provided', async () => {
      const onProgress = vi.fn();

      await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: PRECOMPUTED_STATIC,
          onProgress,
        }),
      );

      const staticAnalysisEvent = onProgress.mock.calls.find(
        ([event]: [{ step: string; message: string }]) => event.step === 'static-analysis',
      );
      expect(staticAnalysisEvent).toBeDefined();
      expect(staticAnalysisEvent?.[0].message).toContain('precomputed');
    });

    it('emits "Running" message when no precomputed results', async () => {
      const onProgress = vi.fn();

      await reviewPipeline(
        makeInput({
          precomputedStaticAnalysis: undefined,
          onProgress,
        }),
      );

      const staticAnalysisEvent = onProgress.mock.calls.find(
        ([event]: [{ step: string; message: string }]) => event.step === 'static-analysis',
      );
      expect(staticAnalysisEvent).toBeDefined();
      expect(staticAnalysisEvent?.[0].message).toContain('Running');
    });
  });
});
