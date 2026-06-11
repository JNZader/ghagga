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

  it('should have a non-empty ignorePatterns array covering all lockfile formats', () => {
    expect(DEFAULT_SETTINGS.ignorePatterns.length).toBeGreaterThan(0);
    // Documentation and text files
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('*.md');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('*.txt');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('.gitignore');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('LICENSE');
    // Lockfiles — all ecosystems
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('*.lock');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('package-lock.json');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('pnpm-lock.yaml');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('bun.lockb');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('composer.lock');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('Gemfile.lock');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('Cargo.lock');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('poetry.lock');
    expect(DEFAULT_SETTINGS.ignorePatterns).toContain('go.sum');
  });
});

// ─── DEFAULT_MODELS ─────────────────────────────────────────────

describe('DEFAULT_MODELS', () => {
  it('should have an entry for every LLMProvider', () => {
    // The provider model was collapsed to a 3-type chain
    // (gateway / cli-bridge / ollama) in the mcp-llm-bridge refactor
    // (types.ts:25). DEFAULT_MODELS is typed `Record<LLMProvider, string>`,
    // so it must carry exactly these keys — the legacy per-vendor providers
    // (anthropic/openai/…) no longer exist as first-class provider types.
    const providers = ['gateway', 'cli-bridge', 'ollama'] as const;
    for (const provider of providers) {
      expect(DEFAULT_MODELS).toHaveProperty(provider);
      expect(typeof DEFAULT_MODELS[provider]).toBe('string');
      expect(DEFAULT_MODELS[provider].length).toBeGreaterThan(0);
    }
  });
});
