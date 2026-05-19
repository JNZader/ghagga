/**
 * Provider validation tests.
 *
 * In ghagga v3 only `gateway` and `cli-bridge` validators exist; `ollama` is
 * explicitly rejected by the SaaS dashboard. The legacy provider validators
 * (anthropic/openai/google/github/qwen/groq/cerebras/deepseek/openrouter) were
 * removed alongside the SaaS server teardown.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock('ghagga-core', () => ({
  // Only the symbols this module imports from ghagga-core.
  getAvailableCLIs: vi.fn(() => []),
}));

// ─── Import after mocks ─────────────────────────────────────────

import { getAvailableCLIs } from 'ghagga-core';
import { CURATED_MODELS, validateProviderKey } from './provider-models.js';

const mockedGetAvailableCLIs = vi.mocked(getAvailableCLIs);

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAvailableCLIs.mockReturnValue([]);
});

// ─── CURATED_MODELS ─────────────────────────────────────────────

describe('CURATED_MODELS', () => {
  it('exposes only the v3 SaaS providers', () => {
    expect(Object.keys(CURATED_MODELS).sort()).toEqual(['cli-bridge', 'gateway', 'ollama']);
  });

  it('gateway resolves to a single auto entry', () => {
    expect(CURATED_MODELS.gateway).toEqual(['auto']);
  });

  it('cli-bridge lists the four supported CLI tools', () => {
    expect(CURATED_MODELS['cli-bridge']).toEqual(['auto', 'opencode', 'copilot', 'gemini']);
  });

  it('ollama lists local model suggestions', () => {
    expect(CURATED_MODELS.ollama.length).toBeGreaterThan(0);
    expect(CURATED_MODELS.ollama).toContain('llama3');
  });
});

// ─── validateProviderKey ────────────────────────────────────────

describe('validateProviderKey', () => {
  describe('gateway', () => {
    it('always returns valid with models=[auto]', async () => {
      const result = await validateProviderKey('gateway', '');
      expect(result).toEqual({ valid: true, models: ['auto'] });
    });
  });

  describe('cli-bridge', () => {
    it('returns detected CLI tools plus auto', async () => {
      mockedGetAvailableCLIs.mockReturnValue(['opencode', 'gemini']);
      const result = await validateProviderKey('cli-bridge', '');
      expect(result.valid).toBe(true);
      expect(result.models).toEqual(['auto', 'opencode', 'gemini']);
      expect(result.detectedCliTools).toEqual(['opencode', 'gemini']);
    });

    it('exposes OpenCode model suggestions when opencode is detected', async () => {
      mockedGetAvailableCLIs.mockReturnValue(['opencode']);
      const result = await validateProviderKey('cli-bridge', '');
      expect(result.cliModelSuggestions?.length).toBeGreaterThan(0);
    });

    it('omits OpenCode model suggestions when opencode is NOT detected', async () => {
      mockedGetAvailableCLIs.mockReturnValue(['gemini']);
      const result = await validateProviderKey('cli-bridge', '');
      expect(result.cliModelSuggestions).toEqual([]);
    });
  });

  describe('ollama', () => {
    it('is always rejected — Ollama is local-only, not SaaS', async () => {
      const result = await validateProviderKey('ollama', '');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Ollama is not available in the SaaS dashboard/);
    });
  });
});
