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
  /**
   * Measured prompt token count (AI SDK v5 `usage.inputTokens`),
   * graph-context-retrieval T5.1. Undefined when the backend does not
   * report a split (most CLI adapters; the gateway only when the bridge
   * sends prompt_tokens/completion_tokens through).
   */
  inputTokens?: number;
  /** Measured completion token count — undefined when unmeasured. */
  outputTokens?: number;
}

/** Generic text generation function — abstracts CLI bridge, gateway, and Ollama */
export type GenerateTextFn = (system: string, prompt: string) => Promise<GenerateResult>;

// ─── Factory: CLI Bridge ────────────────────────────────────────

/**
 * Create a GenerateTextFn backed by the CLI bridge (child_process).
 *
 * Wraps `generateViaCLI`. `tokensUsed` stays 0 for CLIs that report no
 * usage; when the adapter DOES report a split (opencode's step_finish
 * events), the split is wired through and the total becomes
 * input + output (spec: total = inputTokens + outputTokens).
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
    const inputTokens = result.tokens?.input;
    const outputTokens = result.tokens?.output;
    return {
      text: result.text,
      // CLI tools without usage reporting stay 0 (pre-existing behavior);
      // a measured split upgrades the total to input + output.
      tokensUsed:
        inputTokens !== undefined || outputTokens !== undefined
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : 0,
      provider: 'cli-bridge',
      model: result.cli,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
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
  provider?: string;
  model?: string;
  project?: string;
}): GenerateTextFn {
  return async (system, prompt) => {
    const result = await generateViaGateway(prompt, system, options);
    // Split fields are optional in the gateway protocol: a bridge that does
    // not report them leaves the GenerateResult split undefined (measured
    // total only); one that does (OpenAI-compatible prompt_tokens /
    // completion_tokens) flows the split through untouched. tokensUsed stays
    // the gateway-reported total either way.
    const inputTokens = result.inputTokens;
    const outputTokens = result.outputTokens;
    return {
      text: result.text,
      tokensUsed: result.tokensUsed ?? 0,
      provider: result.provider,
      model: result.model,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  };
}

// ─── Factory: Ollama — re-exported from ollama.ts ───────────────
export { createGroqGenerateFn } from './groq.js';
export { createOllamaGenerateFn } from './ollama.js';
