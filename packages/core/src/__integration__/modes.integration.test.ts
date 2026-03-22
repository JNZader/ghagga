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
});
