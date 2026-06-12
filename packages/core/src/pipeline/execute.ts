/**
 * Execute phase: steps 5.5 → 6 of the review pipeline.
 *
 *   5.5  AI enhance — COMPUTE only (the APPLY half lives in enrich
 *        step 7; do NOT fuse them)
 *   5.6  author trust scoring → may override the review mode
 *   6    agent dispatch (or static-only when AI is disabled)
 *
 * Resolves the provider flags onto state FIRST — enrich step 7.6
 * re-resolves generateFns from those flags.
 *
 * Returns the freshly created `ReviewResult`; the orchestrator attaches
 * it to the state (same object — enrich/finalize mutate it in-place).
 */

import { runConsensusReview } from '../agents/consensus.js';
import { runDiagnosticReview } from '../agents/diagnostic.js';
import { loadLensesFromDir, runFanOutReview } from '../agents/fan-out-lenses.js';
import { runSimpleReview } from '../agents/simple.js';
import { runWorkflowReview } from '../agents/workflow.js';
import { enhanceFindings, mergeEnhanceResult } from '../enhance/index.js';
import { serializeFindings } from '../enhance/prompt.js';
import { SqliteMemoryStorage } from '../memory/sqlite.js';
import { computeAuthorTrustScore, getReviewModeForTier } from '../trust/index.js';
import type { LLMProvider, ReviewFinding, ReviewMode, ReviewResult } from '../types.js';
import { runDegradable } from './degrade.js';
import {
  buildConsensusModels,
  resolveEffectiveMode,
  resolveGenerateTextFns,
  resolvePrimaryProvider,
} from './providers.js';
import { createStaticOnlyResult } from './results.js';
import type { PipelineStateBase } from './state.js';

/**
 * Run the execute phase. Mutates provider/enhance/trust fields on
 * `state` and RETURNS the created `ReviewResult`.
 */
export async function execute(state: PipelineStateBase): Promise<ReviewResult> {
  const { input, emit, aiEnabled, startTime, staticResult } = state;

  // ── Step 5.5: AI Enhance (optional) ─────────────────────────
  // Resolve active provider early — needed by enhance block below and by Step 6
  const activeProvider = input.providerChain?.[0]?.provider ?? input.provider ?? 'gateway';
  const isCliBridge = activeProvider === 'cli-bridge';
  const isGateway = activeProvider === 'gateway';
  const isOllama = activeProvider === 'ollama';
  state.activeProvider = activeProvider;
  state.isCliBridge = isCliBridge;
  state.isGateway = isGateway;
  state.isOllama = isOllama;

  if (input.enhance) {
    // Collect all static findings
    const allStaticFindings: ReviewFinding[] = [];
    for (const toolResult of Object.values(staticResult)) {
      allStaticFindings.push(...toolResult.findings);
    }

    if (allStaticFindings.length > 0) {
      emit({ step: 'static-analysis', message: 'Enhancing findings with AI...' });
      // No warnLabel: ai-enhance is the only push-site that degrades without a console.warn.
      await runDegradable(
        state,
        {
          step: 'ai-enhance',
          failEmit: {
            step: 'static-analysis',
            message: 'AI enhance failed — continuing without enhancement',
          },
        },
        async () => {
          const primary = resolvePrimaryProvider(input);
          const enhanceGenerateFn = resolveGenerateTextFns(
            input,
            isCliBridge,
            isGateway,
            isOllama,
          )[0];
          const serialized = serializeFindings(allStaticFindings);
          const { result: eResult, metadata: eMeta } = await enhanceFindings({
            findings: serialized,
            provider: primary.provider,
            model: primary.model,
            apiKey: primary.apiKey,
            generateFn: enhanceGenerateFn,
          });
          state.enhancedStaticFindings = mergeEnhanceResult(allStaticFindings, eResult);
          state.enhanceMetadata = eMeta;
        },
      );
    }
  }

  // ── Step 5.6: Author trust scoring (optional) ──────────────
  // When features.authorTrust is enabled and input.author is set, compute a
  // trust score from git history and potentially override the review mode.
  if (input.features?.authorTrust && input.author) {
    const author = input.author;
    await runDegradable(
      state,
      { step: 'author-trust', warnLabel: '[ghagga] Author trust scoring failed (non-fatal):' },
      async () => {
        const sqliteStorage =
          input.memoryStorage instanceof SqliteMemoryStorage ? input.memoryStorage : null;

        // Check for a cached (fresh) score — recompute if older than 1 day
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        let trustScore = sqliteStorage?.getTrustScore(author) ?? null;
        const isStale = !trustScore || Date.now() - trustScore.lastUpdated.getTime() > ONE_DAY_MS;

        if (isStale) {
          trustScore = await computeAuthorTrustScore(author, { cwd: process.cwd() });
          sqliteStorage?.upsertTrustScore(trustScore);
        }

        if (!trustScore) {
          throw new Error('Trust score unavailable');
        }

        const recommendedMode = getReviewModeForTier(trustScore.tier, input.mode);
        if (recommendedMode !== input.mode) {
          state.trustOverrideMode = recommendedMode as ReviewMode;
        }

        emit({
          step: 'author-trust',
          message: `[trust] author=${author} score=${trustScore.score} tier=${trustScore.tier} → mode=${recommendedMode}`,
        });
      },
    );
  }

  // Effective input mode — may be overridden by trust scoring
  const resolvedInputMode: ReviewMode = state.trustOverrideMode ?? input.mode;
  state.resolvedInputMode = resolvedInputMode;

  // ── Step 6: Execute agent mode (or skip if AI disabled) ────
  let result: ReviewResult;

  // activeProvider / isCliBridge / isGateway / isOllama are resolved above (Step 5.5)

  if (!aiEnabled) {
    // Static-only mode: no LLM calls
    emit({ step: 'agent-start', message: 'AI review disabled — returning static analysis only' });
    result = createStaticOnlyResult(staticResult, resolvedInputMode, startTime);
  } else {
    // ── Unified dispatch: all backends, all modes ──────────────
    // Step 1: Build GenerateTextFn(s) for the detected backend
    const generateFns = resolveGenerateTextFns(input, isCliBridge, isGateway, isOllama);

    // Step 2: Resolve effective mode (diagnostic → simple for non-SDK backends; ollama keeps it)
    const effectiveMode = resolveEffectiveMode(resolvedInputMode, isCliBridge, isGateway);

    if (effectiveMode !== resolvedInputMode) {
      emit({
        step: 'mode-fallback',
        message: `Diagnostic mode not supported with ${isCliBridge ? 'CLI bridge' : 'gateway'} — falling back to simple mode`,
      });
    }

    // Resolve primary provider for progress messages and metadata
    const primary = resolvePrimaryProvider(input);
    emit({
      step: 'agent-start',
      message: `Running ${effectiveMode} agent with ${primary.provider}/${primary.model}...`,
    });

    // Combine stack hints, code intelligence context, and call-chain context for agent prompts
    const combinedStackHints = state.stackHints + state.codeIntelContext + state.callChainContext;

    try {
      switch (effectiveMode) {
        case 'simple':
          result = await runSimpleReview({
            diff: state.truncatedDiff,
            staticContext: state.staticContext,
            memoryContext: state.memoryContext,
            stackHints: combinedStackHints,
            checklistContext: state.checklistContext,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
            generateFn: generateFns[0],
            // Backward compat fields (not used when generateFn is provided)
            provider: (primary.provider as LLMProvider) ?? 'cli-bridge',
            model: primary.model ?? 'auto',
            apiKey: primary.apiKey ?? '',
          });
          break;

        case 'workflow':
          result = await runWorkflowReview({
            diff: state.truncatedDiff,
            staticContext: state.staticContext,
            memoryContext: state.memoryContext,
            stackHints: combinedStackHints,
            checklistContext: state.checklistContext,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
            generateFns,
            concurrency: input.settings?.reviewConcurrency,
            delayMs: input.settings?.reviewDelayMs,
            // Backward compat fields (not used when generateFns is provided)
            provider: (primary.provider as LLMProvider) ?? 'cli-bridge',
            model: primary.model ?? 'auto',
            apiKey: primary.apiKey ?? '',
            providerChain: input.providerChain,
          });
          break;

        case 'consensus':
          result = await runConsensusReview({
            diff: state.truncatedDiff,
            models: buildConsensusModels(input.providerChain, primary),
            staticContext: state.staticContext,
            memoryContext: state.memoryContext,
            stackHints: combinedStackHints,
            checklistContext: state.checklistContext,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
            generateFns,
            concurrency: input.settings?.reviewConcurrency,
            delayMs: input.settings?.reviewDelayMs,
          });
          break;

        case 'diagnostic':
          // Diagnostic mode is AI SDK-only (resolveEffectiveMode ensures this)
          result = await runDiagnosticReview({
            diff: state.truncatedDiff,
            provider: primary.provider as LLMProvider,
            model: primary.model,
            apiKey: primary.apiKey,
            staticContext: state.staticContext,
            memoryContext: state.memoryContext,
            stackHints: combinedStackHints,
            checklistContext: state.checklistContext,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
          });
          break;

        case 'fan-out':
          // Load custom lenses from directory (if configured)
          if (input.settings.lensDir) {
            await loadLensesFromDir(input.settings.lensDir, input.onProgress);
          }

          result = await runFanOutReview({
            diff: state.truncatedDiff,
            provider: (primary.provider as LLMProvider) ?? 'cli-bridge',
            model: primary.model ?? 'auto',
            apiKey: primary.apiKey ?? '',
            staticContext: state.staticContext,
            memoryContext: state.memoryContext,
            stackHints: combinedStackHints,
            checklistContext: state.checklistContext,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
            generateFns,
            // Forward lens selection from settings (CLI flags > config > defaults)
            ...(input.settings.lenses ? { lenses: input.settings.lenses } : {}),
          });
          break;

        default: {
          const _exhaustive: never = effectiveMode;
          throw new Error(`Unknown review mode: ${_exhaustive}`);
        }
      }
    } catch (error) {
      // Agent failed — return static results with NEEDS_HUMAN_REVIEW
      console.warn(
        '[ghagga] AI review failed, returning static analysis only:',
        error instanceof Error ? error.message : String(error),
      );
      state.failedSteps.push({
        step: 'ai-review',
        error: error instanceof Error ? error.message : String(error),
      });
      emit({ step: 'agent-failed', message: 'AI review failed — returning static analysis only' });
      result = createStaticOnlyResult(staticResult, resolvedInputMode, startTime);
      result.status = 'NEEDS_HUMAN_REVIEW';
      result.summary = `AI review failed (${error instanceof Error ? error.message : 'unknown error'}). Static analysis results are shown below.`;
    }
  }

  return result;
}
