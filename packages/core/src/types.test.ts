/**
 * Unit tests for configuration defaults exported from types.ts.
 *
 * Pure constants — no mocking needed.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, DEFAULT_SETTINGS } from './types.js';

// ─── DEFAULT_SETTINGS ───────────────────────────────────────────

describe('DEFAULT_SETTINGS', () => {
  it('should have all expected keys with correct defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: true,
      enableMemory: true,
      customRules: [],
      ignorePatterns: expect.any(Array),
      reviewLevel: 'normal',
      enabledTools: [],
      disabledTools: [],
    });
  });

  it('should have a non-empty ignorePatterns array', () => {
    expect(DEFAULT_SETTINGS.ignorePatterns.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('*.md');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('*.lock');
  });
});

// ─── DEFAULT_MODELS ─────────────────────────────────────────────

describe('DEFAULT_MODELS', () => {
  it('should have entries for all 10 LLM providers', () => {
    const providers = [
      'anthropic',
      'openai',
      'google',
      'github',
      'ollama',
      'qwen',
      'groq',
      'cerebras',
      'deepseek',
      'openrouter',
    ] as const;
    for (const provider of providers) {
      expect(DEFAULT_MODELS).toHaveProperty(provider);
      expect(typeof DEFAULT_MODELS[provider]).toBe('string');
      expect(DEFAULT_MODELS[provider].length).toBeGreaterThan(0);
    }
  });
});
