/**
 * LLM Provider factory using the Vercel AI SDK.
 *
 * Wraps @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google,
 * GitHub Models, and Ollama behind a unified factory so the rest
 * of the codebase doesn't need to know which provider is being used.
 *
 * GitHub Models uses the OpenAI-compatible endpoint at
 * https://models.inference.ai.azure.com and authenticates with a
 * GitHub Personal Access Token (PAT) with `models:read` scope.
 *
 * Ollama runs locally and exposes an OpenAI-compatible endpoint at
 * http://localhost:11434/v1. No API key required.
 *
 * Qwen (Alibaba Cloud DashScope) uses the OpenAI-compatible endpoint at
 * https://dashscope-intl.aliyuncs.com/compatible-mode/v1. Requires a
 * DashScope API key (DASHSCOPE_API_KEY).
 *
 * Groq uses https://api.groq.com/openai/v1 (free tier: 1K–14.4K RPD).
 * Cerebras uses https://api.cerebras.ai/v1 (free tier: 14.4K RPD, ~3000 tok/s).
 * DeepSeek uses https://api.deepseek.com/v1 (near-free, no rate limit).
 * OpenRouter uses https://openrouter.ai/api/v1 (gateway to 200+ models).
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { LLMProvider } from '../types.js';

/** GitHub Models inference endpoint (OpenAI-compatible) */
const GITHUB_MODELS_BASE_URL = 'https://models.inference.ai.azure.com';

/** Ollama local inference endpoint (OpenAI-compatible) */
const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/** Qwen / DashScope international endpoint (OpenAI-compatible) */
const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

/** Groq Cloud inference endpoint (OpenAI-compatible) */
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/** Cerebras inference endpoint (OpenAI-compatible) */
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

/** DeepSeek inference endpoint (OpenAI-compatible) */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/** OpenRouter gateway endpoint (OpenAI-compatible) */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ─── Provider Factory ───────────────────────────────────────────

/**
 * Create a provider instance configured with the given API key.
 *
 * Returns the provider's model creator function, which can be called
 * with a model ID to get a LanguageModel instance.
 *
 * @param provider - Provider name ('anthropic' | 'openai' | 'google' | 'github' | 'ollama')
 * @param apiKey - Decrypted API key for the provider
 * @returns The provider's model creator function
 */
export function createProvider(provider: LLMProvider, apiKey: string) {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey });
    case 'openai':
      return createOpenAI({ apiKey });
    case 'google':
      return createGoogleGenerativeAI({ apiKey });
    case 'github':
      return createOpenAI({
        apiKey,
        baseURL: GITHUB_MODELS_BASE_URL,
        name: 'github-models',
      });
    case 'ollama':
      return createOpenAI({
        apiKey: apiKey || 'ollama',
        baseURL: OLLAMA_BASE_URL,
        name: 'ollama',
      });
    case 'qwen':
      return createOpenAI({
        apiKey,
        baseURL: QWEN_BASE_URL,
        name: 'qwen',
      });
    case 'groq':
      return createOpenAI({
        apiKey,
        baseURL: GROQ_BASE_URL,
        name: 'groq',
      });
    case 'cerebras': {
      const provider = createOpenAICompatible({
        name: 'cerebras',
        baseURL: CEREBRAS_BASE_URL,
        apiKey,
      });
      return ((modelId: string) => provider.chatModel(modelId)) as unknown as ReturnType<
        typeof createOpenAI
      >;
    }
    case 'deepseek': {
      const provider = createOpenAICompatible({
        name: 'deepseek',
        baseURL: DEEPSEEK_BASE_URL,
        apiKey,
      });
      return ((modelId: string) => provider.chatModel(modelId)) as unknown as ReturnType<
        typeof createOpenAI
      >;
    }
    case 'openrouter': {
      const provider = createOpenAICompatible({
        name: 'openrouter',
        baseURL: OPENROUTER_BASE_URL,
        apiKey,
      });
      return ((modelId: string) => provider.chatModel(modelId)) as unknown as ReturnType<
        typeof createOpenAI
      >;
    }
    case 'cli-bridge':
      // CLI Bridge does not use the AI SDK — it calls CLIs via child_process.
      // Return a dummy provider that throws if accidentally called via createModel().
      // The pipeline intercepts cli-bridge before reaching createModel().
      throw new Error(
        'cli-bridge provider cannot be used with createModel(). Use generateViaCLI() from providers/cli-bridge.js instead.',
      );
    case 'gateway':
      // Gateway does not use the AI SDK — it delegates to an external LLM Gateway service.
      // The pipeline intercepts gateway before reaching createModel().
      throw new Error(
        'gateway provider cannot be used with createModel(). Use generateViaGateway() from providers/gateway.js instead.',
      );
    default: {
      // Exhaustive check — TypeScript will error if a provider is missing
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}

// ─── Model Factory ──────────────────────────────────────────────

/**
 * Create a LanguageModel instance for the given provider + model combo.
 *
 * This is the primary entry point for the rest of the codebase.
 * It handles provider initialization and model creation in one step.
 *
 * @param provider - Provider name
 * @param model - Model identifier (e.g., "claude-sonnet-4-20250514")
 * @param apiKey - Decrypted API key
 * @returns A LanguageModel ready for use with AI SDK's generateText/streamText
 */
export function createModel(provider: LLMProvider, model: string, apiKey: string): LanguageModel {
  const providerInstance = createProvider(provider, apiKey);
  return providerInstance(model) as LanguageModel;
}
