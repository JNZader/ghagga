/**
 * Consensus review agent (multi-model voting).
 *
 * Each configured model reviews the code with an assigned stance
 * (for, against, neutral). Individual votes are parsed for
 * DECISION/CONFIDENCE/REASONING, then a weighted voting algorithm
 * determines the final outcome.
 *
 * Thresholds:
 *   - 60% weighted votes for approve/reject → that decision wins
 *   - 30% minimum confidence gap between approve and reject
 *   - If thresholds not met → NEEDS_HUMAN_REVIEW
 */

import { createModel } from '../providers/index.js';
import type {
  ConsensusStance,
  ConsensusVote,
  LLMProvider,
  ProgressCallback,
  ReviewLevel,
  ReviewResult,
  ReviewStatus,
} from '../types.js';
import { generateTextWithTimeout } from '../utils/llm-timeout.js';
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  CONSENSUS_AGAINST_SYSTEM,
  CONSENSUS_FOR_SYSTEM,
  CONSENSUS_NEUTRAL_SYSTEM,
  REVIEW_CALIBRATION,
} from './prompts.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ConsensusModelConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  stance: ConsensusStance;
}

export interface ConsensusReviewInput {
  diff: string;
  models: ConsensusModelConfig[];
  staticContext: string;
  memoryContext: string | null;
  stackHints: string;
  reviewLevel: ReviewLevel;
  onProgress?: ProgressCallback;
}

// ─── Constants ──────────────────────────────────────────────────

/** Minimum percentage of weighted votes to decide approve/reject */
const DECISION_THRESHOLD = 0.6;

/** Minimum gap between approve and reject confidence for a clear decision */
const CONFIDENCE_GAP_THRESHOLD = 0.3;

/** Map stance to system prompt */
const STANCE_PROMPTS: Record<ConsensusStance, string> = {
  for: CONSENSUS_FOR_SYSTEM,
  against: CONSENSUS_AGAINST_SYSTEM,
  neutral: CONSENSUS_NEUTRAL_SYSTEM,
};

// ─── Vote Parsing ───────────────────────────────────────────────

/**
 * Parse a single model's vote from its response text.
 *
 * Expects the format:
 *   DECISION: approve|reject|abstain
 *   CONFIDENCE: 0.0-1.0
 *   REASONING: ...
 */
export function parseVote(
  text: string,
  provider: LLMProvider,
  model: string,
  stance: ConsensusStance,
): ConsensusVote {
  // Extract DECISION
  const decisionMatch = /DECISION:\s*(approve|reject|abstain)/i.exec(text);
  const decision = (decisionMatch?.[1]?.toLowerCase() ?? 'abstain') as ConsensusVote['decision'];

  // Extract CONFIDENCE
  const confidenceMatch = /CONFIDENCE:\s*([\d.]+)/i.exec(text);
  let confidence = confidenceMatch ? parseFloat(confidenceMatch[1] ?? '0.5') : 0.5;
  confidence = Math.max(0, Math.min(1, confidence)); // Clamp to [0, 1]

  // Extract REASONING (everything after REASONING:)
  const reasoningMatch = /REASONING:\s*([\s\S]+?)$/i.exec(text);
  const reasoning = reasoningMatch?.[1]?.trim() ?? 'No reasoning provided.';

  return { provider, model, stance, decision, confidence, reasoning };
}

// ─── Voting Algorithm ───────────────────────────────────────────

/**
 * Calculate the final consensus from individual votes.
 *
 * Uses confidence-weighted voting:
 *   - Each vote's weight = confidence score
 *   - Approve weight = sum of approve confidences
 *   - Reject weight = sum of reject confidences
 *   - Abstain votes don't count toward either
 *
 * Decision rules:
 *   - If approve ratio ≥ 60% → PASSED
 *   - If reject ratio ≥ 60% → FAILED
 *   - If confidence gap < 30% → NEEDS_HUMAN_REVIEW
 */
export function calculateConsensus(votes: ConsensusVote[]): {
  status: ReviewStatus;
  summary: string;
} {
  let approveWeight = 0;
  let rejectWeight = 0;
  let totalWeight = 0;

  for (const vote of votes) {
    if (vote.decision === 'approve') {
      approveWeight += vote.confidence;
      totalWeight += vote.confidence;
    } else if (vote.decision === 'reject') {
      rejectWeight += vote.confidence;
      totalWeight += vote.confidence;
    }
    // abstain votes are counted but don't contribute weight
  }

  // Prevent division by zero
  if (totalWeight === 0) {
    return {
      status: 'NEEDS_HUMAN_REVIEW',
      summary: 'All models abstained. Manual review is recommended.',
    };
  }

  const approveRatio = approveWeight / totalWeight;
  const rejectRatio = rejectWeight / totalWeight;
  const gap = Math.abs(approveRatio - rejectRatio);

  // Check confidence gap
  if (gap < CONFIDENCE_GAP_THRESHOLD) {
    return {
      status: 'NEEDS_HUMAN_REVIEW',
      summary: `Consensus inconclusive (approve: ${(approveRatio * 100).toFixed(0)}%, reject: ${(rejectRatio * 100).toFixed(0)}%). The confidence gap (${(gap * 100).toFixed(0)}%) is below the ${(CONFIDENCE_GAP_THRESHOLD * 100).toFixed(0)}% threshold. Manual review recommended.`,
    };
  }

  // Check decision thresholds
  if (approveRatio >= DECISION_THRESHOLD) {
    return {
      status: 'PASSED',
      summary: `Consensus: APPROVED with ${(approveRatio * 100).toFixed(0)}% weighted confidence across ${votes.length} models.`,
    };
  }

  if (rejectRatio >= DECISION_THRESHOLD) {
    return {
      status: 'FAILED',
      summary: `Consensus: REJECTED with ${(rejectRatio * 100).toFixed(0)}% weighted confidence across ${votes.length} models.`,
    };
  }

  return {
    status: 'NEEDS_HUMAN_REVIEW',
    summary: `No clear consensus reached (approve: ${(approveRatio * 100).toFixed(0)}%, reject: ${(rejectRatio * 100).toFixed(0)}%). Manual review recommended.`,
  };
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Run a consensus (multi-model voting) code review.
 *
 * 1. Each model reviews the diff with its assigned stance prompt
 * 2. Parse each response for DECISION/CONFIDENCE/REASONING
 * 3. Calculate weighted consensus
 * 4. Build the final ReviewResult
 *
 * @param input - Review input with diff, model configs, and context
 * @returns ReviewResult with consensus-derived status and all vote reasoning
 */
export async function runConsensusReview(input: ConsensusReviewInput): Promise<ReviewResult> {
  const { diff, models, staticContext, memoryContext, stackHints, reviewLevel } = input;
  const emit = input.onProgress ?? (() => {});

  const startTime = Date.now();

  // Build the user prompt (same for all models)
  const userPrompt = `Review the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  emit({
    step: 'consensus-start',
    message: `Launching ${models.length} model votes in parallel`,
    detail: models.map((m) => `  → ${m.provider}/${m.model} (stance: ${m.stance})`).join('\n'),
  });

  // ── Step 1: Run all model votes in parallel ────────────────
  const votePromises = models.map(async (config) => {
    const system = [
      STANCE_PROMPTS[config.stance],
      staticContext,
      buildMemoryContext(memoryContext),
      stackHints,
      buildReviewLevelInstruction(reviewLevel),
      REVIEW_CALIBRATION,
    ]
      .filter(Boolean)
      .join('\n');

    const languageModel = createModel(config.provider, config.model, config.apiKey);

    const result = await generateTextWithTimeout(
      {
        model: languageModel,
        system,
        prompt: userPrompt,
        temperature: 0.3,
      },
      { provider: config.provider, model: config.model },
    );

    // Timeout: treat as a failed vote (consensus handles missing votes gracefully)
    if (result === null) {
      throw new Error(
        `LLM call timed out for ${config.provider}/${config.model} (stance: ${config.stance})`,
      );
    }

    const tokensUsed = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);

    return {
      vote: parseVote(result.text, config.provider, config.model, config.stance),
      tokensUsed,
    };
  });

  const results = await Promise.allSettled(votePromises);

  // ── Step 2: Collect votes and token usage ──────────────────
  const votes: ConsensusVote[] = [];
  let totalTokens = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const config = models[i];
    if (!result || !config) continue;

    if (result.status === 'fulfilled') {
      votes.push(result.value.vote);
      totalTokens += result.value.tokensUsed;
      const v = result.value.vote;
      emit({
        step: `vote-${config.stance}`,
        message: `✓ ${config.stance} (${config.provider}/${config.model}) → ${v.decision} (${(v.confidence * 100).toFixed(0)}% confidence)`,
        detail: v.reasoning,
      });
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn('[ghagga] Consensus model failed:', reason);
      emit({
        step: `vote-${config.stance}`,
        message: `✗ ${config.stance} (${config.provider}/${config.model}) — FAILED: ${reason}`,
      });
    }
  }

  emit({ step: 'consensus-voting', message: 'Calculating weighted consensus...' });

  // ── Step 3: Calculate consensus ────────────────────────────
  const { status, summary } = calculateConsensus(votes);

  const executionTimeMs = Date.now() - startTime;

  // Build detailed reasoning from all votes
  const voteDetails = votes
    .map(
      (v) =>
        `[${v.provider}/${v.model}] Stance: ${v.stance} | Decision: ${v.decision} | Confidence: ${v.confidence}\n${v.reasoning}`,
    )
    .join('\n\n---\n\n');

  return {
    status,
    summary: `${summary}\n\n## Individual Votes\n\n${voteDetails}`,
    findings: [], // Consensus mode produces votes, not individual findings
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext,
    metadata: {
      mode: 'consensus',
      provider: votes[0]?.provider ?? models[0]?.provider,
      model: votes[0]?.model ?? models[0]?.model,
      tokensUsed: totalTokens,
      executionTimeMs,
      toolsRun: [],
      toolsSkipped: [],
    },
  };
}
