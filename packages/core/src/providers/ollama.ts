/**
 * Ollama provider — calls a local Ollama instance via OpenAI-compatible API.
 *
 * Uses @ai-sdk/openai pointed at http://localhost:11434/v1.
 * No API key required — Ollama accepts 'ollama' as a dummy key.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { GenerateTextFn } from './generate-fn.js';

/** Default Ollama local inference endpoint (OpenAI-compatible) */
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/**
 * Create a GenerateTextFn that calls a local Ollama instance.
 *
 * @param model - Ollama model tag (e.g., 'llama3', 'qwen2.5-coder:7b')
 * @param baseURL - Ollama endpoint. Defaults to 'http://localhost:11434/v1'.
 */
export function createOllamaGenerateFn(
  model: string,
  baseURL = DEFAULT_OLLAMA_BASE_URL,
): GenerateTextFn {
  const ollama = createOpenAI({ baseURL, apiKey: 'ollama' });
  const ollamaModel = ollama(model);

  return async (system: string, prompt: string) => {
    const result = await generateText({ model: ollamaModel, system, prompt });
    return {
      text: result.text,
      tokensUsed: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      provider: 'ollama',
      model,
    };
  };
}
