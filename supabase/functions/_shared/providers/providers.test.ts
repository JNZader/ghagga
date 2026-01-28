/**
 * Tests for AI Provider Registry
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
  beforeEach,
  afterEach,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';
import { stub, type Stub } from 'https://deno.land/std@0.208.0/testing/mock.ts';

import { AnthropicProvider, type AIProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';
import { GeminiProvider } from './gemini.ts';
import {
  ProviderRegistry,
  getProviderRegistry,
  resetProviderRegistry,
} from './registry.ts';

// Mock environment variables
let envGetStub: Stub | null = null;

function mockEnv(vars: Record<string, string | undefined>) {
  envGetStub = stub(Deno.env, 'get', (key: string) => vars[key]);
}

function restoreEnv() {
  if (envGetStub) {
    envGetStub.restore();
    envGetStub = null;
  }
}

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('should have correct name', () => {
    assertEquals(provider.name, 'anthropic');
  });

  it('should have models defined', () => {
    assertEquals(provider.models.length > 0, true);
    assertEquals(provider.models.includes('claude-opus-4-5-20251101'), true);
    assertEquals(provider.models.includes('claude-sonnet-4-20250514'), true);
  });

  it('should return model info for valid model', () => {
    const info = provider.getModelInfo('claude-opus-4-5-20251101');
    assertExists(info);
    assertEquals(info.provider, 'anthropic');
    assertEquals(info.name, 'Claude Opus 4.5');
    assertEquals(info.contextWindow, 200000);
  });

  it('should return undefined for invalid model', () => {
    const info = provider.getModelInfo('invalid-model');
    assertEquals(info, undefined);
  });

  it('should be available when API key is set', async () => {
    mockEnv({ ANTHROPIC_API_KEY: 'test-key' });
    assertEquals(await provider.isAvailable(), true);
  });

  it('should not be available when API key is missing', async () => {
    mockEnv({});
    assertEquals(await provider.isAvailable(), false);
  });

  it('should throw when completing without API key', async () => {
    mockEnv({});
    await assertRejects(
      () =>
        provider.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      Error,
      'ANTHROPIC_API_KEY'
    );
  });
});

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('should have correct name', () => {
    assertEquals(provider.name, 'openai');
  });

  it('should have models defined', () => {
    assertEquals(provider.models.length > 0, true);
    assertEquals(provider.models.includes('gpt-4o'), true);
    assertEquals(provider.models.includes('gpt-4o-mini'), true);
  });

  it('should return model info for valid model', () => {
    const info = provider.getModelInfo('gpt-4o');
    assertExists(info);
    assertEquals(info.provider, 'openai');
    assertEquals(info.name, 'GPT-4o');
    assertEquals(info.contextWindow, 128000);
  });

  it('should return undefined for invalid model', () => {
    const info = provider.getModelInfo('invalid-model');
    assertEquals(info, undefined);
  });

  it('should be available when API key is set', async () => {
    mockEnv({ OPENAI_API_KEY: 'test-key' });
    assertEquals(await provider.isAvailable(), true);
  });

  it('should not be available when API key is missing', async () => {
    mockEnv({});
    assertEquals(await provider.isAvailable(), false);
  });

  it('should throw when completing without API key', async () => {
    mockEnv({});
    await assertRejects(
      () =>
        provider.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      Error,
      'OPENAI_API_KEY'
    );
  });
});

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('should have correct name', () => {
    assertEquals(provider.name, 'google');
  });

  it('should have models defined', () => {
    assertEquals(provider.models.length > 0, true);
    assertEquals(provider.models.includes('gemini-1.5-pro'), true);
    assertEquals(provider.models.includes('gemini-1.5-flash'), true);
  });

  it('should return model info for valid model', () => {
    const info = provider.getModelInfo('gemini-1.5-pro');
    assertExists(info);
    assertEquals(info.provider, 'google');
    assertEquals(info.name, 'Gemini 1.5 Pro');
    assertEquals(info.contextWindow, 2097152);
  });

  it('should return undefined for invalid model', () => {
    const info = provider.getModelInfo('invalid-model');
    assertEquals(info, undefined);
  });

  it('should be available when API key is set', async () => {
    mockEnv({ GOOGLE_API_KEY: 'test-key' });
    assertEquals(await provider.isAvailable(), true);
  });

  it('should not be available when API key is missing', async () => {
    mockEnv({});
    assertEquals(await provider.isAvailable(), false);
  });

  it('should throw when completing without API key', async () => {
    mockEnv({});
    await assertRejects(
      () =>
        provider.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      Error,
      'GOOGLE_API_KEY'
    );
  });
});

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    resetProviderRegistry();
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('should have correct priority order', () => {
    assertEquals(ProviderRegistry.PRIORITY_ORDER, ['anthropic', 'openai', 'google']);
  });

  it('should register all providers', () => {
    const names = registry.getAllProviderNames();
    assertEquals(names.includes('anthropic'), true);
    assertEquals(names.includes('openai'), true);
    assertEquals(names.includes('google'), true);
  });

  it('should get provider by name', () => {
    const provider = registry.getProvider('anthropic');
    assertExists(provider);
    assertEquals(provider.name, 'anthropic');
  });

  it('should return undefined for unknown provider', () => {
    const provider = registry.getProvider('unknown' as 'anthropic');
    assertEquals(provider, undefined);
  });

  it('should return best provider in priority order', async () => {
    mockEnv({
      ANTHROPIC_API_KEY: 'key1',
      OPENAI_API_KEY: 'key2',
      GOOGLE_API_KEY: 'key3',
    });

    const best = await registry.getBestProvider();
    assertExists(best);
    assertEquals(best.name, 'anthropic');
  });

  it('should fallback to next provider when first unavailable', async () => {
    mockEnv({
      OPENAI_API_KEY: 'key',
    });

    const best = await registry.getBestProvider();
    assertExists(best);
    assertEquals(best.name, 'openai');
  });

  it('should return null when no providers available', async () => {
    mockEnv({});
    const best = await registry.getBestProvider();
    assertEquals(best, null);
  });

  it('should respect preferred provider option', async () => {
    mockEnv({
      ANTHROPIC_API_KEY: 'key1',
      OPENAI_API_KEY: 'key2',
      GOOGLE_API_KEY: 'key3',
    });

    const best = await registry.getBestProvider({
      preferredProvider: 'google',
    });
    assertExists(best);
    assertEquals(best.name, 'google');
  });

  it('should exclude specified providers', async () => {
    mockEnv({
      ANTHROPIC_API_KEY: 'key1',
      OPENAI_API_KEY: 'key2',
      GOOGLE_API_KEY: 'key3',
    });

    const best = await registry.getBestProvider({
      excludeProviders: ['anthropic', 'openai'],
    });
    assertExists(best);
    assertEquals(best.name, 'google');
  });

  it('should filter by required model', async () => {
    mockEnv({
      ANTHROPIC_API_KEY: 'key1',
      OPENAI_API_KEY: 'key2',
    });

    const best = await registry.getBestProvider({
      requireModel: 'gpt-4o',
    });
    assertExists(best);
    assertEquals(best.name, 'openai');
  });

  it('should get available providers', async () => {
    mockEnv({
      ANTHROPIC_API_KEY: 'key1',
      GOOGLE_API_KEY: 'key3',
    });

    const available = await registry.getAvailableProviders();
    assertEquals(available.length, 2);
    assertEquals(
      available.map((p) => p.name).sort(),
      ['anthropic', 'google']
    );
  });

  it('should check if any provider is available', async () => {
    mockEnv({ ANTHROPIC_API_KEY: 'key' });
    assertEquals(await registry.hasAvailableProvider(), true);

    restoreEnv();
    mockEnv({});
    assertEquals(await registry.hasAvailableProvider(), false);
  });

  it('should throw when all providers fail in completeWithFallback', async () => {
    mockEnv({});
    await assertRejects(
      () =>
        registry.completeWithFallback({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      Error,
      'All providers failed'
    );
  });
});

describe('getProviderRegistry singleton', () => {
  beforeEach(() => {
    resetProviderRegistry();
  });

  it('should return same instance', () => {
    const instance1 = getProviderRegistry();
    const instance2 = getProviderRegistry();
    assertEquals(instance1, instance2);
  });

  it('should return new instance after reset', () => {
    const instance1 = getProviderRegistry();
    resetProviderRegistry();
    const instance2 = getProviderRegistry();
    assertEquals(instance1 !== instance2, true);
  });
});
