/**
 * Groq provider — OpenAI-compatible chat completions at api.groq.com.
 *
 * Uses `@ai-sdk/openai` pointed at https://api.groq.com/openai/v1.
 * `.chat()` is required: the provider's default callable talks to OpenAI's
 * Responses API, which Groq does not implement.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { GenerateTextFn } from './generate-fn.js';

/** Groq's OpenAI-compatible API root (chat completions live under /chat/completions). */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Create a GenerateTextFn that calls Groq chat completions.
 *
 * @param model - Groq model id (e.g. 'openai/gpt-oss-120b')
 * @param apiKey - Groq API key (gsk_...)
 */
export function createGroqGenerateFn(model: string, apiKey: string): GenerateTextFn {
  const groq = createOpenAI({ baseURL: GROQ_BASE_URL, apiKey });
  const groqModel = groq.chat(model);

  return async (system, prompt) => {
    const result = await generateText({ model: groqModel, system, prompt });
    return {
      text: result.text,
      tokensUsed: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      provider: 'groq',
      model,
    };
  };
}
