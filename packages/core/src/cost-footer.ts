/**
 * Cost footer — calculates and formats review cost from token usage
 * and model pricing. Appended to PR review comments so teams can
 * track AI review spend.
 */

// ── Pricing ──

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Approximate pricing per model family. Input/output split is estimated
 * at 70/30 when only total tokens are available.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'claude-3.5-sonnet': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-3-haiku': { inputPerMTok: 0.25, outputPerMTok: 1.25 },
  // OpenAI
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  'gpt-4-turbo': { inputPerMTok: 10, outputPerMTok: 30 },
  // Google
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gemini-2.5-flash': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  // Groq (free tier — cost is effectively 0)
  'llama-3': { inputPerMTok: 0, outputPerMTok: 0 },
  mixtral: { inputPerMTok: 0, outputPerMTok: 0 },
};

export function getModelPricing(model: string): ModelPricing | null {
  // Direct match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // Prefix match (handles version suffixes like claude-sonnet-4-20250514)
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key) || key.includes(model.split('-').slice(0, -1).join('-'))) {
      return pricing;
    }
  }

  return null;
}

// ── Cost Calculation ──

export interface ReviewCost {
  totalTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  costUSD: number;
  model: string;
  pricingFound: boolean;
}

/**
 * Estimate cost from total token count and model.
 * When only total tokens are known (no input/output split),
 * we estimate 70% input / 30% output based on typical review patterns.
 */
export function calculateReviewCost(
  totalTokens: number,
  model: string,
  options?: { inputTokens?: number; outputTokens?: number },
): ReviewCost {
  const pricing = getModelPricing(model);

  const inputTokens = options?.inputTokens ?? Math.round(totalTokens * 0.7);
  const outputTokens = options?.outputTokens ?? Math.round(totalTokens * 0.3);

  if (!pricing) {
    return {
      totalTokens,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
      costUSD: 0,
      model,
      pricingFound: false,
    };
  }

  const cost =
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return {
    totalTokens,
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    costUSD: Math.round(cost * 10000) / 10000,
    model,
    pricingFound: true,
  };
}

// ── Formatting ──

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * Format cost as a compact footer line for PR comments.
 * Returns empty string when tokens are 0 (static-only review).
 */
export function formatCostFooter(cost: ReviewCost): string {
  if (cost.totalTokens === 0) return '';

  const tokens = formatTokens(cost.totalTokens);

  if (!cost.pricingFound) {
    return `\n<sub>📊 ${tokens} tokens · \`${cost.model}\` · pricing unavailable</sub>\n`;
  }

  if (cost.costUSD === 0) {
    return `\n<sub>📊 ${tokens} tokens · \`${cost.model}\` · free tier</sub>\n`;
  }

  const dollars = cost.costUSD >= 1 ? `$${cost.costUSD.toFixed(2)}` : `$${cost.costUSD.toFixed(4)}`;

  return `\n<sub>📊 ${tokens} tokens · ${dollars} · \`${cost.model}\`</sub>\n`;
}
