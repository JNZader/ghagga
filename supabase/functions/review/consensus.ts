/**
 * Consensus Review - Multi-model agreement for code review decisions
 *
 * Uses the ConsensusEngine to gather opinions from multiple LLM models
 * with different stances (for/against/neutral) to reach a balanced decision.
 */

import type { LLMProvider, LLMRequestOptions, LLMResponse } from '../_shared/types/providers.ts';
import type { ReviewFile } from '../_shared/types/database.ts';
import {
  ConsensusEngine,
  type AIProvider,
  type ConsensusModelConfig,
  type ConsensusEngineResult,
  type Stance,
} from '../_shared/consensus/engine.ts';
import type { ReviewFinding } from './simple.ts';

/**
 * Context for consensus review execution
 */
export interface ConsensusReviewContext {
  /** Repository rules and guidelines */
  rules: string;
  /** Files changed in the PR */
  files: ReviewFile[];
  /** Combined diff/patch content */
  diff: string;
  /** PR title */
  prTitle?: string;
  /** PR description/body */
  prBody?: string;
}

/**
 * Model configuration for consensus review
 */
export interface ConsensusModelSpec {
  /** Provider name */
  provider: LLMProvider;
  /** Model identifier */
  model: string;
  /** Stance to take (for/against/neutral) */
  stance: Stance;
  /** Optional weight for voting (default: 1.0) */
  weight?: number;
}

/**
 * Configuration for consensus review
 */
export interface ConsensusReviewConfig {
  /** Models to participate in consensus */
  models: ConsensusModelSpec[];
  /** Timeout per model in milliseconds */
  timeoutMs?: number;
  /** Model to use for synthesis (optional) */
  synthesisModel?: {
    provider: LLMProvider;
    model: string;
  };
}

/**
 * Result from consensus review execution
 */
export interface ConsensusReviewResult {
  /** Overall review status based on consensus */
  status: 'passed' | 'failed' | 'discuss';
  /** Summary synthesized from model opinions */
  summary: string;
  /** Aggregated findings from all models */
  findings: ReviewFinding[];
  /** Recommendation from consensus */
  recommendation: {
    action: 'approve' | 'reject' | 'discuss';
    confidence: number;
  };
  /** Individual model responses */
  modelResponses: ModelVoteSummary[];
  /** Total tokens used across all models */
  totalTokensUsed: number;
  /** Total execution time in milliseconds */
  durationMs: number;
}

/**
 * Summary of an individual model's vote
 */
export interface ModelVoteSummary {
  /** Provider name */
  provider: string;
  /** Model name */
  model: string;
  /** Assigned stance */
  stance: Stance;
  /** Vote decision */
  decision: 'approve' | 'reject' | 'abstain';
  /** Confidence in decision (0-1) */
  confidence: number;
  /** Brief reasoning */
  reasoning: string;
  /** Response time in milliseconds */
  responseTimeMs: number;
}

/**
 * Provider adapter to wrap LLM caller for ConsensusEngine
 */
class ProviderAdapter implements AIProvider {
  readonly name: LLMProvider;
  readonly models: string[];
  private llmCaller: (options: LLMRequestOptions) => Promise<LLMResponse>;

  constructor(
    name: LLMProvider,
    models: string[],
    llmCaller: (options: LLMRequestOptions) => Promise<LLMResponse>
  ) {
    this.name = name;
    this.models = models;
    this.llmCaller = llmCaller;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    return this.llmCaller(options);
  }

  async isAvailable(): Promise<boolean> {
    return true; // Availability is managed by the caller
  }
}

/**
 * Default consensus review configuration
 */
const DEFAULT_MODELS: ConsensusModelSpec[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-20250514', stance: 'for' },
  { provider: 'openai', model: 'gpt-4o', stance: 'against' },
  { provider: 'google', model: 'gemini-2.0-flash', stance: 'neutral' },
];

/**
 * Execute a consensus review using multiple models
 *
 * The consensus process:
 * 1. Each model reviews the code with an assigned stance
 * 2. Models vote approve/reject/abstain with confidence
 * 3. Votes are aggregated with optional weighting
 * 4. A synthesis combines all perspectives
 *
 * @param context - Review context with rules, files, and diff
 * @param llmCaller - Function to call the LLM
 * @param config - Consensus configuration with model selection
 * @returns Consensus review result
 */
export async function executeConsensusReview(
  context: ConsensusReviewContext,
  llmCaller: (options: LLMRequestOptions) => Promise<LLMResponse>,
  config?: Partial<ConsensusReviewConfig>
): Promise<ConsensusReviewResult> {
  const startTime = Date.now();

  try {
    // Build the proposal (code changes to review)
    const proposal = buildConsensusProposal(context);

    // Create consensus engine
    const engine = new ConsensusEngine({
      timeoutMs: config?.timeoutMs ?? 60000,
      synthesisModel: config?.synthesisModel,
    });

    // Register providers for each unique provider in the config
    const models = config?.models ?? DEFAULT_MODELS;
    const uniqueProviders = new Set(models.map((m) => m.provider));

    for (const providerName of uniqueProviders) {
      const providerModels = models
        .filter((m) => m.provider === providerName)
        .map((m) => m.model);

      const adapter = new ProviderAdapter(
        providerName,
        providerModels,
        llmCaller
      );
      engine.registerProvider(adapter);
    }

    // Also register synthesis model provider if specified
    if (config?.synthesisModel && !uniqueProviders.has(config.synthesisModel.provider)) {
      const adapter = new ProviderAdapter(
        config.synthesisModel.provider,
        [config.synthesisModel.model],
        llmCaller
      );
      engine.registerProvider(adapter);
    }

    // Prepare model configs for consensus
    const consensusModels: ConsensusModelConfig[] = models.map((m) => ({
      provider: m.provider,
      model: m.model,
      stance: m.stance,
      weight: m.weight,
    }));

    // Run consensus
    const result: ConsensusEngineResult = await engine.runConsensus(
      proposal,
      consensusModels
    );

    const durationMs = Date.now() - startTime;

    // Map responses to summaries
    const modelResponses: ModelVoteSummary[] = result.responses.map((r) => ({
      provider: r.provider,
      model: r.model,
      stance: r.stance,
      decision: r.decision,
      confidence: r.confidence,
      reasoning: truncateReasoning(r.reasoning),
      responseTimeMs: r.responseTimeMs,
    }));

    // Parse findings from model reasoning
    const findings = parseConsensusFindings(result);

    // Determine status from recommendation
    const status = mapRecommendationToStatus(result.recommendation.action);

    return {
      status,
      summary: result.synthesis,
      findings,
      recommendation: result.recommendation,
      modelResponses,
      totalTokensUsed: result.totalTokens,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      status: 'discuss',
      summary: `Consensus review failed: ${errorMessage}`,
      findings: [
        {
          severity: 'error',
          category: 'system',
          message: `Consensus execution failed: ${errorMessage}`,
        },
      ],
      recommendation: {
        action: 'discuss',
        confidence: 0,
      },
      modelResponses: [],
      totalTokensUsed: 0,
      durationMs,
    };
  }
}

/**
 * Build the proposal content for consensus review
 */
function buildConsensusProposal(context: ConsensusReviewContext): string {
  const parts: string[] = [];

  // Add PR context
  if (context.prTitle) {
    parts.push(`# Pull Request: ${context.prTitle}`);
  }

  if (context.prBody) {
    parts.push(`## Description\n${context.prBody}`);
  }

  // Add rules for context
  if (context.rules && context.rules.trim()) {
    parts.push(`## Repository Guidelines\n${context.rules}`);
  }

  // Add file summary
  const fileSummary = context.files
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join('\n');

  parts.push(`## Files Changed\n${fileSummary}`);

  // Add the diff
  parts.push(`## Code Changes\n\`\`\`diff\n${context.diff}\n\`\`\``);

  parts.push(`\nPlease review these changes and provide your assessment.`);

  return parts.join('\n\n');
}

/**
 * Parse findings from consensus model responses
 */
function parseConsensusFindings(result: ConsensusEngineResult): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const response of result.responses) {
    // Extract issues mentioned in reasoning
    const issues = extractIssuesFromReasoning(response.reasoning);

    for (const issue of issues) {
      findings.push({
        severity: mapDecisionToSeverity(response.decision, issue),
        category: mapStanceToCategory(response.stance),
        message: issue,
      });
    }
  }

  // Deduplicate similar findings
  const uniqueFindings = deduplicateFindings(findings);

  // Sort by severity
  const severityOrder: Record<string, number> = {
    error: 0,
    warning: 1,
    info: 2,
    suggestion: 3,
  };

  uniqueFindings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return uniqueFindings;
}

/**
 * Extract specific issues from model reasoning
 */
function extractIssuesFromReasoning(reasoning: string): string[] {
  const issues: string[] = [];

  // Look for bullet points or numbered items
  const bulletMatches = reasoning.match(/[-•*]\s+(.+?)(?=\n[-•*]|\n\n|$)/g);
  if (bulletMatches) {
    for (const match of bulletMatches) {
      const issue = match.replace(/^[-•*]\s+/, '').trim();
      if (issue.length > 10 && issue.length < 500) {
        issues.push(issue);
      }
    }
  }

  // Look for "concern", "issue", "problem", "risk" keywords
  const concernPatterns = [
    /(?:concern|issue|problem|risk|vulnerability|bug):\s*(.+?)(?=\.|$)/gi,
    /(?:should|must|need to)\s+(.+?)(?=\.|$)/gi,
  ];

  for (const pattern of concernPatterns) {
    let match;
    while ((match = pattern.exec(reasoning)) !== null) {
      const issue = match[1].trim();
      if (issue.length > 10 && issue.length < 300 && !issues.includes(issue)) {
        issues.push(issue);
      }
    }
  }

  // Limit to most relevant issues
  return issues.slice(0, 5);
}

/**
 * Map model decision to finding severity
 */
function mapDecisionToSeverity(
  decision: 'approve' | 'reject' | 'abstain',
  _issue: string
): ReviewFinding['severity'] {
  switch (decision) {
    case 'reject':
      return 'warning';
    case 'abstain':
      return 'info';
    case 'approve':
    default:
      return 'suggestion';
  }
}

/**
 * Map model stance to finding category
 */
function mapStanceToCategory(stance: Stance): string {
  switch (stance) {
    case 'for':
      return 'benefits';
    case 'against':
      return 'concerns';
    case 'neutral':
    default:
      return 'analysis';
  }
}

/**
 * Deduplicate similar findings
 */
function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const unique: ReviewFinding[] = [];

  for (const finding of findings) {
    const isDuplicate = unique.some((f) => {
      const similarity = calculateSimilarity(f.message, finding.message);
      return similarity > 0.7;
    });

    if (!isDuplicate) {
      unique.push(finding);
    }
  }

  return unique;
}

/**
 * Calculate simple similarity between two strings
 */
function calculateSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return 1;

  const aWords = new Set(aLower.split(/\s+/));
  const bWords = new Set(bLower.split(/\s+/));

  const intersection = new Set([...aWords].filter((w) => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);

  return intersection.size / union.size;
}

/**
 * Map recommendation action to review status
 */
function mapRecommendationToStatus(
  action: 'approve' | 'reject' | 'discuss'
): 'passed' | 'failed' | 'discuss' {
  switch (action) {
    case 'approve':
      return 'passed';
    case 'reject':
      return 'failed';
    case 'discuss':
    default:
      return 'discuss';
  }
}

/**
 * Truncate reasoning for summary display
 */
function truncateReasoning(reasoning: string, maxLength: number = 300): string {
  if (reasoning.length <= maxLength) {
    return reasoning;
  }

  return reasoning.slice(0, maxLength - 3) + '...';
}
