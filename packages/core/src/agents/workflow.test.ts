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
  UNTRUSTED_CONTENT_POLICY: 'UNTRUSTED_CONTENT_POLICY_BLOCK',
  STATIC_ANALYSIS_UNTRUSTED_LABEL: 'STATIC ANALYSIS OUTPUT (untrusted tool/data)',
  SPECIALIST_OUTPUT_UNTRUSTED_LABEL: 'SPECIALIST OUTPUT (untrusted, model-generated)',
  buildMemoryContext: vi.fn((ctx: string | null) => (ctx ? `MEMORY:${ctx}` : '')),
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
