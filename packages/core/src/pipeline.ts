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
import {
  buildMemoryContext,
  buildReviewLevelInstruction,
  buildStackHints,
  REVIEW_CALIBRATION,
  SIMPLE_REVIEW_SYSTEM,
} from './agents/prompts.js';
import { parseReviewResponse, runSimpleReview } from './agents/simple.js';
import { runWorkflowReview } from './agents/workflow.js';
import { enhanceFindings, mergeEnhanceResult } from './enhance/index.js';
import { serializeFindings } from './enhance/prompt.js';
import { computeBlastRadius } from './graph/blast-radius.js';
import type { BlastRadiusMetadata } from './graph/schema.js';
import { isGraphStale } from './graph/schema.js';
import { persistReviewObservations } from './memory/persist.js';
import { searchMemoryForContext } from './memory/search.js';
import { generateViaCLI, resolveCredentialEnvVar } from './providers/cli-bridge.js';
import { initializeDefaultTools } from './tools/plugins/index.js';
import { toolRegistry } from './tools/registry.js';
import {
  formatStaticAnalysisContext,
  isToolRegistryEnabled,
  runStaticAnalysis,
} from './tools/runner.js';
import type {
  LLMProvider,
  ProviderChainEntry,
  ReviewFinding,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from './types.js';
import { buildProgressiveContext } from './utils/context-levels.js';
import { filterDiffFiles, filterIgnoredFiles, parseDiffFiles, truncateDiff } from './utils/diff.js';
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

  // Single provider mode (CLI/Action backward compat)
  if (!input.apiKey) {
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
  const [staticResult, rawMemoryContext] = await Promise.all([
    input.precomputedStaticAnalysis
      ? Promise.resolve(input.precomputedStaticAnalysis)
      : runStaticAnalysisSafe(fileList, input),
    aiEnabled ? searchMemorySafe(input, fileList) : Promise.resolve(null),
  ]);

  // Build full (L2) context first, then choose fidelity level based on budget
  const fullStaticContext = formatStaticAnalysisContext(staticResult);

  const progressiveContext = buildProgressiveContext({
    staticResult,
    memoryContext: rawMemoryContext,
    stackHints,
    contextBudget,
    fullStaticContext,
  });

  const staticContext = progressiveContext.staticContext;
  const memoryContext = progressiveContext.memoryContext;

  {
    const toolsSummary = Object.entries(staticResult)
      .map(([name, result]) => `  ${name}: ${result.status} (${result.findings.length} findings)`)
      .join('\n');
    const levelDetail = `  context levels: static=${progressiveContext.staticLevel}, memory=${progressiveContext.memoryLevel}`;
    emit({
      step: 'static-results',
      message: `Static analysis complete (context: static=${progressiveContext.staticLevel}, memory=${progressiveContext.memoryLevel})`,
      detail:
        toolsSummary +
        (rawMemoryContext ? '\n  memory: loaded' : '\n  memory: disabled') +
        '\n' +
        levelDetail,
    });
  }

  // ── Step 5.5: AI Enhance (optional) ─────────────────────────
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
        const serialized = serializeFindings(allStaticFindings);
        const { result: eResult, metadata: eMeta } = await enhanceFindings({
          findings: serialized,
          provider: primary.provider,
          model: primary.model,
          apiKey: primary.apiKey,
        });
        enhancedStaticFindings = mergeEnhanceResult(allStaticFindings, eResult);
        enhanceMetadata = eMeta;
      } catch {
        emit({
          step: 'static-analysis',
          message: 'AI enhance failed — continuing without enhancement',
        });
      }
    }
  }

  // ── Step 6: Execute agent mode (or skip if AI disabled) ────
  let result: ReviewResult;

  // Check if CLI bridge should be used (intercept before normal provider flow)
  const isCliBridge =
    input.provider === 'cli-bridge' ||
    input.providerChain?.[0]?.provider === ('cli-bridge' as ProviderChainEntry['provider']);

  if (!aiEnabled) {
    // Static-only mode: no LLM calls
    emit({ step: 'agent-start', message: 'AI review disabled — returning static analysis only' });
    result = createStaticOnlyResult(staticResult, input.mode, startTime);
  } else if (isCliBridge) {
    // CLI Bridge mode: call LLM CLIs directly instead of AI SDK
    // Resolve CLI bridge entry from provider chain or flat input fields
    const cliBridgeEntry = input.providerChain?.[0];
    const preferredCLI = (cliBridgeEntry?.model ?? input.model) !== 'auto'
      ? (cliBridgeEntry?.model ?? input.model)
      : undefined;

    const cliModel = cliBridgeEntry?.cliModel;

    // Build credentials from the decrypted API key (server decrypts before passing to pipeline)
    const decryptedKey = cliBridgeEntry?.apiKey || input.apiKey;
    const credentialEnvName = resolveCredentialEnvVar(preferredCLI, cliModel);
    const credentials: Record<string, string> = {};
    if (decryptedKey && credentialEnvName) {
      credentials[credentialEnvName] = decryptedKey;
    }

    emit({
      step: 'agent-start',
      message: `Running CLI bridge review (preferred: ${preferredCLI ?? 'auto'}${cliModel ? `, model: ${cliModel}` : ''})...`,
    });

    try {
      result = await runCLIBridgeReview({
        diff: truncatedDiff,
        staticContext,
        memoryContext,
        stackHints,
        reviewLevel: input.settings.reviewLevel,
        preferredCLI,
        cliModel,
        credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
        onProgress: input.onProgress,
      });
    } catch (error) {
      console.warn(
        '[ghagga] CLI bridge review failed, returning static analysis only:',
        error instanceof Error ? error.message : String(error),
      );
      emit({
        step: 'agent-failed',
        message: 'CLI bridge review failed — returning static analysis only',
      });
      result = createStaticOnlyResult(staticResult, input.mode, startTime);
      result.status = 'NEEDS_HUMAN_REVIEW';
      result.summary = `CLI bridge review failed (${error instanceof Error ? error.message : 'unknown error'}). Static analysis results are shown below.`;
    }
  } else {
    // Resolve the primary provider for agent calls
    const primary = resolvePrimaryProvider(input);
    emit({
      step: 'agent-start',
      message: `Running ${input.mode} agent with ${primary.provider}/${primary.model}...`,
    });

    try {
      switch (input.mode) {
        case 'simple':
          result = await runSimpleReview({
            diff: truncatedDiff,
            provider: primary.provider as LLMProvider,
            model: primary.model,
            apiKey: primary.apiKey,
            staticContext,
            memoryContext,
            stackHints,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
          });
          break;

        case 'workflow':
          result = await runWorkflowReview({
            diff: truncatedDiff,
            provider: primary.provider as LLMProvider,
            model: primary.model,
            apiKey: primary.apiKey,
            providerChain: input.providerChain,
            staticContext,
            memoryContext,
            stackHints,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
          });
          break;

        case 'consensus':
          result = await runConsensusReview({
            diff: truncatedDiff,
            models: buildConsensusModels(input.providerChain, primary),
            staticContext,
            memoryContext,
            stackHints,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
          });
          break;

        case 'diagnostic':
          result = await runDiagnosticReview({
            diff: truncatedDiff,
            provider: primary.provider as LLMProvider,
            model: primary.model,
            apiKey: primary.apiKey,
            staticContext,
            memoryContext,
            stackHints,
            reviewLevel: input.settings.reviewLevel,
            onProgress: input.onProgress,
          });
          break;

        default: {
          const _exhaustive: never = input.mode;
          throw new Error(`Unknown review mode: ${_exhaustive}`);
        }
      }
    } catch (error) {
      // All providers failed — return static results with NEEDS_HUMAN_REVIEW
      console.warn(
        '[ghagga] All AI providers failed, returning static analysis only:',
        error instanceof Error ? error.message : String(error),
      );
      emit({ step: 'agent-failed', message: 'AI review failed — returning static analysis only' });
      result = createStaticOnlyResult(staticResult, input.mode, startTime);
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
    });
  }

  return result;
}

// ─── Provider Resolution ────────────────────────────────────────

/**
 * Determine if AI review is enabled.
 * Defaults to true for backward compatibility (CLI/Action don't set this).
 */
function resolveAiEnabled(input: ReviewInput): boolean {
  if (input.aiReviewEnabled === false) return false;
  // If chain is explicitly empty and no single provider, treat as disabled
  if (input.providerChain && input.providerChain.length === 0 && !input.provider) {
    console.warn(
      '[ghagga] AI review enabled but provider chain is empty and no single provider — treating as disabled',
    );
    return false;
  }
  return true;
}

/**
 * Resolve the primary provider from chain or flat fields.
 * Returns the first entry in the chain, or builds one from flat fields.
 */
function resolvePrimaryProvider(input: ReviewInput): ProviderChainEntry {
  if (input.providerChain && input.providerChain.length > 0) {
    const first = input.providerChain[0];
    if (first) return first;
  }

  // Backward compat: single provider from flat fields
  if (!input.provider || !input.model || !input.apiKey) {
    throw new Error('No provider chain and no single provider configured');
  }
  return {
    provider: input.provider as ProviderChainEntry['provider'],
    model: input.model,
    apiKey: input.apiKey,
  };
}

/**
 * Build the 3-entry ConsensusModelConfig array for the for/against/neutral votes.
 *
 * Distribution rules (given a chain of length N):
 *   N >= 3 : chain[0]→for, chain[1]→against, chain[2]→neutral
 *   N == 2 : chain[0]→for, chain[1]→against, chain[0]→neutral
 *   N == 1 : all 3 votes use chain[0]  (same as primary-only)
 *   N == 0 : all 3 votes use `primary` (backward compat)
 *
 * This spreads consensus votes across providers so each vote hits a
 * different TPM budget instead of all three hammering the same limit.
 */
function buildConsensusModels(
  chain: ProviderChainEntry[] | undefined,
  primary: ProviderChainEntry,
): import('./agents/consensus.js').ConsensusModelConfig[] {
  const stances = ['for', 'against', 'neutral'] as const;

  return stances.map((stance, i) => {
    const entry =
      chain && chain.length > 0 ? (chain[i % chain.length] as ProviderChainEntry) : primary;
    return {
      provider: entry.provider as import('./types.js').LLMProvider,
      model: entry.model,
      apiKey: entry.apiKey,
      stance,
    };
  });
}

/**
 * Resolve the model name for token budget calculation.
 */
function resolvePrimaryModel(input: ReviewInput): string {
  if (input.providerChain && input.providerChain.length > 0) {
    return input.providerChain[0]?.model ?? 'gpt-4o-mini';
  }
  return input.model ?? 'gpt-4o-mini';
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Run static analysis with graceful degradation.
 * Returns a result with all tools skipped if anything goes wrong.
 */
async function runStaticAnalysisSafe(fileList: string[], input: ReviewInput) {
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
async function searchMemorySafe(input: ReviewInput, fileList: string[]): Promise<string | null> {
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
    return null;
  }
}

/**
 * Create a SKIPPED result when all files are filtered out.
 */
function createSkippedResult(input: ReviewInput, startTime: number): ReviewResult {
  const primary = input.providerChain?.[0];

  // Build a dynamic skipped result (legacy keys always present)
  const skippedToolResult = { status: 'skipped' as const, findings: [], executionTimeMs: 0 };
  const staticAnalysis: import('./types.js').StaticAnalysisResult = {
    semgrep: { ...skippedToolResult },
    trivy: { ...skippedToolResult },
    cpd: { ...skippedToolResult },
  };

  // Collect all tool names for the toolsSkipped metadata
  const allToolNames = ['semgrep', 'trivy', 'cpd'];

  // When registry is enabled, include all registered tools as skipped
  if (isToolRegistryEnabled()) {
    initializeDefaultTools();
    for (const tool of toolRegistry.getAll()) {
      if (!staticAnalysis[tool.name]) {
        staticAnalysis[tool.name] = { ...skippedToolResult };
      }
      if (!allToolNames.includes(tool.name)) {
        allToolNames.push(tool.name);
      }
    }
  }

  return {
    status: 'SKIPPED' as ReviewStatus,
    summary: 'All files in the diff matched ignore patterns. No review was performed.',
    findings: [],
    staticAnalysis,
    memoryContext: null,
    metadata: {
      mode: input.mode,
      provider: primary?.provider ?? input.provider ?? 'none',
      model: primary?.model ?? input.model ?? 'unknown',
      tokensUsed: 0,
      executionTimeMs: Date.now() - startTime,
      toolsRun: [],
      toolsSkipped: allToolNames,
    },
  };
}

/**
 * Create a result with only static analysis findings (no AI).
 * Used when AI review is disabled or when all providers fail.
 */
function createStaticOnlyResult(
  staticResult: import('./types.js').StaticAnalysisResult,
  mode: import('./types.js').ReviewMode,
  startTime: number,
): ReviewResult {
  // Determine status from static findings severity (dynamic — all tools)
  const allFindings = Object.values(staticResult).flatMap((toolResult) =>
    toolResult && typeof toolResult === 'object' && 'findings' in toolResult
      ? toolResult.findings
      : [],
  );
  const hasCriticalOrHigh = allFindings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );

  return {
    status: hasCriticalOrHigh ? 'FAILED' : 'PASSED',
    summary:
      allFindings.length > 0
        ? `Static analysis found ${allFindings.length} finding(s). AI review was not performed.`
        : 'Static analysis found no issues. AI review was not performed.',
    findings: [], // Will be merged in step 7
    staticAnalysis: staticResult,
    memoryContext: null,
    metadata: {
      mode,
      provider: 'none',
      model: 'static-only',
      tokensUsed: 0,
      executionTimeMs: Date.now() - startTime,
      toolsRun: [],
      toolsSkipped: [],
    },
  };
}

// ─── CLI Bridge Review ──────────────────────────────────────────

interface CLIBridgeReviewInput {
  diff: string;
  staticContext: string;
  memoryContext: string | null;
  stackHints: string;
  reviewLevel: import('./types.js').ReviewLevel;
  preferredCLI?: string;
  /** OpenCode model in `provider/model` format. */
  cliModel?: string;
  /** Injected credentials mapped by env var name (e.g., { ANTHROPIC_API_KEY: 'sk-...' }). */
  credentials?: Record<string, string>;
  onProgress?: import('./types.js').ProgressCallback;
}

/**
 * Run a review using CLI bridge (calls LLM CLIs directly).
 *
 * Builds the same prompt as simple mode, calls generateViaCLI(),
 * and parses the response with the same parser.
 * Simple mode only — workflow/consensus would need multiple sequential calls.
 */
async function runCLIBridgeReview(input: CLIBridgeReviewInput): Promise<ReviewResult> {
  const { diff, staticContext, memoryContext, stackHints, reviewLevel, preferredCLI, cliModel, credentials } = input;
  const emit = input.onProgress ?? (() => {});

  const startTime = Date.now();

  // Build the same system prompt as simple mode
  const system = [
    SIMPLE_REVIEW_SYSTEM,
    staticContext,
    buildMemoryContext(memoryContext),
    stackHints,
    buildReviewLevelInstruction(reviewLevel),
    REVIEW_CALIBRATION,
  ]
    .filter(Boolean)
    .join('\n');

  // Build the user prompt with the diff
  const prompt = `Please review the following code changes:\n\n\`\`\`diff\n${diff}\n\`\`\``;

  emit({
    step: 'cli-bridge-call',
    message: `Calling CLI bridge (preferred: ${preferredCLI ?? 'auto'})...`,
  });

  // generateViaCLI is synchronous (execSync) but we wrap in async for pipeline compat
  const cliResult = generateViaCLI(prompt, system, { preferredCLI, cliModel, credentials });

  const executionTimeMs = Date.now() - startTime;

  emit({
    step: 'cli-bridge-done',
    message: `CLI bridge review complete via ${cliResult.cli} — ${(executionTimeMs / 1000).toFixed(1)}s`,
  });

  return parseReviewResponse(
    cliResult.text,
    'cli-bridge',
    cliResult.cli,
    0, // No token count available from CLI
    executionTimeMs,
    memoryContext,
  );
}
