/**
 * Consensus Engine for multi-model agreement
 *
 * Implements a system where multiple LLM models can vote on proposals
 * with different stances (for/against/neutral) to reach consensus.
 */

import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  ChatMessage,
  TokenUsage,
} from '../types/index.ts';

/**
 * Stance represents the argumentative position a model takes
 */
export type Stance = 'for' | 'against' | 'neutral';

/**
 * Stance prompts instruct models how to approach their analysis
 */
export const STANCE_PROMPTS: Record<Stance, string> = {
  for: `Argue strongly IN FAVOR of this change. Focus on:
- Benefits and improvements it brings
- Problems it solves
- Why the approach is sound
Be constructive but advocate for approval.`,

  against: `Argue AGAINST this change. Focus on:
- Potential issues and risks
- What could go wrong
- Alternative approaches that might be better
Be constructive but highlight concerns.`,

  neutral: `Provide a BALANCED analysis of this change. Consider:
- Both benefits and drawbacks
- Trade-offs involved
Be objective and thorough.`,
};
