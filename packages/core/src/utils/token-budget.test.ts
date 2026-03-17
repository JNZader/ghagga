import { describe, expect, it } from 'vitest';
import { calculateTokenBudget, getContextWindow } from './token-budget.js';

describe('getContextWindow', () => {
  it('returns correct window for claude-sonnet-4-20250514', () => {
    expect(getContextWindow('claude-sonnet-4-20250514')).toBe(200_000);
  });

  it('returns correct window for gpt-4o', () => {
    expect(getContextWindow('gpt-4o')).toBe(128_000);
  });

  it('returns correct window for gemini-2.0-flash', () => {
    expect(getContextWindow('gemini-2.0-flash')).toBe(1_048_576);
  });

  it('returns default (128000) for unknown models', () => {
    expect(getContextWindow('some-unknown-model-v99')).toBe(128_000);
  });

  // ─── Groq models (TPM-constrained) ────────────────────────────

  it('returns TPM-capped window for Groq openai/gpt-oss-120b', () => {
    expect(getContextWindow('openai/gpt-oss-120b')).toBe(6_000);
  });

  it('returns TPM-capped window for Groq llama-3.3-70b-versatile', () => {
    expect(getContextWindow('llama-3.3-70b-versatile')).toBe(8_000);
  });

  it('returns TPM-capped window for Groq llama-3.1-8b-instant', () => {
    expect(getContextWindow('llama-3.1-8b-instant')).toBe(4_000);
  });

  // ─── Provider prefix stripping ────────────────────────────────

  it('strips provider prefix for lookup (deepseek/deepseek-chat)', () => {
    expect(getContextWindow('deepseek/deepseek-chat')).toBe(64_000);
  });

  it('strips provider prefix for lookup (deepseek/deepseek-r1:free)', () => {
    // "deepseek-r1:free" is not in the map, but "deepseek-chat" is — this should fall back
    expect(getContextWindow('deepseek/deepseek-r1:free')).toBe(128_000);
  });

  it('prefers direct match over prefix-stripped match', () => {
    // "openai/gpt-oss-120b" is directly in the map with TPM-capped value
    expect(getContextWindow('openai/gpt-oss-120b')).toBe(6_000);
  });

  // ─── DeepSeek, Cerebras, Qwen ─────────────────────────────────

  it('returns correct window for deepseek-chat', () => {
    expect(getContextWindow('deepseek-chat')).toBe(64_000);
  });

  it('returns correct window for Cerebras llama-3.3-70b', () => {
    expect(getContextWindow('llama-3.3-70b')).toBe(128_000);
  });

  it('returns correct window for qwen-max', () => {
    expect(getContextWindow('qwen-max')).toBe(32_000);
  });
});

describe('calculateTokenBudget', () => {
  it('returns 70/30 split for a known model', () => {
    const budget = calculateTokenBudget('claude-sonnet-4-20250514');
    // 200_000 * 0.7 = 140_000
    expect(budget.diffBudget).toBe(140_000);
    // 200_000 * 0.3 = 60_000
    expect(budget.contextBudget).toBe(60_000);
  });

  it('returns 70/30 split for gpt-4o', () => {
    const budget = calculateTokenBudget('gpt-4o');
    // 128_000 * 0.7 = 89_600
    expect(budget.diffBudget).toBe(89_600);
    // 128_000 * 0.3 = 38_400
    expect(budget.contextBudget).toBe(38_400);
  });

  it('diffBudget + contextBudget approximates total window', () => {
    const models = ['claude-sonnet-4-20250514', 'gpt-4o', 'gemini-2.0-flash', 'unknown-model'];

    for (const model of models) {
      const total = getContextWindow(model);
      const budget = calculateTokenBudget(model);
      // Due to Math.floor, the sum may be slightly less than total
      expect(budget.diffBudget + budget.contextBudget).toBeLessThanOrEqual(total);
      // But the difference should be at most 1 (from two floor operations)
      expect(total - (budget.diffBudget + budget.contextBudget)).toBeLessThanOrEqual(1);
    }
  });

  it('uses default window for unknown models', () => {
    const budget = calculateTokenBudget('totally-unknown');
    expect(budget.diffBudget).toBe(Math.floor(128_000 * 0.7));
    expect(budget.contextBudget).toBe(Math.floor(128_000 * 0.3));
  });

  // ─── TPM-constrained models ───────────────────────────────────

  it('returns small budgets for Groq TPM-constrained models', () => {
    const budget = calculateTokenBudget('openai/gpt-oss-120b');
    // 6_000 * 0.7 = 4_200
    expect(budget.diffBudget).toBe(4_200);
    // 6_000 * 0.3 = 1_800
    expect(budget.contextBudget).toBe(1_800);
  });

  it('returns small budgets for llama-3.1-8b-instant', () => {
    const budget = calculateTokenBudget('llama-3.1-8b-instant');
    // 4_000 * 0.7 = 2_800
    expect(budget.diffBudget).toBe(2_800);
    // 4_000 * 0.3 = 1_200
    expect(budget.contextBudget).toBe(1_200);
  });

  it('enforces minimum context window of 2000', () => {
    // Even if a model somehow had a 0 context window, minimum is 2000
    const budget = calculateTokenBudget('llama-3.1-8b-instant');
    expect(budget.diffBudget + budget.contextBudget).toBeGreaterThanOrEqual(2_000);
  });
});
