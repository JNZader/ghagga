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
 * Content item with priority for budget fitting
 */
export interface PrioritizedContent {
  content: string;
  priority: number; // Higher number = higher priority (kept first)
  type: 'files' | 'history' | 'rules';
}

/**
 * Result of fitting content to budget
 */
export interface FitResult {
  items: PrioritizedContent[];
  totalTokens: number;
  truncatedCount: number;
  droppedCount: number;
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

  /**
   * Truncate content to fit within a token limit
   * Appends truncation indicator when content is cut
   */
  static truncateToFit(content: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (content.length <= maxChars) {
      return content;
    }
    // Reserve space for truncation indicator
    const truncationIndicator = '\n\n... [TRUNCATED] ...';
    const availableChars = maxChars - truncationIndicator.length;
    if (availableChars <= 0) {
      return truncationIndicator;
    }
    return content.slice(0, availableChars) + truncationIndicator;
  }

  /**
   * Fit multiple content items within a total token budget
   *
   * Strategy:
   * 1. Sort items by priority (highest first)
   * 2. Add items until budget is reached
   * 3. If an item doesn't fit fully, truncate it
   * 4. Drop remaining items
   */
  static fitToBudget(
    items: PrioritizedContent[],
    maxTokens: number
  ): FitResult {
    // Sort by priority descending (higher priority first)
    const sorted = [...items].sort((a, b) => b.priority - a.priority);

    const result: PrioritizedContent[] = [];
    let totalTokens = 0;
    let truncatedCount = 0;
    let droppedCount = 0;

    for (const item of sorted) {
      const itemTokens = this.estimateTokens(item.content);
      const remainingBudget = maxTokens - totalTokens;

      if (remainingBudget <= 0) {
        // No budget left, drop remaining items
        droppedCount++;
        continue;
      }

      if (itemTokens <= remainingBudget) {
        // Item fits completely
        result.push(item);
        totalTokens += itemTokens;
      } else if (remainingBudget > 100) {
        // Partial fit - truncate the item (only if meaningful space remains)
        const truncatedContent = this.truncateToFit(item.content, remainingBudget);
        result.push({
          ...item,
          content: truncatedContent,
        });
        totalTokens += this.estimateTokens(truncatedContent);
        truncatedCount++;
      } else {
        // Not enough space for meaningful content, drop
        droppedCount++;
      }
    }

    return {
      items: result,
      totalTokens,
      truncatedCount,
      droppedCount,
    };
  }

  /**
   * Check if content fits within a token budget
   */
  static fitsInBudget(content: string, maxTokens: number): boolean {
    return this.estimateTokens(content) <= maxTokens;
  }

  /**
   * Calculate remaining tokens after accounting for used content
   */
  static remainingBudget(
    allocation: TokenAllocation,
    used: { files?: number; history?: number; rules?: number }
  ): TokenAllocation {
    return {
      total: allocation.total,
      content:
        allocation.content -
        (used.files || 0) -
        (used.history || 0) -
        (used.rules || 0),
      response: allocation.response,
      files: allocation.files - (used.files || 0),
      history: allocation.history - (used.history || 0),
      rules: allocation.rules - (used.rules || 0),
    };
  }
}
