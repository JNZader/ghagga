import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('../providers/index.js', () => ({
  createModel: vi.fn(() => 'mock-language-model'),
}));

vi.mock('./prompts.js', () => ({
  WORKFLOW_SCOPE_SYSTEM: 'SCOPE_SYSTEM',
  WORKFLOW_STANDARDS_SYSTEM: 'STANDARDS_SYSTEM',
  WORKFLOW_ERRORS_SYSTEM: 'ERRORS_SYSTEM',
  WORKFLOW_SECURITY_SYSTEM: 'SECURITY_SYSTEM',
  WORKFLOW_PERFORMANCE_SYSTEM: 'PERFORMANCE_SYSTEM',
  WORKFLOW_SYNTHESIS_SYSTEM: 'SYNTHESIS_SYSTEM',
  REVIEW_CALIBRATION: 'REVIEW_CALIBRATION_BLOCK',
  COMPACT_CALIBRATION: 'COMPACT_CALIBRATION_BLOCK',
  buildMemoryContext: vi.fn((ctx: string | null) => (ctx ? `MEMORY:${ctx}` : '')),
  buildReviewLevelInstruction: vi.fn((level: string) => `REVIEW_LEVEL:${level}`),
}));

vi.mock('./simple.js', () => ({
  parseReviewResponse: vi.fn(),
}));

import { generateText } from 'ai';
import { createModel } from '../providers/index.js';
import type { ReviewResult } from '../types.js';
import { parseReviewResponse } from './simple.js';
import type { WorkflowReviewInput } from './workflow.js';
import { runWorkflowReview } from './workflow.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockGenerateText = vi.mocked(generateText);
const mockCreateModel = vi.mocked(createModel);
const mockParseReviewResponse = vi.mocked(parseReviewResponse);

function makeInput(overrides: Partial<WorkflowReviewInput> = {}): WorkflowReviewInput {
  return {
    diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old\n+new',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    apiKey: 'sk-test-key',
    staticContext: '',
    memoryContext: null,
    stackHints: '',
    reviewLevel: 'normal' as const,
    ...overrides,
  };
}

function makeSpecialistResult(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    text,
    usage: { inputTokens, outputTokens },
  };
}

function makeParsedResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    status: 'PASSED',
    summary: 'Synthesis summary.',
    findings: [],
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext: null,
    metadata: {
      mode: 'simple',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 0,
      executionTimeMs: 0,
      toolsRun: [],
      toolsSkipped: [],
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runWorkflowReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: all generateText calls succeed
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    mockGenerateText.mockResolvedValue(makeSpecialistResult('Specialist output') as any);

    // Default: parseReviewResponse returns a valid result
    mockParseReviewResponse.mockReturnValue(makeParsedResult());
  });

  // ── Model creation ──

  it('creates the language model with the correct provider, model, and apiKey', async () => {
    await runWorkflowReview(
      makeInput({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-openai-key',
      }),
    );

    expect(mockCreateModel).toHaveBeenCalledWith('openai', 'gpt-4o', 'sk-openai-key');
  });

  it('creates one model instance per specialist + one for synthesis (6 total)', async () => {
    await runWorkflowReview(makeInput());

    // 5 specialists + 1 synthesis = 6 createModel calls
    expect(mockCreateModel).toHaveBeenCalledTimes(6);
  });

  // ── Specialist calls ──

  it('makes exactly 5 specialist calls + 1 synthesis call (6 total)', async () => {
    await runWorkflowReview(makeInput());

    expect(mockGenerateText).toHaveBeenCalledTimes(6);
  });

  it('calls all 5 specialists with temperature 0.3 and the diff', async () => {
    const input = makeInput({ diff: 'my-diff-content' });
    await runWorkflowReview(input);

    // First 5 calls are specialists
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const call = mockGenerateText.mock.calls[i]?.[0] as any;
      expect(call.temperature).toBe(0.3);
      expect(call.prompt).toContain('my-diff-content');
    }
  });

  // ── Context isolation per specialist ──

  it('gives security specialist staticContext only', async () => {
    const input = makeInput({
      staticContext: 'STATIC_CONTEXT_DATA',
      memoryContext: 'MEMORY_DATA',
      stackHints: 'STACK_HINTS_DATA',
    });
    await runWorkflowReview(input);

    // Specialists order: scope(0), standards(1), errors(2), security(3), performance(4)
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const securityCall = mockGenerateText.mock.calls[3]?.[0] as any;
    expect(securityCall.system).toContain('STATIC_CONTEXT_DATA');
    expect(securityCall.system).not.toContain('STACK_HINTS_DATA');
    expect(securityCall.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  it('gives performance specialist stackHints only', async () => {
    const input = makeInput({
      staticContext: 'STATIC_CONTEXT_DATA',
      memoryContext: 'MEMORY_DATA',
      stackHints: 'STACK_HINTS_DATA',
    });
    await runWorkflowReview(input);

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const perfCall = mockGenerateText.mock.calls[4]?.[0] as any;
    expect(perfCall.system).toContain('STACK_HINTS_DATA');
    expect(perfCall.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(perfCall.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  it('gives scope specialist memoryContext only', async () => {
    const input = makeInput({
      staticContext: 'STATIC_CONTEXT_DATA',
      memoryContext: 'MEMORY_DATA',
      stackHints: 'STACK_HINTS_DATA',
    });
    await runWorkflowReview(input);

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const scopeCall = mockGenerateText.mock.calls[0]?.[0] as any;
    expect(scopeCall.system).toContain('MEMORY:MEMORY_DATA');
    expect(scopeCall.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(scopeCall.system).not.toContain('STACK_HINTS_DATA');
  });

  it('gives standards specialist stackHints only', async () => {
    const input = makeInput({
      staticContext: 'STATIC_CONTEXT_DATA',
      memoryContext: 'MEMORY_DATA',
      stackHints: 'STACK_HINTS_DATA',
    });
    await runWorkflowReview(input);

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const standardsCall = mockGenerateText.mock.calls[1]?.[0] as any;
    expect(standardsCall.system).toContain('STACK_HINTS_DATA');
    expect(standardsCall.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(standardsCall.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  it('gives error handling specialist no extra context (minimal)', async () => {
    const input = makeInput({
      staticContext: 'STATIC_CONTEXT_DATA',
      memoryContext: 'MEMORY_DATA',
      stackHints: 'STACK_HINTS_DATA',
    });
    await runWorkflowReview(input);

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const errorsCall = mockGenerateText.mock.calls[2]?.[0] as any;
    expect(errorsCall.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(errorsCall.system).not.toContain('STACK_HINTS_DATA');
    expect(errorsCall.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  // ── Synthesis call ──

  it('passes SYNTHESIS_SYSTEM with review-level and calibration in system prompt for the 6th call', async () => {
    await runWorkflowReview(makeInput());

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const synthesisCall = mockGenerateText.mock.calls[5]?.[0] as any;
    expect(synthesisCall.system).toContain('SYNTHESIS_SYSTEM');
    expect(synthesisCall.system).toContain('REVIEW_LEVEL:normal');
    expect(synthesisCall.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(synthesisCall.temperature).toBe(0.3);
  });

  it('includes all specialist outputs in the synthesis prompt', async () => {
    // Make each specialist return different text
    mockGenerateText
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Scope output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Standards output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Errors output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Security output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Performance output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Synthesis final') as any);

    await runWorkflowReview(makeInput());

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const synthesisCall = mockGenerateText.mock.calls[5]?.[0] as any;
    expect(synthesisCall.prompt).toContain('Scope output');
    expect(synthesisCall.prompt).toContain('Standards output');
    expect(synthesisCall.prompt).toContain('Errors output');
    expect(synthesisCall.prompt).toContain('Security output');
    expect(synthesisCall.prompt).toContain('Performance output');
  });

  // ── Failed specialists ──

  it('includes [FAILED] marker in synthesis prompt when a specialist fails', async () => {
    mockGenerateText
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Scope output') as any)
      .mockRejectedValueOnce(new Error('Standards LLM timeout'))
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Errors output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Security output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Performance output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Synthesis final') as any);

    await runWorkflowReview(makeInput());

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const synthesisCall = mockGenerateText.mock.calls[5]?.[0] as any;
    expect(synthesisCall.prompt).toContain('[FAILED]');
    expect(synthesisCall.prompt).toContain('Standards LLM timeout');
  });

  it('still produces a result when some specialists fail', async () => {
    mockGenerateText
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Errors output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Security output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Performance output') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Synthesis final') as any);

    const result = await runWorkflowReview(makeInput());

    expect(result).toBeDefined();
    expect(result.metadata.mode).toBe('workflow');
  });

  // ── Token counting ──

  it('aggregates tokens from all successful specialists and synthesis', async () => {
    mockGenerateText
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s1', 100, 50) as any) // 150
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s2', 200, 100) as any) // 300
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s3', 150, 75) as any) // 225
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s4', 180, 90) as any) // 270
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s5', 120, 60) as any) // 180
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('syn', 300, 200) as any); // 500

    await runWorkflowReview(makeInput());

    // Total: 150 + 300 + 225 + 270 + 180 + 500 = 1625
    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      'syn',
      'anthropic',
      'claude-sonnet-4-20250514',
      1625,
      expect.any(Number),
      null,
    );
  });

  it('does not count tokens from failed specialists', async () => {
    mockGenerateText
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s1', 100, 50) as any) // 150
      .mockRejectedValueOnce(new Error('fail')) // 0
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s3', 100, 50) as any) // 150
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s4', 100, 50) as any) // 150
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s5', 100, 50) as any) // 150
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('syn', 100, 50) as any); // 150

    await runWorkflowReview(makeInput());

    // Total: 150*4 + 150 = 750
    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      750,
      expect.any(Number),
      null,
    );
  });

  it('handles missing usage gracefully (defaults to 0)', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'output',
      usage: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
    } as any);

    await runWorkflowReview(makeInput());

    // All 6 calls contribute 0 tokens
    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      0,
      expect.any(Number),
      null,
    );
  });

  // ── parseReviewResponse integration ──

  it('calls parseReviewResponse with synthesis text output', async () => {
    mockGenerateText
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s1') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s2') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s3') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s4') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s5') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('Final synthesis text') as any);

    await runWorkflowReview(makeInput());

    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      'Final synthesis text',
      'anthropic',
      'claude-sonnet-4-20250514',
      expect.any(Number),
      expect.any(Number),
      null,
    );
  });

  it('passes memoryContext to parseReviewResponse', async () => {
    await runWorkflowReview(makeInput({ memoryContext: 'some-memory' }));

    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      'some-memory',
    );
  });

  // ── Metadata override ──

  it('overrides metadata.mode to "workflow"', async () => {
    mockParseReviewResponse.mockReturnValue(
      makeParsedResult({
        metadata: {
          mode: 'simple',
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          tokensUsed: 100,
          executionTimeMs: 500,
          toolsRun: [],
          toolsSkipped: [],
        },
      }),
    );

    const result = await runWorkflowReview(makeInput());

    expect(result.metadata.mode).toBe('workflow');
  });

  // ── Progress callbacks ──

  it('calls onProgress for workflow-start', async () => {
    const onProgress = vi.fn();
    await runWorkflowReview(makeInput({ onProgress }));

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'workflow-start',
        message: expect.stringContaining('5'),
      }),
    );
  });

  it('calls onProgress for each successful specialist with token count', async () => {
    const onProgress = vi.fn();
    mockGenerateText
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('scope', 50, 50) as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('standards', 50, 50) as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('errors', 50, 50) as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('security', 50, 50) as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('perf', 50, 50) as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('synthesis') as any);

    await runWorkflowReview(makeInput({ onProgress }));

    // Should have specialist progress events with ✓
    const specialistCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✓'),
    );
    expect(specialistCalls).toHaveLength(5);
  });

  it('calls onProgress for failed specialists with ✗', async () => {
    const onProgress = vi.fn();
    mockGenerateText
      .mockRejectedValueOnce(new Error('boom'))
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s2') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s3') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s4') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('s5') as any)
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      .mockResolvedValueOnce(makeSpecialistResult('syn') as any);

    await runWorkflowReview(makeInput({ onProgress }));

    const failedCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✗'),
    );
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]?.[0].message).toContain('FAILED');
  });

  it('calls onProgress for workflow-synthesis step', async () => {
    const onProgress = vi.fn();
    await runWorkflowReview(makeInput({ onProgress }));

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'workflow-synthesis',
        message: expect.stringContaining('Synthesizing'),
      }),
    );
  });

  it('does not throw when onProgress is not provided', async () => {
    await expect(runWorkflowReview(makeInput({ onProgress: undefined }))).resolves.toBeDefined();
  });

  // ── Multi-provider chain distribution ──

  it('distributes 5 specialists round-robin across a 3-entry chain', async () => {
    const chain = [
      { provider: 'anthropic' as const, model: 'claude-sonnet-4-20250514', apiKey: 'key-a' },
      { provider: 'openai' as const, model: 'gpt-4o', apiKey: 'key-b' },
      { provider: 'google' as const, model: 'gemini-2.0-flash', apiKey: 'key-c' },
    ];
    await runWorkflowReview(makeInput({ providerChain: chain }));

    // Specialist 0 (scope)       → chain[0] = anthropic/claude-sonnet-4-20250514
    // Specialist 1 (standards)   → chain[1] = openai/gpt-4o
    // Specialist 2 (errors)      → chain[2] = google/gemini-2.0-flash
    // Specialist 3 (security)    → chain[0] = anthropic/claude-sonnet-4-20250514 (wraps)
    // Specialist 4 (performance) → chain[1] = openai/gpt-4o (wraps)
    expect(mockCreateModel).toHaveBeenNthCalledWith(
      1,
      'anthropic',
      'claude-sonnet-4-20250514',
      'key-a',
    );
    expect(mockCreateModel).toHaveBeenNthCalledWith(2, 'openai', 'gpt-4o', 'key-b');
    expect(mockCreateModel).toHaveBeenNthCalledWith(3, 'google', 'gemini-2.0-flash', 'key-c');
    expect(mockCreateModel).toHaveBeenNthCalledWith(
      4,
      'anthropic',
      'claude-sonnet-4-20250514',
      'key-a',
    );
    expect(mockCreateModel).toHaveBeenNthCalledWith(5, 'openai', 'gpt-4o', 'key-b');
    // Synthesis (call 6) always uses chain[0] = primary
    expect(mockCreateModel).toHaveBeenNthCalledWith(
      6,
      'anthropic',
      'claude-sonnet-4-20250514',
      'key-a',
    );
  });

  it('synthesis always uses chain[0] (primary) regardless of chain length', async () => {
    const chain = [
      { provider: 'openai' as const, model: 'gpt-4o', apiKey: 'key-primary' },
      { provider: 'google' as const, model: 'gemini-2.0-flash', apiKey: 'key-secondary' },
    ];
    await runWorkflowReview(makeInput({ providerChain: chain }));

    // 6th createModel call is synthesis — must be chain[0]
    expect(mockCreateModel).toHaveBeenNthCalledWith(6, 'openai', 'gpt-4o', 'key-primary');
  });

  it('falls back to flat provider/model/apiKey when providerChain is undefined', async () => {
    await runWorkflowReview(
      makeInput({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-flat',
        providerChain: undefined,
      }),
    );

    // All 6 calls use the flat fields
    expect(mockCreateModel).toHaveBeenCalledTimes(6);
    for (let i = 1; i <= 6; i++) {
      expect(mockCreateModel).toHaveBeenNthCalledWith(
        i,
        'anthropic',
        'claude-sonnet-4-20250514',
        'sk-flat',
      );
    }
  });

  it('falls back to flat provider/model/apiKey when providerChain is empty', async () => {
    await runWorkflowReview(
      makeInput({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-flat', providerChain: [] }),
    );

    expect(mockCreateModel).toHaveBeenCalledTimes(6);
    for (let i = 1; i <= 6; i++) {
      expect(mockCreateModel).toHaveBeenNthCalledWith(i, 'openai', 'gpt-4o', 'sk-flat');
    }
  });

  it('uses single-entry chain for all specialists and synthesis', async () => {
    const chain = [{ provider: 'google' as const, model: 'gemini-2.0-flash', apiKey: 'key-only' }];
    await runWorkflowReview(makeInput({ providerChain: chain }));

    expect(mockCreateModel).toHaveBeenCalledTimes(6);
    for (let i = 1; i <= 6; i++) {
      expect(mockCreateModel).toHaveBeenNthCalledWith(i, 'google', 'gemini-2.0-flash', 'key-only');
    }
  });

  it('includes provider/model in progress message for each specialist when chain is set', async () => {
    const chain = [
      { provider: 'anthropic' as const, model: 'claude-sonnet-4-20250514', apiKey: 'ka' },
      { provider: 'openai' as const, model: 'gpt-4o', apiKey: 'kb' },
    ];
    const onProgress = vi.fn();
    await runWorkflowReview(makeInput({ providerChain: chain, onProgress }));

    const specialistCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✓'),
    );
    // First specialist message should mention chain[0]'s model
    expect(specialistCalls[0]?.[0].message).toContain('anthropic/claude-sonnet-4-20250514');
    // Second specialist message should mention chain[1]'s model
    expect(specialistCalls[1]?.[0].message).toContain('openai/gpt-4o');
  });

  it('records modelsUsed in metadata with specialist:provider/model format', async () => {
    const chain = [
      { provider: 'anthropic' as const, model: 'claude-sonnet-4-20250514', apiKey: 'ka' },
      { provider: 'openai' as const, model: 'gpt-4o', apiKey: 'kb' },
    ];
    const parsed = makeParsedResult();
    mockParseReviewResponse.mockReturnValue(parsed);

    const result = await runWorkflowReview(makeInput({ providerChain: chain }));

    // modelsUsed is set directly on the returned result's metadata
    expect(result.metadata.modelsUsed).toBeDefined();
    expect(result.metadata.modelsUsed).toHaveLength(5);
    // Specialist 0 (scope-analysis) → chain[0]
    expect(result.metadata.modelsUsed?.[0]).toBe(
      'scope-analysis:anthropic/claude-sonnet-4-20250514',
    );
    // Specialist 1 (coding-standards) → chain[1]
    expect(result.metadata.modelsUsed?.[1]).toBe('coding-standards:openai/gpt-4o');
  });

  // ── Review level & calibration injection ──

  it('includes review-level instruction in ALL specialist system prompts', async () => {
    await runWorkflowReview(makeInput({ reviewLevel: 'soft' }));

    // All 5 specialist calls should contain the review level instruction
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const call = mockGenerateText.mock.calls[i]?.[0] as any;
      expect(call.system).toContain('REVIEW_LEVEL:soft');
    }
  });

  it('includes REVIEW_CALIBRATION for specialists with context, COMPACT for those without', async () => {
    await runWorkflowReview(
      makeInput({
        staticContext: 'STATIC',
        memoryContext: 'MEMORY',
        stackHints: 'HINTS',
      }),
    );

    // Specialists with context (scope=memory, standards=stackHints, security=static, perf=stackHints)
    // get REVIEW_CALIBRATION. Error handling (no context) gets COMPACT_CALIBRATION.
    //
    // Order: scope(0), standards(1), errors(2), security(3), performance(4)

    // scope has memoryContext → REVIEW_CALIBRATION
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const scopeCall = mockGenerateText.mock.calls[0]?.[0] as any;
    expect(scopeCall.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(scopeCall.system).not.toContain('COMPACT_CALIBRATION_BLOCK');

    // standards has stackHints → REVIEW_CALIBRATION
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const standardsCall = mockGenerateText.mock.calls[1]?.[0] as any;
    expect(standardsCall.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(standardsCall.system).not.toContain('COMPACT_CALIBRATION_BLOCK');

    // errors has no context → COMPACT_CALIBRATION
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const errorsCall = mockGenerateText.mock.calls[2]?.[0] as any;
    expect(errorsCall.system).toContain('COMPACT_CALIBRATION_BLOCK');
    expect(errorsCall.system).not.toContain('REVIEW_CALIBRATION_BLOCK');

    // security has staticContext → REVIEW_CALIBRATION
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const securityCall = mockGenerateText.mock.calls[3]?.[0] as any;
    expect(securityCall.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(securityCall.system).not.toContain('COMPACT_CALIBRATION_BLOCK');

    // performance has stackHints → REVIEW_CALIBRATION
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const perfCall = mockGenerateText.mock.calls[4]?.[0] as any;
    expect(perfCall.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(perfCall.system).not.toContain('COMPACT_CALIBRATION_BLOCK');
  });

  it('all specialists get COMPACT_CALIBRATION when no context is provided', async () => {
    // With empty context, even specialists that would receive context get nothing
    await runWorkflowReview(
      makeInput({
        staticContext: '',
        memoryContext: null,
        stackHints: '',
      }),
    );

    // All 5 specialists should get COMPACT since no context resolves to non-empty
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const call = mockGenerateText.mock.calls[i]?.[0] as any;
      expect(call.system).toContain('COMPACT_CALIBRATION_BLOCK');
      expect(call.system).not.toContain('REVIEW_CALIBRATION_BLOCK');
    }
  });

  it('includes review-level instruction in synthesis system prompt', async () => {
    await runWorkflowReview(makeInput({ reviewLevel: 'strict' }));

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const synthesisCall = mockGenerateText.mock.calls[5]?.[0] as any;
    expect(synthesisCall.system).toContain('REVIEW_LEVEL:strict');
  });

  it('includes REVIEW_CALIBRATION in synthesis system prompt', async () => {
    await runWorkflowReview(makeInput());

    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const synthesisCall = mockGenerateText.mock.calls[5]?.[0] as any;
    expect(synthesisCall.system).toContain('REVIEW_CALIBRATION_BLOCK');
  });
});
