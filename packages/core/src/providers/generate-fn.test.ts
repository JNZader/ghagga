import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateTextFn } from './generate-fn.js';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('./index.js', () => ({
  createModel: vi.fn().mockReturnValue('mock-language-model'),
}));

vi.mock('../utils/llm-timeout.js', () => ({
  generateTextWithTimeout: vi.fn(),
}));

vi.mock('./cli-bridge.js', () => ({
  generateViaCLI: vi.fn(),
}));

vi.mock('./gateway.js', () => ({
  generateViaGateway: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────

import { generateTextWithTimeout } from '../utils/llm-timeout.js';
import { generateViaCLI } from './cli-bridge.js';
import { generateViaGateway } from './gateway.js';
import {
  createAISDKGenerateFn,
  createCLIBridgeGenerateFn,
  createGatewayGenerateFn,
} from './generate-fn.js';
import { createModel } from './index.js';

// ─── AI SDK Factory ─────────────────────────────────────────────

describe('createAISDKGenerateFn', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns correct GenerateResult shape', async () => {
    vi.mocked(createModel).mockReturnValue('mock-model' as never);
    vi.mocked(generateTextWithTimeout).mockResolvedValue({
      text: 'Review looks good',
      usage: { inputTokens: 100, outputTokens: 50 },
    } as never);

    const fn = createAISDKGenerateFn('anthropic', 'claude-sonnet-4-20250514', 'sk-test-key');
    const result = await fn('You are a reviewer', 'Review this diff');

    expect(result).toEqual({
      text: 'Review looks good',
      tokensUsed: 150,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });
  });

  it('passes provider/model/apiKey to createModel', async () => {
    vi.mocked(createModel).mockReturnValue('mock-model' as never);
    vi.mocked(generateTextWithTimeout).mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 0, outputTokens: 0 },
    } as never);

    const fn = createAISDKGenerateFn('openai', 'gpt-4o', 'sk-openai-key');
    await fn('system', 'prompt');

    expect(createModel).toHaveBeenCalledWith('openai', 'gpt-4o', 'sk-openai-key');
  });

  it('passes system/prompt/temperature to generateTextWithTimeout', async () => {
    const mockModel = { modelId: 'test' };
    vi.mocked(createModel).mockReturnValue(mockModel as never);
    vi.mocked(generateTextWithTimeout).mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never);

    const fn = createAISDKGenerateFn('anthropic', 'claude-sonnet-4-20250514', 'key');
    await fn('system-prompt', 'user-prompt');

    expect(generateTextWithTimeout).toHaveBeenCalledWith(
      {
        model: mockModel,
        system: 'system-prompt',
        prompt: 'user-prompt',
        temperature: 0.3,
      },
      { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    );
  });

  it('throws on timeout (null result)', async () => {
    vi.mocked(createModel).mockReturnValue('mock-model' as never);
    vi.mocked(generateTextWithTimeout).mockResolvedValue(null);

    const fn = createAISDKGenerateFn('anthropic', 'claude-sonnet-4-20250514', 'key');

    await expect(fn('system', 'prompt')).rejects.toThrow(
      'LLM call timed out (anthropic/claude-sonnet-4-20250514)',
    );
  });

  it('handles missing usage gracefully (defaults to 0)', async () => {
    vi.mocked(createModel).mockReturnValue('mock-model' as never);
    vi.mocked(generateTextWithTimeout).mockResolvedValue({
      text: 'response',
      usage: {},
    } as never);

    const fn = createAISDKGenerateFn('google', 'gemini-pro', 'key');
    const result = await fn('system', 'prompt');

    expect(result.tokensUsed).toBe(0);
  });
});

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
    // generateViaCLI is sync, but the factory wraps it in async
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
    vi.mocked(createModel).mockReturnValue('mock' as never);

    const aiSdkFn: GenerateTextFn = createAISDKGenerateFn('anthropic', 'model', 'key');
    const cliFn: GenerateTextFn = createCLIBridgeGenerateFn({});
    const gatewayFn: GenerateTextFn = createGatewayGenerateFn({
      gatewayUrl: 'https://example.com',
      gatewayToken: 'token',
    });

    // All should be functions that accept (system, prompt) and return Promise<GenerateResult>
    expect(typeof aiSdkFn).toBe('function');
    expect(typeof cliFn).toBe('function');
    expect(typeof gatewayFn).toBe('function');
  });
});
