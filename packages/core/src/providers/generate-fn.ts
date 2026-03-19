/**
 * GenerateTextFn abstraction — backend-agnostic LLM text generation.
 *
 * Decouples agent orchestration from the LLM backend. Agents call
 * `generateFn(system, prompt)` instead of directly importing AI SDK,
 * CLI bridge, or gateway functions.
 *
 * Three factory functions create GenerateTextFn instances for each backend:
 *   - createAISDKGenerateFn    — wraps AI SDK's createModel + generateTextWithTimeout
 *   - createCLIBridgeGenerateFn — wraps generateViaCLI (child_process)
 *   - createGatewayGenerateFn   — wraps generateViaGateway (HTTP)
 */

import type { LLMProvider } from '../types.js';
import { generateTextWithTimeout } from '../utils/llm-timeout.js';
import { generateViaCLI } from './cli-bridge.js';
import { generateViaGateway } from './gateway.js';
import { createModel } from './index.js';

// ─── Types ──────────────────────────────────────────────────────

/** Result from any LLM text generation backend */
export interface GenerateResult {
  text: string;
  tokensUsed: number;
  provider: string;
  model: string;
}

/** Generic text generation function — abstracts AI SDK, CLI bridge, and gateway */
export type GenerateTextFn = (system: string, prompt: string) => Promise<GenerateResult>;

// ─── Factory: AI SDK ────────────────────────────────────────────

/**
 * Create a GenerateTextFn backed by the Vercel AI SDK.
 *
 * Wraps `createModel` + `generateTextWithTimeout`. Converts the
 * `null` timeout sentinel into a thrown Error so agents get a
 * clean exception (caught by `allSettled`).
 *
 * @param provider - LLM provider name (e.g., 'anthropic', 'openai')
 * @param model - Model identifier (e.g., 'claude-sonnet-4-20250514')
 * @param apiKey - Decrypted API key
 */
export function createAISDKGenerateFn(
  provider: LLMProvider,
  model: string,
  apiKey: string,
): GenerateTextFn {
  return async (system, prompt) => {
    const languageModel = createModel(provider, model, apiKey);
    const result = await generateTextWithTimeout(
      { model: languageModel, system, prompt, temperature: 0.3 },
      { provider, model },
    );
    if (result === null) {
      throw new Error(`LLM call timed out (${provider}/${model})`);
    }
    return {
      text: result.text,
      tokensUsed: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
      provider,
      model,
    };
  };
}

// ─── Factory: CLI Bridge ────────────────────────────────────────

/**
 * Create a GenerateTextFn backed by the CLI bridge (child_process).
 *
 * Wraps `generateViaCLI`. Returns `tokensUsed: 0` because CLI
 * tools don't report token usage.
 *
 * @param options - CLI bridge options (preferredCLI, cliModel, credentials)
 */
export function createCLIBridgeGenerateFn(options: {
  preferredCLI?: string;
  cliModel?: string;
  credentials?: Record<string, string>;
}): GenerateTextFn {
  return async (system, prompt) => {
    const result = generateViaCLI(prompt, system, options);
    return {
      text: result.text,
      tokensUsed: 0, // CLI doesn't report tokens
      provider: 'cli-bridge',
      model: result.cli,
    };
  };
}

// ─── Factory: Gateway ───────────────────────────────────────────

/**
 * Create a GenerateTextFn backed by the LLM Gateway (HTTP).
 *
 * Wraps `generateViaGateway`. Maps gateway response fields into
 * the GenerateResult shape.
 *
 * @param options - Gateway connection options (URL, token, model, project)
 */
export function createGatewayGenerateFn(options: {
  gatewayUrl: string;
  gatewayToken: string;
  model?: string;
  project?: string;
}): GenerateTextFn {
  return async (system, prompt) => {
    const result = await generateViaGateway(prompt, system, options);
    return {
      text: result.text,
      tokensUsed: result.tokensUsed ?? 0,
      provider: result.provider,
      model: result.model,
    };
  };
}
