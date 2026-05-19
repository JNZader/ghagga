/**
 * Provider validation and model listing.
 *
 * In ghagga v3 only three providers exist:
 * - `gateway`    — delegates to mcp-llm-bridge (vault-managed credentials)
 * - `cli-bridge` — calls local CLIs directly (Claude, OpenCode, Gemini, Copilot)
 * - `ollama`     — calls a local Ollama instance directly
 *
 * Legacy SaaS providers (anthropic/openai/google/github/qwen/groq/cerebras/
 * deepseek/openrouter) were removed when the SaaS server was torn down.
 * Legacy strings persisted in DB JSONB columns are remapped to `gateway`
 * at the runtime boundary by `normalizeLegacyProvider` in
 * `apps/server/src/queues/review.ts` — no validation path remains.
 */

import type { SaaSProvider } from 'ghagga-core';
import { getAvailableCLIs } from 'ghagga-core';
import { logger as rootLogger } from './logger.js';

const logger = rootLogger.child({ module: 'provider-models' });

// ─── Curated Model Lists ────────────────────────────────────────

/**
 * Static model lists exposed to the dashboard for provider/model selection.
 * Gateway and cli-bridge resolve their real model at review time; the curated
 * entries here only seed the dashboard dropdown.
 */
export const CURATED_MODELS: Record<SaaSProvider, string[]> = {
  'cli-bridge': ['auto', 'opencode', 'copilot', 'gemini'],
  gateway: ['auto'],
  ollama: ['llama3', 'llama3.1', 'codellama', 'mistral', 'gemma3', 'qwen2.5-coder'],
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
 * Validate a provider entry from the dashboard.
 *
 * - `gateway`    : always valid; the gateway URL is health-checked separately by the
 *                  `/api/settings/validate-provider` route before this function runs.
 * - `cli-bridge` : reports detected local CLI tools + curated OpenCode model suggestions.
 * - `ollama`     : always rejected — Ollama is local-only (CLI/Action), never SaaS.
 *
 * `apiKey` is accepted for API compatibility with prior versions but ignored —
 * none of the surviving providers consume one through this code path.
 */
export async function validateProviderKey(
  provider: SaaSProvider,
  _apiKey: string,
): Promise<ValidationResult> {
  try {
    switch (provider) {
      case 'cli-bridge': {
        const detectedCliTools = getAvailableCLIs();
        return {
          valid: true,
          models: ['auto', ...detectedCliTools],
          detectedCliTools,
          cliModelSuggestions: detectedCliTools.includes('opencode') ? CURATED_OPENCODE_MODELS : [],
        };
      }
      case 'gateway': {
        return { valid: true, models: ['auto'] };
      }
      case 'ollama': {
        return {
          valid: false,
          models: [],
          error: 'Ollama is not available in the SaaS dashboard. Use CLI or Action instead.',
        };
      }
      default: {
        const _exhaustive: never = provider;
        return { valid: false, models: [], error: `Unknown provider: ${String(_exhaustive)}` };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ provider, error: message }, 'Provider validation failed');
    return { valid: false, models: [], error: message };
  }
}
