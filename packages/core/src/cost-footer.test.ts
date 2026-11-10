import { describe, expect, it } from 'vitest';
import {
  calculateReviewCost,
  formatCostFooter,
  getModelPricing,
  MODEL_PRICING,
} from './cost-footer.js';

// ── getModelPricing ──

describe('getModelPricing', () => {
  it('finds direct match', () => {
    const p = getModelPricing('gpt-4o');
    expect(p).not.toBeNull();
    expect(p?.inputPerMTok).toBe(2.5);
  });

  it('finds prefix match for versioned models', () => {
    const p = getModelPricing('claude-sonnet-4-20250514');
    expect(p).not.toBeNull();
    expect(p?.inputPerMTok).toBe(3);
  });

  it('finds anthropic opus', () => {
    expect(getModelPricing('claude-opus-4-6')).not.toBeNull();
  });

  it('returns null for unknown model', () => {
    expect(getModelPricing('unknown-model-xyz')).toBeNull();
  });

  it('covers major providers', () => {
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThanOrEqual(10);
  });
});

// ── calculateReviewCost ──

describe('calculateReviewCost', () => {
  it('estimates cost with 70/30 split', () => {
    const cost = calculateReviewCost(100_000, 'claude-sonnet-4-20250514');
    expect(cost.pricingFound).toBe(true);
    expect(cost.estimatedInputTokens).toBe(70_000);
    expect(cost.estimatedOutputTokens).toBe(30_000);
    // 70K * $3/M + 30K * $15/M = $0.21 + $0.45 = $0.66
    expect(cost.costUSD).toBeCloseTo(0.66, 1);
  });

  it('uses explicit input/output when provided', () => {
    const cost = calculateReviewCost(100_000, 'gpt-4o', {
      inputTokens: 90_000,
      outputTokens: 10_000,
    });
    // 90K * $2.5/M + 10K * $10/M = $0.225 + $0.1 = $0.325
    expect(cost.costUSD).toBeCloseTo(0.325, 2);
  });

  it('returns 0 cost for free tier models', () => {
    const cost = calculateReviewCost(50_000, 'llama-3');
    expect(cost.costUSD).toBe(0);
    expect(cost.pricingFound).toBe(true);
  });

  it('returns 0 cost and pricingFound=false for unknown model', () => {
    const cost = calculateReviewCost(50_000, 'unknown-model');
    expect(cost.costUSD).toBe(0);
    expect(cost.pricingFound).toBe(false);
  });

  it('opus costs more than sonnet for same tokens', () => {
    const opus = calculateReviewCost(100_000, 'claude-opus-4-6');
    const sonnet = calculateReviewCost(100_000, 'claude-sonnet-4-20250514');
    expect(opus.costUSD).toBeGreaterThan(sonnet.costUSD);
  });

  it('handles 0 tokens', () => {
    const cost = calculateReviewCost(0, 'gpt-4o');
    expect(cost.costUSD).toBe(0);
    expect(cost.totalTokens).toBe(0);
  });
});

// ── formatCostFooter ──

describe('formatCostFooter', () => {
  it('formats with cost for known model', () => {
    const cost = calculateReviewCost(100_000, 'claude-sonnet-4-20250514');
    const footer = formatCostFooter(cost);
    expect(footer).toContain('100K tokens');
    expect(footer).toContain('$');
    expect(footer).toContain('claude-sonnet-4-20250514');
  });

  it("shows 'pricing unavailable' for unknown model", () => {
    const cost = calculateReviewCost(50_000, 'unknown-model');
    const footer = formatCostFooter(cost);
    expect(footer).toContain('pricing unavailable');
    expect(footer).toContain('50K tokens');
  });

  it("shows 'free tier' for zero-cost models", () => {
    const cost = calculateReviewCost(50_000, 'llama-3');
    const footer = formatCostFooter(cost);
    expect(footer).toContain('free tier');
  });

  it('returns empty string for 0 tokens (static-only)', () => {
    const cost = calculateReviewCost(0, 'gpt-4o');
    expect(formatCostFooter(cost)).toBe('');
  });

  it('formats M tokens for large reviews', () => {
    const cost = calculateReviewCost(2_500_000, 'claude-opus-4-6');
    const footer = formatCostFooter(cost);
    expect(footer).toContain('2.5M tokens');
  });

  it('uses sub tag for clean PR rendering', () => {
    const cost = calculateReviewCost(10_000, 'gpt-4o');
    const footer = formatCostFooter(cost);
    expect(footer).toContain('<sub>');
    expect(footer).toContain('</sub>');
  });
});

// ─── Measured input/output split (graph-context-retrieval T5.5,
//     honest partial labeling per comment-format-signal Fix 4) ──

describe('cost footer measured split', () => {
  it('fully-measured row shows the measured split and no estimation marker', () => {
    const cost = calculateReviewCost(10_000, 'claude-sonnet-4', {
      inputTokens: 7_000,
      outputTokens: 3_000,
    });
    expect(cost.inputMeasured).toBe(true);
    expect(cost.outputMeasured).toBe(true);
    const footer = formatCostFooter(cost);
    expect(footer).toContain('in 7K / out 3K');
    expect(footer).not.toContain('~');
    expect(footer).not.toContain('estimated');
  });

  it('unmeasured row keeps the heuristic and is labeled "(estimated 70/30)"', () => {
    const cost = calculateReviewCost(10_000, 'claude-sonnet-4');
    expect(cost.inputMeasured).toBe(false);
    expect(cost.outputMeasured).toBe(false);
    const footer = formatCostFooter(cost);
    expect(footer).toContain('in 7K / out 3K');
    expect(footer).toContain('estimated 70/30');
    expect(footer).not.toContain('~');
  });

  it('partial measurement (input only) marks the output as estimated (REA-003)', () => {
    // The PR #479 defect: a partially-measured split rendered identically to
    // a measured one. Now the estimated side carries ~ and the trailing tag
    // names WHICH side is estimated.
    const cost = calculateReviewCost(10_000, 'claude-sonnet-4', { inputTokens: 7_000 });
    expect(cost.inputMeasured).toBe(true);
    expect(cost.outputMeasured).toBe(false);
    expect(cost.estimatedOutputTokens).toBe(3_000); // 70/30 heuristic fallback
    const footer = formatCostFooter(cost);
    expect(footer).toContain('in 7K / out ~3K, output estimated');
    expect(footer).not.toContain('estimated 70/30');
  });

  it('partial measurement (output only) marks the input as estimated', () => {
    const cost = calculateReviewCost(10_000, 'claude-sonnet-4', { outputTokens: 3_000 });
    expect(cost.inputMeasured).toBe(false);
    expect(cost.outputMeasured).toBe(true);
    expect(cost.estimatedInputTokens).toBe(7_000); // 70/30 heuristic fallback
    const footer = formatCostFooter(cost);
    expect(footer).toContain('in ~7K / out 3K, input estimated');
    expect(footer).not.toContain('estimated 70/30');
  });

  // ─── Gap-voice rows (review-output-compression T2.4) ───────────
  // simple/diagnostic/fan-out now propagate the measured split into
  // metadata (T2.1-T2.3); the footer's three split states must apply to
  // them exactly as they already do for workflow/consensus.

  it('gap voices with a measured split render the output side measured (no 70/30 label)', () => {
    for (const _mode of ['simple', 'diagnostic', 'fan-out'] as const) {
      const cost = calculateReviewCost(10_000, 'claude-sonnet-4', {
        inputTokens: 7_000,
        outputTokens: 3_000,
      });
      expect(cost.inputMeasured).toBe(true);
      expect(cost.outputMeasured).toBe(true);
      const footer = formatCostFooter(cost);
      expect(footer).toContain('in 7K / out 3K');
      expect(footer).not.toContain('estimated 70/30');
      expect(footer).not.toContain('~');
    }
  });

  it('gap voices on a no-split provider (gateway) fall back to the heuristic with estimated labeling', () => {
    const cost = calculateReviewCost(10_000, 'claude-sonnet-4');
    expect(cost.inputMeasured).toBe(false);
    expect(cost.outputMeasured).toBe(false);
    const footer = formatCostFooter(cost);
    expect(footer).toContain('in 7K / out 3K, estimated 70/30');
  });
});
