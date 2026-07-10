/**
 * Prepare phase: steps 1 → 4 of the review pipeline.
 *
 *   1   Validate input
 *   2   Parse and filter the diff (path protection)
 *   2.1 Flood / spam detection        → may EARLY-RETURN a skipped result
 *   2.2 All-files-filtered check      → may EARLY-RETURN a skipped result
 *   2.5 Blast-radius filter           (prepare-graph.ts, bespoke catch)
 *   2.6 Call-chain + reverse-deps     (prepare-graph.ts, warn-only degrade)
 *   3   Detect tech stacks
 *   4   Token budget + diff truncation
 *
 * Because the two early-returns fire BEFORE a complete `PipelineStateBase`
 * can exist (`fileList`/`allFiles` are readonly and only known post-parse),
 * prepare CONSTRUCTS and RETURNS the base itself — analogous to how the
 * execute phase returns the `ReviewResult` it creates. The outcome is a
 * discriminated union: `early` carries the final `ReviewResult` (flood-skip
 * / all-filtered), `continue` carries the base for the downstream phases.
 */

import { buildStackHints } from '../agents/prompts.js';
import { detectFlood } from '../flood/index.js';
import type { LLMProvider, ReviewInput, ReviewResult, ToolResult } from '../types.js';
import { filterDiffFiles, parseDiffFiles, truncateDiff } from '../utils/diff.js';
import { detectStacks } from '../utils/stack-detect.js';
import { calculateTokenBudget } from '../utils/token-budget.js';
import { applyBlastRadius, buildCallChainContext } from './prepare-graph.js';
import { resolveAiEnabled, resolvePrimaryModel } from './providers.js';
import { createSkippedResult } from './results.js';
import type { FailedStep, PipelineStateBase } from './state.js';

/**
 * Result of the prepare phase.
 * - `early`: the pipeline is done — return `result` as-is (flood-skip or
 *   all-files-filtered). No further phase runs.
 * - `continue`: proceed with `base` through gather → execute → enrich →
 *   finalize.
 */
export type PrepareOutcome =
  | { readonly kind: 'early'; readonly result: ReviewResult }
  | { readonly kind: 'continue'; readonly base: PipelineStateBase };

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validate the numeric concurrency/delay knobs on ReviewSettings.
 *
 * `reviewConcurrency` must be a finite integer >= 1 (it drives the
 * `i += concurrency` batch loop in runWithConcurrency); `reviewDelayMs`
 * must be a finite integer >= 0. Undefined values fall back to defaults
 * downstream and are accepted here. Throws on any invalid value.
 */
function validateReviewSettings(settings: ReviewInput['settings']): void {
  const { reviewConcurrency, reviewDelayMs } = settings;

  if (reviewConcurrency !== undefined) {
    if (!Number.isInteger(reviewConcurrency) || reviewConcurrency < 1) {
      throw new Error(
        `reviewConcurrency must be a finite integer >= 1, received: ${reviewConcurrency}`,
      );
    }
  }

  if (reviewDelayMs !== undefined) {
    if (!Number.isFinite(reviewDelayMs) || reviewDelayMs < 0) {
      throw new Error(`reviewDelayMs must be a finite number >= 0, received: ${reviewDelayMs}`);
    }
  }
}

/**
 * Validate the review input for required fields.
 * Throws descriptive errors for misconfiguration.
 */
function validateInput(input: ReviewInput): void {
  if (!input.diff || input.diff.trim().length === 0) {
    throw new Error('Review input must include a non-empty diff');
  }

  // Central boundary validation for public tuning knobs. These flow from the
  // API straight into runWithConcurrency; an invalid concurrency would make
  // the batch loop stall (0) or run backwards (negatives), and a negative
  // delay is nonsensical for setTimeout. Reject early with a clear message.
  validateReviewSettings(input.settings);

  // If AI review is explicitly disabled, no provider/model/key needed
  if (input.aiReviewEnabled === false) {
    return;
  }

  // Provider chain mode: validate the chain has entries
  if (input.providerChain && input.providerChain.length > 0) {
    return;
  }

  // CLI Bridge mode: no API key required (uses CLI auth)
  if (input.provider === 'cli-bridge') {
    return;
  }

  // Gateway mode: uses dashboard-configured token (stored as apiKey in chain entry)
  if (input.provider === 'gateway') {
    return;
  }

  // Ollama mode: no API key required (local instance)
  if (input.provider === 'ollama') {
    return;
  }

  // Single provider mode — must be one of the 3 supported providers
  if (input.provider) {
    const supported: LLMProvider[] = ['gateway', 'cli-bridge', 'ollama'];
    if (!supported.includes(input.provider)) {
      throw new Error(
        `Provider '${input.provider}' is no longer supported directly. ` +
          `Set provider: 'gateway' and configure credentials in mcp-llm-bridge. ` +
          `See docs/configuration.md#gateway-mode-mcp-llm-bridge`,
      );
    }
  }

  if (!input.apiKey && input.provider !== 'cli-bridge' && input.provider !== 'ollama') {
    throw new Error('Review input must include an API key');
  }

  if (!input.provider) {
    throw new Error('Review input must specify an LLM provider');
  }

  if (!input.model) {
    throw new Error('Review input must specify a model');
  }
}

// ─── Prepare phase ──────────────────────────────────────────────

/**
 * Run steps 1 → 4 and construct the shared `PipelineStateBase`.
 */
export async function prepare(input: ReviewInput): Promise<PrepareOutcome> {
  const startTime = Date.now();

  const emit = input.onProgress ?? (() => {});

  // Track steps that failed but were gracefully degraded
  const failedSteps: FailedStep[] = [];
  // Track warn-only degradations (reportFailure: false sites) — never
  // surface in failedSteps but still count against coverageComplete.
  const warnOnlyDegradations: string[] = [];

  // Resolve whether AI review is enabled
  const aiEnabled = resolveAiEnabled(input);

  // ── Step 1: Validate ───────────────────────────────────────
  validateInput(input);
  emit({ step: 'validate', message: 'Input validated' });

  // ── Step 2: Parse and filter the diff ──────────────────────
  const allFiles = parseDiffFiles(input.diff);
  let {
    filtered: filteredFiles,
    blocked,
    redacted,
  } = filterDiffFiles(allFiles, input.settings.ignorePatterns);

  if (blocked.length > 0) {
    emit({
      step: 'path-protection',
      message: `Blocked ${blocked.length} sensitive file(s) from review`,
      detail: blocked.map((p) => `  [BLOCKED] ${p}`).join('\n'),
    });
  }
  if (redacted.length > 0) {
    emit({
      step: 'path-protection',
      message: `Redacted ${redacted.length} file(s) — paths visible, content hidden`,
      detail: redacted.map((p) => `  [REDACTED] ${p}`).join('\n'),
    });
  }

  emit({
    step: 'parse-diff',
    message: `Parsed ${allFiles.length} files from diff, ${filteredFiles.length} after filtering (${blocked.length} blocked, ${redacted.length} redacted)`,
    detail: filteredFiles.map((f) => `  ${f.path}`).join('\n'),
  });

  // ── Step 2.1: Flood / spam detection ──────────────────────
  // Runs before any expensive operation (static analysis, LLM).
  const linesChanged = allFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const floodResult = detectFlood({
    authorLogin: input.author ?? '',
    prTitle: input.context?.commitMessages[0] ?? '',
    prBody: input.context?.commitMessages.slice(1).join('\n') ?? null,
    linesChanged,
    recentPrCount: undefined,
  });

  if (floodResult.isFlood) {
    emit({
      step: 'flood-detection',
      message: `Flood detected: ${floodResult.recommendation}`,
      detail: floodResult.signals.map((s) => `  [${s.type}] ${s.detail}`).join('\n'),
    });
  }

  if (floodResult.recommendation === 'skip') {
    const skipped = createSkippedResult(input, startTime);
    return {
      kind: 'early',
      result: {
        ...skipped,
        summary: 'Flood detection: PR skipped (bot author or spam signal).',
      },
    };
  }

  // If all files were filtered out, skip the review
  if (filteredFiles.length === 0) {
    return { kind: 'early', result: createSkippedResult(input, startTime) };
  }

  // Reconstruct filtered diff and get file list
  let filteredDiff = filteredFiles.map((f) => f.content).join('\n');
  const fileList = filteredFiles.map((f) => f.path);

  // ── Step 2.5: Blast-radius filter (optional) ──────────────
  const blast = await applyBlastRadius({
    input,
    emit,
    failedSteps,
    fileList,
    filteredFiles,
    filteredDiff,
  });
  filteredFiles = blast.filteredFiles;
  filteredDiff = blast.filteredDiff;
  const blastRadiusMetadata = blast.blastRadiusMetadata;

  // ── Step 2.6: Call-chain + reverse-deps (optional, runs when blast-radius enabled) ──
  const callChainContext = await buildCallChainContext({
    input,
    emit,
    failedSteps,
    warnOnlyDegradations,
    fileList,
    filteredDiff,
  });

  // ── Step 3: Detect tech stacks ─────────────────────────────
  const stacks = detectStacks(fileList);
  const stackHints = buildStackHints(stacks);
  emit({
    step: 'detect-stacks',
    message: `Detected ${stacks.length} tech stack(s)`,
    detail: stacks.length > 0 ? stacks.map((s) => `  ${s}`).join('\n') : '  (none detected)',
  });

  // ── Step 4: Truncate diff to fit token budget ──────────────
  const primaryModel = resolvePrimaryModel(input);
  const { diffBudget, contextBudget } = calculateTokenBudget(primaryModel);
  const { truncated: truncatedDiff } = truncateDiff(filteredDiff, diffBudget);
  emit({
    step: 'token-budget',
    message: `Token budget: ${diffBudget.toLocaleString()} tokens for diff, ${contextBudget.toLocaleString()} tokens for context`,
  });

  // ── Construct the shared PipelineState (sans result) ────────
  // Locals settled by steps 1–4 migrate into the base here. The
  // gather-context phase overwrites the gather-owned placeholders below
  // UNCONDITIONALLY before any consumer reads them; the execute phase
  // resolves provider flags / enhance / trust onto this state and
  // RETURNS the ReviewResult it creates; enrich and finalize then
  // mutate `state.result` in-place.
  const pendingTool = (): ToolResult => ({ status: 'skipped', findings: [], executionTimeMs: 0 });
  const base: PipelineStateBase = {
    input,
    startTime,
    emit,
    aiEnabled,
    allFiles,
    fileList,
    filteredFiles,
    filteredDiff,
    blastRadiusMetadata,
    callChainContext,
    stacks,
    stackHints,
    truncatedDiff,
    diffBudget,
    contextBudget,
    // Gathered by the gather-context phase (placeholders until then —
    // never read pre-gather):
    staticResult: { semgrep: pendingTool(), trivy: pendingTool(), cpd: pendingTool() },
    rawMemoryContext: null,
    codeIntelResults: [],
    staticContext: '',
    memoryContext: null,
    codeIntelContext: '',
    checklistContext: '',
    resolvedChecklist: null,
    negativeExamplesPrompt: '',
    selfImproveRulesPrompt: '',
    // Resolved by the execute phase (placeholders until then):
    activeProvider: '',
    isCliBridge: false,
    isGateway: false,
    isOllama: false,
    resolvedInputMode: input.mode, // pre-trust value; execute overwrites
    failedSteps,
    warnOnlyDegradations,
  };

  return { kind: 'continue', base };
}
