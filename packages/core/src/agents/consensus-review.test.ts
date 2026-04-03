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
  UNTRUSTED_CONTENT_POLICY: 'UNTRUSTED_CONTENT_POLICY_BLOCK',
  buildMemoryContext: vi.fn((ctx: string | null) => (ctx ? `MEMORY:${ctx}` : '')),
  buildReviewLevelInstruction: vi.fn((level: string) => `REVIEW_LEVEL:${level}`),
  wrapUntrustedDiff: vi.fn((diff: string) => `<USER_DIFF>\n\`\`\`diff\n${diff}\n\`\`\`\n</USER_DIFF>`),
}));

import { generateText } from 'ai';
import { createModel } from '../providers/index.js';
import type { ConsensusReviewInput } from './consensus.js';
import { runConsensusReview } from './consensus.js';

// ─── Helpers ────────────────────────────────────────────────────

const mockGenerateText = vi.mocked(generateText);
const mockCreateModel = vi.mocked(createModel);

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

// ─── Multi-provider chain distribution (via pipeline.buildConsensusModels) ───

describe('runConsensusReview — multi-provider distribution via models array', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // biome-ignore lint/suspicious/noExplicitAny: mock cast
    mockGenerateText.mockResolvedValue(makeVoteResponse() as any);
  });

  it('uses distinct providers for each stance when models array has 3 different entries', async () => {
    const input = makeInput({
      models: [
        { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'ka', stance: 'for' },
        { provider: 'openai', model: 'gpt-4o', apiKey: 'kb', stance: 'against' },
        { provider: 'google', model: 'gemini-2.0-flash', apiKey: 'kc', stance: 'neutral' },
      ],
    });
    await runConsensusReview(input);

    expect(mockCreateModel).toHaveBeenCalledTimes(3);
    expect(mockCreateModel).toHaveBeenNthCalledWith(
      1,
      'anthropic',
      'claude-sonnet-4-20250514',
      'ka',
    );
    expect(mockCreateModel).toHaveBeenNthCalledWith(2, 'openai', 'gpt-4o', 'kb');
    expect(mockCreateModel).toHaveBeenNthCalledWith(3, 'google', 'gemini-2.0-flash', 'kc');
  });

  it('uses chain[0] for for-vote and chain[1] for against-vote when 2 entries provided', async () => {
    const input = makeInput({
      models: [
        { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: 'ka', stance: 'for' },
        { provider: 'openai', model: 'gpt-4o', apiKey: 'kb', stance: 'against' },
        // neutral wraps back to index 0 — this is set by buildConsensusModels in pipeline
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          apiKey: 'ka',
          stance: 'neutral',
        },
      ],
    });
    await runConsensusReview(input);

    expect(mockCreateModel).toHaveBeenCalledTimes(3);
    expect(mockCreateModel).toHaveBeenNthCalledWith(
      1,
      'anthropic',
      'claude-sonnet-4-20250514',
      'ka',
    );
    expect(mockCreateModel).toHaveBeenNthCalledWith(2, 'openai', 'gpt-4o', 'kb');
    // neutral uses ka (same as for-vote) — the pipeline wraps i%2 = 2%2 = 0
    expect(mockCreateModel).toHaveBeenNthCalledWith(
      3,
      'anthropic',
      'claude-sonnet-4-20250514',
      'ka',
    );
  });

  it('all 3 votes use same provider when models array has a single provider repeated', async () => {
    // Equivalent to no chain configured — all use primary
    const input = makeInput({
      models: [
        { provider: 'openai', model: 'gpt-4o', apiKey: 'k', stance: 'for' },
        { provider: 'openai', model: 'gpt-4o', apiKey: 'k', stance: 'against' },
        { provider: 'openai', model: 'gpt-4o', apiKey: 'k', stance: 'neutral' },
      ],
    });
    await runConsensusReview(input);

    expect(mockCreateModel).toHaveBeenCalledTimes(3);
    for (let i = 1; i <= 3; i++) {
      expect(mockCreateModel).toHaveBeenNthCalledWith(i, 'openai', 'gpt-4o', 'k');
    }
  });
});
