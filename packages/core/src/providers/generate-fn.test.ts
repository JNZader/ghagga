import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateTextFn } from './generate-fn.js';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./cli-bridge.js', () => ({
  generateViaCLI: vi.fn(),
}));

vi.mock('./gateway.js', () => ({
  generateViaGateway: vi.fn(),
}));

vi.mock('./ollama.js', () => ({
  createOllamaGenerateFn: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────

import { generateViaCLI } from './cli-bridge.js';
import { generateViaGateway } from './gateway.js';
import {
  createCLIBridgeGenerateFn,
  createGatewayGenerateFn,
  createOllamaGenerateFn,
} from './generate-fn.js';

// ─── CLI Bridge Factory ─────────────────────────────────────────

describe('createCLIBridgeGenerateFn', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct GenerateResult shape', () => {
    vi.mocked(generateViaCLI).mockReturnValue({
      text: 'CLI review output',
      provider: 'cli-bridge',
      cli: 'opencode',
    });

    const fn = createCLIBridgeGenerateFn({ preferredCLI: 'opencode' });
    const resultPromise = fn('You are a reviewer', 'Review this diff');

    return resultPromise.then((result) => {
      expect(result).toEqual({
        text: 'CLI review output',
        tokensUsed: 0,
        provider: 'cli-bridge',
        model: 'opencode',
      });
    });
  });

  it('tokensUsed is always 0', async () => {
    vi.mocked(generateViaCLI).mockReturnValue({
      text: 'output',
      provider: 'cli-bridge',
      cli: 'gemini',
    });

    const fn = createCLIBridgeGenerateFn({});
    const result = await fn('system', 'prompt');

    expect(result.tokensUsed).toBe(0);
  });

  it('passes prompt and system correctly to generateViaCLI', async () => {
    vi.mocked(generateViaCLI).mockReturnValue({
      text: 'ok',
      provider: 'cli-bridge',
      cli: 'opencode',
    });

    const options = {
      preferredCLI: 'opencode' as const,
      cliModel: 'anthropic/claude-sonnet-4-5',
      credentials: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    };
    const fn = createCLIBridgeGenerateFn(options);
    await fn('system-prompt', 'user-prompt');

    expect(generateViaCLI).toHaveBeenCalledWith('user-prompt', 'system-prompt', options);
  });

  it('maps result.cli to model field', async () => {
    vi.mocked(generateViaCLI).mockReturnValue({
      text: 'output',
      provider: 'cli-bridge',
      cli: 'copilot',
    });

    const fn = createCLIBridgeGenerateFn({});
    const result = await fn('system', 'prompt');

    expect(result.model).toBe('copilot');
  });
});

// ─── Gateway Factory ────────────────────────────────────────────

describe('createGatewayGenerateFn', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct GenerateResult shape', async () => {
    vi.mocked(generateViaGateway).mockResolvedValue({
      text: 'Gateway review',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 250,
    });

    const fn = createGatewayGenerateFn({
      gatewayUrl: 'https://gateway.example.com',
      gatewayToken: 'token-123',
      model: 'auto',
      project: 'ghagga',
    });
    const result = await fn('system-prompt', 'user-prompt');

    expect(result).toEqual({
      text: 'Gateway review',
      tokensUsed: 250,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
  });

  it('passes options correctly to generateViaGateway', async () => {
    vi.mocked(generateViaGateway).mockResolvedValue({
      text: 'ok',
      provider: 'groq',
      model: 'llama-3',
    });

    const options = {
      gatewayUrl: 'https://gw.test.com',
      gatewayToken: 'secret-token',
      model: 'specific-model',
      project: 'test-project',
    };
    const fn = createGatewayGenerateFn(options);
    await fn('system', 'prompt');

    expect(generateViaGateway).toHaveBeenCalledWith('prompt', 'system', options);
  });

  it('maps tokensUsed from gateway response (defaults to 0 when missing)', async () => {
    vi.mocked(generateViaGateway).mockResolvedValue({
      text: 'output',
      provider: 'groq',
      model: 'llama-3',
      // No tokensUsed field
    });

    const fn = createGatewayGenerateFn({
      gatewayUrl: 'https://gw.test.com',
      gatewayToken: 'token',
    });
    const result = await fn('system', 'prompt');

    expect(result.tokensUsed).toBe(0);
  });

  it('propagates gateway errors', async () => {
    vi.mocked(generateViaGateway).mockRejectedValue(new Error('Gateway error (401): Unauthorized'));

    const fn = createGatewayGenerateFn({
      gatewayUrl: 'https://gw.test.com',
      gatewayToken: 'bad-token',
    });

    await expect(fn('system', 'prompt')).rejects.toThrow('Gateway error (401): Unauthorized');
  });
});

// ─── Type Compliance ────────────────────────────────────────────

describe('GenerateTextFn type compliance', () => {
  it('all three factories return functions matching GenerateTextFn signature', () => {
    const mockGenerateFn = vi.fn().mockResolvedValue({
      text: 'ok',
      tokensUsed: 0,
      provider: 'ollama',
      model: 'llama3',
    });
    vi.mocked(createOllamaGenerateFn).mockReturnValue(mockGenerateFn as GenerateTextFn);

    const ollamaFn: GenerateTextFn = createOllamaGenerateFn('llama3');
    const cliFn: GenerateTextFn = createCLIBridgeGenerateFn({});
    const gatewayFn: GenerateTextFn = createGatewayGenerateFn({
      gatewayUrl: 'https://example.com',
      gatewayToken: 'token',
    });

    expect(typeof ollamaFn).toBe('function');
    expect(typeof cliFn).toBe('function');
    expect(typeof gatewayFn).toBe('function');
  });
});
