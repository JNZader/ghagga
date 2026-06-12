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

import { buildCodeIntelSection, buildStackHints } from './agents/prompts.js';
import { buildChecklistContext, resolveChecklistConfig } from './checklist/index.js';
import { buildCodeIntelContext } from './code-intel/context.js';
import type { CodeIntelMetadata, CodeIntelResult } from './code-intel/types.js';
import { detectFlood } from './flood/index.js';
import { computeBlastRadius } from './graph/blast-radius.js';
import { buildCallChainFromDiff } from './graph/call-chain.js';
import { buildReverseDependencyMap, findDependents } from './graph/reverse-deps.js';
import type { BlastRadiusMetadata } from './graph/schema.js';
import { isGraphStale } from './graph/schema.js';
import { searchMemoryForContext } from './memory/search.js';
import { SqliteMemoryStorage } from './memory/sqlite.js';
import { formatNegativeExamplesPrompt } from './negative.js';
import { runDegradable } from './pipeline/degrade.js';
import { enrich } from './pipeline/enrich.js';
import { execute } from './pipeline/execute.js';
import { finalize } from './pipeline/finalize.js';
import { resolveAiEnabled, resolvePrimaryModel } from './pipeline/providers.js';
import { createSkippedResult } from './pipeline/results.js';
import type { FailedStep, PipelineState, PipelineStateBase } from './pipeline/state.js';
import { deriveRules, formatRulesForPrompt, loadFeedback } from './self-improve/index.js';
import { formatStaticAnalysisContext, runStaticAnalysis } from './tools/runner.js';
import type { LLMProvider, ReviewInput, ReviewResult } from './types.js';
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
    // reportFailure: false is DELIBERATE — call-chain degrades with a warn only
    // and never lands in failedSteps (pinned by the golden degradation suite).
    await runDegradable(
      { failedSteps, emit },
      {
        step: 'call-chain',
        warnLabel: '[ghagga] Call-chain/reverse-deps failed (degrading gracefully):',
        reportFailure: false,
      },
      async () => {
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
      },
    );
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
    // reportFailure: false is DELIBERATE — negative-examples degrades with a warn
    // only and never lands in failedSteps (pinned by the golden degradation suite).
    await runDegradable(
      { failedSteps, emit },
      {
        step: 'negative-examples',
        warnLabel: '[ghagga] Negative examples load failed (degrading gracefully):',
        reportFailure: false,
      },
      () => {
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
      },
    );
  }

  // ── Step 5.0a: Self-improve rules (optional) ─────────────────
  let selfImproveRulesPrompt = '';
  if (input.settings.selfImprovePath) {
    const selfImprovePath = input.settings.selfImprovePath;
    // reportFailure: false is DELIBERATE — self-improve degrades with a warn only
    // and never lands in failedSteps (pinned by the golden degradation suite).
    await runDegradable(
      { failedSteps, emit },
      {
        step: 'self-improve',
        warnLabel: '[ghagga] Self-improve rules load failed (degrading gracefully):',
        reportFailure: false,
      },
      async () => {
        const feedback = await loadFeedback(selfImprovePath);
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
      },
    );
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

  // ── Phase boundary: populate shared PipelineState (sans result) ──
  // Locals settled by the steps above migrate into state here. The
  // execute phase resolves provider flags / enhance / trust onto this
  // state and RETURNS the ReviewResult it creates; enrich and finalize
  // then mutate `state.result` in-place.
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
    staticResult,
    rawMemoryContext,
    codeIntelResults,
    codeIntelMetadata,
    staticContext,
    memoryContext,
    codeIntelContext,
    checklistContext,
    resolvedChecklist,
    negativeExamplesPrompt,
    selfImproveRulesPrompt,
    // Resolved by the execute phase (placeholders until then):
    activeProvider: '',
    isCliBridge: false,
    isGateway: false,
    isOllama: false,
    resolvedInputMode: input.mode, // pre-trust value; execute overwrites
    failedSteps,
  };

  // ── Steps 5.5 → 6: execute (enhance compute + trust + dispatch) ──
  const result = await execute(base);

  // Attach the result created by execute. Object.assign keeps the SAME
  // base object (no copy — aliases like `failedSteps` stay intact) and
  // upgrades it to a full PipelineState.
  const state: PipelineState = Object.assign(base, { result });

  // ── Steps 7 → 7.8: enrich (merge + post-processing) ─────────
  await enrich(state);

  // ── Steps 8 → 9: finalize (persist + status downgrade) ──────
  await finalize(state);

  return state.result;
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
