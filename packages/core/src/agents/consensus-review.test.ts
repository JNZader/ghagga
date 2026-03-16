/**
 * Consensus review integration tests — reviewLevel + calibration injection.
 *
 * Mirrors the pattern in workflow.test.ts: mock `ai` and `../providers`,
 * then verify that runConsensusReview assembles stance system prompts
 * containing the review-level instruction and REVIEW_CALIBRATION block.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('../providers/index.js', () => ({
  createModel: vi.fn(() => 'mock-language-model'),
}));

vi.mock('./prompts.js', () => ({
  CONSENSUS_FOR_SYSTEM: 'CONSENSUS_FOR_SYSTEM',
  CONSENSUS_AGAINST_SYSTEM: 'CONSENSUS_AGAINST_SYSTEM',
  CONSENSUS_NEUTRAL_SYSTEM: 'CONSENSUS_NEUTRAL_SYSTEM',
  REVIEW_CALIBRATION: 'REVIEW_CALIBRATION_BLOCK',
  COMPACT_CALIBRATION: 'COMPACT_CALIBRATION_BLOCK',
  buildMemoryContext: vi.fn((ctx: string | null) => (ctx ? `MEMORY:${ctx}` : '')),
  buildReviewLevelInstruction: vi.fn((level: string) => `REVIEW_LEVEL:${level}`),
}));

import { generateText } from 'ai';
import type { ConsensusReviewInput } from './consensus.js';
import { runConsensusReview } from './consensus.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockGenerateText = vi.mocked(generateText);

function makeInput(overrides: Partial<ConsensusReviewInput> = {}): ConsensusReviewInput {
  return {
    diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old\n+new',
    models: [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-test',
        stance: 'for',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-test',
        stance: 'against',
      },
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-test',
        stance: 'neutral',
      },
    ],
    staticContext: '',
    memoryContext: null,
    stackHints: '',
    reviewLevel: 'normal',
    ...overrides,
  };
}

function makeVoteResponse(decision = 'approve', confidence = '0.8') {
  return {
    text: `DECISION: ${decision}\nCONFIDENCE: ${confidence}\nREASONING: Looks good.`,
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('runConsensusReview reviewLevel injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    mockGenerateText.mockResolvedValue(makeVoteResponse() as any);
  });

  it('includes soft review-level instruction in all 3 stance prompts', async () => {
    await runConsensusReview(makeInput({ reviewLevel: 'soft' }));

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const call = mockGenerateText.mock.calls[i]?.[0] as any;
      expect(call.system).toContain('REVIEW_LEVEL:soft');
    }
  });

  it('includes normal review-level instruction in all 3 stance prompts', async () => {
    await runConsensusReview(makeInput({ reviewLevel: 'normal' }));

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const call = mockGenerateText.mock.calls[i]?.[0] as any;
      expect(call.system).toContain('REVIEW_LEVEL:normal');
    }
  });

  it('includes strict review-level instruction in all 3 stance prompts', async () => {
    await runConsensusReview(makeInput({ reviewLevel: 'strict' }));

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const call = mockGenerateText.mock.calls[i]?.[0] as any;
      expect(call.system).toContain('REVIEW_LEVEL:strict');
    }
  });

  it('includes full REVIEW_CALIBRATION for the first vote, compact for the rest', async () => {
    await runConsensusReview(makeInput());

    // First vote gets full calibration
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    const firstCall = mockGenerateText.mock.calls[0]?.[0] as any;
    expect(firstCall.system).toContain('REVIEW_CALIBRATION_BLOCK');

    // Subsequent votes get compact calibration
    for (let i = 1; i < 3; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: mock cast
      const call = mockGenerateText.mock.calls[i]?.[0] as any;
      expect(call.system).toContain('COMPACT_CALIBRATION_BLOCK');
      expect(call.system).not.toContain('REVIEW_CALIBRATION_BLOCK');
    }
  });
});
