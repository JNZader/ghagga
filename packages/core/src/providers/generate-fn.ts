/**
 * GenerateTextFn abstraction — backend-agnostic LLM text generation.
 *
 * Decouples agent orchestration from the LLM backend. Agents call
 * `generateFn(system, prompt)` instead of directly importing AI SDK,
 * CLI bridge, or gateway functions.
 *
 * Three factory functions create GenerateTextFn instances for each backend:
 *   - createCLIBridgeGenerateFn — wraps generateViaCLI (child_process)
 *   - createGatewayGenerateFn   — wraps generateViaGateway (HTTP)
 *   - createOllamaGenerateFn    — wraps Ollama via OpenAI-compatible API
 */

import { generateViaCLI } from './cli-bridge.js';
import { generateViaGateway } from './gateway.js';

// ─── Types ──────────────────────────────────────────────────────

/** Result from any LLM text generation backend */
export interface GenerateResult {
  text: string;
  tokensUsed: number;
  provider: string;
  model: string;
}

/** Generic text generation function — abstracts CLI bridge, gateway, and Ollama */
export type GenerateTextFn = (system: string, prompt: string) => Promise<GenerateResult>;

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

// ─── Factory: Ollama — re-exported from ollama.ts ───────────────
export { createOllamaGenerateFn } from './ollama.js';
