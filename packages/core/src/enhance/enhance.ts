/**
 * AI Enhance — post-analysis intelligence layer.
 *
 * Calls an LLM to group, prioritize, and filter static analysis findings.
 * Failures are non-blocking — returns empty result on any error.
 */

import { createModel } from '../providers/index.js';
import { generateTextWithTimeout } from '../utils/llm-timeout.js';
import type { LLMProvider, ReviewFinding } from '../types.js';
import {
  buildEnhancePrompt,
  ENHANCE_SYSTEM_PROMPT,
  serializeFindings,
  truncateByTokenBudget,
} from './prompt.js';
import type { EnhanceInput, EnhanceMetadata, EnhanceResult } from './types.js';

/** A ReviewFinding augmented with AI enhance metadata. */
export interface EnhancedReviewFinding extends ReviewFinding {
  groupId?: string;
  aiPriority?: number;
  aiFiltered?: boolean;
  filterReason?: string;
}

/** Default token budget for the enhance prompt (4K tokens). */
const DEFAULT_TOKEN_BUDGET = 4000;

/** Empty result returned on failure or zero findings. */
const EMPTY_RESULT: EnhanceResult = {
  groups: [],
  priorities: {},
  suggestions: {},
  filtered: [],
};

/**
 * Enhance static analysis findings using AI.
 *
 * @param input - Findings and LLM configuration
 * @returns Enhanced result with groups, priorities, suggestions, and filtered findings
 */
export async function enhanceFindings(
  input: EnhanceInput,
): Promise<{ result: EnhanceResult; metadata: EnhanceMetadata }> {
  // Skip AI call if no findings
  if (input.findings.length === 0) {
    return {
      result: EMPTY_RESULT,
      metadata: {
        model: input.model,
        tokenUsage: { input: 0, output: 0 },
        groupCount: 0,
        filteredCount: 0,
      },
    };
  }

  try {
    // Truncate to fit token budget
    const truncated = truncateByTokenBudget(input.findings, DEFAULT_TOKEN_BUDGET);
    const prompt = buildEnhancePrompt(truncated);

    // Call LLM
    const model = createModel(input.provider as LLMProvider, input.model, input.apiKey);
    const response = await generateTextWithTimeout(
      {
        model,
        system: ENHANCE_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: 2000,
      },
      { provider: input.provider, model: input.model },
    );

    // Timeout: return empty result (enhance is already non-blocking)
    if (response === null) {
      return {
        result: EMPTY_RESULT,
        metadata: {
          model: input.model,
          tokenUsage: { input: 0, output: 0 },
          groupCount: 0,
          filteredCount: 0,
        },
      };
    }

    // Parse response
    const parsed = parseEnhanceResponse(response.text);

    return {
      result: parsed,
      metadata: {
        model: input.model,
        tokenUsage: {
          input: response.usage?.inputTokens ?? 0,
          output: response.usage?.outputTokens ?? 0,
        },
        groupCount: parsed.groups.length,
        filteredCount: parsed.filtered.length,
      },
    };
  } catch {
    // Non-blocking — return empty result on any error
    return {
      result: EMPTY_RESULT,
      metadata: {
        model: input.model,
        tokenUsage: { input: 0, output: 0 },
        groupCount: 0,
        filteredCount: 0,
      },
    };
  }
}

/**
 * Parse the LLM response text into an EnhanceResult.
 * Gracefully handles malformed JSON.
 */
function parseEnhanceResponse(text: string): EnhanceResult {
  try {
    // Extract JSON from response (may have markdown code fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return EMPTY_RESULT;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      priorities:
        typeof parsed.priorities === 'object' && parsed.priorities !== null
          ? parsed.priorities
          : {},
      suggestions:
        typeof parsed.suggestions === 'object' && parsed.suggestions !== null
          ? parsed.suggestions
          : {},
      filtered: Array.isArray(parsed.filtered) ? parsed.filtered : [],
    };
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * Merge enhance results back onto the original findings.
 * Assigns groupId, aiPriority, aiFiltered, and filterReason.
 */
export function mergeEnhanceResult(
  findings: ReviewFinding[],
  enhanceResult: EnhanceResult,
): EnhancedReviewFinding[] {
  // Build lookup maps
  const groupByFindingId = new Map<number, string>();
  for (const group of enhanceResult.groups) {
    for (const id of group.findingIds) {
      groupByFindingId.set(id, group.groupId);
    }
  }

  const filteredMap = new Map<number, string>();
  for (const f of enhanceResult.filtered) {
    filteredMap.set(f.findingId, f.reason);
  }

  return findings.map((finding, index) => {
    const id = index + 1; // IDs are 1-based from serializeFindings
    const enhanced: EnhancedReviewFinding = { ...finding };

    const groupId = groupByFindingId.get(id);
    if (groupId) enhanced.groupId = groupId;

    const priority = enhanceResult.priorities[id];
    if (priority !== undefined) enhanced.aiPriority = priority;

    const suggestion = enhanceResult.suggestions[id];
    if (suggestion) enhanced.suggestion = suggestion;

    const filterReason = filteredMap.get(id);
    if (filterReason) {
      enhanced.aiFiltered = true;
      enhanced.filterReason = filterReason;
    }

    return enhanced;
  });
}
