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
 * AI Provider interface for LLM interactions
 * Compatible with providers from T-005 provider registry
 */
export interface AIProvider {
  readonly name: LLMProvider;
  readonly models: string[];
  complete(options: LLMRequestOptions): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}

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

/**
 * Model configuration for consensus participation
 */
export interface ConsensusModelConfig {
  provider: string;
  model: string;
  stance: Stance;
  weight?: number;
}

/**
 * Individual response from a model in consensus
 */
export interface ConsensusResponse {
  provider: string;
  model: string;
  stance: Stance;
  decision: 'approve' | 'reject' | 'abstain';
  confidence: number;
  reasoning: string;
  responseTimeMs: number;
  tokenUsage?: TokenUsage;
}

/**
 * Final consensus result
 */
export interface ConsensusEngineResult {
  responses: ConsensusResponse[];
  synthesis: string;
  recommendation: {
    action: 'approve' | 'reject' | 'discuss';
    confidence: number;
  };
  totalTokens: number;
  totalTimeMs: number;
}

/**
 * Configuration for the consensus engine
 */
export interface ConsensusEngineConfig {
  timeoutMs?: number;
  maxRetries?: number;
  synthesisModel?: {
    provider: string;
    model: string;
  };
}

/**
 * ConsensusEngine orchestrates multi-model consensus building
 */
export class ConsensusEngine {
  private providers: Map<string, AIProvider>;
  private config: ConsensusEngineConfig;

  constructor(config: ConsensusEngineConfig = {}) {
    this.providers = new Map();
    this.config = {
      timeoutMs: config.timeoutMs ?? 60000,
      maxRetries: config.maxRetries ?? 2,
      synthesisModel: config.synthesisModel,
    };
  }

  /**
   * Register an AI provider for use in consensus
   */
  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get a registered provider by name
   */
  getProvider(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Check if a provider is registered
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Get all registered provider names
   */
  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }
}
