/**
 * Token budget management for LLM context windows.
 *
 * Different models have different context window sizes. This module
 * provides utilities to calculate how much of the token budget should
 * be allocated to the diff vs. surrounding context (system prompt,
 * static analysis, memory, stack hints).
 *
 * For providers with low TPM (Tokens Per Minute) limits on free tiers
 * (e.g., Groq, Cerebras), the effective context window is capped to
 * ensure individual requests don't exceed the TPM limit.
 */

// ─── Context Window Sizes ───────────────────────────────────────

/**
 * Known model context window sizes (in tokens).
 * Sourced from official provider documentation as of 2025.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-haiku-4-20250414': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,

  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'o3-mini': 128_000,

  // Google
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-3-flash': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,

  // Groq — context windows are large but FREE-TIER TPM limits are very low.
  // We cap to TPM limit since Groq rejects any single request exceeding TPM.
  // Free tier TPM: gpt-oss-120b=8K, llama-3.3-70b=12K, llama-3.1-8b=6K
  'openai/gpt-oss-120b': 6_000,
  'llama-3.3-70b-versatile': 8_000,
  'llama-3.1-70b-versatile': 8_000,
  'llama-3.1-8b-instant': 4_000,
  'gemma2-9b-it': 6_000,
  'mixtral-8x7b-32768': 12_000,
  'qwen-qwq-32b': 8_000,

  // Cerebras — very fast inference, generous limits
  'llama-3.3-70b': 128_000,
  'llama-3.1-8b': 128_000,
  'llama-3.1-70b': 128_000,
  'qwen-3-32b': 32_768,

  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,

  // GitHub Models
  'Phi-4': 16_000,
  'Mistral-Large-2411': 128_000,
  'DeepSeek-R1': 64_000,

  // Qwen
  'qwen-coder-plus': 128_000,
  'qwen-plus': 128_000,
  'qwen-max': 32_000,
  'qwen-turbo': 128_000,
  'qwen-coder-turbo': 128_000,
  'qwen-long': 1_000_000,
};

/** Default context window when the model is not in our lookup table. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Minimum effective context window.
 * Even for the most constrained models, we need at least this much
 * to produce a meaningful review (system prompt + small diff).
 */
const MINIMUM_CONTEXT_WINDOW = 2_000;

/** Fraction of total budget allocated to the diff content. */
const DIFF_BUDGET_RATIO = 0.7;

/** Fraction of total budget allocated to context (system, memory, static analysis). */
const CONTEXT_BUDGET_RATIO = 0.3;

// ─── Public API ─────────────────────────────────────────────────

/**
 * Get the context window size for a given model.
 *
 * Handles model name normalization:
 * - Strips common prefixes (e.g., "openai/gpt-oss-120b" → lookup "openai/gpt-oss-120b" first,
 *   then try "gpt-oss-120b")
 * - Falls back to DEFAULT_CONTEXT_WINDOW for truly unknown models
 *
 * @param model - Model identifier (e.g., "claude-sonnet-4-20250514", "openai/gpt-oss-120b")
 * @returns Context window size in tokens
 */
export function getContextWindow(model: string): number {
  // Direct lookup first
  if (model in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[model]!;
  }

  // Try without provider prefix (e.g., "deepseek/deepseek-chat" → "deepseek-chat")
  const slashIndex = model.indexOf('/');
  if (slashIndex !== -1) {
    const modelWithoutPrefix = model.slice(slashIndex + 1);
    if (modelWithoutPrefix in MODEL_CONTEXT_WINDOWS) {
      return MODEL_CONTEXT_WINDOWS[modelWithoutPrefix]!;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Calculate token budgets for diff and context.
 *
 * The diff gets 70% of the total context window, while surrounding
 * context (system prompt, memory, static analysis hints) gets 30%.
 * This ensures the diff always has enough room while leaving space
 * for enrichment.
 *
 * For very constrained models (e.g., Groq free tier with 6K effective window),
 * the budgets are still split 70/30 but the absolute numbers are much smaller,
 * ensuring the diff is aggressively truncated to fit.
 *
 * @param model - Model identifier
 * @returns Object with diffBudget and contextBudget in tokens
 */
export function calculateTokenBudget(model: string): {
  diffBudget: number;
  contextBudget: number;
} {
  const total = Math.max(getContextWindow(model), MINIMUM_CONTEXT_WINDOW);

  return {
    diffBudget: Math.floor(total * DIFF_BUDGET_RATIO),
    contextBudget: Math.floor(total * CONTEXT_BUDGET_RATIO),
  };
}
