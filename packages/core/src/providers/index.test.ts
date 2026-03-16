/**
 * Provider factory tests.
 *
 * Tests createProvider() for all 6 provider branches (anthropic, openai,
 * google, github, ollama, qwen) and the unknown-provider error case.
 * Tests createModel() which composes createProvider + model invocation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mock fns ───────────────────────────────────────────

const mockCreateAnthropic = vi.hoisted(() => vi.fn());
const mockCreateOpenAI = vi.hoisted(() => vi.fn());
const mockCreateGoogleGenerativeAI = vi.hoisted(() => vi.fn());

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mockCreateAnthropic,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: mockCreateGoogleGenerativeAI,
}));

import type { LLMProvider } from '../types.js';
import { createModel, createProvider } from './index.js';

// ─── Tests ──────────────────────────────────────────────────────

describe('createProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Each factory returns a callable provider instance
    mockCreateAnthropic.mockReturnValue(() => ({ modelId: 'anthropic-model' }));
    mockCreateOpenAI.mockReturnValue(() => ({ modelId: 'openai-model' }));
    mockCreateGoogleGenerativeAI.mockReturnValue(() => ({ modelId: 'google-model' }));
  });

  it('anthropic: calls createAnthropic with apiKey', () => {
    createProvider('anthropic', 'sk-ant-key');

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant-key' });
    expect(mockCreateAnthropic).toHaveBeenCalledTimes(1);
  });

  it('openai: calls createOpenAI with apiKey', () => {
    createProvider('openai', 'sk-oai-key');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-oai-key' });
    expect(mockCreateOpenAI).toHaveBeenCalledTimes(1);
  });

  it('google: calls createGoogleGenerativeAI with apiKey', () => {
    createProvider('google', 'goog-key');

    expect(mockCreateGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'goog-key' });
    expect(mockCreateGoogleGenerativeAI).toHaveBeenCalledTimes(1);
  });

  it('github: calls createOpenAI with GitHub Models baseURL and name', () => {
    createProvider('github', 'ghp_token');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'ghp_token',
      baseURL: 'https://models.inference.ai.azure.com',
      name: 'github-models',
    });
  });

  it('ollama: calls createOpenAI with Ollama baseURL, name, and provided key', () => {
    createProvider('ollama', 'custom-key');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'custom-key',
      baseURL: 'http://localhost:11434/v1',
      name: 'ollama',
    });
  });

  it('ollama: falls back to "ollama" when key is empty', () => {
    createProvider('ollama', '');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      name: 'ollama',
    });
  });

  it('qwen: calls createOpenAI with DashScope baseURL and name', () => {
    createProvider('qwen', 'dash-key');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'dash-key',
      baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      name: 'qwen',
    });
  });

  it('groq: calls createOpenAI with Groq baseURL and name', () => {
    createProvider('groq', 'gsk-key');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'gsk-key',
      baseURL: 'https://api.groq.com/openai/v1',
      name: 'groq',
    });
  });

  it('cerebras: calls createOpenAI with Cerebras baseURL and name', () => {
    createProvider('cerebras', 'csk-key');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'csk-key',
      baseURL: 'https://api.cerebras.ai/v1',
      name: 'cerebras',
    });
  });

  it('deepseek: calls createOpenAI with DeepSeek baseURL and name', () => {
    createProvider('deepseek', 'dsk-key');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'dsk-key',
      baseURL: 'https://api.deepseek.com/v1',
      name: 'deepseek',
    });
  });

  it('openrouter: calls createOpenAI with OpenRouter baseURL and name', () => {
    createProvider('openrouter', 'sk-or-key');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-or-key',
      baseURL: 'https://openrouter.ai/api/v1',
      name: 'openrouter',
    });
  });

  it('unknown provider: throws "Unknown provider" error', () => {
    expect(() => {
      createProvider('mistral' as LLMProvider, 'key');
    }).toThrow('Unknown provider: mistral');
  });
});

describe('createModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls createProvider and invokes the result with the model string', () => {
    const mockProviderInstance = vi.fn().mockReturnValue({ modelId: 'claude-test' });
    mockCreateAnthropic.mockReturnValue(mockProviderInstance);

    const model = createModel('anthropic', 'claude-sonnet-4-20250514', 'sk-key');

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-key' });
    expect(mockProviderInstance).toHaveBeenCalledWith('claude-sonnet-4-20250514');
    expect(model).toEqual({ modelId: 'claude-test' });
  });

  it('works with openai provider and a specific model', () => {
    const mockProviderInstance = vi.fn().mockReturnValue({ modelId: 'gpt-4o' });
    mockCreateOpenAI.mockReturnValue(mockProviderInstance);

    const model = createModel('openai', 'gpt-4o', 'sk-oai');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-oai' });
    expect(mockProviderInstance).toHaveBeenCalledWith('gpt-4o');
    expect(model).toEqual({ modelId: 'gpt-4o' });
  });
});
