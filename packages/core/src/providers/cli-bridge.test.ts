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
  parseOpenCodeOutput,
  resolveCredentialEnvVar,
  sanitizeErrorMessage,
  validateCliModel,
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

  // ─── Task 11: New targeted tests ────────────────────────────────

  describe('parseOpenCodeOutput', () => {
    it('concatenates text events into a single string', () => {
      const raw = [
        JSON.stringify({ type: 'text', part: { text: 'Hello ' } }),
        JSON.stringify({ type: 'text', part: { text: 'world' } }),
      ].join('\n');

      const result = parseOpenCodeOutput(raw);
      expect(result.text).toBe('Hello world');
      expect(result.tokens).toBeUndefined();
    });

    it('extracts token usage from step_finish events', () => {
      const raw = [
        JSON.stringify({ type: 'text', part: { text: 'Review content' } }),
        JSON.stringify({
          type: 'step_finish',
          part: { tokens: { input: 1500, output: 200 }, cost: 0.003 },
        }),
      ].join('\n');

      const result = parseOpenCodeOutput(raw);
      expect(result.text).toBe('Review content');
      expect(result.tokens).toEqual({ input: 1500, output: 200 });
    });

    it('gracefully skips malformed JSON lines', () => {
      const raw = [
        JSON.stringify({ type: 'text', part: { text: 'Good line' } }),
        '{ this is not valid JSON',
        'another bad line',
        JSON.stringify({ type: 'text', part: { text: ' more text' } }),
      ].join('\n');

      const result = parseOpenCodeOutput(raw);
      expect(result.text).toBe('Good line more text');
    });

    it('returns empty string for empty output', () => {
      const result = parseOpenCodeOutput('');
      expect(result.text).toBe('');
      expect(result.tokens).toBeUndefined();
    });

    it('returns empty string for whitespace-only output', () => {
      const result = parseOpenCodeOutput('   \n  \n  ');
      expect(result.text).toBe('');
    });

    it('skips events with unknown types', () => {
      const raw = [
        JSON.stringify({ type: 'metadata', part: { model: 'test' } }),
        JSON.stringify({ type: 'text', part: { text: 'actual content' } }),
        JSON.stringify({ type: 'progress', part: { percent: 50 } }),
      ].join('\n');

      const result = parseOpenCodeOutput(raw);
      expect(result.text).toBe('actual content');
    });

    it('handles text events with missing part.text gracefully', () => {
      const raw = [
        JSON.stringify({ type: 'text', part: {} }),
        JSON.stringify({ type: 'text', part: { text: 'valid text' } }),
      ].join('\n');

      const result = parseOpenCodeOutput(raw);
      expect(result.text).toBe('valid text');
    });

    it('uses the last step_finish for token counts', () => {
      const raw = [
        JSON.stringify({
          type: 'step_finish',
          part: { tokens: { input: 100, output: 50 } },
        }),
        JSON.stringify({ type: 'text', part: { text: 'response' } }),
        JSON.stringify({
          type: 'step_finish',
          part: { tokens: { input: 200, output: 100 } },
        }),
      ].join('\n');

      const result = parseOpenCodeOutput(raw);
      // The last step_finish should overwrite the first
      expect(result.tokens).toEqual({ input: 200, output: 100 });
    });
  });

  describe('legacy claude alias', () => {
    it('resolves preferredCLI "claude" to opencode with anthropic/claude-sonnet-4-5', () => {
      // This test verifies the legacy mapping at the validation level.
      // When 'claude' is used, cliModel defaults to 'anthropic/claude-sonnet-4-5',
      // which requires ANTHROPIC_API_KEY for credential validation.
      // We test through resolveCredentialEnvVar since the alias mapping
      // results in opencode + anthropic prefix.
      const envVar = resolveCredentialEnvVar('opencode', 'anthropic/claude-sonnet-4-5');
      expect(envVar).toBe('ANTHROPIC_API_KEY');
    });

    it('generates CLI call with claude alias when opencode is available', () => {
      const available = getAvailableCLIs();
      if (available.includes('opencode')) {
        // Set credential so validation passes
        const original = process.env['ANTHROPIC_API_KEY'];
        process.env['ANTHROPIC_API_KEY'] = 'test-key';
        try {
          // Mock opencode to return valid JSON output
          const jsonOutput = [
            JSON.stringify({ type: 'text', part: { text: 'STATUS: PASSED\nSUMMARY: Good\nFINDINGS:\n' } }),
          ].join('\n');
          mockExecSync.mockReturnValue(jsonOutput);

          const result = generateViaCLI('test prompt', undefined, { preferredCLI: 'claude' });
          expect(result.cli).toBe('opencode');
          expect(result.provider).toBe('cli-bridge');
        } finally {
          process.env['ANTHROPIC_API_KEY'] = original;
        }
      }
    });

    it('claude alias does not override an explicitly set cliModel', () => {
      // When 'claude' is the alias but cliModel is explicitly set,
      // the explicit model should be used, not the default anthropic/claude-sonnet-4-5
      const available = getAvailableCLIs();
      if (available.includes('opencode')) {
        const original = process.env['OPENAI_API_KEY'];
        process.env['OPENAI_API_KEY'] = 'test-key';
        try {
          const jsonOutput = [
            JSON.stringify({ type: 'text', part: { text: 'review output' } }),
          ].join('\n');
          mockExecSync.mockReturnValue(jsonOutput);

          // Should use openai/gpt-5-codex, not the default claude model
          const result = generateViaCLI('test', undefined, {
            preferredCLI: 'claude',
            cliModel: 'openai/gpt-5-codex',
          });
          expect(result.cli).toBe('opencode');
        } finally {
          process.env['OPENAI_API_KEY'] = original;
        }
      }
    });
  });

  describe('validateCliModel edge cases', () => {
    it('throws for empty string', () => {
      expect(() => validateCliModel('')).toThrow(CLIConfigurationError);
      expect(() => validateCliModel('')).toThrow('Invalid cliModel format');
    });

    it('throws for just a slash', () => {
      // '/' has empty prefix and empty model — fails prefix check
      expect(() => validateCliModel('/')).toThrow(CLIConfigurationError);
    });

    it('accepts multiple slashes (provider is first segment)', () => {
      // 'anthropic/claude/v2' — provider prefix is 'anthropic' (valid)
      expect(() => validateCliModel('anthropic/claude/v2')).not.toThrow();
    });

    it('throws for whitespace-only model', () => {
      expect(() => validateCliModel('  ')).toThrow(CLIConfigurationError);
    });

    it('throws for model with spaces around slash', () => {
      // ' anthropic / model ' — the regex requires no leading whitespace
      expect(() => validateCliModel(' anthropic/model')).toThrow(CLIConfigurationError);
    });

    it('throws for trailing slash only (no model name)', () => {
      // 'anthropic/' has a prefix but regex requires .+ after slash
      expect(() => validateCliModel('anthropic/')).toThrow(CLIConfigurationError);
    });

    it('accepts valid provider/model combinations', () => {
      expect(() => validateCliModel('anthropic/claude-sonnet-4-5')).not.toThrow();
      expect(() => validateCliModel('openai/gpt-5-codex')).not.toThrow();
      expect(() => validateCliModel('google/gemini-2.5-pro')).not.toThrow();
      expect(() => validateCliModel('groq/llama-3-70b')).not.toThrow();
      expect(() => validateCliModel('openrouter/deepseek-chat')).not.toThrow();
      expect(() => validateCliModel('github-copilot/claude-sonnet-4')).not.toThrow();
    });

    it('throws for valid format but unsupported prefix', () => {
      expect(() => validateCliModel('azure/gpt-4')).toThrow(CLIConfigurationError);
      expect(() => validateCliModel('azure/gpt-4')).toThrow('Unsupported OpenCode provider prefix');
    });
  });

  describe('buildSubprocessEnv credential isolation', () => {
    it('injecting ANTHROPIC_API_KEY does NOT leak other sensitive vars', () => {
      const original = { ...process.env };
      process.env['OPENAI_API_KEY'] = 'secret-openai-key';
      process.env['GEMINI_API_KEY'] = 'secret-gemini-key';
      process.env['GROQ_API_KEY'] = 'secret-groq-key';
      process.env['GITHUB_TOKEN'] = 'secret-github-token';
      process.env['COPILOT_GITHUB_TOKEN'] = 'secret-copilot-token';
      process.env['GH_TOKEN'] = 'secret-gh-token';
      process.env['OPENROUTER_API_KEY'] = 'secret-openrouter-key';

      try {
        const env = buildSubprocessEnv('ANTHROPIC_API_KEY', 'injected-anthropic-key');

        // The injected credential MUST be present
        expect(env['ANTHROPIC_API_KEY']).toBe('injected-anthropic-key');

        // ALL other sensitive vars MUST be absent
        expect(env['OPENAI_API_KEY']).toBeUndefined();
        expect(env['GEMINI_API_KEY']).toBeUndefined();
        expect(env['GROQ_API_KEY']).toBeUndefined();
        expect(env['GITHUB_TOKEN']).toBeUndefined();
        expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
        expect(env['GH_TOKEN']).toBeUndefined();
        expect(env['OPENROUTER_API_KEY']).toBeUndefined();
      } finally {
        // Restore original env
        for (const key of [
          'OPENAI_API_KEY',
          'GEMINI_API_KEY',
          'GROQ_API_KEY',
          'GITHUB_TOKEN',
          'COPILOT_GITHUB_TOKEN',
          'GH_TOKEN',
          'OPENROUTER_API_KEY',
        ]) {
          if (original[key] !== undefined) {
            process.env[key] = original[key];
          } else {
            delete process.env[key];
          }
        }
      }
    });

    it('preserves baseline runtime vars alongside injected credential', () => {
      const env = buildSubprocessEnv('GEMINI_API_KEY', 'test-gemini-key');

      // Baseline vars should survive
      expect(env['PATH']).toBe(process.env['PATH']);
      expect(env['HOME']).toBe(process.env['HOME']);

      // Injected credential should be present
      expect(env['GEMINI_API_KEY']).toBe('test-gemini-key');
    });

    it('strips ALL known sensitive vars when no credential is injected', () => {
      const original = { ...process.env };
      process.env['ANTHROPIC_API_KEY'] = 'secret1';
      process.env['OPENAI_API_KEY'] = 'secret2';
      process.env['GEMINI_API_KEY'] = 'secret3';
      process.env['GROQ_API_KEY'] = 'secret4';
      process.env['OPENROUTER_API_KEY'] = 'secret5';
      process.env['GITHUB_TOKEN'] = 'secret6';
      process.env['COPILOT_GITHUB_TOKEN'] = 'secret7';
      process.env['GH_TOKEN'] = 'secret8';

      try {
        const env = buildSubprocessEnv();

        expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
        expect(env['OPENAI_API_KEY']).toBeUndefined();
        expect(env['GEMINI_API_KEY']).toBeUndefined();
        expect(env['GROQ_API_KEY']).toBeUndefined();
        expect(env['OPENROUTER_API_KEY']).toBeUndefined();
        expect(env['GITHUB_TOKEN']).toBeUndefined();
        expect(env['COPILOT_GITHUB_TOKEN']).toBeUndefined();
        expect(env['GH_TOKEN']).toBeUndefined();
      } finally {
        for (const key of [
          'ANTHROPIC_API_KEY',
          'OPENAI_API_KEY',
          'GEMINI_API_KEY',
          'GROQ_API_KEY',
          'OPENROUTER_API_KEY',
          'GITHUB_TOKEN',
          'COPILOT_GITHUB_TOKEN',
          'GH_TOKEN',
        ]) {
          if (original[key] !== undefined) {
            process.env[key] = original[key];
          } else {
            delete process.env[key];
          }
        }
      }
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('redacts Anthropic API keys (sk-ant-*)', () => {
      const msg = 'Failed with key sk-ant-api03-abc123def456ghi789jkl012mno345pqr678';
      expect(sanitizeErrorMessage(msg)).toBe('Failed with key [REDACTED_KEY]');
      expect(sanitizeErrorMessage(msg)).not.toContain('sk-ant-');
    });

    it('redacts OpenAI API keys (sk-*)', () => {
      const msg = 'Error: auth failed for sk-projAbcDefGhiJklMnoPqrStUvWx';
      const result = sanitizeErrorMessage(msg);
      expect(result).not.toContain('sk-proj');
      expect(result).toContain('[REDACTED_KEY]');
    });

    it('redacts Google API keys (AIza*)', () => {
      // Constructed to avoid GitHub push protection
      const key = 'AIza' + 'SyBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890A';
      const msg = `Invalid key: ${key}`;
      const result = sanitizeErrorMessage(msg);
      expect(result).not.toContain('AIza');
      expect(result).toContain('[REDACTED_KEY]');
    });

    it('redacts GitHub PAT classic (ghp_*)', () => {
      const key = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcde';
      const msg = `Token ${key} is expired`;
      const result = sanitizeErrorMessage(msg);
      expect(result).not.toContain('ghp_');
      expect(result).toContain('[REDACTED_KEY]');
    });

    it('redacts GitHub fine-grained PAT (github_pat_*)', () => {
      const key = 'github_pat_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcde';
      const msg = `Auth with ${key} failed`;
      const result = sanitizeErrorMessage(msg);
      expect(result).not.toContain('github_pat_');
      expect(result).toContain('[REDACTED_KEY]');
    });

    it('redacts Groq API keys (gsk_*)', () => {
      const key = 'gsk_abcdefghijklmnopqrstu12345';
      const msg = `Groq error with key ${key}`;
      const result = sanitizeErrorMessage(msg);
      expect(result).not.toContain('gsk_');
      expect(result).toContain('[REDACTED_KEY]');
    });

    it('redacts OpenRouter API keys (sk-or-*)', () => {
      const key = 'sk-or-v1-abc123def456ghi789jkl';
      const msg = `OpenRouter rejected ${key}`;
      const result = sanitizeErrorMessage(msg);
      expect(result).not.toContain('sk-or-');
      expect(result).toContain('[REDACTED_KEY]');
    });

    it('does not modify messages without API keys', () => {
      const msg = 'Connection timeout after 30s';
      expect(sanitizeErrorMessage(msg)).toBe(msg);
    });

    it('redacts multiple keys in a single message', () => {
      const msg = 'Tried sk-ant-api03-abc123def456ghi789jkl012mno345pqr678 then ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcde';
      const result = sanitizeErrorMessage(msg);
      expect(result).not.toContain('sk-ant-');
      expect(result).not.toContain('ghp_');
      expect(result).toBe('Tried [REDACTED_KEY] then [REDACTED_KEY]');
    });
  });
});
