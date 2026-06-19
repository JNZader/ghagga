/**
 * Simple review agent.
 *
 * Runs a single LLM call with the full diff and context.
 * Best for small-to-medium PRs where parallel specialists
 * would be overkill.
 */

import type { GenerateTextFn } from '../providers/generate-fn.js';
import type {
  FindingSeverity,
  FindingSource,
  LLMProvider,
  ProgressCallback,
  ReviewFinding,
  ReviewLevel,
  ReviewResult,
  ReviewStatus,
} from '../types.js';
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  REVIEW_CALIBRATION,
  SIMPLE_REVIEW_SYSTEM,
  STATIC_ANALYSIS_UNTRUSTED_LABEL,
  UNTRUSTED_CONTENT_POLICY,
  wrapUntrusted,
  wrapUntrustedDiff,
} from './prompts.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SimpleReviewInput {
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

  /**
   * Optional backend-agnostic generation function.
   * When provided, used instead of createModel + generateTextWithTimeout.
   * When omitted, one is created internally from provider/model/apiKey (backward compat).
   */
  generateFn?: GenerateTextFn;
}

// ─── Response Parsing ───────────────────────────────────────────

/** Valid severity values for type-safe parsing */
const VALID_SEVERITIES = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low', 'info']);

/**
 * Parse the structured LLM response into a ReviewResult.
 *
 * Extracts STATUS, SUMMARY, and FINDINGS sections using regex
 * patterns that match the format defined in SIMPLE_REVIEW_SYSTEM.
 */
function parseReviewResponse(
  text: string,
  provider: LLMProvider,
  model: string,
  tokensUsed: number,
  executionTimeMs: number,
  memoryContext: string | null,
): ReviewResult {
  // Extract STATUS
  const statusMatch = /STATUS:\s*(PASSED|FAILED|NEEDS_HUMAN_REVIEW|SKIPPED)/i.exec(text);
  const status: ReviewStatus =
    (statusMatch?.[1]?.toUpperCase() as ReviewStatus) ?? 'NEEDS_HUMAN_REVIEW';

  // Extract SUMMARY — fall back to raw text if structured format is not found
  const summaryMatch = /SUMMARY:\s*(.+?)(?:\n(?:FINDINGS:|$))/is.exec(text);
  let summary: string;
  if (summaryMatch?.[1]?.trim()) {
    summary = summaryMatch[1].trim();
  } else {
    // CLI providers (e.g., copilot) may return raw text without SUMMARY: markers.
    // Use the raw text (minus any FINDINGS block) as the summary instead of a generic error.
    const withoutFindings = text.replace(/FINDINGS:[\s\S]*$/i, '').trim();
    summary = withoutFindings || 'Review completed but summary could not be parsed.';
  }

  // Extract FINDINGS
  const findings = parseFindingsBlock(text);

  return {
    status,
    summary,
    findings,
    staticAnalysis: {
      semgrep: { status: 'skipped', findings: [], executionTimeMs: 0 },
      trivy: { status: 'skipped', findings: [], executionTimeMs: 0 },
      cpd: { status: 'skipped', findings: [], executionTimeMs: 0 },
    },
    memoryContext,
    metadata: {
      mode: 'simple',
      provider,
      model,
      tokensUsed,
      executionTimeMs,
      toolsRun: [],
      toolsSkipped: [],
    },
  };
}

/**
 * Parse the FINDINGS block from the LLM response.
 *
 * Each finding follows this format:
 *   - SEVERITY: critical
 *     CATEGORY: security
 *     FILE: src/auth.ts
 *     LINE: 42
 *     MESSAGE: SQL injection vulnerability
 *     SUGGESTION: Use parameterized queries
 */
function parseFindingsBlock(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Match each finding block
  const findingPattern =
    /- SEVERITY:\s*(\S+)\s*\n\s*CATEGORY:\s*(\S+)\s*\n\s*FILE:\s*(.+?)\s*\n\s*LINE:\s*(.+?)\s*\n\s*MESSAGE:\s*(.+?)\s*\n\s*SUGGESTION:\s*(.+?)(?=\n\s*- SEVERITY:|\n*$)/gis;

  let match = findingPattern.exec(text);
  while (match !== null) {
    const rawSeverity = match[1]?.toLowerCase() as FindingSeverity;
    const severity: FindingSeverity = VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : 'info';

    const lineStr = match[4]?.trim();
    const line = lineStr === 'N/A' ? undefined : parseInt(lineStr, 10) || undefined;

    findings.push({
      severity,
      category: match[2]?.trim().toLowerCase(),
      file: match[3]?.trim(),
      line,
      message: match[5]?.trim(),
      suggestion: match[6]?.trim(),
      source: 'ai' as FindingSource,
    });
    match = findingPattern.exec(text);
  }

  return findings;
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Run a simple (single-pass) code review.
 *
 * Combines the system prompt with all context layers (static analysis,
 * memory, stack hints) and the diff into a single LLM call.
 *
 * @param input - Review input with diff, provider config, and context
 * @returns Parsed ReviewResult
 */
export async function runSimpleReview(input: SimpleReviewInput): Promise<ReviewResult> {
  const { diff, provider, model, staticContext, memoryContext, stackHints, reviewLevel } = input;
  const emit = input.onProgress ?? (() => {});

  // Resolve the generation function (required — must be injected by pipeline)
  const generateFn = input.generateFn;
  if (!generateFn) {
    throw new Error(
      'runSimpleReview requires generateFn to be provided in SimpleReviewInput. ' +
        'The pipeline must resolve the backend and pass a GenerateTextFn instance.',
    );
  }

  const startTime = Date.now();

  // Build the full system prompt with all context layers.
  // staticContext is attacker-influenceable tool/data output → fence as untrusted.
  // memoryContext is fenced inside buildMemoryContext().
  const system = [
    SIMPLE_REVIEW_SYSTEM,
    UNTRUSTED_CONTENT_POLICY,
    staticContext ? wrapUntrusted(STATIC_ANALYSIS_UNTRUSTED_LABEL, staticContext) : '',
    buildMemoryContext(memoryContext),
    stackHints,
    input.checklistContext ?? '',
    buildReviewLevelInstruction(reviewLevel),
    REVIEW_CALIBRATION,
  ]
    .filter(Boolean)
    .join('\n');

  // Build the user prompt with the diff (wrapped in untrusted-content delimiters)
  const prompt = `Please review the following code changes:\n\n${wrapUntrustedDiff(diff)}`;

  emit({
    step: 'simple-call',
    message: `Calling ${provider}/${model} for single-pass review...`,
  });

  try {
    const result = await generateFn(system, prompt);

    const executionTimeMs = Date.now() - startTime;

    emit({
      step: 'simple-done',
      message: `Review complete — ${result.tokensUsed} tokens, ${(executionTimeMs / 1000).toFixed(1)}s`,
    });

    return parseReviewResponse(
      result.text,
      result.provider as LLMProvider,
      result.model,
      result.tokensUsed,
      executionTimeMs,
      memoryContext,
    );
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;

    // Timeout or other failure: fall back to empty AI result (static analysis still applies)
    emit({
      step: 'simple-done',
      message: `LLM failed — falling back to static-analysis-only results: ${error instanceof Error ? error.message : String(error)}`,
    });

    return parseReviewResponse(
      'STATUS: NEEDS_HUMAN_REVIEW\nSUMMARY: LLM call failed. Only static analysis results are available.\nFINDINGS:\n',
      provider,
      model,
      0,
      executionTimeMs,
      memoryContext,
    );
  }
}

// Re-export the parser for use in workflow and consensus modes
export { parseFindingsBlock, parseReviewResponse };
