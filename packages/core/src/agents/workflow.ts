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
import type {
  LLMProvider,
  ProgressCallback,
  ProviderChainEntry,
  ReviewLevel,
  ReviewResult,
  WorkflowSpecialist,
} from '../types.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import { generateTextWithTimeout } from '../utils/llm-timeout.js';
import { calculateRateSchedule } from '../utils/token-budget.js';
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  COMPACT_CALIBRATION,
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

  /**
   * Max specialist agents running concurrently (default: 2).
   * Set to 1 for strict sequential, 5 for full parallel (original behavior).
   * Lower values reduce peak TPM usage for free-tier providers.
   */
  concurrency?: number;

  /**
   * Delay in ms between concurrency batches (default: 0).
   * Useful for RPM-limited providers (e.g., Gemini free at 20 RPM).
   */
  delayMs?: number;

  /**
   * Provider chain for distributing specialists across multiple providers.
   * Specialist i uses chain[i % chain.length].
   * When set, takes precedence over the flat provider/model/apiKey fields
   * for individual specialists. Synthesis always uses chain[0] (primary).
   * When undefined or empty, all specialists use the flat fields (backward compat).
   */
  providerChain?: ProviderChainEntry[];
}

interface SpecialistConfig {
  name: WorkflowSpecialist;
  label: string;
  system: string;
}

/**
 * Context distribution map: each specialist gets only the context
 * relevant to its domain, preventing cross-contamination and
 * reducing token usage per call.
 *
 * - Security:   staticContext (security findings from static analysis are relevant)
 * - Performance: stackHints  (tech-specific performance patterns)
 * - Scope:      memoryContext (past observations help understand scope)
 * - Standards:  stackHints   (tech-specific naming/formatting conventions)
 * - Errors:     minimal      (focuses purely on the diff)
 */
type SpecialistContextKey = 'staticContext' | 'memoryContext' | 'stackHints';

const SPECIALIST_CONTEXT_MAP: Record<WorkflowSpecialist, SpecialistContextKey[]> = {
  'security-audit': ['staticContext'],
  'performance-review': ['stackHints'],
  'scope-analysis': ['memoryContext'],
  'coding-standards': ['stackHints'],
  'error-handling': [],
};

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

  // Auto-calculate concurrency and delay based on the primary model's TPM.
  // Free-tier models (Groq 8K TPM) → serialize with 60s delays (~5min total).
  // High-capacity models → full parallel (~10s total).
  const primaryModel = input.providerChain?.[0]?.model ?? model;
  const rateSchedule = calculateRateSchedule(primaryModel);
  const concurrency = input.concurrency ?? rateSchedule.concurrency;
  const delayMs = input.delayMs ?? rateSchedule.delayMs;

  const startTime = Date.now();

  emit({
    step: 'workflow-start',
    message: `Launching ${SPECIALISTS.length} specialist reviewers (concurrency: ${concurrency}, delay: ${Math.round(delayMs / 1000)}s)`,
    detail: SPECIALISTS.map((s) => `  → ${s.label}`).join('\n'),
  });

  // Build the user prompt (same for all specialists)
  const userPrompt = `Review the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  // Context sources keyed for lookup by the specialist context map
  const contextSources: Record<SpecialistContextKey, string> = {
    staticContext,
    memoryContext: buildMemoryContext(memoryContext),
    stackHints,
  };

  // ── Step 1: Run specialists with bounded concurrency ───────
  //
  // Each specialist creates its own model instance and receives only
  // the context relevant to its domain. Specialists with context get
  // REVIEW_CALIBRATION; those without extra context get COMPACT_CALIBRATION.
  //
  // When providerChain is set, specialists are distributed round-robin:
  //   specialist 0 → chain[0], specialist 1 → chain[1], ..., n → chain[n % len]
  // This spreads TPM load across providers instead of hammering one.
  const chain = input.providerChain && input.providerChain.length > 0 ? input.providerChain : null;

  const specialistTasks = SPECIALISTS.map((specialist, index) => {
    return async () => {
      // Resolve which provider/model this specialist uses
      const entry: ProviderChainEntry = chain
        ? (chain[index % chain.length] as ProviderChainEntry)
        : { provider: provider as ProviderChainEntry['provider'], model, apiKey };

      // Each specialist gets its own isolated model instance
      const specialistModel = createModel(entry.provider as LLMProvider, entry.model, entry.apiKey);

      // Build context: only include what's relevant for this specialist
      const contextKeys = SPECIALIST_CONTEXT_MAP[specialist.name] ?? [];
      const contextParts = contextKeys.map((key) => contextSources[key]).filter(Boolean);

      const hasContext = contextParts.length > 0;

      const system = [
        specialist.system,
        ...contextParts,
        buildReviewLevelInstruction(reviewLevel),
        hasContext ? REVIEW_CALIBRATION : COMPACT_CALIBRATION,
      ]
        .filter(Boolean)
        .join('\n');

      const result = await generateTextWithTimeout(
        {
          model: specialistModel,
          system,
          prompt: userPrompt,
          temperature: 0.3,
        },
        { provider: entry.provider, model: entry.model },
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
        providerUsed: entry.provider,
        modelUsed: entry.model,
      };
    };
  });

  const results = await runWithConcurrency(specialistTasks, { concurrency, delayMs });

  // ── Step 2: Collect results ────────────────────────────────
  let totalTokens = 0;
  const specialistOutputs: string[] = [];
  const modelsUsed: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const spec = SPECIALISTS[i];
    if (!result || !spec) continue;

    if (result.status === 'fulfilled') {
      totalTokens += result.value.tokensUsed;
      specialistOutputs.push(`### ${result.value.label}\n\n${result.value.text}`);
      modelsUsed.push(
        `${result.value.name}:${result.value.providerUsed}/${result.value.modelUsed}`,
      );
      emit({
        step: `specialist-${spec.name}`,
        message: `✓ ${spec.label} — ${result.value.tokensUsed} tokens (${result.value.providerUsed}/${result.value.modelUsed})`,
        detail: result.value.text,
      });
    } else {
      // Include error information in synthesis so it's aware of gaps
      specialistOutputs.push(
        `### [FAILED] Specialist\n\nThis specialist could not complete: ${String(result.reason)}`,
      );
      // Track failed specialists with error reason for debugging
      const failedEntry: ProviderChainEntry = chain
        ? (chain[i % chain.length] as ProviderChainEntry)
        : { provider: provider as ProviderChainEntry['provider'], model, apiKey };
      const errorMsg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      // Truncate error to keep log lines manageable
      const shortError = errorMsg.length > 100 ? `${errorMsg.slice(0, 100)}...` : errorMsg;
      modelsUsed.push(
        `${spec.name}:${failedEntry.provider}/${failedEntry.model}[FAILED:${shortError}]`,
      );
      emit({
        step: `specialist-${spec.name}`,
        message: `✗ ${spec.label} — FAILED (${failedEntry.provider}/${failedEntry.model}): ${String(result.reason)}`,
      });
    }
  }

  emit({
    step: 'workflow-synthesis',
    message: `Synthesizing ${specialistOutputs.length} specialist outputs...`,
  });

  // ── Step 3: Synthesis ──────────────────────────────────────
  // Synthesis always uses the primary provider (chain[0] or flat fields)
  // for the highest-quality aggregation step.
  const primaryEntry: ProviderChainEntry = chain
    ? (chain[0] as ProviderChainEntry)
    : { provider: provider as ProviderChainEntry['provider'], model, apiKey };
  const synthesisModel = createModel(
    primaryEntry.provider as LLMProvider,
    primaryEntry.model,
    primaryEntry.apiKey,
  );

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
      model: synthesisModel,
      system: synthesisSystem,
      prompt: synthesisPrompt,
      temperature: 0.3,
    },
    { provider: primaryEntry.provider, model: primaryEntry.model },
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
      primaryEntry.provider as LLMProvider,
      primaryEntry.model,
      totalTokens,
      executionTimeMs,
      memoryContext,
    );
    reviewResult.metadata.mode = 'workflow';
    reviewResult.metadata.modelsUsed = modelsUsed;
    return reviewResult;
  }

  const synthesisTokens =
    (synthesisResult.usage?.inputTokens ?? 0) + (synthesisResult.usage?.outputTokens ?? 0);
  totalTokens += synthesisTokens;

  // Parse the synthesis output using the same parser as simple mode
  const reviewResult = parseReviewResponse(
    synthesisResult.text,
    primaryEntry.provider as LLMProvider,
    primaryEntry.model,
    totalTokens,
    executionTimeMs,
    memoryContext,
  );

  // Override mode in metadata
  reviewResult.metadata.mode = 'workflow';
  reviewResult.metadata.modelsUsed = modelsUsed;

  return reviewResult;
}
