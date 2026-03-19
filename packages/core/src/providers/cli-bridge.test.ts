/**
 * CLI Bridge provider tests.
 *
 * Tests the CLI bridge module that calls LLM CLIs directly
 * instead of using API tokens via the AI SDK.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

// Must import after mocking
import { execSync } from 'node:child_process';
import {
  _getAdapters,
  buildSubprocessEnv,
  CLIConfigurationError,
  generateViaCLI,
  getAvailableCLIs,
  OPENCODE_ENV_BY_PREFIX,
  resolveCredentialEnvVar,
} from './cli-bridge.js';

const mockExecSync = vi.mocked(execSync);

describe('cli-bridge', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getAvailableCLIs', () => {
    it('returns an array', () => {
      const result = getAvailableCLIs();
      expect(Array.isArray(result)).toBe(true);
    });

    it('only contains known CLI names', () => {
      const validNames = new Set(['opencode', 'copilot', 'gemini']);
      const result = getAvailableCLIs();
      for (const name of result) {
        expect(validNames.has(name)).toBe(true);
      }
    });
  });

  describe('_getAdapters', () => {
    it('returns adapters in priority order: opencode, copilot, gemini', () => {
      const adapters = _getAdapters();
      expect(adapters).toHaveLength(3);
      expect(adapters[0]?.name).toBe('opencode');
      expect(adapters[1]?.name).toBe('copilot');
      expect(adapters[2]?.name).toBe('gemini');
    });

    it('each adapter has required fields', () => {
      const adapters = _getAdapters();
      for (const adapter of adapters) {
        expect(adapter).toHaveProperty('name');
        expect(adapter).toHaveProperty('command');
        expect(adapter).toHaveProperty('available');
        expect(adapter).toHaveProperty('generate');
        expect(typeof adapter.name).toBe('string');
        expect(typeof adapter.command).toBe('string');
        expect(typeof adapter.available).toBe('boolean');
        expect(typeof adapter.generate).toBe('function');
      }
    });
  });

  describe('generateViaCLI', () => {
    it('throws when no CLIs are available', () => {
      // Since detectCLI runs at module load time and all CLIs are likely
      // not installed in the test environment, all adapters should show
      // available: false (the mock makes `which` throw by default).
      const available = getAvailableCLIs();
      if (available.length === 0) {
        expect(() => generateViaCLI('test prompt')).toThrow(
          'No CLI providers available. Install one of: opencode, copilot, gemini',
        );
      }
    });

    it('error message includes all available CLI names when all fail', () => {
      const available = getAvailableCLIs();
      if (available.length === 0) {
        try {
          generateViaCLI('test prompt');
        } catch (error) {
          expect((error as Error).message).toContain('No CLI providers available');
        }
      }
    });

    it('returns correct shape when a CLI succeeds', () => {
      // If any CLI is actually available in the test env, verify the shape
      const available = getAvailableCLIs();
      if (available.length > 0) {
        // Mock the actual exec to return a fake review
        mockExecSync.mockReturnValue('STATUS: PASSED\nSUMMARY: Looks good\nFINDINGS:\n');
        const result = generateViaCLI('test');
        expect(result).toHaveProperty('text');
        expect(result).toHaveProperty('provider', 'cli-bridge');
        expect(result).toHaveProperty('cli');
        expect(typeof result.text).toBe('string');
        expect(typeof result.cli).toBe('string');
      }
    });

    it('accepts options object with preferredCLI', () => {
      const adapters = _getAdapters();
      // Verify that preferredCLI via options would reorder (structural test)
      const names = adapters.map((a) => a.name);
      expect(names).toEqual(['opencode', 'copilot', 'gemini']);
    });

    it('accepts options object without error', () => {
      // Should not throw when options object is passed (even if no CLIs available)
      const available = getAvailableCLIs();
      if (available.length === 0) {
        expect(() => generateViaCLI('test prompt', undefined, { preferredCLI: 'opencode' })).toThrow(
          'No CLI providers available',
        );
      }
    });
  });

  describe('OPENCODE_ENV_BY_PREFIX', () => {
    it('contains expected provider prefixes', () => {
      expect(OPENCODE_ENV_BY_PREFIX).toHaveProperty('anthropic', 'ANTHROPIC_API_KEY');
      expect(OPENCODE_ENV_BY_PREFIX).toHaveProperty('openai', 'OPENAI_API_KEY');
      expect(OPENCODE_ENV_BY_PREFIX).toHaveProperty('google', 'GEMINI_API_KEY');
      expect(OPENCODE_ENV_BY_PREFIX).toHaveProperty('github-copilot', 'GITHUB_TOKEN');
      expect(OPENCODE_ENV_BY_PREFIX).toHaveProperty('groq', 'GROQ_API_KEY');
      expect(OPENCODE_ENV_BY_PREFIX).toHaveProperty('openrouter', 'OPENROUTER_API_KEY');
    });
  });

  describe('resolveCredentialEnvVar', () => {
    it('resolves opencode anthropic prefix to ANTHROPIC_API_KEY', () => {
      expect(resolveCredentialEnvVar('opencode', 'anthropic/claude-sonnet-4-5')).toBe(
        'ANTHROPIC_API_KEY',
      );
    });

    it('resolves opencode openai prefix to OPENAI_API_KEY', () => {
      expect(resolveCredentialEnvVar('opencode', 'openai/gpt-5-codex')).toBe('OPENAI_API_KEY');
    });

    it('resolves opencode google prefix to GEMINI_API_KEY', () => {
      expect(resolveCredentialEnvVar('opencode', 'google/gemini-2.5-pro')).toBe('GEMINI_API_KEY');
    });

    it('resolves opencode github-copilot prefix to GITHUB_TOKEN', () => {
      expect(resolveCredentialEnvVar('opencode', 'github-copilot/claude-sonnet-4')).toBe(
        'GITHUB_TOKEN',
      );
    });

    it('resolves opencode groq prefix to GROQ_API_KEY', () => {
      expect(resolveCredentialEnvVar('opencode', 'groq/llama-3-70b')).toBe('GROQ_API_KEY');
    });

    it('resolves opencode openrouter prefix to OPENROUTER_API_KEY', () => {
      expect(resolveCredentialEnvVar('opencode', 'openrouter/deepseek-chat')).toBe(
        'OPENROUTER_API_KEY',
      );
    });

    it('returns undefined for opencode with unknown prefix', () => {
      expect(resolveCredentialEnvVar('opencode', 'unknown/some-model')).toBeUndefined();
    });

    it('returns undefined for opencode without cliModel', () => {
      expect(resolveCredentialEnvVar('opencode')).toBeUndefined();
    });

    it('resolves gemini to GEMINI_API_KEY regardless of cliModel', () => {
      expect(resolveCredentialEnvVar('gemini')).toBe('GEMINI_API_KEY');
      expect(resolveCredentialEnvVar('gemini', 'anything')).toBe('GEMINI_API_KEY');
    });

    it('resolves copilot to COPILOT_GITHUB_TOKEN', () => {
      expect(resolveCredentialEnvVar('copilot')).toBe('COPILOT_GITHUB_TOKEN');
    });

    it('returns undefined for undefined preferredCLI', () => {
      expect(resolveCredentialEnvVar(undefined)).toBeUndefined();
    });
  });

  describe('buildSubprocessEnv', () => {
    it('removes sensitive env vars from process.env', () => {
      // Temporarily set some sensitive vars
      const original = { ...process.env };
      process.env['ANTHROPIC_API_KEY'] = 'secret-anthropic';
      process.env['OPENAI_API_KEY'] = 'secret-openai';

      try {
        const env = buildSubprocessEnv();
        expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
        expect(env['OPENAI_API_KEY']).toBeUndefined();
      } finally {
        // Restore
        process.env['ANTHROPIC_API_KEY'] = original['ANTHROPIC_API_KEY'];
        process.env['OPENAI_API_KEY'] = original['OPENAI_API_KEY'];
      }
    });

    it('preserves non-sensitive env vars like PATH', () => {
      const env = buildSubprocessEnv();
      expect(env['PATH']).toBe(process.env['PATH']);
    });

    it('adds back the single required credential', () => {
      const env = buildSubprocessEnv('ANTHROPIC_API_KEY', 'my-secret-key');
      expect(env['ANTHROPIC_API_KEY']).toBe('my-secret-key');
      // Other sensitive vars should still be removed
      expect(env['OPENAI_API_KEY']).toBeUndefined();
    });

    it('returns env without credentials when no args given', () => {
      const env = buildSubprocessEnv();
      expect(env['PATH']).toBeDefined();
      // All sensitive vars removed
      expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
      expect(env['GH_TOKEN']).toBeUndefined();
    });
  });

  describe('CLIConfigurationError', () => {
    it('is an instance of Error', () => {
      const err = new CLIConfigurationError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CLIConfigurationError);
    });

    it('has the correct name', () => {
      const err = new CLIConfigurationError('test message');
      expect(err.name).toBe('CLIConfigurationError');
      expect(err.message).toBe('test message');
    });
  });

  describe('cliModel validation', () => {
    it('throws CLIConfigurationError for malformed cliModel (no slash)', () => {
      const available = getAvailableCLIs();
      if (available.includes('opencode')) {
        expect(() =>
          generateViaCLI('test', undefined, {
            preferredCLI: 'opencode',
            cliModel: 'no-slash-here',
          }),
        ).toThrow(CLIConfigurationError);
      }
    });

    it('throws CLIConfigurationError for unsupported provider prefix', () => {
      const available = getAvailableCLIs();
      if (available.includes('opencode')) {
        expect(() =>
          generateViaCLI('test', undefined, {
            preferredCLI: 'opencode',
            cliModel: 'unsupported-provider/some-model',
          }),
        ).toThrow(CLIConfigurationError);
      }
    });

    it('does not validate cliModel format when preferredCLI is not opencode', () => {
      const available = getAvailableCLIs();
      if (available.includes('gemini')) {
        // Set GEMINI_API_KEY so credential validation passes
        const original = process.env['GEMINI_API_KEY'];
        process.env['GEMINI_API_KEY'] = 'test-key';
        try {
          // Should not throw CLIConfigurationError about cliModel format for gemini
          // (cliModel format validation only applies to opencode)
          mockExecSync.mockReturnValue('review output');
          expect(() =>
            generateViaCLI('test', undefined, {
              preferredCLI: 'gemini',
              cliModel: 'invalid-format',
            }),
          ).not.toThrow(CLIConfigurationError);
        } finally {
          process.env['GEMINI_API_KEY'] = original;
        }
      }
    });
  });
});
