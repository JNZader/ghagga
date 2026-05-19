/**
 * Integration: Core Review Pipeline
 *
 * Tests the pipeline orchestrator with mocked AI providers and tools.
 * Verifies the full flow: validate -> parse diff -> detect stacks ->
 * static analysis -> agent execution -> memory -> result assembly.
 *
 * Addresses audit item #13: no tests validating the full review pipeline flow.
 */

import { beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';

// ─── Mock all external dependencies ─────────────────────────────

vi.mock('../agents/simple.js', () => ({
  runSimpleReview: vi.fn(),
}));

vi.mock('../agents/workflow.js', () => ({
  runWorkflowReview: vi.fn(),
}));

vi.mock('../agents/consensus.js', () => ({
  runConsensusReview: vi.fn(),
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

// ─── Imports (after mocks) ──────────────────────────────────────

import { runSimpleReview } from '../agents/simple.js';
import { persistReviewObservations } from '../memory/persist.js';
import { searchMemoryForContext } from '../memory/search.js';
import { reviewPipeline } from '../pipeline.js';
import { formatStaticAnalysisContext, runStaticAnalysis } from '../tools/runner.js';
import type { ReviewInput, ReviewResult } from '../types.js';

// ─── Test Data ──────────────────────────────────────────────────

const REALISTIC_DIFF = `diff --git a/src/services/auth.ts b/src/services/auth.ts
index 1234567..abcdefg 100644
--- a/src/services/auth.ts
+++ b/src/services/auth.ts
@@ -10,6 +10,15 @@ import { hashPassword } from '../utils/crypto.js';
 export class AuthService {
   constructor(private db: Database) {}
 
+  async validateSession(token: string): Promise<User | null> {
+    const session = await this.db.getSession(token);
+    if (!session || session.expiresAt < new Date()) {
+      return null;
+    }
+    return this.db.getUserById(session.userId);
+  }
+
   async login(email: string, password: string): Promise<string> {
     const user = await this.db.getUserByEmail(email);
diff --git a/src/routes/dashboard.ts b/src/routes/dashboard.ts
index 7654321..fedcba9 100644
--- a/src/routes/dashboard.ts
+++ b/src/routes/dashboard.ts
@@ -5,6 +5,12 @@ import { AuthService } from '../services/auth.js';
 
 const router = new Hono();
 
+router.get('/dashboard/profile', async (c) => {
+  const user = c.get('user');
+  const stats = await getStats(user.id);
+  return c.json({ user, stats });
+});
+
 export default router;
`;

const AI_REVIEW_RESULT: ReviewResult = {
  status: 'PASSED',
  summary:
    'New session validation and dashboard profile endpoint look good. Minor suggestions below.',
  findings: [
    {
      severity: 'low',
      category: 'security',
      file: 'src/services/auth.ts',
      line: 13,
      message: 'Consider adding rate limiting to session validation',
      source: 'ai',
    },
  ],
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
    tokensUsed: 1250,
    executionTimeMs: 800,
    toolsRun: [],
    toolsSkipped: [],
  },
};

const STATIC_WITH_FINDINGS = {
  semgrep: {
    status: 'success' as const,
    findings: [
      {
        severity: 'medium' as const,
        category: 'security',
        file: 'src/services/auth.ts',
        line: 14,
        message: 'Potential timing attack in session comparison',
        source: 'semgrep' as const,
      },
    ],
    executionTimeMs: 150,
  },
  trivy: { status: 'skipped' as const, findings: [], executionTimeMs: 0 },
  cpd: { status: 'skipped' as const, findings: [], executionTimeMs: 0 },
};

const _SKIPPED_STATIC = {
  semgrep: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
  trivy: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
  cpd: { status: 'skipped' as const, findings: [], error: 'not installed', executionTimeMs: 0 },
};

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: REALISTIC_DIFF,
    mode: 'simple',
    provider: 'gateway',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-api-key',
    settings: {
      enableSemgrep: true,
      enableTrivy: false,
      enableCpd: false,
      enableMemory: false,
      customRules: [],
      ignorePatterns: [],
      reviewLevel: 'normal',
    },
    context: {
      repoFullName: 'acme/webapp',
      prNumber: 42,
      commitMessages: ['feat: add session validation', 'feat: add profile endpoint'],
      fileList: ['src/services/auth.ts', 'src/routes/dashboard.ts'],
    },
    memoryStorage: undefined,
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: static analysis returns findings
  (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockResolvedValue(
    STATIC_WITH_FINDINGS,
  );
  (
    formatStaticAnalysisContext as MockedFunction<typeof formatStaticAnalysisContext>
  ).mockReturnValue(
    '## Semgrep\n- [medium] Potential timing attack in session comparison (src/services/auth.ts:14)',
  );

  // Default: AI review returns a realistic result
  (runSimpleReview as MockedFunction<typeof runSimpleReview>).mockResolvedValue({
    ...AI_REVIEW_RESULT,
  });
});

// ─── Integration Tests ──────────────────────────────────────────

describe('integration: core review pipeline', () => {
  // S3.1: Full pipeline produces correct ReviewResult shape
  it('S3.1: pipeline produces ReviewResult with AI findings + static findings merged', async () => {
    const result = await reviewPipeline(makeInput());

    // Verify the full result shape
    expect(result.status).toBe('PASSED');
    expect(result.summary).toContain('session validation');

    // AI finding + static finding should both be present
    expect(result.findings.length).toBeGreaterThanOrEqual(2);

    const aiFinding = result.findings.find((f) => f.source === 'ai');
    expect(aiFinding).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    expect(aiFinding!.message).toContain('rate limiting');

    const semgrepFinding = result.findings.find((f) => f.source === 'semgrep');
    expect(semgrepFinding).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    expect(semgrepFinding!.message).toContain('timing attack');

    // Metadata reflects the full pipeline
    expect(result.metadata.mode).toBe('simple');
    expect(result.metadata.provider).toBe('gateway');
    expect(result.metadata.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.toolsRun).toContain('semgrep');

    // Static analysis context was passed to the agent
    expect(runSimpleReview).toHaveBeenCalledWith(
      expect.objectContaining({
        staticContext: expect.stringContaining('Semgrep'),
        provider: 'gateway',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'test-api-key',
      }),
    );

    // Verify the diff was parsed and truncated (agent received non-empty diff)
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const agentArgs = (runSimpleReview as MockedFunction<typeof runSimpleReview>).mock.calls[0]![0];
    expect(agentArgs.diff.length).toBeGreaterThan(0);
    expect(agentArgs.diff).toContain('auth.ts');
  });

  // S3.2: Pipeline with memory enabled calls search and persist
  it('S3.2: pipeline with memory enabled searches and persists observations', async () => {
    const fakeMemoryStorage = {
      searchObservations: vi.fn(),
      saveObservation: vi.fn(),
      createSession: vi.fn(),
      endSession: vi.fn(),
      close: vi.fn(),
      listObservations: vi.fn(),
      getObservation: vi.fn(),
      deleteObservation: vi.fn(),
      getStats: vi.fn(),
      clearObservations: vi.fn(),
    };

    (searchMemoryForContext as MockedFunction<typeof searchMemoryForContext>).mockResolvedValue(
      'Previous review: auth.ts had a SQL injection fixed in PR #30.',
    );

    const result = await reviewPipeline(
      makeInput({
        settings: {
          enableSemgrep: true,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: true,
          customRules: [],
          ignorePatterns: [],
          reviewLevel: 'normal',
        },
        memoryStorage: fakeMemoryStorage,
      }),
    );

    // Memory context should be set on the result
    expect(result.memoryContext).toBe(
      'Previous review: auth.ts had a SQL injection fixed in PR #30.',
    );

    // Memory context was passed to the agent
    expect(runSimpleReview).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryContext: 'Previous review: auth.ts had a SQL injection fixed in PR #30.',
      }),
    );

    // Persist was called after the review
    expect(persistReviewObservations).toHaveBeenCalledOnce();
    expect(persistReviewObservations).toHaveBeenCalledWith(
      fakeMemoryStorage,
      'acme/webapp',
      42,
      expect.objectContaining({ status: 'PASSED' }),
    );
  });

  // S3.3: Pipeline degrades gracefully when static analysis throws
  it('S3.3: pipeline continues with AI review when static analysis throws', async () => {
    (runStaticAnalysis as MockedFunction<typeof runStaticAnalysis>).mockRejectedValue(
      new Error('semgrep binary not found'),
    );

    const result = await reviewPipeline(makeInput());

    // Pipeline completes but marks as PARTIAL due to failed static analysis step
    expect(result.status).toBe('PARTIAL');
    expect(runSimpleReview).toHaveBeenCalledOnce();

    // Static analysis should be in error state
    expect(result.staticAnalysis.semgrep.status).toBe('error');
    expect(result.staticAnalysis.trivy.status).toBe('error');

    // Tools should be recorded as skipped/errored
    expect(result.metadata.toolsSkipped.length).toBeGreaterThan(0);
  });

  // S3.4: Pipeline returns SKIPPED when all files match ignore patterns
  it('S3.4: pipeline returns SKIPPED when all files are filtered by ignore patterns', async () => {
    const mdOnlyDiff = `diff --git a/README.md b/README.md
index 1234567..abcdefg 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Project
+Added contribution guide.
diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1 +1,2 @@
 # Changes
+v1.2.0 - New features
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
    expect(result.findings).toHaveLength(0);
    expect(result.metadata.tokensUsed).toBe(0);

    // Agent should NOT have been called
    expect(runSimpleReview).not.toHaveBeenCalled();
    // Static analysis should NOT have been called
    expect(runStaticAnalysis).not.toHaveBeenCalled();
  });
});
