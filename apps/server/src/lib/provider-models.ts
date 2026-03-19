/**
 * Provider validation and model listing.
 *
 * Validates API keys by testing against provider APIs and returns
 * available models. For providers without a models endpoint
 * (Anthropic, Google), we use a curated static list + a minimal
 * API call to validate the key.
 */

import type { SaaSProvider } from 'ghagga-core';
import { getAvailableCLIs } from 'ghagga-core';
import { logger as rootLogger } from './logger.js';

const logger = rootLogger.child({ module: 'provider-models' });

// ─── Curated Model Lists ────────────────────────────────────────

/**
 * Static model lists for providers that don't expose a /models endpoint.
 * Updated manually when new models are released.
 */
export const CURATED_MODELS: Record<SaaSProvider, string[]> = {
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-4-20250414',
    'claude-3-5-haiku-20241022',
    'claude-3-5-sonnet-20241022',
  ],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'o3-mini'],
  google: [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ],
  github: ['gpt-4o-mini', 'gpt-4o', 'o3-mini', 'Phi-4', 'Mistral-Large-2411', 'DeepSeek-R1'],
  qwen: ['qwen-coder-plus', 'qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-coder-turbo', 'qwen-long'],
  groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  cerebras: ['llama3.1-8b', 'gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'zai-glm-4.7'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: [
    'deepseek/deepseek-chat',
    'deepseek/deepseek-r1:free',
    'google/gemma-3-27b-it:free',
    'qwen/qwen3-235b-a22b:free',
    'anthropic/claude-sonnet-4',
    'openai/gpt-4o',
    'google/gemini-2.5-flash',
  ],
  'cli-bridge': ['auto', 'opencode', 'copilot', 'gemini'],
};

/**
 * Curated OpenCode model suggestions for the dashboard.
 * These are well-known models that work with OpenCode's `--model provider/model` flag.
 */
const CURATED_OPENCODE_MODELS = [
  // Free models — no API key needed
  'opencode/gpt-5-nano',
  'opencode/big-pickle',
  'opencode/mimo-v2-pro-free',
  'opencode/minimax-m2.5-free',
  'opencode/nemotron-3-super-free',
  'opencode/mimo-v2-omni-free',
  // Paid models — require provider API key
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-5-codex',
  'groq/openai/gpt-oss-120b',
  'openrouter/deepseek/deepseek-chat',
];

// ─── Validation ─────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  models: string[];
  error?: string;
  /** Detected CLI tools on the server (cli-bridge only). */
  detectedCliTools?: string[];
  /** Curated OpenCode model suggestions (cli-bridge only, when opencode is detected). */
  cliModelSuggestions?: string[];
}

/**
 * Validate an API key against a provider and return available models.
 *
 * - OpenAI/GitHub Models: fetches GET /v1/models dynamically
 * - Anthropic: makes a minimal messages call to validate the key, returns curated list
 * - Google: makes a minimal generateContent call to validate, returns curated list
 */
export async function validateProviderKey(
  provider: SaaSProvider,
  apiKey: string,
): Promise<ValidationResult> {
  try {
    switch (provider) {
      case 'openai':
        return await validateOpenAI(apiKey, 'https://api.openai.com/v1');
      case 'github':
        return await validateOpenAI(apiKey, 'https://models.inference.ai.azure.com');
      case 'anthropic':
        return await validateAnthropic(apiKey);
      case 'google':
        return await validateGoogle(apiKey);
      case 'qwen':
        return await validateQwen(apiKey);
      case 'groq':
        return await validateOpenAICompat(apiKey, 'https://api.groq.com/openai/v1', 'groq');
      case 'cerebras':
        return await validateOpenAICompat(apiKey, 'https://api.cerebras.ai/v1', 'cerebras');
      case 'deepseek':
        return await validateOpenAICompat(apiKey, 'https://api.deepseek.com/v1', 'deepseek');
      case 'openrouter':
        return await validateOpenAICompat(apiKey, 'https://openrouter.ai/api/v1', 'openrouter');
      case 'cli-bridge': {
        // CLI Bridge doesn't need API key validation — it uses local CLIs.
        // Return detected tools and curated OpenCode model suggestions.
        const detectedCliTools = getAvailableCLIs();
        return {
          valid: true,
          models: ['auto', ...detectedCliTools],
          detectedCliTools,
          cliModelSuggestions: detectedCliTools.includes('opencode') ? CURATED_OPENCODE_MODELS : [],
        };
      }
      default: {
        const _exhaustive: never = provider;
        return { valid: false, models: [], error: `Unknown provider: ${_exhaustive}` };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ provider, error: message }, 'Provider validation failed');
    return { valid: false, models: [], error: message };
  }
}

// ─── Provider-Specific Validators ───────────────────────────────

/**
 * OpenAI-compatible validation (works for OpenAI and GitHub Models).
 * Fetches /v1/models and filters to chat-capable models.
 */
async function validateOpenAI(apiKey: string, baseUrl: string): Promise<ValidationResult> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      return { valid: false, models: [], error: 'Invalid API key' };
    }
    return {
      valid: false,
      models: [],
      error: `API error ${response.status}: ${text.substring(0, 200)}`,
    };
  }

  const data = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> };
  const allModels = data.data ?? [];

  // Filter out non-chat models (embeddings, tts, dall-e, whisper, etc.)
  const excludePatterns = [
    'embedding',
    'tts',
    'dall-e',
    'whisper',
    'davinci',
    'babbage',
    'moderation',
  ];
  const chatModels = allModels
    .map((m) => m.id)
    .filter((id) => !excludePatterns.some((p) => id.toLowerCase().includes(p)))
    .sort();

  return { valid: true, models: chatModels.length > 0 ? chatModels : CURATED_MODELS.openai };
}

/**
 * Anthropic validation via a minimal messages API call.
 * The key is valid if we get any response (even an error about empty content).
 */
async function validateAnthropic(apiKey: string): Promise<ValidationResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
    signal: AbortSignal.timeout(15_000),
  });

  // 401/403 = invalid key
  if (response.status === 401 || response.status === 403) {
    return { valid: false, models: [], error: 'Invalid API key' };
  }

  // Any other response (200, 400, 429) means the key is valid
  // (400 = bad request but key works, 429 = rate limited but key works)
  return { valid: true, models: CURATED_MODELS.anthropic };
}

/**
 * Qwen / DashScope validation via the OpenAI-compatible models endpoint.
 * Uses the international (Singapore) endpoint.
 */
async function validateQwen(apiKey: string): Promise<ValidationResult> {
  const response = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { valid: false, models: [], error: 'Invalid API key' };
    }
    // If models endpoint fails but key format looks valid, fall back to curated list
    // by trying a minimal chat completion
    const chatResponse = await fetch(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen-turbo',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (chatResponse.status === 401 || chatResponse.status === 403) {
      return { valid: false, models: [], error: 'Invalid API key' };
    }

    // Any other response (200, 400, 429) means the key is valid
    return { valid: true, models: CURATED_MODELS.qwen };
  }

  // Parse models from response (OpenAI format)
  const data = (await response.json()) as { data?: Array<{ id: string }> };
  const allModels = data.data ?? [];

  // Filter to text generation models (exclude embedding, audio, vision-only)
  const excludePatterns = ['embedding', 'audio', 'vl-', 'ocr', 'rerank'];
  const textModels = allModels
    .map((m) => m.id)
    .filter((id) => !excludePatterns.some((p) => id.toLowerCase().includes(p)))
    .sort();

  return { valid: true, models: textModels.length > 0 ? textModels : CURATED_MODELS.qwen };
}

/**
 * Generic OpenAI-compatible validation (Groq, Cerebras, DeepSeek, OpenRouter).
 * Tries GET /models first; falls back to curated list if the endpoint is unavailable.
 */
async function validateOpenAICompat(
  apiKey: string,
  baseUrl: string,
  provider: SaaSProvider,
): Promise<ValidationResult> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { valid: false, models: [], error: 'Invalid API key' };
    }
    // Models endpoint unavailable (some providers don't expose it) — key might still be valid.
    // Return curated list as fallback.
    return { valid: true, models: CURATED_MODELS[provider] };
  }

  const data = (await response.json()) as { data?: Array<{ id: string }> };
  const allModels = data.data ?? [];

  const excludePatterns = ['embedding', 'tts', 'whisper', 'dall-e', 'moderation', 'audio'];
  const chatModels = allModels
    .map((m) => m.id)
    .filter((id) => !excludePatterns.some((p) => id.toLowerCase().includes(p)))
    .sort();

  return {
    valid: true,
    models: chatModels.length > 0 ? chatModels : CURATED_MODELS[provider],
  };
}

/**
 * Google Generative AI validation via a minimal generateContent call.
 */
async function validateGoogle(apiKey: string): Promise<ValidationResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (response.status === 400 || response.status === 403) {
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = data.error?.message ?? 'Invalid API key';
    if (msg.toLowerCase().includes('api key')) {
      return { valid: false, models: [], error: 'Invalid API key' };
    }
  }

  if (response.status === 401) {
    return { valid: false, models: [], error: 'Invalid API key' };
  }

  // 200 or 429 = key is valid
  return { valid: true, models: CURATED_MODELS.google };
}
