/**
 * Consensus review tests — reviewLevel + calibration injection.
 *
 * Tests use mock generateFns to verify that runConsensusReview assembles
 * stance system prompts containing the review-level instruction and
 * REVIEW_CALIBRATION block, without depending on deleted AI SDK providers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./prompts.js', () => ({
  CONSENSUS_FOR_SYSTEM: 'CONSENSUS_FOR_SYSTEM',
  CONSENSUS_AGAINST_SYSTEM: 'CONSENSUS_AGAINST_SYSTEM',
  CONSENSUS_NEUTRAL_SYSTEM: 'CONSENSUS_NEUTRAL_SYSTEM',
  REVIEW_CALIBRATION: 'REVIEW_CALIBRATION_BLOCK',
  COMPACT_CALIBRATION: 'COMPACT_CALIBRATION_BLOCK',
  UNTRUSTED_CONTENT_POLICY: 'UNTRUSTED_CONTENT_POLICY_BLOCK',
  buildMemoryContext: vi.fn((ctx: string | null) => (ctx ? `MEMORY:${ctx}` : '')),
  buildReviewLevelInstruction: vi.fn((level: string) => `REVIEW_LEVEL:${level}`),
  wrapUntrustedDiff: vi.fn(
    (diff: string) => `<USER_DIFF>\n\`\`\`diff\n${diff}\n\`\`\`\n</USER_DIFF>`,
  ),
}));

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type { ConsensusReviewInput } from './consensus.js';
import { runConsensusReview } from './consensus.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeVoteText(decision = 'approve') {
  return `DECISION: ${decision}\nCONFIDENCE: 0.8\nREASONING: Looks good.`;
}

/** Create a mock generateFn that tracks (system, prompt) calls */
function makeMockGenerateFn(
  providerName = 'gateway',
  modelName = 'auto',
): { fn: GenerateTextFn; calls: Array<{ system: string; prompt: string }> } {
  const calls: Array<{ system: string; prompt: string }> = [];
  const fn: GenerateTextFn = vi.fn(async (system: string, prompt: string) => {
    calls.push({ system, prompt });
    return {
      text: makeVoteText(),
      tokensUsed: 150,
      provider: providerName,
      model: modelName,
    };
  });
  return { fn, calls };
}

function makeInput(overrides: Partial<ConsensusReviewInput> = {}): ConsensusReviewInput {
  const { fn } = makeMockGenerateFn();
  return {
    diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old\n+new',
    models: [
      { provider: 'gateway', model: 'auto', apiKey: 'token', stance: 'for' },
      { provider: 'gateway', model: 'auto', apiKey: 'token', stance: 'against' },
      { provider: 'gateway', model: 'auto', apiKey: 'token', stance: 'neutral' },
    ],
    staticContext: '',
    memoryContext: null,
    stackHints: '',
    reviewLevel: 'normal',
    generateFns: [fn],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runConsensusReview reviewLevel injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when generateFns is not provided', async () => {
    const input = makeInput({ generateFns: undefined });
    await expect(runConsensusReview(input)).rejects.toThrow('requires generateFns');
  });

  it('throws when generateFns is empty', async () => {
    const input = makeInput({ generateFns: [] });
    await expect(runConsensusReview(input)).rejects.toThrow('requires generateFns');
  });

  it('includes soft review-level instruction in all 3 stance prompts', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runConsensusReview(makeInput({ reviewLevel: 'soft', generateFns: [fn] }));

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.system).toContain('REVIEW_LEVEL:soft');
    }
  });

  it('includes normal review-level instruction in all 3 stance prompts', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runConsensusReview(makeInput({ reviewLevel: 'normal', generateFns: [fn] }));

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.system).toContain('REVIEW_LEVEL:normal');
    }
  });

  it('includes strict review-level instruction in all 3 stance prompts', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runConsensusReview(makeInput({ reviewLevel: 'strict', generateFns: [fn] }));

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.system).toContain('REVIEW_LEVEL:strict');
    }
  });

  it('includes full REVIEW_CALIBRATION for the first vote, compact for the rest', async () => {
    const { fn, calls } = makeMockGenerateFn();
    await runConsensusReview(makeInput({ generateFns: [fn] }));

    // First vote gets full calibration
    expect(calls[0]?.system).toContain('REVIEW_CALIBRATION_BLOCK');

    // Subsequent votes get compact calibration
    for (let i = 1; i < 3; i++) {
      expect(calls[i]?.system).toContain('COMPACT_CALIBRATION_BLOCK');
      expect(calls[i]?.system).not.toContain('REVIEW_CALIBRATION_BLOCK');
    }
  });
});

// ─── Multi-provider distribution via generateFns array ───────────────────────

describe('runConsensusReview — multi-provider distribution via generateFns array', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses distinct generateFns for each stance when 3 fns are provided', async () => {
    const fn0 = vi.fn().mockResolvedValue({
      text: makeVoteText(),
      tokensUsed: 100,
      provider: 'gateway',
      model: 'p0',
    });
    const fn1 = vi.fn().mockResolvedValue({
      text: makeVoteText(),
      tokensUsed: 100,
      provider: 'gateway',
      model: 'p1',
    });
    const fn2 = vi.fn().mockResolvedValue({
      text: makeVoteText(),
      tokensUsed: 100,
      provider: 'gateway',
      model: 'p2',
    });

    await runConsensusReview(makeInput({ generateFns: [fn0, fn1, fn2] }));

    // Each stance gets a different generateFn (round-robin)
    expect(fn0).toHaveBeenCalledTimes(1); // for-vote (index 0)
    expect(fn1).toHaveBeenCalledTimes(1); // against-vote (index 1)
    expect(fn2).toHaveBeenCalledTimes(1); // neutral-vote (index 2)
  });

  it('wraps back to fn0 for neutral when only 2 fns provided', async () => {
    const fn0 = vi.fn().mockResolvedValue({
      text: makeVoteText(),
      tokensUsed: 100,
      provider: 'gateway',
      model: 'p0',
    });
    const fn1 = vi.fn().mockResolvedValue({
      text: makeVoteText(),
      tokensUsed: 100,
      provider: 'gateway',
      model: 'p1',
    });

    await runConsensusReview(makeInput({ generateFns: [fn0, fn1] }));

    // 3 votes, 2 fns: vote 0 → fn0, vote 1 → fn1, vote 2 → fn0 (wraps)
    expect(fn0).toHaveBeenCalledTimes(2); // for + neutral
    expect(fn1).toHaveBeenCalledTimes(1); // against
  });

  it('all 3 votes use same fn when only 1 fn is provided', async () => {
    const fn0 = vi.fn().mockResolvedValue({
      text: makeVoteText(),
      tokensUsed: 100,
      provider: 'gateway',
      model: 'p0',
    });

    await runConsensusReview(makeInput({ generateFns: [fn0] }));

    expect(fn0).toHaveBeenCalledTimes(3);
  });
});
