/**
 * Diagnostic review agent (hypothesis-driven).
 *
 * Instead of just flagging issues, this mode generates testable
 * hypotheses about potential bugs and suggests how to verify each one.
 * Best for debugging-oriented reviews where you want actionable
 * investigation steps, not just "this is wrong".
 *
 * Output includes:
 *   - 1-5 ranked hypotheses (H1, H2, etc.)
 *   - Each with conditions, verification steps, and confidence
 *   - Standard FINDINGS block for compatibility with parseReviewResponse()
 */

import { createOllamaGenerateFn } from '../providers/ollama.js';
import type {
  Hypothesis,
  HypothesisConfidence,
  LLMProvider,
  ProgressCallback,
  ReviewLevel,
  ReviewResult,
} from '../types.js';
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  DIAGNOSTIC_SYSTEM,
  REVIEW_CALIBRATION,
  UNTRUSTED_CONTENT_POLICY,
  wrapUntrustedDiff,
} from './prompts.js';
import { parseReviewResponse } from './simple.js';

// ─── Types ──────────────────────────────────────────────────────

export interface DiagnosticReviewInput {
  diff: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  staticContext: string;
  memoryContext: string | null;
  stackHints: string;
  reviewLevel: ReviewLevel;
  onProgress?: ProgressCallback;

  /** Optional SOLID/boundary checklist context for structured review. */
  checklistContext?: string;
}

// ─── Hypothesis Parsing ─────────────────────────────────────────

/** Valid confidence values for type-safe parsing */
const VALID_CONFIDENCES = new Set<HypothesisConfidence>(['high', 'medium', 'low']);

/**
 * Parse hypothesis blocks from the LLM response text.
 *
 * Each hypothesis follows this format:
 *   HYPOTHESIS H1: [title]
 *   CONDITIONS: [when/why]
 *   VERIFICATION: [how to test]
 *   CONFIDENCE: high|medium|low
 *   FILES: file1.ts, file2.ts
 *
 * The parser is fault-tolerant:
 *   - Missing fields get sensible defaults
 *   - Malformed confidence values default to 'medium'
 *   - Partial hypotheses are still extracted if they have at least a title
 */
export function parseHypotheses(text: string): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];

  // Match each HYPOTHESIS block — greedy capture up to next HYPOTHESIS or FINDINGS or end
  const hypothesisPattern =
    /HYPOTHESIS\s+(H\d+):\s*(.+?)(?=\nHYPOTHESIS\s+H\d+:|\nFINDINGS:|\n*$)/gis;

  let match = hypothesisPattern.exec(text);
  while (match !== null) {
    const id = match[1]?.trim() ?? 'H?';
    const block = match[2]?.trim() ?? '';

    // Extract title (first line of the block, before CONDITIONS:)
    const titleMatch = /^(.+?)(?:\n|$)/i.exec(block);
    const title = titleMatch?.[1]?.trim() ?? 'Unknown hypothesis';

    // Extract CONDITIONS
    const conditionsMatch =
      /CONDITIONS:\s*(.+?)(?=\nVERIFICATION:|\nCONFIDENCE:|\nFILES:|\n*$)/is.exec(block);
    const conditions = conditionsMatch?.[1]?.trim() ?? 'Conditions not specified';

    // Extract VERIFICATION
    const verificationMatch = /VERIFICATION:\s*(.+?)(?=\nCONFIDENCE:|\nFILES:|\n*$)/is.exec(block);
    const verification = verificationMatch?.[1]?.trim() ?? 'Verification steps not specified';

    // Extract CONFIDENCE
    const confidenceMatch = /CONFIDENCE:\s*(\S+)/i.exec(block);
    const rawConfidence = confidenceMatch?.[1]?.toLowerCase() as HypothesisConfidence | undefined;
    const confidence: HypothesisConfidence =
      rawConfidence && VALID_CONFIDENCES.has(rawConfidence) ? rawConfidence : 'medium';

    // Extract FILES
    const filesMatch = /FILES:\s*(.+?)(?:\n|$)/i.exec(block);
    const relatedFiles = filesMatch?.[1]
      ? filesMatch[1]
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
      : [];

    hypotheses.push({
      id,
      title,
      conditions,
      verification,
      confidence,
      relatedFiles,
    });

    match = hypothesisPattern.exec(text);
  }

  return hypotheses;
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Run a diagnostic (hypothesis-driven) code review.
 *
 * Combines the diagnostic system prompt with all context layers
 * and the diff into a single LLM call. The response is parsed
 * for both standard findings AND structured hypotheses.
 *
 * Uses simple mode's token profile (single LLM call, same budget).
 *
 * @param input - Review input with diff, provider config, and context
 * @returns Parsed ReviewResult with hypotheses attached
 */
export async function runDiagnosticReview(input: DiagnosticReviewInput): Promise<ReviewResult> {
  const { diff, provider, model, apiKey, staticContext, memoryContext, stackHints, reviewLevel } =
    input;
  const emit = input.onProgress ?? (() => {});

  const startTime = Date.now();

  // Build the full system prompt with all context layers
  const system = [
    DIAGNOSTIC_SYSTEM,
    UNTRUSTED_CONTENT_POLICY,
    staticContext,
    buildMemoryContext(memoryContext),
    stackHints,
    input.checklistContext ?? '',
    buildReviewLevelInstruction(reviewLevel),
    REVIEW_CALIBRATION,
  ]
    .filter(Boolean)
    .join('\n');

  // Build the user prompt with the diff (wrapped in untrusted-content delimiters)
  const prompt = `Please perform a diagnostic analysis of the following code changes. Generate testable hypotheses for any potential issues:\n\n${wrapUntrustedDiff(diff)}`;

  // Only Ollama reaches diagnostic mode (gateway/cli-bridge are redirected to simple).
  // Use createOllamaGenerateFn for the single AI SDK path still available.
  const generateFn = createOllamaGenerateFn(model);

  emit({
    step: 'diagnostic-call',
    message: `Calling ${provider}/${model} for diagnostic hypothesis analysis...`,
  });

  let responseText: string;
  let tokensUsed: number;

  try {
    const callResult = await generateFn(system, prompt);
    responseText = callResult.text;
    tokensUsed = callResult.tokensUsed;
  } catch (err) {
    const executionTimeMs = Date.now() - startTime;
    emit({
      step: 'diagnostic-done',
      message: `LLM call failed — falling back to static-analysis-only results`,
    });

    const reviewResult = parseReviewResponse(
      'STATUS: NEEDS_HUMAN_REVIEW\nSUMMARY: LLM call failed. Only static analysis results are available.\nFINDINGS:\n',
      provider,
      model,
      0,
      executionTimeMs,
      memoryContext,
    );
    reviewResult.metadata.mode = 'diagnostic';
    reviewResult.hypotheses = [];
    return reviewResult;
  }

  const executionTimeMs = Date.now() - startTime;

  emit({
    step: 'diagnostic-done',
    message: `Diagnostic analysis complete — ${tokensUsed} tokens, ${(executionTimeMs / 1000).toFixed(1)}s`,
  });

  // Parse the standard review response (STATUS, SUMMARY, FINDINGS)
  const reviewResult = parseReviewResponse(
    responseText,
    provider,
    model,
    tokensUsed,
    executionTimeMs,
    memoryContext,
  );

  // Override mode in metadata
  reviewResult.metadata.mode = 'diagnostic';

  // Parse hypotheses from the response and attach to result
  reviewResult.hypotheses = parseHypotheses(responseText);

  return reviewResult;
}
