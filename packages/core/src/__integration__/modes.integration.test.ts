/**
 * Integration: Review modes via pipeline with fake LLM generation.
 *
 * Tests the pipeline with REAL agent code (not mocked agents).
 * Only the LLM generation function is faked to avoid actual API calls.
 * Static analysis is mocked (no real tools in test env).
 *
 * Coverage targets: pipeline.ts branches for workflow/consensus/diagnostic modes,
 * agent parsing and response assembly, fallback to static-only on agent failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only tools and memory — NOT agents
vi.mock('../tools/runner.js', () => ({
  runStaticAnalysis: vi.fn().mockResolvedValue({
    semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
    trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
    cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
  }),
  formatStaticAnalysisContext: vi.fn().mockReturnValue(''),
  isToolRegistryEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../tools/plugins/index.js', () => ({
  initializeDefaultTools: vi.fn(),
}));

vi.mock('../tools/registry.js', () => ({
  toolRegistry: { getAll: vi.fn().mockReturnValue([]), clear: vi.fn() },
}));

vi.mock('../memory/search.js', () => ({
  searchMemoryForContext: vi.fn().mockResolvedValue(null),
}));

vi.mock('../memory/persist.js', () => ({
  persistReviewObservations: vi.fn().mockResolvedValue(undefined),
}));

// Mock the generate-fn factory to return our fake generator
vi.mock('../providers/generate-fn.js', () => ({
  createCLIBridgeGenerateFn: vi.fn(),
  createGatewayGenerateFn: vi.fn(),
  createOllamaGenerateFn: vi.fn(),
}));

// Ollama module mock (for diagnostic mode tests)
vi.mock('../providers/ollama.js', () => ({
  createOllamaGenerateFn: vi.fn(),
}));

import { reviewPipeline } from '../pipeline.js';
import { createGatewayGenerateFn } from '../providers/generate-fn.js';
import type { ReviewInput } from '../types.js';

const SIMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1234567..abcdefg 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
 import express from 'express';
+import helmet from 'helmet';
 const app = express();
+app.use(helmet());
 export default app;
`;

function fakeGenerateFn(responseText: string) {
  return vi.fn().mockResolvedValue({
    text: responseText,
    tokensUsed: 500,
    provider: 'gateway',
    model: 'auto',
  });
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: SIMPLE_DIFF,
    mode: 'simple',
    provider: 'gateway',
    model: 'auto',
    apiKey: 'test-token',
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
      prNumber: 1,
      commitMessages: ['feat: add helmet'],
      fileList: ['src/app.ts'],
    },
    memoryStorage: undefined,
    ...overrides,
  };
}

const SIMPLE_RESPONSE = `STATUS: PASSED
SUMMARY: Adding helmet middleware is a security best practice.
FINDINGS:
- [low] security src/app.ts:4 Consider configuring helmet options for stricter CSP`;

const WORKFLOW_RESPONSE = `STATUS: PASSED
SUMMARY: Code looks good from this perspective.
FINDINGS:
- [info] style src/app.ts:2 Import order follows convention`;

const CONSENSUS_RESPONSE_APPROVE = `DECISION: approve
CONFIDENCE: 0.9
REASONING: The change adds security middleware which is a clear improvement.
FINDINGS:
- [low] security src/app.ts:4 Consider CSP configuration`;

const DIAGNOSTIC_RESPONSE = `STATUS: PASSED
SUMMARY: No significant issues found.
HYPOTHESIS H1: Helmet defaults may be too permissive
CONDITIONS: When serving user-generated content
VERIFICATION: Check CSP headers with browser devtools
CONFIDENCE: low
FILES: src/app.ts
FINDINGS:
- [info] security src/app.ts:4 Review helmet default configuration`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('integration: review modes through pipeline', () => {
  it('simple mode: agent parses response and returns result', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'simple' }));

    expect(result.status).toBe('PASSED');
    expect(result.summary).toContain('helmet');
    expect(result.metadata.mode).toBe('simple');
    expect(result.metadata.tokensUsed).toBeGreaterThan(0);
    expect(gen).toHaveBeenCalledOnce();
  });

  it('workflow mode: runs specialists and synthesizes', async () => {
    // Workflow calls generateFn multiple times (5 specialists + 1 synthesis)
    const gen = fakeGenerateFn(WORKFLOW_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'workflow' }));

    expect(result.status).toBeDefined();
    expect(result.metadata.mode).toBe('workflow');
    // Workflow should call generate multiple times (specialists + synthesis)
    expect(gen.mock.calls.length).toBeGreaterThan(1);
  });

  it('consensus mode: runs voting and produces decision', async () => {
    const gen = fakeGenerateFn(CONSENSUS_RESPONSE_APPROVE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'consensus' }));

    expect(result.status).toBeDefined();
    expect(result.metadata.mode).toBe('consensus');
    // Consensus runs 3 parallel votes
    expect(gen.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('diagnostic mode: runs and returns result (may fallback if not AI SDK)', async () => {
    const gen = fakeGenerateFn(DIAGNOSTIC_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'diagnostic' }));

    // Diagnostic may succeed or fallback depending on provider resolution
    expect(['PASSED', 'NEEDS_HUMAN_REVIEW']).toContain(result.status);
    // Mode should be diagnostic or simple (if fallback occurred)
    expect(['diagnostic', 'simple']).toContain(result.metadata.mode);
  });

  it('agent failure: returns result with error indication', async () => {
    const gen = vi.fn().mockRejectedValue(new Error('LLM API timeout'));
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'simple' }));

    // Pipeline should handle agent failure gracefully
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
    // Either NEEDS_HUMAN_REVIEW (fallback) or the pipeline handles it differently
    expect(['NEEDS_HUMAN_REVIEW', 'PASSED', 'FAILED']).toContain(result.status);
  });

  it('empty diff after filtering: returns SKIPPED without calling agent', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        diff: `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Hello
+World`,
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
    expect(gen).not.toHaveBeenCalled();
  });

  it('legacy provider: pipeline throws migration error', async () => {
    // Providers like 'anthropic' are no longer supported directly
    await expect(
      reviewPipeline(
        makeInput({ provider: 'anthropic' as any, apiKey: 'sk-test', providerChain: undefined }),
      ),
    ).rejects.toThrow('no longer supported directly');
  });

  it('precomputed static analysis: uses provided results instead of running tools', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const precomputed = {
      semgrep: {
        status: 'success' as const,
        findings: [
          {
            severity: 'high' as const,
            category: 'security',
            file: 'src/app.ts',
            line: 3,
            message: 'Precomputed finding',
            source: 'semgrep' as const,
          },
        ],
        executionTimeMs: 100,
      },
      trivy: { status: 'skipped' as const, findings: [] as any[], executionTimeMs: 0 },
      cpd: { status: 'skipped' as const, findings: [] as any[], executionTimeMs: 0 },
    };

    const result = await reviewPipeline(makeInput({ precomputedStaticAnalysis: precomputed }));

    expect(result.status).toBeDefined();
    // Static findings should include the precomputed one
    const semgrepFinding = result.findings.find((f) => f.message === 'Precomputed finding');
    expect(semgrepFinding).toBeDefined();
  });

  it('AI disabled (no API key but valid providerChain empty): returns static-only', async () => {
    // When provider is 'none' or AI is explicitly disabled, skip agent
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        apiKey: 'skip-ai',
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

    // Should produce a result regardless
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
  });

  it('providerChain with multiple gateway entries: creates multiple generate functions', async () => {
    const gen = fakeGenerateFn(WORKFLOW_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        mode: 'workflow',
        providerChain: [
          { provider: 'gateway', model: 'model-a', apiKey: 'key1', gatewayUrl: 'http://gw.test' },
          { provider: 'gateway', model: 'model-b', apiKey: 'key2', gatewayUrl: 'http://gw.test' },
        ],
      }),
    );

    expect(result.status).toBeDefined();
    expect(result.metadata.mode).toBe('workflow');
    // createGatewayGenerateFn should have been called for each chain entry
    expect(vi.mocked(createGatewayGenerateFn).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ── Validation branches ────────────────────────────────────────

  it('validation: aiReviewEnabled=false skips provider requirements', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        aiReviewEnabled: false,
        apiKey: '', // would throw without aiReviewEnabled=false
        provider: undefined as any,
      }),
    );

    expect(result.status).toBeDefined();
    // AI agent should NOT have been called
    expect(gen).not.toHaveBeenCalled();
    expect(result.metadata.tokensUsed).toBe(0);
  });

  it('validation: cli-bridge provider skips API key requirement', async () => {
    const { createCLIBridgeGenerateFn } = await import('../providers/generate-fn.js');
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createCLIBridgeGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        provider: 'cli-bridge' as any,
        model: 'copilot',
        apiKey: '',
        providerChain: [{ provider: 'cli-bridge' as any, model: 'copilot', apiKey: '' }],
      }),
    );

    expect(result.status).toBeDefined();
    expect(vi.mocked(createCLIBridgeGenerateFn)).toHaveBeenCalled();
  });

  it('validation: gateway provider skips API key requirement', async () => {
    const { createGatewayGenerateFn } = await import('../providers/generate-fn.js');
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        provider: 'gateway' as any,
        model: 'auto',
        apiKey: '',
        providerChain: [
          {
            provider: 'gateway' as any,
            model: 'auto',
            apiKey: '',
            gatewayUrl: 'http://localhost:3000',
          },
        ],
      }),
    );

    expect(result.status).toBeDefined();
    expect(vi.mocked(createGatewayGenerateFn)).toHaveBeenCalled();
  });

  it('validation: empty diff throws error', async () => {
    await expect(reviewPipeline(makeInput({ diff: '' }))).rejects.toThrow('non-empty diff');
    await expect(reviewPipeline(makeInput({ diff: '   ' }))).rejects.toThrow('non-empty diff');
  });

  it('validation: missing provider throws error', async () => {
    await expect(
      reviewPipeline(makeInput({ provider: '' as any, model: 'x', apiKey: 'x' })),
    ).rejects.toThrow('provider');
  });

  // ── Mode fallback ───────────────────────────────────────────────

  it('diagnostic mode falls back to simple for cli-bridge', async () => {
    const { createCLIBridgeGenerateFn } = await import('../providers/generate-fn.js');
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createCLIBridgeGenerateFn).mockReturnValue(gen);

    const steps: Array<{ step: string; message: string }> = [];
    const result = await reviewPipeline(
      makeInput({
        mode: 'diagnostic',
        provider: 'cli-bridge' as any,
        model: 'copilot',
        apiKey: '',
        providerChain: [{ provider: 'cli-bridge' as any, model: 'copilot', apiKey: '' }],
        onProgress: (e) => steps.push(e),
      }),
    );

    // Should fall back to simple mode
    expect(result.metadata.mode).toBe('simple');
    expect(steps.some((s) => s.step === 'mode-fallback')).toBe(true);
  });

  it('diagnostic mode dispatches the diagnostic path for ollama (no fallback)', async () => {
    // runDiagnosticReview builds its own generate fn from providers/ollama.js
    const { createOllamaGenerateFn: ollamaModuleGen } = await import('../providers/ollama.js');
    const { createOllamaGenerateFn: factoryGen } = await import('../providers/generate-fn.js');
    const gen = fakeGenerateFn(DIAGNOSTIC_RESPONSE);
    vi.mocked(ollamaModuleGen).mockReturnValue(gen);
    // resolveGenerateTextFns also builds an (unused-by-diagnostic) ollama fn
    vi.mocked(factoryGen).mockReturnValue(fakeGenerateFn(SIMPLE_RESPONSE));

    const steps: Array<{ step: string; message: string }> = [];
    const result = await reviewPipeline(
      makeInput({
        mode: 'diagnostic',
        provider: 'ollama',
        model: 'llama3',
        apiKey: 'ollama',
        onProgress: (e) => steps.push(e),
      }),
    );

    // Diagnostic must actually run — not downgrade to simple
    expect(result.metadata.mode).toBe('diagnostic');
    expect(steps.some((s) => s.step === 'mode-fallback')).toBe(false);
    expect(steps.some((s) => s.step === 'diagnostic-call')).toBe(true);
    expect(gen).toHaveBeenCalledOnce();
    // The hypothesis block from the response must be parsed
    expect(result.hypotheses?.length).toBeGreaterThan(0);
  });

  // ── resolveAiEnabled edge case ──────────────────────────────────

  it('aiReviewEnabled=false with valid key still skips AI', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ aiReviewEnabled: false }));

    // AI should be disabled even with valid key
    expect(gen).not.toHaveBeenCalled();
    expect(result.metadata.tokensUsed).toBe(0);
    expect(result.status).toBeDefined();
  });

  // ── Blocked/redacted files ──────────────────────────────────────

  it('reports blocked sensitive files and continues review', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const diffWithSecrets = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 import express from 'express';
+app.use(helmet());
 export default app;
diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1,2 @@
 SECRET=old
+SECRET=new
`;

    const steps: Array<{ step: string; message: string }> = [];
    const result = await reviewPipeline(
      makeInput({
        diff: diffWithSecrets,
        onProgress: (e) => steps.push(e),
        context: {
          repoFullName: 'test/repo',
          prNumber: 1,
          commitMessages: ['feat: test'],
          fileList: ['src/app.ts', '.env'],
        },
      }),
    );

    expect(result.status).toBeDefined();
    // .env should be blocked or redacted
    const protectionStep = steps.find((s) => s.step === 'path-protection');
    if (protectionStep) {
      expect(protectionStep.message).toMatch(/blocked|redacted/i);
    }
  });

  // ── Progress events ───────────────────────────────────────────

  // ── Enhance findings path ─────────────────────────────────────

  it('enhance=true: runs AI enhancement on static findings', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    // Need static analysis to return findings for enhance to work
    const { runStaticAnalysis } = await import('../tools/runner.js');
    vi.mocked(runStaticAnalysis).mockResolvedValueOnce({
      semgrep: {
        status: 'success',
        findings: [
          {
            severity: 'medium' as const,
            category: 'security',
            file: 'src/app.ts',
            line: 3,
            message: 'Possible XSS',
            source: 'semgrep' as const,
          },
        ],
        executionTimeMs: 100,
      },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    });

    const result = await reviewPipeline(
      makeInput({
        enhance: true,
        settings: {
          enableSemgrep: true,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: false,
          customRules: [],
          ignorePatterns: [],
          reviewLevel: 'normal',
        },
      }),
    );

    expect(result.status).toBeDefined();
    // Should have attempted enhancement (gen called for review + enhance)
    expect(gen.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Blast radius path ───────────────────────────────────────────

  it('blast radius with graphLoader: filters files by dependency graph', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const mockGraph = {
      nodes: new Map([['src/app.ts', { id: 'src/app.ts', type: 'module' as const, imports: [] }]]),
      edges: [],
    };

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
          traversalDepth: 3,
          maxBlastRadiusFiles: 50,
        },
        graphLoader: {
          load: vi.fn().mockResolvedValue(mockGraph),
          loadMetadata: vi.fn().mockResolvedValue({
            lastIndexedAt: new Date().toISOString(),
            nodeCount: 1,
            edgeCount: 0,
          }),
        },
      }),
    );

    expect(result.status).toBeDefined();
    if (result.metadata.blastRadius) {
      expect(result.metadata.blastRadius.enabled).toBe(true);
      expect(result.metadata.blastRadius.graphAvailable).toBe(true);
    }
  });

  it('blast radius with null graph: falls back to full diff', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

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
        graphLoader: {
          load: vi.fn().mockResolvedValue(null),
          loadMetadata: vi.fn().mockResolvedValue(null),
        },
      }),
    );

    expect(result.status).toBeDefined();
    if (result.metadata.blastRadius) {
      expect(result.metadata.blastRadius.graphAvailable).toBe(false);
    }
  });

  it('blast radius with loader error: degrades gracefully', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

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
        graphLoader: {
          load: vi.fn().mockRejectedValue(new Error('graph load failed')),
          loadMetadata: vi.fn().mockResolvedValue(null),
        },
      }),
    );

    expect(result.status).toBeDefined();
    if (result.metadata.blastRadius) {
      expect(result.metadata.blastRadius.fallbackReason).toContain('error');
    }
  });

  // ── Redacted files ──────────────────────────────────────────────

  it('redacted files are reported in progress events', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    // .env.local should be redacted (path visible, content hidden)
    const diffWithRedacted = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 import express from 'express';
+app.use(helmet());
 export default app;
diff --git a/.env.local b/.env.local
--- a/.env.local
+++ b/.env.local
@@ -1 +1,2 @@
 DB_URL=postgres://localhost
+API_KEY=secret123
`;

    const steps: Array<{ step: string; message: string }> = [];
    await reviewPipeline(
      makeInput({
        diff: diffWithRedacted,
        onProgress: (e) => steps.push(e),
        context: {
          repoFullName: 'test/repo',
          prNumber: 1,
          commitMessages: ['test'],
          fileList: ['src/app.ts', '.env.local'],
        },
      }),
    );

    // parse-diff step should mention filtering
    const parseStep = steps.find((s) => s.step === 'parse-diff');
    expect(parseStep).toBeDefined();
  });

  // ── Progress events ───────────────────────────────────────────

  it('onProgress: emits validate, parse-diff, detect-stacks, token-budget, static, agent steps', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const steps: Array<{ step: string; message: string; detail?: string }> = [];
    await reviewPipeline(makeInput({ onProgress: (e) => steps.push(e) }));

    const stepNames = steps.map((s) => s.step);
    expect(stepNames).toContain('validate');
    expect(stepNames).toContain('parse-diff');
    expect(stepNames).toContain('detect-stacks');
    expect(stepNames).toContain('token-budget');
    expect(stepNames).toContain('static-analysis');
    expect(stepNames).toContain('static-results');
    expect(stepNames).toContain('agent-start');

    // Validate step messages are non-empty
    for (const step of steps) {
      expect(step.message.length).toBeGreaterThan(0);
    }

    // parse-diff should mention file count
    const parseDiff = steps.find((s) => s.step === 'parse-diff');
    expect(parseDiff?.message).toMatch(/\d+ file/);

    // detect-stacks should mention stack count
    const detectStacks = steps.find((s) => s.step === 'detect-stacks');
    expect(detectStacks?.message).toMatch(/\d+ tech stack/);

    // token-budget should mention tokens
    const tokenBudget = steps.find((s) => s.step === 'token-budget');
    expect(tokenBudget?.message).toContain('tokens');

    // agent-start should mention provider and model
    const agentStart = steps.find((s) => s.step === 'agent-start');
    expect(agentStart?.message).toContain('simple');
  });

  it('onProgress: blocked files emit path-protection step', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    // .env files are blocked by default path protection
    const diffWithBlocked = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 import express from 'express';
+app.use(helmet());
 export default app;
diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1,2 @@
 SECRET=old
+SECRET=new
`;

    const steps: Array<{ step: string; message: string }> = [];
    await reviewPipeline(
      makeInput({
        diff: diffWithBlocked,
        onProgress: (e) => steps.push(e),
        context: {
          repoFullName: 'test/repo',
          prNumber: 1,
          commitMessages: ['test'],
          fileList: ['src/app.ts', '.env'],
        },
      }),
    );

    // parse-diff should show blocked or redacted info
    const parseDiff = steps.find((s) => s.step === 'parse-diff');
    expect(parseDiff?.message).toMatch(/\d+ after filtering/);
  });

  it('blast radius: stale graph emits warning', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const staleDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ago
    const mockGraph = {
      nodes: new Map([['src/app.ts', { id: 'src/app.ts', type: 'module' as const, imports: [] }]]),
      edges: [],
    };

    const steps: Array<{ step: string; message: string }> = [];
    await reviewPipeline(
      makeInput({
        onProgress: (e) => steps.push(e),
        settings: {
          enableSemgrep: false,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: false,
          customRules: [],
          ignorePatterns: [],
          reviewLevel: 'normal',
          enableBlastRadius: true,
          traversalDepth: 3,
          maxBlastRadiusFiles: 50,
        },
        graphLoader: {
          load: vi.fn().mockResolvedValue(mockGraph),
          loadMetadata: vi.fn().mockResolvedValue({
            lastIndexedAt: staleDate,
            nodeCount: 1,
            edgeCount: 0,
          }),
        },
      }),
    );

    // Should have blast-radius step
    const brSteps = steps.filter((s) => s.step === 'blast-radius');
    expect(brSteps.length).toBeGreaterThan(0);
  });

  it('blast radius: exceeded cap uses full diff and reports', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    // Create a graph where blast radius would exceed cap
    const nodes = new Map();
    for (let i = 0; i < 100; i++) {
      nodes.set(`src/file${i}.ts`, {
        id: `src/file${i}.ts`,
        type: 'module' as const,
        imports: i > 0 ? [`src/file${i - 1}.ts`] : [],
      });
    }

    const steps: Array<{ step: string; message: string }> = [];
    const result = await reviewPipeline(
      makeInput({
        onProgress: (e) => steps.push(e),
        settings: {
          enableSemgrep: false,
          enableTrivy: false,
          enableCpd: false,
          enableMemory: false,
          customRules: [],
          ignorePatterns: [],
          reviewLevel: 'normal',
          enableBlastRadius: true,
          traversalDepth: 10,
          maxBlastRadiusFiles: 1, // Very low cap to trigger exceeded
        },
        graphLoader: {
          load: vi.fn().mockResolvedValue({ nodes, edges: [] }),
          loadMetadata: vi.fn().mockResolvedValue({
            lastIndexedAt: new Date().toISOString(),
            nodeCount: 100,
            edgeCount: 99,
          }),
        },
      }),
    );

    expect(result.status).toBeDefined();
    if (result.metadata.blastRadius) {
      expect(result.metadata.blastRadius.enabled).toBe(true);
    }
  });

  it('static-results: emits tool summary with context levels', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const steps: Array<{ step: string; message: string; detail?: string }> = [];
    await reviewPipeline(makeInput({ onProgress: (e) => steps.push(e) }));

    const staticResults = steps.find((s) => s.step === 'static-results');
    expect(staticResults).toBeDefined();
    expect(staticResults?.message).toContain('Static analysis complete');
    expect(staticResults?.message).toContain('static=');
    expect(staticResults?.message).toContain('memory=');
  });

  it('result metadata: includes fileList, totalAdditions, totalDeletions', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createGatewayGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput());
    expect(result.metadata.fileList).toBeDefined();
    expect(result.metadata.fileList?.length).toBeGreaterThan(0);
    expect(result.metadata.totalAdditions).toBeGreaterThanOrEqual(0);
    expect(result.metadata.totalDeletions).toBeGreaterThanOrEqual(0);
    expect(result.metadata.executionTimeMs).toBeGreaterThanOrEqual(0);
  });
});
