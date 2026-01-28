/**
 * Token Budgeter - Model-aware token allocation system
 *
 * Provides token budget allocation based on model capabilities,
 * with utilities for fitting content within budget constraints.
 */

/**
 * Token allocation breakdown for different content types
 */
export interface TokenAllocation {
  total: number;
  content: number;
  response: number;
  files: number;
  history: number;
  rules: number;
}

/**
 * Model capability information
 */
export interface ModelCapabilities {
  contextWindow: number;
  maxOutput: number;
}

/**
 * Known model capabilities
 * Maps model IDs to their context window and max output limits
 */
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // Anthropic models
  'claude-opus-4-5-20251101': { contextWindow: 200000, maxOutput: 32000 },
  'claude-sonnet-4-20250514': { contextWindow: 200000, maxOutput: 64000 },
  'claude-3-5-sonnet-20241022': { contextWindow: 200000, maxOutput: 8192 },
  'claude-3-5-haiku-20241022': { contextWindow: 200000, maxOutput: 8192 },
  'claude-3-opus-20240229': { contextWindow: 200000, maxOutput: 4096 },

  // OpenAI models
  'gpt-4o': { contextWindow: 128000, maxOutput: 16384 },
  'gpt-4o-mini': { contextWindow: 128000, maxOutput: 16384 },
  'gpt-4-turbo': { contextWindow: 128000, maxOutput: 4096 },
  'gpt-4': { contextWindow: 8192, maxOutput: 4096 },
  'gpt-3.5-turbo': { contextWindow: 16385, maxOutput: 4096 },

  // Google models
  'gemini-2.0-flash': { contextWindow: 1000000, maxOutput: 8192 },
  'gemini-1.5-pro': { contextWindow: 1000000, maxOutput: 8192 },
  'gemini-1.5-flash': { contextWindow: 1000000, maxOutput: 8192 },

  // Groq models
  'llama-3.1-70b-versatile': { contextWindow: 131072, maxOutput: 8192 },
  'llama-3.1-8b-instant': { contextWindow: 131072, maxOutput: 8192 },
  'mixtral-8x7b-32768': { contextWindow: 32768, maxOutput: 4096 },

  // Mistral models
  'mistral-large-latest': { contextWindow: 128000, maxOutput: 4096 },
  'mistral-small-latest': { contextWindow: 32000, maxOutput: 4096 },
};

/**
 * Default capabilities for unknown models
 */
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 100000,
  maxOutput: 4096,
};

/**
 * Token Budgeter class for managing token allocations
 */
export class TokenBudgeter {
  /**
   * Get capabilities for a specific model
   * Returns default capabilities if model is not found
   */
  static getCapabilities(model: string): ModelCapabilities {
    return MODEL_CAPABILITIES[model] || DEFAULT_CAPABILITIES;
  }

  /**
   * Check if a model is known in the capabilities map
   */
  static isKnownModel(model: string): boolean {
    return model in MODEL_CAPABILITIES;
  }

  /**
   * Get all known model IDs
   */
  static getKnownModels(): string[] {
    return Object.keys(MODEL_CAPABILITIES);
  }
}
