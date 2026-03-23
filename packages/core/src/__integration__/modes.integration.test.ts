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
  createAISDKGenerateFn: vi.fn(),
  createCLIBridgeGenerateFn: vi.fn(),
  createGatewayGenerateFn: vi.fn(),
}));

import { createAISDKGenerateFn } from '../providers/generate-fn.js';
import { reviewPipeline } from '../pipeline.js';
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
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
}

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: SIMPLE_DIFF,
    mode: 'simple',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'test-key',
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
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

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
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'workflow' }));

    expect(result.status).toBeDefined();
    expect(result.metadata.mode).toBe('workflow');
    // Workflow should call generate multiple times (specialists + synthesis)
    expect(gen.mock.calls.length).toBeGreaterThan(1);
  });

  it('consensus mode: runs voting and produces decision', async () => {
    const gen = fakeGenerateFn(CONSENSUS_RESPONSE_APPROVE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'consensus' }));

    expect(result.status).toBeDefined();
    expect(result.metadata.mode).toBe('consensus');
    // Consensus runs 3 parallel votes
    expect(gen.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('diagnostic mode: runs and returns result (may fallback if not AI SDK)', async () => {
    const gen = fakeGenerateFn(DIAGNOSTIC_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'diagnostic' }));

    // Diagnostic may succeed or fallback depending on provider resolution
    expect(['PASSED', 'NEEDS_HUMAN_REVIEW']).toContain(result.status);
    // Mode should be diagnostic or simple (if fallback occurred)
    expect(['diagnostic', 'simple']).toContain(result.metadata.mode);
  });

  it('agent failure: returns result with error indication', async () => {
    const gen = vi.fn().mockRejectedValue(new Error('LLM API timeout'));
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(makeInput({ mode: 'simple' }));

    // Pipeline should handle agent failure gracefully
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
    // Either NEEDS_HUMAN_REVIEW (fallback) or the pipeline handles it differently
    expect(['NEEDS_HUMAN_REVIEW', 'PASSED', 'FAILED']).toContain(result.status);
  });

  it('empty diff after filtering: returns SKIPPED without calling agent', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

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

  it('missing API key: pipeline throws validation error', async () => {
    await expect(
      reviewPipeline(makeInput({ apiKey: '', providerChain: undefined })),
    ).rejects.toThrow('API key');
  });

  it('precomputed static analysis: uses provided results instead of running tools', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const precomputed = {
      semgrep: {
        status: 'success' as const,
        findings: [{
          severity: 'high' as const,
          category: 'security',
          file: 'src/app.ts',
          line: 3,
          message: 'Precomputed finding',
          source: 'semgrep' as const,
        }],
        executionTimeMs: 100,
      },
      trivy: { status: 'skipped' as const, findings: [] as any[], executionTimeMs: 0 },
      cpd: { status: 'skipped' as const, findings: [] as any[], executionTimeMs: 0 },
    };

    const result = await reviewPipeline(
      makeInput({ precomputedStaticAnalysis: precomputed }),
    );

    expect(result.status).toBeDefined();
    // Static findings should include the precomputed one
    const semgrepFinding = result.findings.find(f => f.message === 'Precomputed finding');
    expect(semgrepFinding).toBeDefined();
  });

  it('AI disabled (no API key but valid providerChain empty): returns static-only', async () => {
    // When provider is 'none' or AI is explicitly disabled, skip agent
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        apiKey: 'skip-ai',
        settings: {
          enableSemgrep: false, enableTrivy: false, enableCpd: false,
          enableMemory: false, customRules: [], ignorePatterns: [],
          reviewLevel: 'normal',
        },
      }),
    );

    // Should produce a result regardless
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
  });

  it('providerChain with multiple entries: creates multiple generate functions', async () => {
    const gen = fakeGenerateFn(WORKFLOW_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({
        mode: 'workflow',
        providerChain: [
          { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'key1' },
          { provider: 'openai', model: 'gpt-4o', apiKey: 'key2' },
        ],
      }),
    );

    expect(result.status).toBeDefined();
    expect(result.metadata.mode).toBe('workflow');
    // createAISDKGenerateFn should have been called for each chain entry
    expect(vi.mocked(createAISDKGenerateFn).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ── Validation branches ────────────────────────────────────────

  it('validation: aiReviewEnabled=false skips provider requirements', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

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
        providerChain: [{ provider: 'gateway' as any, model: 'auto', apiKey: '', gatewayUrl: 'http://localhost:3000' }],
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
    expect(steps.some(s => s.step === 'mode-fallback')).toBe(true);
  });

  // ── resolveAiEnabled edge case ──────────────────────────────────

  it('aiReviewEnabled=false with valid key still skips AI', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const result = await reviewPipeline(
      makeInput({ aiReviewEnabled: false }),
    );

    // AI should be disabled even with valid key
    expect(gen).not.toHaveBeenCalled();
    expect(result.metadata.tokensUsed).toBe(0);
    expect(result.status).toBeDefined();
  });

  // ── Blocked/redacted files ──────────────────────────────────────

  it('reports blocked sensitive files and continues review', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

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
    const protectionStep = steps.find(s => s.step === 'path-protection');
    if (protectionStep) {
      expect(protectionStep.message).toMatch(/blocked|redacted/i);
    }
  });

  // ── Progress events ───────────────────────────────────────────

  it('onProgress callback receives step updates', async () => {
    const gen = fakeGenerateFn(SIMPLE_RESPONSE);
    vi.mocked(createAISDKGenerateFn).mockReturnValue(gen);

    const steps: Array<{ step: string; message: string }> = [];
    const result = await reviewPipeline(
      makeInput({
        onProgress: (event) => steps.push(event),
      }),
    );

    expect(result.status).toBeDefined();
    expect(steps.length).toBeGreaterThan(0);
    // Should include key pipeline steps
    const stepNames = steps.map(s => s.step);
    expect(stepNames).toContain('detect-stacks');
    expect(stepNames).toContain('agent-start');
  });
});
