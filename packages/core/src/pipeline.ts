/**
 * Main review pipeline orchestrator.
 *
 * Coordinates the entire review flow:
 *   1. Validate input
 *   2. Parse and filter the diff
 *   3. Detect tech stacks
 *   4. Run static analysis tools
 *   5. Search memory for past context
 *   6. Execute the selected agent mode
 *   7. Persist new observations to memory
 *   8. Return the final result
 *
 * Each step degrades gracefully — if static analysis fails, or
 * memory is unavailable, the pipeline continues with what it has.
 */

import { runConsensusReview } from './agents/consensus.js';
import { runDiagnosticReview } from './agents/diagnostic.js';
import { loadLensesFromDir, runFanOutReview } from './agents/fan-out-lenses.js';
import { buildCodeIntelSection, buildStackHints } from './agents/prompts.js';
import { runSimpleReview } from './agents/simple.js';
import { runWorkflowReview } from './agents/workflow.js';
import { buildChecklistContext, resolveChecklistConfig, scoreFindings } from './checklist/index.js';
import { buildCodeIntelContext } from './code-intel/context.js';
import type { CodeIntelMetadata, CodeIntelResult } from './code-intel/types.js';
import {
  extractChangedSymbols as extractChangedSymbolsFromDiff,
  scanDocsForSymbols as scanDocsForSymbolRefs,
} from './doc-validation/index.js';
import { enhanceFindings, mergeEnhanceResult } from './enhance/index.js';
import { serializeFindings } from './enhance/prompt.js';
import { analyzeExploitability, analyzeUsage } from './exploitability/index.js';
import { detectFlood } from './flood/index.js';
import { computeBlastRadius } from './graph/blast-radius.js';
import { buildCallChainFromDiff } from './graph/call-chain.js';
import { buildReverseDependencyMap, findDependents } from './graph/reverse-deps.js';
import type { BlastRadiusMetadata } from './graph/schema.js';
import { isGraphStale } from './graph/schema.js';
import { persistReviewObservations } from './memory/persist.js';
import { searchMemoryForContext } from './memory/search.js';
import { SqliteMemoryStorage } from './memory/sqlite.js';
import { formatNegativeExamplesPrompt } from './negative.js';
import {
  buildConsensusModels,
  resolveAiEnabled,
  resolveEffectiveMode,
  resolveGenerateTextFns,
  resolvePrimaryModel,
  resolvePrimaryProvider,
} from './pipeline/providers.js';
import { createSkippedResult, createStaticOnlyResult } from './pipeline/results.js';
import type { FailedStep } from './pipeline/state.js';
import { rankFindings } from './ranking/index.js';
import { recursiveReview } from './recursive/index.js';
import { deriveRules, formatRulesForPrompt, loadFeedback } from './self-improve/index.js';
import { formatStaticAnalysisContext, runStaticAnalysis } from './tools/runner.js';
import { computeAuthorTrustScore, getReviewModeForTier } from './trust/index.js';
import type { LLMProvider, ReviewFinding, ReviewInput, ReviewMode, ReviewResult } from './types.js';
import { buildProgressiveContext } from './utils/context-levels.js';
import { filterDiffFiles, parseDiffFiles, truncateDiff } from './utils/diff.js';
import { detectStacks } from './utils/stack-detect.js';
import { calculateTokenBudget } from './utils/token-budget.js';

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validate the review input for required fields.
 * Throws descriptive errors for misconfiguration.
 */
function validateInput(input: ReviewInput): void {
  if (!input.diff || input.diff.trim().length === 0) {
    throw new Error('Review input must include a non-empty diff');
  }

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

// ─── Pipeline ───────────────────────────────────────────────────

/**
 * Run the full review pipeline.
 *
 * This is the primary entry point for all review operations.
 * It orchestrates parsing, analysis, agent execution, and
 * memory operations in a resilient pipeline that degrades
 * gracefully when optional components fail.
 *
 * @param input - Complete review input with diff, config, and settings
 * @returns ReviewResult with status, findings, and metadata
 */
export async function reviewPipeline(input: ReviewInput): Promise<ReviewResult> {
  const startTime = Date.now();

  const emit = input.onProgress ?? (() => {});

  // Track steps that failed but were gracefully degraded
  const failedSteps: FailedStep[] = [];

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
      ...skipped,
      summary: 'Flood detection: PR skipped (bot author or spam signal).',
    };
  }

  // If all files were filtered out, skip the review
  if (filteredFiles.length === 0) {
    return createSkippedResult(input, startTime);
  }

  // Reconstruct filtered diff and get file list
  let filteredDiff = filteredFiles.map((f) => f.content).join('\n');
  const fileList = filteredFiles.map((f) => f.path);

  // ── Step 2.5: Blast-radius filter (optional) ──────────────
  let blastRadiusMetadata: BlastRadiusMetadata | undefined;

  if (input.settings.enableBlastRadius && input.graphLoader) {
    try {
      const graph = await input.graphLoader.load();
      if (graph) {
        const metadata = await input.graphLoader.loadMetadata();
        const stale = metadata ? isGraphStale(metadata) : false;

        if (stale) {
          emit({
            step: 'blast-radius',
            message: `Dependency graph is stale (last indexed: ${metadata?.lastIndexedAt})`,
          });
        }

        const blastResult = computeBlastRadius(graph, fileList, {
          maxDepth: input.settings.traversalDepth,
          maxFiles: input.settings.maxBlastRadiusFiles,
        });

        if (blastResult.exceededCap) {
          emit({
            step: 'blast-radius',
            message: `Blast radius exceeds ${input.settings.maxBlastRadiusFiles ?? 50} files — using full diff`,
          });
          blastRadiusMetadata = {
            enabled: true,
            graphAvailable: true,
            totalFiles: filteredFiles.length,
            blastRadiusFiles: filteredFiles.length,
            fallbackReason: `blast radius exceeds ${input.settings.maxBlastRadiusFiles ?? 50} files`,
            graphStale: stale,
          };
        } else {
          // Filter to blast-radius files
          filteredFiles = filteredFiles.filter((f) => blastResult.files.has(f.path));
          filteredDiff = filteredFiles.map((f) => f.content).join('\n');
          emit({
            step: 'blast-radius',
            message: `Blast radius: ${blastResult.files.size} files (from ${fileList.length} in diff)`,
            detail: [
              `  changed: ${blastResult.changedFiles.length}`,
              `  dependents: ${blastResult.dependents.length}`,
              `  tests: ${blastResult.testFiles.length}`,
            ].join('\n'),
          });
          blastRadiusMetadata = {
            enabled: true,
            graphAvailable: true,
            totalFiles: fileList.length,
            blastRadiusFiles: blastResult.files.size,
            graphStale: stale,
          };
        }
      } else {
        emit({ step: 'blast-radius', message: 'Blast radius: skipped (no graph available)' });
        blastRadiusMetadata = {
          enabled: true,
          graphAvailable: false,
          totalFiles: filteredFiles.length,
          blastRadiusFiles: filteredFiles.length,
          fallbackReason: 'no graph available',
        };
      }
    } catch (error) {
      console.warn('[ghagga] Blast-radius failed (degrading gracefully):', error);
      failedSteps.push({
        step: 'blast-radius',
        error: error instanceof Error ? error.message : String(error),
      });
      emit({ step: 'blast-radius', message: 'Blast radius: skipped (error loading graph)' });
      blastRadiusMetadata = {
        enabled: true,
        graphAvailable: false,
        totalFiles: filteredFiles.length,
        blastRadiusFiles: filteredFiles.length,
        fallbackReason: `error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ── Step 2.6: Call-chain + reverse-deps (optional, runs when blast-radius enabled) ──
  let callChainContext = '';
  if (input.settings.enableBlastRadius) {
    try {
      if (input.fileReader) {
        const fileContentsMap = new Map<string, string>();
        for (const fp of fileList) {
          try {
            const content = await input.fileReader(fp);
            if (content) fileContentsMap.set(fp, content);
          } catch {
            // non-fatal — skip unreadable files
          }
        }

        if (fileContentsMap.size > 0) {
          const callChain = buildCallChainFromDiff(filteredDiff, fileContentsMap);
          if (callChain.affectedSymbols.length > 0) {
            const affectedFiles = [...new Set(callChain.affectedSymbols.map((s) => s.filePath))];
            callChainContext = `\n## Call-Chain Impact\n${callChain.affectedSymbols.length} symbol(s) across ${affectedFiles.length} file(s) may be affected by these changes (depth: ${callChain.depth}).\n`;
            emit({
              step: 'call-chain',
              message: `Call-chain: ${callChain.changedSymbols.length} changed symbol(s), ${callChain.affectedSymbols.length} affected symbol(s)`,
            });
          }

          const reverseDepMap = buildReverseDependencyMap(
            [...fileContentsMap.keys()],
            fileContentsMap,
          );
          const highRiskFiles: string[] = [];
          for (const fp of fileList) {
            const result = findDependents(fp, reverseDepMap, 2);
            if (result.transitiveCount >= 3) {
              highRiskFiles.push(`${fp} (${result.transitiveCount} dependents)`);
            }
          }
          if (highRiskFiles.length > 0) {
            callChainContext += `\n## High-Risk Files (many dependents)\nThese changed files have many transitive dependents — review carefully:\n${highRiskFiles.map((f) => `- ${f}`).join('\n')}\n`;
            emit({
              step: 'reverse-deps',
              message: `Reverse deps: ${highRiskFiles.length} high-risk file(s) detected`,
            });
          }
        }
      }
    } catch (error) {
      console.warn(
        '[ghagga] Call-chain/reverse-deps failed (degrading gracefully):',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

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

  // ── Step 5: Run static analysis (in parallel with memory) ──
  // If precomputed results are available (from GitHub Actions runner), use those directly.
  // Otherwise, run tools locally (CLI/Action modes).
  emit({
    step: 'static-analysis',
    message: input.precomputedStaticAnalysis
      ? 'Using precomputed static analysis from runner...'
      : 'Running static analysis & memory search...',
  });
  const [staticResult, rawMemoryContext, codeIntelResults] = await Promise.all([
    input.precomputedStaticAnalysis
      ? Promise.resolve(input.precomputedStaticAnalysis)
      : runStaticAnalysisSafe(fileList, input, failedSteps),
    aiEnabled ? searchMemorySafe(input, fileList, failedSteps) : Promise.resolve(null),
    queryCodeIntelSafe(input, fileList, emit, failedSteps),
  ]);

  // ── Step 5.0: Negative examples (optional) ────────────────────
  // Load dismissed findings for the files in this diff and prepend them
  // to the memory context so agents suppress known false positives.
  let negativeExamplesPrompt = '';
  if (
    input.features?.negativeExamples !== false &&
    input.memoryStorage instanceof SqliteMemoryStorage
  ) {
    try {
      const allNegativeExamples = fileList.flatMap((filePath) =>
        (input.memoryStorage as SqliteMemoryStorage).getNegativeExamplesForFile(filePath),
      );
      // De-duplicate by findingHash
      const seen = new Set<string>();
      const uniqueExamples = allNegativeExamples.filter((e) => {
        if (seen.has(e.findingHash)) return false;
        seen.add(e.findingHash);
        return true;
      });
      negativeExamplesPrompt = formatNegativeExamplesPrompt(uniqueExamples);
      if (negativeExamplesPrompt) {
        emit({
          step: 'negative-examples',
          message: `Loaded ${uniqueExamples.length} dismissed finding(s) — injecting suppression context`,
        });
      }
    } catch (error) {
      // Non-fatal — degraded gracefully
      console.warn(
        '[ghagga] Negative examples load failed (degrading gracefully):',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ── Step 5.0a: Self-improve rules (optional) ─────────────────
  let selfImproveRulesPrompt = '';
  if (input.settings.selfImprovePath) {
    try {
      const feedback = await loadFeedback(input.settings.selfImprovePath);
      if (feedback.length > 0) {
        const rules = deriveRules(feedback);
        selfImproveRulesPrompt = formatRulesForPrompt(rules);
        if (selfImproveRulesPrompt) {
          emit({
            step: 'self-improve',
            message: `Self-improve: loaded ${feedback.length} feedback record(s), derived ${rules.length} rule(s)`,
          });
        }
      }
    } catch (error) {
      console.warn(
        '[ghagga] Self-improve rules load failed (degrading gracefully):',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Build full (L2) context first, then choose fidelity level based on budget
  const fullStaticContext = formatStaticAnalysisContext(staticResult);

  // Prepend self-improve rules + negative examples to memory context
  const rawMemoryContextWithNegatives =
    [selfImproveRulesPrompt, negativeExamplesPrompt, rawMemoryContext].filter(Boolean).join('\n') ||
    null;

  const progressiveContext = buildProgressiveContext({
    staticResult,
    memoryContext: rawMemoryContextWithNegatives,
    stackHints,
    contextBudget,
    fullStaticContext,
  });

  const staticContext = progressiveContext.staticContext;
  const memoryContext = progressiveContext.memoryContext;

  // ── Step 5.1b: Build code intelligence context (optional) ───
  const codeIntelContext =
    codeIntelResults.length > 0
      ? buildCodeIntelSection(
          buildCodeIntelContext(codeIntelResults, input.settings.codeIntelMaxTokens),
        )
      : '';

  let codeIntelMetadata: CodeIntelMetadata | undefined;
  if (input.settings.enableCodeIntel) {
    codeIntelMetadata = {
      enabled: true,
      providerAvailable: !!input.codeIntelProvider,
      filesQueried: fileList.length,
      filesWithData: codeIntelResults.filter(
        (r) => r.callers.length > 0 || r.callees.length > 0 || r.imports.length > 0,
      ).length,
      queryDurationMs: 0, // Timing captured in queryCodeIntelSafe
    };
  }

  {
    const toolsSummary = Object.entries(staticResult)
      .map(([name, result]) => `  ${name}: ${result.status} (${result.findings.length} findings)`)
      .join('\n');
    const levelDetail = `  context levels: static=${progressiveContext.staticLevel}, memory=${progressiveContext.memoryLevel}`;
    const codeIntelDetail = codeIntelContext
      ? `\n  code-intel: ${codeIntelResults.length} file(s) with structural data`
      : '\n  code-intel: disabled or unavailable';
    emit({
      step: 'static-results',
      message: `Static analysis complete (context: static=${progressiveContext.staticLevel}, memory=${progressiveContext.memoryLevel})`,
      detail:
        toolsSummary +
        (rawMemoryContext ? '\n  memory: loaded' : '\n  memory: disabled') +
        codeIntelDetail +
        '\n' +
        levelDetail,
    });
  }

  // ── Step 5.4: Build checklist context (optional) ────────────
  let checklistContext = '';
  const resolvedChecklist = resolveChecklistConfig(input.settings.checklist);
  if (resolvedChecklist) {
    checklistContext = buildChecklistContext(resolvedChecklist);
    if (checklistContext) {
      emit({
        step: 'checklist',
        message: `Checklist active: ${resolvedChecklist.dimensions.filter((d) => d.enabled).length} dimensions`,
      });
    }
  }

  // ── Step 5.5: AI Enhance (optional) ─────────────────────────
  // Resolve active provider early — needed by enhance block below and by Step 6
  const activeProvider = input.providerChain?.[0]?.provider ?? input.provider ?? 'gateway';
  const isCliBridge = activeProvider === 'cli-bridge';
  const isGateway = activeProvider === 'gateway';
  const isOllama = activeProvider === 'ollama';

  let enhancedStaticFindings: ReviewFinding[] | undefined;
  let enhanceMetadata: import('./enhance/types.js').EnhanceMetadata | undefined;

  if (input.enhance) {
    // Collect all static findings
    const allStaticFindings: ReviewFinding[] = [];
    for (const toolResult of Object.values(staticResult)) {
      allStaticFindings.push(...toolResult.findings);
    }

    if (allStaticFindings.length > 0) {
      emit({ step: 'static-analysis', message: 'Enhancing findings with AI...' });
      try {
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
        enhancedStaticFindings = mergeEnhanceResult(allStaticFindings, eResult);
        enhanceMetadata = eMeta;
      } catch (enhanceError) {
        failedSteps.push({
          step: 'ai-enhance',
          error: enhanceError instanceof Error ? enhanceError.message : String(enhanceError),
        });
        emit({
          step: 'static-analysis',
          message: 'AI enhance failed — continuing without enhancement',
        });
      }
    }
  }

  // ── Step 5.6: Author trust scoring (optional) ──────────────
  // When features.authorTrust is enabled and input.author is set, compute a
  // trust score from git history and potentially override the review mode.
  let trustOverrideMode: ReviewMode | undefined;

  if (input.features?.authorTrust && input.author) {
    try {
      const author = input.author;
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
        trustOverrideMode = recommendedMode as ReviewMode;
      }

      emit({
        step: 'author-trust',
        message: `[trust] author=${author} score=${trustScore.score} tier=${trustScore.tier} → mode=${recommendedMode}`,
      });
    } catch (error) {
      console.warn(
        '[ghagga] Author trust scoring failed (non-fatal):',
        error instanceof Error ? error.message : String(error),
      );
      failedSteps.push({
        step: 'author-trust',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Effective input mode — may be overridden by trust scoring
  const resolvedInputMode: ReviewMode = trustOverrideMode ?? input.mode;

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
    const combinedStackHints = stackHints + codeIntelContext + callChainContext;

    try {
      switch (effectiveMode) {
        case 'simple':
          result = await runSimpleReview({
            diff: truncatedDiff,
            staticContext,
            memoryContext,
            stackHints: combinedStackHints,
            checklistContext,
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
            diff: truncatedDiff,
            staticContext,
            memoryContext,
            stackHints: combinedStackHints,
            checklistContext,
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
            diff: truncatedDiff,
            models: buildConsensusModels(input.providerChain, primary),
            staticContext,
            memoryContext,
            stackHints: combinedStackHints,
            checklistContext,
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
            diff: truncatedDiff,
            provider: primary.provider as LLMProvider,
            model: primary.model,
            apiKey: primary.apiKey,
            staticContext,
            memoryContext,
            stackHints: combinedStackHints,
            checklistContext,
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
            diff: truncatedDiff,
            provider: (primary.provider as LLMProvider) ?? 'cli-bridge',
            model: primary.model ?? 'auto',
            apiKey: primary.apiKey ?? '',
            staticContext,
            memoryContext,
            stackHints: combinedStackHints,
            checklistContext,
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
      failedSteps.push({
        step: 'ai-review',
        error: error instanceof Error ? error.message : String(error),
      });
      emit({ step: 'agent-failed', message: 'AI review failed — returning static analysis only' });
      result = createStaticOnlyResult(staticResult, resolvedInputMode, startTime);
      result.status = 'NEEDS_HUMAN_REVIEW';
      result.summary = `AI review failed (${error instanceof Error ? error.message : 'unknown error'}). Static analysis results are shown below.`;
    }
  }

  // ── Step 7: Merge static analysis into result ──────────────
  result.staticAnalysis = staticResult;
  result.memoryContext = memoryContext;

  // Add static analysis findings to the result's findings array (dynamic — all tools)
  const staticFindings = Object.values(staticResult).flatMap((toolResult) =>
    toolResult && typeof toolResult === 'object' && 'findings' in toolResult
      ? toolResult.findings
      : [],
  );
  result.findings = [...result.findings, ...staticFindings];

  // ── Merge enhanced static findings into result ──────────────
  if (enhancedStaticFindings && enhanceMetadata) {
    result.enhanced = true;
    result.enhanceMetadata = enhanceMetadata;
    // Replace static-sourced findings with enhanced versions
    const nonStaticFindings = result.findings.filter((f) => f.source === 'ai');
    result.findings = [...enhancedStaticFindings, ...nonStaticFindings];
  }

  // Track which tools ran successfully
  result.metadata.toolsRun = [];
  result.metadata.toolsSkipped = [];
  for (const [name, tool] of Object.entries(staticResult)) {
    if (tool.status === 'success') {
      result.metadata.toolsRun.push(name);
    } else {
      result.metadata.toolsSkipped.push(name);
    }
  }

  // Update execution time to cover the full pipeline
  result.metadata.executionTimeMs = Date.now() - startTime;

  // Add file stats metadata (for emoji stats bar in comment)
  result.metadata.totalAdditions = allFiles.reduce((sum, f) => sum + f.additions, 0);
  result.metadata.totalDeletions = allFiles.reduce((sum, f) => sum + f.deletions, 0);
  result.metadata.fileList = allFiles.map((f) => f.path);

  // Add blast-radius metadata (if applicable)
  if (blastRadiusMetadata) {
    result.metadata.blastRadius = blastRadiusMetadata;
  }

  // Add code intelligence metadata (if applicable)
  if (codeIntelMetadata) {
    result.codeIntelMetadata = codeIntelMetadata;
  }

  // ── Step 7.4: Exploitability analysis (optional) ────────────
  if (input.settings.enableBlastRadius && result.findings.length > 0) {
    const trivyCveCount = result.findings.filter(
      (f) => f.source === 'trivy' && f.category === 'dependency-vulnerability',
    ).length;

    if (trivyCveCount > 0) {
      emit({
        step: 'exploitability',
        message: `Analyzing exploitability for ${trivyCveCount} CVE(s)...`,
      });
      try {
        // Load graph if not already loaded (reuse from blast-radius when available)
        const exploitGraph = input.graphLoader ? await input.graphLoader.load() : null;

        analyzeExploitability(result.findings, exploitGraph);

        const labels = result.findings
          .filter((f) => f.exploitability)
          .reduce(
            (acc, f) => {
              const key = f.exploitability ?? 'unknown';
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            },
            {} as Record<string, number>,
          );

        const exploitable = labels.exploitable ?? 0;
        const potential = labels['potentially-exploitable'] ?? 0;
        const notExploitable = labels['not-exploitable'] ?? 0;

        emit({
          step: 'exploitability',
          message: `Exploitability analysis complete: ${exploitable} exploitable, ${potential} potentially, ${notExploitable} not exploitable`,
        });

        // Function-level usage analysis (requires fileReader)
        if (input.fileReader) {
          emit({
            step: 'usage-analysis',
            message: 'Analyzing function-level usage of vulnerable packages...',
          });
          await analyzeUsage(result.findings, exploitGraph, input.fileReader);

          const usageLabels = result.findings
            .filter((f) => f.usageLabel)
            .reduce(
              (acc, f) => {
                const key = f.usageLabel ?? 'unknown';
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
              },
              {} as Record<string, number>,
            );

          const inUse = usageLabels['in-use'] ?? 0;
          const importedNotCalled = usageLabels['imported-not-called'] ?? 0;
          const notInUse = usageLabels['not-in-use'] ?? 0;

          emit({
            step: 'usage-analysis',
            message: `Usage analysis complete: ${inUse} in-use, ${importedNotCalled} imported-not-called, ${notInUse} not-in-use`,
          });
        }
      } catch (error) {
        console.warn(
          '[ghagga] Exploitability analysis failed (non-fatal):',
          error instanceof Error ? error.message : String(error),
        );
        failedSteps.push({
          step: 'exploitability',
          error: error instanceof Error ? error.message : String(error),
        });
        emit({
          step: 'exploitability',
          message: 'Exploitability analysis failed — continuing without',
        });
      }
    }
  }

  // ── Step 7.5: Score findings against checklist (optional) ───
  if (resolvedChecklist && result.findings.length > 0) {
    result.checklistScore = scoreFindings(result.findings, resolvedChecklist);
    emit({
      step: 'checklist-score',
      message: `Checklist score: ${result.checklistScore.totalScore} (${result.checklistScore.findings.length} matched findings)`,
    });
  }

  // ── Step 7.6: Recursive review (optional) ──────────────────────
  if (input.settings.enableRecursiveReview && aiEnabled && result.findings.length > 0) {
    emit({ step: 'recursive-review', message: 'Running recursive review on suggested fixes...' });
    try {
      const generateFns = resolveGenerateTextFns(input, isCliBridge, isGateway, isOllama);
      const report = await recursiveReview({
        originalDiff: truncatedDiff,
        findings: result.findings,
        generateFn: generateFns[0],
        config: {
          maxIterations: input.settings.maxRecursiveIterations ?? 2,
        },
        onProgress: (message) => emit({ step: 'recursive-review', message }),
      });

      if (report) {
        result.recursiveReview = report;

        // Add regressions to the findings array
        if (report.regressions.length > 0) {
          result.findings = [...result.findings, ...report.regressions];
          emit({
            step: 'recursive-review',
            message: `Recursive review: ${report.regressions.length} regression(s) found in suggested fixes`,
          });
        } else {
          emit({
            step: 'recursive-review',
            message: `Recursive review: suggestions validated — ${report.converged ? 'converged' : 'no regressions'} after ${report.iterations} iteration(s)`,
          });
        }
      }
    } catch (error) {
      console.warn(
        '[ghagga] Recursive review failed (non-fatal):',
        error instanceof Error ? error.message : String(error),
      );
      failedSteps.push({
        step: 'recursive-review',
        error: error instanceof Error ? error.message : String(error),
      });
      emit({ step: 'recursive-review', message: 'Recursive review failed — continuing without' });
    }
  }

  // ── Step 7.7: Code-doc validation (optional) ───────────────────
  if (input.settings.enableDocValidation && filteredFiles.length > 0) {
    try {
      const changedSymbols = extractChangedSymbolsFromDiff(filteredDiff);
      if (changedSymbols.length > 0) {
        emit({
          step: 'doc-validation',
          message: `Scanning docs for ${changedSymbols.length} changed symbol(s)...`,
        });

        const docResult = scanDocsForSymbolRefs(changedSymbols, allFiles, fileList);
        result.docValidation = docResult;

        if (docResult.staleReferences.length > 0) {
          // Convert stale references to findings
          for (const ref of docResult.staleReferences) {
            result.findings.push({
              severity: 'low',
              category: 'documentation',
              file: ref.file,
              line: ref.line,
              message: `Documentation references \`${ref.symbol}\` which was changed in this PR but this doc was not updated.`,
              suggestion: `Review and update the reference to \`${ref.symbol}\` in this file.`,
              source: 'doc-validation',
            });
          }
          emit({
            step: 'doc-validation',
            message: `Doc validation: ${docResult.staleReferences.length} stale reference(s) found in ${docResult.docsScanned} doc(s)`,
          });
        } else {
          emit({
            step: 'doc-validation',
            message: `Doc validation: no stale references (${docResult.docsScanned} docs scanned)`,
          });
        }
      }
    } catch (error) {
      console.warn(
        '[ghagga] Doc validation failed (non-fatal):',
        error instanceof Error ? error.message : String(error),
      );
      failedSteps.push({
        step: 'doc-validation',
        error: error instanceof Error ? error.message : String(error),
      });
      emit({ step: 'doc-validation', message: 'Doc validation failed — continuing without' });
    }
  }

  // ── Step 7.8: Semantic ranking of findings (optional) ─────────
  const semanticRankingEnabled =
    input.features?.semanticRanking !== false && !!input.embeddingProvider;
  if (semanticRankingEnabled && result.findings.length > 1) {
    emit({ step: 'semantic-ranking', message: 'Reranking findings by semantic relevance...' });
    try {
      result.findings = await rankFindings(result.findings, input.embeddingProvider);
      emit({
        step: 'semantic-ranking',
        message: `Semantic ranking complete (${result.findings.length} findings reranked)`,
      });
    } catch (error) {
      console.warn(
        '[ghagga] Semantic ranking failed (non-fatal):',
        error instanceof Error ? error.message : String(error),
      );
      failedSteps.push({
        step: 'semantic-ranking',
        error: error instanceof Error ? error.message : String(error),
      });
      emit({ step: 'semantic-ranking', message: 'Semantic ranking failed — continuing without' });
    }
  }

  // ── Step 8: Persist to memory (awaited for SQLite correctness) ──
  if (input.settings.enableMemory && input.memoryStorage && input.context) {
    await persistReviewObservations(
      input.memoryStorage,
      input.context.repoFullName,
      input.context.prNumber,
      result,
    ).catch((error: unknown) => {
      console.warn(
        '[ghagga] Memory persist failed (non-fatal):',
        error instanceof Error ? error.message : String(error),
      );
      failedSteps.push({
        step: 'memory-persist',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // ── Step 9: Attach failed steps and mark as PARTIAL ─────────
  if (failedSteps.length > 0) {
    result.failedSteps = failedSteps;
    // Only downgrade to PARTIAL if the review otherwise appeared successful
    if (result.status === 'PASSED') {
      result.status = 'PARTIAL';
    }
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Run static analysis with graceful degradation.
 * Returns a result with all tools skipped if anything goes wrong.
 */
async function runStaticAnalysisSafe(
  fileList: string[],
  input: ReviewInput,
  failedSteps: { step: string; error: string }[],
) {
  try {
    // Build a file map for static analysis (paths only, content from diff)
    const files = new Map<string, string>();
    for (const path of fileList) {
      files.set(path, ''); // Content is extracted from diff by the tool runner
    }

    return await runStaticAnalysis(files, '.', {
      enableSemgrep: input.settings.enableSemgrep,
      enableTrivy: input.settings.enableTrivy,
      enableCpd: input.settings.enableCpd,
      customRules: input.settings.customRules,
      enabledTools: input.settings.enabledTools,
      disabledTools: input.settings.disabledTools,
    });
  } catch (error) {
    console.warn(
      '[ghagga] Static analysis failed (degrading gracefully):',
      error instanceof Error ? error.message : String(error),
    );
    failedSteps.push({
      step: 'static-analysis',
      error: error instanceof Error ? error.message : String(error),
    });

    const errorResult = {
      status: 'error' as const,
      findings: [],
      error: error instanceof Error ? error.message : String(error),
      executionTimeMs: 0,
    };

    return {
      semgrep: errorResult,
      trivy: errorResult,
      cpd: errorResult,
    };
  }
}

/**
 * Search memory with graceful degradation.
 * Returns null if memory is disabled or unavailable.
 */
async function searchMemorySafe(
  input: ReviewInput,
  fileList: string[],
  failedSteps: { step: string; error: string }[],
): Promise<string | null> {
  if (!input.settings.enableMemory || !input.memoryStorage || !input.context) {
    return null;
  }

  try {
    return await searchMemoryForContext(input.memoryStorage, input.context.repoFullName, fileList);
  } catch (error) {
    console.warn(
      '[ghagga] Memory search failed (degrading gracefully):',
      error instanceof Error ? error.message : String(error),
    );
    failedSteps.push({
      step: 'memory-search',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Query the code intelligence provider for structural context.
 * Returns an empty array when disabled, unavailable, or on error.
 */
async function queryCodeIntelSafe(
  input: ReviewInput,
  fileList: string[],
  emit: (event: import('./types.js').ProgressEvent) => void,
  failedSteps: { step: string; error: string }[],
): Promise<CodeIntelResult[]> {
  if (!input.settings.enableCodeIntel || !input.codeIntelProvider) {
    return [];
  }

  const startTime = Date.now();
  emit({
    step: 'code-intel',
    message: `Querying code intelligence for ${fileList.length} file(s)...`,
  });

  try {
    const results: CodeIntelResult[] = [];
    const provider = input.codeIntelProvider;

    // Query each changed file for structural data (parallel)
    const queries = fileList.map(async (file) => {
      const [imports, exports] = await Promise.all([
        provider.getFileImports(file),
        provider.getFileExports(file),
      ]);

      // Query callers/callees for each exported symbol
      const callerResults = await Promise.all(
        exports.slice(0, 10).map((sym) => provider.getCallers(sym, file)),
      );
      const calleeResults = await Promise.all(
        exports.slice(0, 10).map((sym) => provider.getCallees(sym, file)),
      );

      const callers = callerResults.flat();
      const callees = calleeResults.flat();

      return { file, callers, callees, imports, exports };
    });

    const settled = await Promise.allSettled(queries);
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      }
    }

    const durationMs = Date.now() - startTime;
    const withData = results.filter(
      (r) => r.callers.length > 0 || r.callees.length > 0 || r.imports.length > 0,
    ).length;

    emit({
      step: 'code-intel',
      message: `Code intelligence: ${withData}/${results.length} files with structural data (${durationMs}ms)`,
    });

    return results;
  } catch (error) {
    console.warn(
      '[ghagga] Code intelligence query failed (degrading gracefully):',
      error instanceof Error ? error.message : String(error),
    );
    failedSteps.push({
      step: 'code-intel',
      error: error instanceof Error ? error.message : String(error),
    });
    emit({ step: 'code-intel', message: 'Code intelligence: failed — continuing without' });
    return [];
  }
}
