import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./prompts.js', () => ({
  WORKFLOW_SCOPE_SYSTEM: 'SCOPE_SYSTEM',
  WORKFLOW_STANDARDS_SYSTEM: 'STANDARDS_SYSTEM',
  WORKFLOW_ERRORS_SYSTEM: 'ERRORS_SYSTEM',
  WORKFLOW_SECURITY_SYSTEM: 'SECURITY_SYSTEM',
  WORKFLOW_PERFORMANCE_SYSTEM: 'PERFORMANCE_SYSTEM',
  WORKFLOW_SYNTHESIS_SYSTEM: 'SYNTHESIS_SYSTEM',
  REVIEW_CALIBRATION: 'REVIEW_CALIBRATION_BLOCK',
  COMPACT_CALIBRATION: 'COMPACT_CALIBRATION_BLOCK',
  OUTPUT_STYLE_CALIBRATION: 'OUTPUT_STYLE_CALIBRATION_BLOCK',
  UNTRUSTED_CONTENT_POLICY: 'UNTRUSTED_CONTENT_POLICY_BLOCK',
  STATIC_ANALYSIS_UNTRUSTED_LABEL: 'STATIC ANALYSIS OUTPUT (untrusted tool/data)',
  SPECIALIST_OUTPUT_UNTRUSTED_LABEL: 'SPECIALIST OUTPUT (untrusted, model-generated)',
  buildMemoryContext: vi.fn((ctx: string | null) => (ctx ? `MEMORY:${ctx}` : '')),
  buildGraphNeighborhoodSection: vi.fn((ctx: string | null) =>
    ctx ? `GRAPH_NEIGHBORHOOD:${ctx}` : '',
  ),
  buildReviewLevelInstruction: vi.fn((level: string) => `REVIEW_LEVEL:${level}`),
  wrapUntrusted: vi.fn(
    (label: string, content: string) => `<UNTRUSTED label="${label}">\n${content}\n</UNTRUSTED>`,
  ),
  wrapUntrustedDiff: vi.fn(
    (diff: string) => `<USER_DIFF>\n\`\`\`diff\n${diff}\n\`\`\`\n</USER_DIFF>`,
  ),
}));

vi.mock('./simple.js', () => ({
  parseReviewResponse: vi.fn(),
}));

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { ReviewResult } from '../types.js';
import { parseReviewResponse } from './simple.js';
import type { WorkflowReviewInput } from './workflow.js';
import { runWorkflowReview } from './workflow.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockParseReviewResponse = vi.mocked(parseReviewResponse);

/** Create a mock GenerateTextFn that returns controlled responses */
function makeMockGenerateFn(
  providerName = 'gateway',
  modelName = 'auto',
): { fn: GenerateTextFn; calls: Array<{ system: string; prompt: string }> } {
  const calls: Array<{ system: string; prompt: string }> = [];
  const fn: GenerateTextFn = vi.fn(async (system: string, prompt: string) => {
    calls.push({ system, prompt });
    return {
      text: `Output from ${providerName}/${modelName}`,
      tokensUsed: 150,
      provider: providerName,
      model: modelName,
    };
  });
  return { fn, calls };
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
      provider: 'gateway',
      model: 'auto',
      tokensUsed: 0,
      executionTimeMs: 0,
      toolsRun: [],
      toolsSkipped: [],
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<WorkflowReviewInput> = {}): WorkflowReviewInput {
  const { fn: defaultGenerateFn } = makeMockGenerateFn();
  return {
    diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old\n+new',
    provider: 'gateway',
    model: 'auto',
    apiKey: 'test-token',
    staticContext: '',
    memoryContext: null,
    stackHints: '',
    reviewLevel: 'normal' as const,
    generateFns: [defaultGenerateFn],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runWorkflowReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseReviewResponse.mockReturnValue(makeParsedResult());
  });

  // ── Guard: requires generateFns ──

  it('throws when generateFns is not provided', async () => {
    const input = makeInput({ generateFns: undefined });
    await expect(runWorkflowReview(input)).rejects.toThrow('requires generateFns');
  });

  it('throws when generateFns is empty', async () => {
    const input = makeInput({ generateFns: [] });
    await expect(runWorkflowReview(input)).rejects.toThrow('requires generateFns');
  });

  // ── Specialist calls ──

  it('makes exactly 5 specialist calls + 1 synthesis call (6 total)', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(calls).toHaveLength(6);
  });

  it('calls all 5 specialists with the diff in the prompt', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ diff: 'my-diff-content', generateFns: [fn] }));

    // First 5 calls are specialists
    for (let i = 0; i < 5; i++) {
      expect(calls[i]?.prompt).toContain('my-diff-content');
    }
  });

  // ── Context isolation per specialist ──

  it('gives security specialist staticContext only', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        staticContext: 'STATIC_CONTEXT_DATA',
        memoryContext: 'MEMORY_DATA',
        stackHints: 'STACK_HINTS_DATA',
        generateFns: [fn],
      }),
    );

    // Specialists order: scope(0), standards(1), errors(2), security(3), performance(4)
    expect(calls[3]?.system).toContain('STATIC_CONTEXT_DATA');
    expect(calls[3]?.system).not.toContain('STACK_HINTS_DATA');
    expect(calls[3]?.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  it('gives performance specialist stackHints only', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        staticContext: 'STATIC_CONTEXT_DATA',
        memoryContext: 'MEMORY_DATA',
        stackHints: 'STACK_HINTS_DATA',
        generateFns: [fn],
      }),
    );

    expect(calls[4]?.system).toContain('STACK_HINTS_DATA');
    expect(calls[4]?.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(calls[4]?.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  it('gives scope specialist memoryContext only', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        staticContext: 'STATIC_CONTEXT_DATA',
        memoryContext: 'MEMORY_DATA',
        stackHints: 'STACK_HINTS_DATA',
        generateFns: [fn],
      }),
    );

    expect(calls[0]?.system).toContain('MEMORY:MEMORY_DATA');
    expect(calls[0]?.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(calls[0]?.system).not.toContain('STACK_HINTS_DATA');
  });

  it('gives standards specialist stackHints only', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        staticContext: 'STATIC_CONTEXT_DATA',
        memoryContext: 'MEMORY_DATA',
        stackHints: 'STACK_HINTS_DATA',
        generateFns: [fn],
      }),
    );

    expect(calls[1]?.system).toContain('STACK_HINTS_DATA');
    expect(calls[1]?.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(calls[1]?.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  it('gives error handling specialist no extra context (minimal)', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        staticContext: 'STATIC_CONTEXT_DATA',
        memoryContext: 'MEMORY_DATA',
        stackHints: 'STACK_HINTS_DATA',
        generateFns: [fn],
      }),
    );

    expect(calls[2]?.system).not.toContain('STATIC_CONTEXT_DATA');
    expect(calls[2]?.system).not.toContain('STACK_HINTS_DATA');
    expect(calls[2]?.system).not.toContain('MEMORY:MEMORY_DATA');
  });

  // ── Synthesis call ──

  it('passes SYNTHESIS_SYSTEM with review-level and calibration in system prompt for the 6th call', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(calls[5]?.system).toContain('SYNTHESIS_SYSTEM');
    expect(calls[5]?.system).toContain('REVIEW_LEVEL:normal');
    expect(calls[5]?.system).toContain('REVIEW_CALIBRATION_BLOCK');
  });

  it('includes all specialist outputs in the synthesis prompt', async () => {
    let callCount = 0;
    const specialistOutputs = [
      'Scope output',
      'Standards output',
      'Errors output',
      'Security output',
      'Performance output',
    ];
    const fn: GenerateTextFn = vi.fn(async () => {
      const text = specialistOutputs[callCount++] ?? 'Synthesis final';
      return { text, tokensUsed: 150, provider: 'gateway', model: 'auto' };
    });

    const { calls } = { calls: [] as Array<{ system: string; prompt: string }> };
    // Capture through the vitest mock
    const trackedFn: GenerateTextFn = vi.fn(async (system, prompt) => {
      const result = await fn(system, prompt);
      calls.push({ system, prompt });
      return result;
    });

    await runWorkflowReview(makeInput({ generateFns: [trackedFn] }));

    expect(calls[5]?.prompt).toContain('Scope output');
    expect(calls[5]?.prompt).toContain('Standards output');
    expect(calls[5]?.prompt).toContain('Errors output');
    expect(calls[5]?.prompt).toContain('Security output');
    expect(calls[5]?.prompt).toContain('Performance output');
  });

  // ── Failed specialists ──

  it('includes [FAILED] marker in synthesis prompt when a specialist fails', async () => {
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error('Standards LLM timeout');
      return { text: `Output ${callCount}`, tokensUsed: 100, provider: 'gateway', model: 'auto' };
    });

    const calls: Array<{ system: string; prompt: string }> = [];
    const trackedFn: GenerateTextFn = vi.fn(async (system, prompt) => {
      const result = await fn(system, prompt);
      calls.push({ system, prompt });
      return result;
    });

    await runWorkflowReview(makeInput({ generateFns: [trackedFn] }));

    // Synthesis prompt should contain [FAILED] for the failed specialist
    const synthesisCalls = (vi.mocked(trackedFn).mock.calls as [string, string][]).map(
      ([s, p]) => ({ system: s, prompt: p }),
    );
    const lastCall = synthesisCalls[synthesisCalls.length - 1];
    expect(lastCall?.prompt).toContain('[FAILED]');
    expect(lastCall?.prompt).toContain('Standards LLM timeout');
  });

  it('still produces a result when some specialists fail', async () => {
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) throw new Error(`Fail ${callCount}`);
      return { text: `Output ${callCount}`, tokensUsed: 100, provider: 'gateway', model: 'auto' };
    });

    const result = await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(result).toBeDefined();
    expect(result.metadata.mode).toBe('workflow');
  });

  // ── Dead voices (fulfilled with garbage) ──

  it('treats a specialist that fulfills with a CLI error envelope as failed', async () => {
    const errorEnvelope = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      duration_ms: 42,
    });
    const onProgress = vi.fn();
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      callCount++;
      if (callCount === 2) {
        return { text: errorEnvelope, tokensUsed: 999, provider: 'gateway', model: 'auto' };
      }
      return { text: `Output ${callCount}`, tokensUsed: 150, provider: 'gateway', model: 'auto' };
    });

    const result = await runWorkflowReview(makeInput({ onProgress, generateFns: [fn] }));

    // ✗ emitted for the dead voice, not ✓
    const failedCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✗'),
    );
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]?.[0].message).toContain('FAILED');

    // [FAILED] marker (not the raw envelope as a success) in the synthesis prompt
    const synthesisCall = (vi.mocked(fn).mock.calls as [string, string][])[5];
    expect(synthesisCall?.[1]).toContain('[FAILED]');
    expect(synthesisCall?.[1]).toContain('error envelope');

    // modelsUsed tags the dead voice as FAILED instead of a success entry
    const failedEntries = (result.metadata.modelsUsed ?? []).filter((m) => m.includes('[FAILED:'));
    expect(failedEntries).toHaveLength(1);

    // Tokens from the dead voice are NOT counted: 4 specialists + synthesis = 5 * 150
    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      750,
      expect.any(Number),
      null,
    );
  });

  it('treats a specialist that fulfills with empty text as failed', async () => {
    const onProgress = vi.fn();
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      callCount++;
      if (callCount === 3) {
        return { text: '   \n', tokensUsed: 150, provider: 'gateway', model: 'auto' };
      }
      return { text: `Output ${callCount}`, tokensUsed: 150, provider: 'gateway', model: 'auto' };
    });

    await runWorkflowReview(makeInput({ onProgress, generateFns: [fn] }));

    const failedCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✗'),
    );
    expect(failedCalls).toHaveLength(1);

    const synthesisCall = (vi.mocked(fn).mock.calls as [string, string][])[5];
    expect(synthesisCall?.[1]).toContain('[FAILED]');
    expect(synthesisCall?.[1]).toContain('empty response text');
  });

  it('does not flag a normal review that merely contains the word "error"', async () => {
    const onProgress = vi.fn();
    const fn: GenerateTextFn = vi.fn(async () => ({
      text: 'STATUS: FAILED\nSUMMARY: Missing error handling.\nFINDINGS:\n- error path uncovered',
      tokensUsed: 150,
      provider: 'gateway',
      model: 'auto',
    }));

    await runWorkflowReview(makeInput({ onProgress, generateFns: [fn] }));

    const successCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✓'),
    );
    expect(successCalls).toHaveLength(5);

    const synthesisCall = (vi.mocked(fn).mock.calls as [string, string][])[5];
    expect(synthesisCall?.[1]).not.toContain('[FAILED]');
  });

  // ── Token counting ──

  it('aggregates tokens from all successful specialists and synthesis', async () => {
    const tokenValues = [150, 300, 225, 270, 180, 500];
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      const tokensUsed = tokenValues[callCount++] ?? 0;
      return { text: `syn`, tokensUsed, provider: 'gateway', model: 'auto' };
    });

    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    // Total: 150 + 300 + 225 + 270 + 180 + 500 = 1625
    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      'syn',
      expect.any(String),
      expect.any(String),
      1625,
      expect.any(Number),
      null,
    );
  });

  it('does not count tokens from failed specialists', async () => {
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error('fail');
      return { text: 'syn', tokensUsed: 150, provider: 'gateway', model: 'auto' };
    });

    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    // 5 successful calls * 150 tokens = 750 (one failed)
    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      750,
      expect.any(Number),
      null,
    );
  });

  // ── parseReviewResponse integration ──

  it('calls parseReviewResponse with synthesis text output', async () => {
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      const text = callCount++ < 5 ? `S${callCount}` : 'Final synthesis text';
      return { text, tokensUsed: 100, provider: 'gateway', model: 'auto' };
    });

    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      'Final synthesis text',
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      null,
    );
  });

  it('passes memoryContext to parseReviewResponse', async () => {
    const { fn } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ memoryContext: 'some-memory', generateFns: [fn] }));

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
          provider: 'gateway',
          model: 'auto',
          tokensUsed: 100,
          executionTimeMs: 500,
          toolsRun: [],
          toolsSkipped: [],
        },
      }),
    );

    const { fn } = makeMockGenerateFn();
    const result = await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(result.metadata.mode).toBe('workflow');
  });

  // ── Progress callbacks ──

  it('calls onProgress for workflow-start', async () => {
    const onProgress = vi.fn();
    const { fn } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ onProgress, generateFns: [fn] }));

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'workflow-start',
        message: expect.stringContaining('5'),
      }),
    );
  });

  it('calls onProgress for each successful specialist with token count', async () => {
    const onProgress = vi.fn();
    const { fn } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ onProgress, generateFns: [fn] }));

    const specialistCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✓'),
    );
    expect(specialistCalls).toHaveLength(5);
  });

  it('calls onProgress for failed specialists with ✗', async () => {
    const onProgress = vi.fn();
    let callCount = 0;
    const fn: GenerateTextFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
      return { text: 'ok', tokensUsed: 100, provider: 'gateway', model: 'auto' };
    });

    await runWorkflowReview(makeInput({ onProgress, generateFns: [fn] }));

    const failedCalls = onProgress.mock.calls.filter(
      // biome-ignore lint/suspicious/noExplicitAny: mock callback type
      ([event]: [any]) => event.step.startsWith('specialist-') && event.message.includes('✗'),
    );
    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]?.[0].message).toContain('FAILED');
  });

  it('calls onProgress for workflow-synthesis step', async () => {
    const onProgress = vi.fn();
    const { fn } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ onProgress, generateFns: [fn] }));

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'workflow-synthesis',
        message: expect.stringContaining('Synthesizing'),
      }),
    );
  });

  it('does not throw when onProgress is not provided', async () => {
    const { fn } = makeMockGenerateFn();
    await expect(
      runWorkflowReview(makeInput({ onProgress: undefined, generateFns: [fn] })),
    ).resolves.toBeDefined();
  });

  // ── Multi-provider chain distribution ──

  it('distributes 5 specialists round-robin across a 3-entry generateFns array', async () => {
    const fn0 = vi
      .fn()
      .mockResolvedValue({ text: 'A', tokensUsed: 100, provider: 'gateway', model: 'm0' });
    const fn1 = vi
      .fn()
      .mockResolvedValue({ text: 'B', tokensUsed: 100, provider: 'gateway', model: 'm1' });
    const fn2 = vi
      .fn()
      .mockResolvedValue({ text: 'C', tokensUsed: 100, provider: 'gateway', model: 'm2' });

    await runWorkflowReview(makeInput({ generateFns: [fn0, fn1, fn2] }));

    // Specialist 0 (scope)       → fn0 (index 0 % 3)
    // Specialist 1 (standards)   → fn1 (index 1 % 3)
    // Specialist 2 (errors)      → fn2 (index 2 % 3)
    // Specialist 3 (security)    → fn0 (index 3 % 3)
    // Specialist 4 (performance) → fn1 (index 4 % 3)
    // Synthesis always uses fn0 (index 0)
    expect(fn0).toHaveBeenCalledTimes(3); // specialist 0, specialist 3, synthesis
    expect(fn1).toHaveBeenCalledTimes(2); // specialist 1, specialist 4
    expect(fn2).toHaveBeenCalledTimes(1); // specialist 2
  });

  it('synthesis always uses generateFns[0] (primary) regardless of array length', async () => {
    const fn0 = vi.fn().mockResolvedValue({
      text: 'primary',
      tokensUsed: 100,
      provider: 'gateway',
      model: 'primary',
    });
    const fn1 = vi.fn().mockResolvedValue({
      text: 'secondary',
      tokensUsed: 100,
      provider: 'gateway',
      model: 'secondary',
    });

    await runWorkflowReview(makeInput({ generateFns: [fn0, fn1] }));

    // fn0: specialists 0, 2, 4 (indices 0,2,4 → 0%2=0, 2%2=0, 4%2=0) + synthesis = 4 calls
    // fn1: specialists 1, 3 (indices 1,3 → 1%2=1, 3%2=1) = 2 calls
    expect(fn0.mock.calls.length).toBeGreaterThan(fn1.mock.calls.length);
  });

  // ── Review level & calibration injection ──

  it('includes review-level instruction in ALL specialist system prompts', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ reviewLevel: 'soft', generateFns: [fn] }));

    // All 5 specialist calls should contain the review level instruction
    for (let i = 0; i < 5; i++) {
      expect(calls[i]?.system).toContain('REVIEW_LEVEL:soft');
    }
  });

  it('includes REVIEW_CALIBRATION for specialists with context, COMPACT for those without', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        staticContext: 'STATIC',
        memoryContext: 'MEMORY',
        stackHints: 'HINTS',
        generateFns: [fn],
      }),
    );

    // Order: scope(0), standards(1), errors(2), security(3), performance(4)
    // scope has memoryContext → REVIEW_CALIBRATION
    expect(calls[0]?.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(calls[0]?.system).not.toContain('COMPACT_CALIBRATION_BLOCK');

    // standards has stackHints → REVIEW_CALIBRATION
    expect(calls[1]?.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(calls[1]?.system).not.toContain('COMPACT_CALIBRATION_BLOCK');

    // errors has no context → COMPACT_CALIBRATION
    expect(calls[2]?.system).toContain('COMPACT_CALIBRATION_BLOCK');
    expect(calls[2]?.system).not.toContain('REVIEW_CALIBRATION_BLOCK');

    // security has staticContext → REVIEW_CALIBRATION
    expect(calls[3]?.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(calls[3]?.system).not.toContain('COMPACT_CALIBRATION_BLOCK');

    // performance has stackHints → REVIEW_CALIBRATION
    expect(calls[4]?.system).toContain('REVIEW_CALIBRATION_BLOCK');
    expect(calls[4]?.system).not.toContain('COMPACT_CALIBRATION_BLOCK');
  });

  it('all specialists get COMPACT_CALIBRATION when no context is provided', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        staticContext: '',
        memoryContext: null,
        stackHints: '',
        generateFns: [fn],
      }),
    );

    for (let i = 0; i < 5; i++) {
      expect(calls[i]?.system).toContain('COMPACT_CALIBRATION_BLOCK');
      expect(calls[i]?.system).not.toContain('REVIEW_CALIBRATION_BLOCK');
    }
  });

  it('includes review-level instruction in synthesis system prompt', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ reviewLevel: 'strict', generateFns: [fn] }));

    expect(calls[5]?.system).toContain('REVIEW_LEVEL:strict');
  });

  it('includes REVIEW_CALIBRATION in synthesis system prompt', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(calls[5]?.system).toContain('REVIEW_CALIBRATION_BLOCK');
  });

  // ── Untrusted framing (prompt-injection trust boundary) ──

  it('wraps staticContext in an untrusted fence for the security specialist', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ staticContext: 'STATIC_CONTEXT_DATA', generateFns: [fn] }));

    // Security specialist is index 3 and is the only one receiving staticContext.
    expect(calls[3]?.system).toContain('<UNTRUSTED label="STATIC ANALYSIS OUTPUT');
    expect(calls[3]?.system).toContain('STATIC_CONTEXT_DATA');
    expect(calls[3]?.system).toContain('</UNTRUSTED>');
  });

  it('wraps each specialist output as untrusted in the synthesis prompt', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    // Synthesis is call index 5.
    expect(calls[5]?.prompt).toContain('<UNTRUSTED label="SPECIALIST OUTPUT');
    expect(calls[5]?.prompt).toContain('</UNTRUSTED>');
  });

  it('includes the untrusted-content policy in the synthesis system prompt', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(calls[5]?.system).toContain('UNTRUSTED_CONTENT_POLICY_BLOCK');
  });
});

// ─── Graph neighborhood specialist subsets (graph-context-retrieval T4.3) ──

describe('runWorkflowReview graph neighborhood subsets', () => {
  const NEIGHBORHOOD =
    'Graph neighborhood (exact-commit graph):\n- src/a.ts\n  imported by: src/b.ts';

  it('scope/performance/standards receive the section; security and errors do NOT', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({ generateFns: [fn], graphNeighborhoodContext: NEIGHBORHOOD }),
    );

    // call order = SPECIALISTS order: scope, standards, errors, security, performance
    const byIndex: Record<string, string> = {
      '0': 'scope-analysis',
      '1': 'coding-standards',
      '2': 'error-handling',
      '3': 'security-audit',
      '4': 'performance-review',
    };
    for (const [index, name] of Object.entries(byIndex)) {
      const system = calls[Number(index)]?.system ?? '';
      if (
        name === 'scope-analysis' ||
        name === 'coding-standards' ||
        name === 'performance-review'
      ) {
        expect(system).toContain(`GRAPH_NEIGHBORHOOD:${NEIGHBORHOOD}`);
      } else {
        expect(system).not.toContain('GRAPH_NEIGHBORHOOD:');
      }
    }
    // Synthesis (6th call) never receives the neighborhood.
    expect(calls[5]?.system ?? '').not.toContain('GRAPH_NEIGHBORHOOD:');
  });

  it('absent param and empty string produce byte-identical specialist prompts', async () => {
    const absent = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [absent.fn] }));

    const empty = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [empty.fn], graphNeighborhoodContext: '' }));

    expect(empty.calls.map((c) => c.system)).toEqual(absent.calls.map((c) => c.system));
  });

  it('each specialist section stays within the graphContextMaxTokens cap', async () => {
    // 30-token cap → the upstream formatter truncates to ≤ 30 tokens
    // (120 chars of rendered entries). Simulate the capped shared string.
    const capped = 'a'.repeat(120);
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(makeInput({ generateFns: [fn], graphNeighborhoodContext: capped }));

    for (const call of calls.slice(0, 5)) {
      const match = /GRAPH_NEIGHBORHOOD:(a*)/.exec(call.system ?? '');
      expect(match?.[1]?.length ?? 0).toBeLessThanOrEqual(120);
    }
  });
});

// ─── Input/output token split aggregation (graph-context-retrieval T5.2) ──

describe('runWorkflowReview token split aggregation', () => {
  // Local re-seed: this describe sits outside the main one, so the shared
  // beforeEach does not run here — without this, tests would read whatever
  // metadata the previous test mutated on a stale mocked-result object.
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseReviewResponse.mockReturnValue(makeParsedResult());
  });

  it('sums measured input/output tokens across specialists and synthesis', async () => {
    let call = 0;
    const fn: import('../providers/generate-fn.js').GenerateTextFn = vi.fn(
      async (_system: string, _prompt: string) => {
        call += 1;
        return {
          text: call === 6 ? 'STATUS: PASSED\nSUMMARY: ok\nFINDINGS:\n' : 'SCOPE OUTPUT',
          tokensUsed: 100,
          inputTokens: 70,
          outputTokens: 30,
          provider: 'gateway',
          model: 'auto',
        };
      },
    );

    const result = await runWorkflowReview(makeInput({ generateFns: [fn] }));

    // 5 specialists + 1 synthesis, each 70/30. tokensUsed travels as the
    // parseReviewResponse argument (the mocked parser owns the metadata
    // stub); the split is attached to the result post-parse.
    expect(mockParseReviewResponse).toHaveBeenCalledWith(
      'STATUS: PASSED\nSUMMARY: ok\nFINDINGS:\n',
      expect.any(String),
      expect.any(String),
      600,
      expect.any(Number),
      null,
    );
    expect(result.metadata.inputTokensUsed).toBe(420);
    expect(result.metadata.outputTokensUsed).toBe(180);
  });

  it('leaves the split absent when no voice reports one (unmeasured)', async () => {
    const { fn } = makeMockGenerateFn();
    const result = await runWorkflowReview(makeInput({ generateFns: [fn] }));

    // The mocked parser stub reports no split and the aggregation must not
    // invent one (tokensUsed itself lives on the parse argument).
    expect(result.metadata.inputTokensUsed).toBeUndefined();
    expect(result.metadata.outputTokensUsed).toBeUndefined();
  });

  it('reports only the measured side on a one-sided split (no `?? 0` measured zero)', async () => {
    // Regression: `?? 0` aggregation wrote outputTokensUsed: 0 — a MEASURED
    // ZERO — when every voice reported inputTokens but none reported output.
    let call = 0;
    const fn: import('../providers/generate-fn.js').GenerateTextFn = vi.fn(
      async (_system: string, _prompt: string) => {
        call += 1;
        return {
          text: call === 6 ? 'STATUS: PASSED\nSUMMARY: ok\nFINDINGS:\n' : 'SCOPE OUTPUT',
          tokensUsed: 100,
          inputTokens: 70,
          provider: 'gateway',
          model: 'auto',
        };
      },
    );

    const result = await runWorkflowReview(makeInput({ generateFns: [fn] }));

    expect(result.metadata.inputTokensUsed).toBe(420);
    expect(result.metadata.outputTokensUsed).toBeUndefined();
  });
});

// ─── Output style calibration (review-output-compression T1.2) ──

describe('runWorkflowReview output style calibration', () => {
  const SENTINEL = 'OUTPUT_STYLE_CALIBRATION_BLOCK';

  beforeEach(() => {
    vi.clearAllMocks();
    mockParseReviewResponse.mockReturnValue(makeParsedResult());
  });

  /** Run one workflow review and capture all 6 systems (5 specialists + synthesis). */
  async function captureSystems(compressOutput?: boolean): Promise<string[]> {
    const { fn, calls } = makeMockGenerateFn();
    await runWorkflowReview(
      makeInput({
        generateFns: [fn],
        ...(compressOutput === undefined ? {} : { compressOutput }),
      }),
    );
    return calls.map((c) => c.system);
  }

  it('default ON: every specialist and the synthesis get the block exactly once, after the calibration entry', async () => {
    const systems = await captureSystems();

    expect(systems).toHaveLength(6);
    for (const system of systems) {
      expect(system.split(SENTINEL).length - 1).toBe(1);
      // Pinned slot: immediately after whichever calibration entry the voice used.
      const lastCalibrationEnd = Math.max(
        system.lastIndexOf('REVIEW_CALIBRATION_BLOCK'),
        system.lastIndexOf('COMPACT_CALIBRATION_BLOCK'),
      );
      expect(system.indexOf(SENTINEL)).toBeGreaterThan(lastCalibrationEnd);
    }
  });

  it('explicit true behaves like the default', async () => {
    const systems = await captureSystems(true);
    for (const system of systems) {
      expect(system).toContain(SENTINEL);
    }
  });

  it('ON prompts are exactly the OFF prompts plus the block (appendix purely additive)', async () => {
    const on = await captureSystems();
    const off = await captureSystems(false);

    expect(on).toHaveLength(off.length);
    for (let i = 0; i < on.length; i++) {
      expect(on[i]).toBe(`${off[i]}\n${SENTINEL}`);
    }
  });

  it('explicit false: no block anywhere and every system ends at its calibration entry', async () => {
    const systems = await captureSystems(false);

    for (const system of systems) {
      expect(system).not.toContain(SENTINEL);
      expect(
        system.endsWith('REVIEW_CALIBRATION_BLOCK') || system.endsWith('COMPACT_CALIBRATION_BLOCK'),
      ).toBe(true);
    }
  });
});
