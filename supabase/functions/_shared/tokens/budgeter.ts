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

  /**
   * Allocate token budget based on model capabilities
   *
   * Allocation ratios depend on context window size:
   * - Small models (<50k): 50% content, 50% response
   * - Medium models (50k-300k): 60% content, 40% response
   * - Large models (>300k): 80% content, 20% response
   *
   * Content is further divided:
   * - 50% for files
   * - 30% for conversation history
   * - 20% for rules/system prompts
   */
  static allocate(model: string): TokenAllocation {
    const caps = this.getCapabilities(model);
    const total = caps.contextWindow;

    // Determine content ratio based on context window size
    let contentRatio: number;
    if (total < 50000) {
      contentRatio = 0.5; // Small model - split evenly
    } else if (total < 300000) {
      contentRatio = 0.6; // Medium model - favor content
    } else {
      contentRatio = 0.8; // Large model - maximize content
    }

    const content = Math.floor(total * contentRatio);
    const response = Math.floor(total * (1 - contentRatio));

    // Subdivide content allocation
    const files = Math.floor(content * 0.5);
    const history = Math.floor(content * 0.3);
    const rules = Math.floor(content * 0.2);

    return { total, content, response, files, history, rules };
  }

  /**
   * Estimate token count for a given text
   * Uses a simple approximation of ~4 characters per token
   */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
