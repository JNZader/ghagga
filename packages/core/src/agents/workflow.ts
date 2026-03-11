/**
 * Workflow review agent (multi-specialist).
 *
 * Runs 5 specialist reviewers in parallel, then synthesizes their
 * findings into a single unified review. Best for medium-to-large PRs
 * where different aspects need focused attention.
 *
 * Specialists:
 *   1. Scope Analysis   — what changed, what's affected
 *   2. Coding Standards — naming, formatting, DRY
 *   3. Error Handling   — null safety, edge cases, exceptions
 *   4. Security Audit   — injection, XSS, auth, data exposure
 *   5. Performance      — complexity, N+1, memory, resources
 *
 * After all specialists complete, a synthesis step merges and
 * deduplicates findings into the final STATUS/SUMMARY/FINDINGS.
 */

import { createModel } from '../providers/index.js';
import { generateTextWithTimeout } from '../utils/llm-timeout.js';
import type {
  LLMProvider,
  ProgressCallback,
  ReviewLevel,
  ReviewResult,
  WorkflowSpecialist,
} from '../types.js';
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  REVIEW_CALIBRATION,
  WORKFLOW_ERRORS_SYSTEM,
  WORKFLOW_PERFORMANCE_SYSTEM,
  WORKFLOW_SCOPE_SYSTEM,
  WORKFLOW_SECURITY_SYSTEM,
  WORKFLOW_STANDARDS_SYSTEM,
  WORKFLOW_SYNTHESIS_SYSTEM,
} from './prompts.js';
import { parseReviewResponse } from './simple.js';

// ─── Types ──────────────────────────────────────────────────────

export interface WorkflowReviewInput {
  diff: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  staticContext: string;
  memoryContext: string | null;
  stackHints: string;
  reviewLevel: ReviewLevel;
  onProgress?: ProgressCallback;
}

interface SpecialistConfig {
  name: WorkflowSpecialist;
  label: string;
  system: string;
}

// ─── Specialist Configuration ───────────────────────────────────

const SPECIALISTS: SpecialistConfig[] = [
  { name: 'scope-analysis', label: 'Scope Analysis', system: WORKFLOW_SCOPE_SYSTEM },
  { name: 'coding-standards', label: 'Coding Standards', system: WORKFLOW_STANDARDS_SYSTEM },
  { name: 'error-handling', label: 'Error Handling', system: WORKFLOW_ERRORS_SYSTEM },
  { name: 'security-audit', label: 'Security Audit', system: WORKFLOW_SECURITY_SYSTEM },
  { name: 'performance-review', label: 'Performance', system: WORKFLOW_PERFORMANCE_SYSTEM },
];

// ─── Main Function ──────────────────────────────────────────────

/**
 * Run a workflow (multi-specialist) code review.
 *
 * 1. Launch 5 specialist reviews in parallel with Promise.allSettled
 * 2. Collect all specialist outputs (including failures)
 * 3. Run a synthesis step to merge findings into a unified review
 *
 * @param input - Review input with diff, provider config, and context
 * @returns Parsed ReviewResult from the synthesis step
 */
export async function runWorkflowReview(input: WorkflowReviewInput): Promise<ReviewResult> {
  const { diff, provider, model, apiKey, staticContext, memoryContext, stackHints, reviewLevel } =
    input;
  const emit = input.onProgress ?? (() => {});

  const startTime = Date.now();
  const languageModel = createModel(provider, model, apiKey);

  emit({
    step: 'workflow-start',
    message: `Launching ${SPECIALISTS.length} specialist reviewers in parallel`,
    detail: SPECIALISTS.map((s) => `  → ${s.label}`).join('\n'),
  });

  // Build the user prompt (same for all specialists)
  const userPrompt = `Review the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  // ── Step 1: Run all specialists in parallel ────────────────
  const specialistPromises = SPECIALISTS.map(async (specialist) => {
    const system = [
      specialist.system,
      staticContext,
      buildMemoryContext(memoryContext),
      stackHints,
      buildReviewLevelInstruction(reviewLevel),
      REVIEW_CALIBRATION,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await generateTextWithTimeout(
      {
        model: languageModel,
        system,
        prompt: userPrompt,
        temperature: 0.3,
      },
      { provider, model },
    );

    // Timeout: treat as a failed specialist (synthesis will be aware of the gap)
    if (result === null) {
      throw new Error(`LLM call timed out for specialist ${specialist.label}`);
    }

    return {
      name: specialist.name,
      label: specialist.label,
      text: result.text,
      tokensUsed: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    };
  });

  const results = await Promise.allSettled(specialistPromises);

  // ── Step 2: Collect results ────────────────────────────────
  let totalTokens = 0;
  const specialistOutputs: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const spec = SPECIALISTS[i];
    if (!result || !spec) continue;

    if (result.status === 'fulfilled') {
      totalTokens += result.value.tokensUsed;
      specialistOutputs.push(`### ${result.value.label}\n\n${result.value.text}`);
      emit({
        step: `specialist-${spec.name}`,
        message: `✓ ${spec.label} — ${result.value.tokensUsed} tokens`,
        detail: result.value.text,
      });
    } else {
      // Include error information in synthesis so it's aware of gaps
      specialistOutputs.push(
        `### [FAILED] Specialist\n\nThis specialist could not complete: ${String(result.reason)}`,
      );
      emit({
        step: `specialist-${spec.name}`,
        message: `✗ ${spec.label} — FAILED: ${String(result.reason)}`,
      });
    }
  }

  emit({
    step: 'workflow-synthesis',
    message: `Synthesizing ${specialistOutputs.length} specialist outputs...`,
  });

  // ── Step 3: Synthesis ──────────────────────────────────────
  const synthesisPrompt = [
    'Below are the findings from 5 specialist reviewers. Synthesize them into a final review.\n',
    ...specialistOutputs,
    '\n\n---\n\nNow provide the unified review in the required format.',
  ].join('\n\n');

  const synthesisSystem = [
    WORKFLOW_SYNTHESIS_SYSTEM,
    buildReviewLevelInstruction(reviewLevel),
    REVIEW_CALIBRATION,
  ]
    .filter(Boolean)
    .join('\n');

  const synthesisResult = await generateTextWithTimeout(
    {
      model: languageModel,
      system: synthesisSystem,
      prompt: synthesisPrompt,
      temperature: 0.3,
    },
    { provider, model },
  );

  const executionTimeMs = Date.now() - startTime;

  // If synthesis timed out, return a fallback result
  if (synthesisResult === null) {
    emit({
      step: 'workflow-synthesis',
      message: 'Synthesis LLM call timed out — falling back to static-analysis-only results',
    });

    const reviewResult = parseReviewResponse(
      'STATUS: NEEDS_HUMAN_REVIEW\nSUMMARY: LLM synthesis timed out. Only static analysis results are available.\nFINDINGS:\n',
      provider,
      model,
      totalTokens,
      executionTimeMs,
      memoryContext,
    );
    reviewResult.metadata.mode = 'workflow';
    return reviewResult;
  }

  const synthesisTokens =
    (synthesisResult.usage?.inputTokens ?? 0) + (synthesisResult.usage?.outputTokens ?? 0);
  totalTokens += synthesisTokens;

  // Parse the synthesis output using the same parser as simple mode
  const reviewResult = parseReviewResponse(
    synthesisResult.text,
    provider,
    model,
    totalTokens,
    executionTimeMs,
    memoryContext,
  );

  // Override mode in metadata
  reviewResult.metadata.mode = 'workflow';

  return reviewResult;
}
