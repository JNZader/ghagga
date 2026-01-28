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

  /**
   * Get a model's opinion on a proposal with the assigned stance
   */
  async getModelOpinion(
    proposal: string,
    modelConfig: ConsensusModelConfig
  ): Promise<ConsensusResponse> {
    const startTime = Date.now();
    const provider = this.providers.get(modelConfig.provider);

    if (!provider) {
      throw new Error(`Provider "${modelConfig.provider}" is not registered`);
    }

    const stancePrompt = STANCE_PROMPTS[modelConfig.stance];
    const systemPrompt = `You are a code reviewer participating in a consensus process.

${stancePrompt}

After your analysis, you MUST provide a structured response with:
1. Your DECISION: "approve", "reject", or "abstain"
2. Your CONFIDENCE: a number from 0 to 1 (e.g., 0.8 for 80% confident)
3. Your REASONING: a brief explanation

Format your final response as:
DECISION: [approve|reject|abstain]
CONFIDENCE: [0.0-1.0]
REASONING: [your explanation]`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Please review the following proposal:\n\n${proposal}` },
    ];

    const response = await provider.complete({
      messages,
      model: modelConfig.model,
      maxTokens: 2048,
      temperature: 0.3,
    });

    const responseTimeMs = Date.now() - startTime;
    const parsed = this.parseModelResponse(response.content);

    return {
      provider: modelConfig.provider,
      model: modelConfig.model,
      stance: modelConfig.stance,
      decision: parsed.decision,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      responseTimeMs,
      tokenUsage: response.usage,
    };
  }

  /**
   * Parse structured response from model output
   */
  private parseModelResponse(content: string): {
    decision: 'approve' | 'reject' | 'abstain';
    confidence: number;
    reasoning: string;
  } {
    const decisionMatch = content.match(/DECISION:\s*(approve|reject|abstain)/i);
    const confidenceMatch = content.match(/CONFIDENCE:\s*([\d.]+)/i);
    const reasoningMatch = content.match(/REASONING:\s*(.+)/is);

    const decision = (decisionMatch?.[1]?.toLowerCase() || 'abstain') as
      | 'approve'
      | 'reject'
      | 'abstain';

    let confidence = parseFloat(confidenceMatch?.[1] || '0.5');
    confidence = Math.max(0, Math.min(1, confidence));

    const reasoning =
      reasoningMatch?.[1]?.trim() || 'No reasoning provided';

    return { decision, confidence, reasoning };
  }

  /**
   * Run consensus process with multiple models in parallel
   */
  async runConsensus(
    proposal: string,
    models: ConsensusModelConfig[]
  ): Promise<ConsensusEngineResult> {
    const startTime = Date.now();

    if (models.length === 0) {
      throw new Error('At least one model is required for consensus');
    }

    // Run all models in parallel
    const responses = await Promise.all(
      models.map((m) => this.getModelOpinion(proposal, m))
    );

    // Calculate recommendation based on responses
    const recommendation = this.calculateRecommendation(responses);

    // Synthesize the results
    const synthesis = await this.synthesize(proposal, responses);

    // Calculate total tokens used
    const totalTokens = responses.reduce((sum, r) => {
      return sum + (r.tokenUsage?.totalTokens ?? 0);
    }, 0);

    const totalTimeMs = Date.now() - startTime;

    return {
      responses,
      synthesis,
      recommendation,
      totalTokens,
      totalTimeMs,
    };
  }

  /**
   * Calculate recommendation based on model responses
   */
  calculateRecommendation(responses: ConsensusResponse[]): {
    action: 'approve' | 'reject' | 'discuss';
    confidence: number;
  } {
    let forScore = 0;
    let againstScore = 0;
    let totalWeight = 0;

    for (const response of responses) {
      const weight = response.confidence;
      totalWeight += weight;

      if (response.decision === 'approve') {
        forScore += weight;
      } else if (response.decision === 'reject') {
        againstScore += weight;
      }
      // abstain doesn't contribute to either score
    }

    // Prevent division by zero
    if (totalWeight === 0) {
      return { action: 'discuss', confidence: 0 };
    }

    const normalizedFor = forScore / totalWeight;
    const normalizedAgainst = againstScore / totalWeight;
    const difference = Math.abs(normalizedFor - normalizedAgainst);

    // Decision thresholds
    const APPROVE_THRESHOLD = 0.6;
    const REJECT_THRESHOLD = 0.6;
    const MIN_CONFIDENCE = 0.3;

    if (normalizedFor >= APPROVE_THRESHOLD && difference >= MIN_CONFIDENCE) {
      return {
        action: 'approve',
        confidence: normalizedFor,
      };
    }

    if (normalizedAgainst >= REJECT_THRESHOLD && difference >= MIN_CONFIDENCE) {
      return {
        action: 'reject',
        confidence: normalizedAgainst,
      };
    }

    // Not enough consensus - needs discussion
    return {
      action: 'discuss',
      confidence: Math.max(normalizedFor, normalizedAgainst),
    };
  }

  /**
   * Synthesize model responses into a coherent summary
   */
  async synthesize(
    proposal: string,
    responses: ConsensusResponse[]
  ): Promise<string> {
    // If no synthesis model configured, generate a simple summary
    if (!this.config.synthesisModel) {
      return this.generateSimpleSynthesis(responses);
    }

    const provider = this.providers.get(this.config.synthesisModel.provider);
    if (!provider) {
      return this.generateSimpleSynthesis(responses);
    }

    const responseSummary = responses
      .map(
        (r) =>
          `[${r.provider}/${r.model}] Stance: ${r.stance}, Decision: ${r.decision}, ` +
          `Confidence: ${(r.confidence * 100).toFixed(0)}%\nReasoning: ${r.reasoning}`
      )
      .join('\n\n');

    const systemPrompt = `You are synthesizing multiple code review opinions into a coherent summary.
Be concise and highlight key points of agreement and disagreement.`;

    const userPrompt = `Original proposal:
${proposal}

Model opinions:
${responseSummary}

Please provide a concise synthesis of these opinions, highlighting:
1. Points of agreement
2. Points of disagreement
3. Key concerns raised
4. Overall assessment`;

    const response = await provider.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      model: this.config.synthesisModel.model,
      maxTokens: 1024,
      temperature: 0.5,
    });

    return response.content;
  }

  /**
   * Generate a simple synthesis without using an LLM
   */
  private generateSimpleSynthesis(responses: ConsensusResponse[]): string {
    const approvals = responses.filter((r) => r.decision === 'approve');
    const rejections = responses.filter((r) => r.decision === 'reject');
    const abstentions = responses.filter((r) => r.decision === 'abstain');

    const lines: string[] = [
      `**Consensus Summary**`,
      ``,
      `- Approvals: ${approvals.length}/${responses.length}`,
      `- Rejections: ${rejections.length}/${responses.length}`,
      `- Abstentions: ${abstentions.length}/${responses.length}`,
      ``,
    ];

    if (approvals.length > 0) {
      lines.push(`**In Favor:**`);
      approvals.forEach((r) => {
        lines.push(`- [${r.provider}/${r.model}]: ${r.reasoning.slice(0, 200)}...`);
      });
      lines.push(``);
    }

    if (rejections.length > 0) {
      lines.push(`**Against:**`);
      rejections.forEach((r) => {
        lines.push(`- [${r.provider}/${r.model}]: ${r.reasoning.slice(0, 200)}...`);
      });
      lines.push(``);
    }

    return lines.join('\n');
  }
}
