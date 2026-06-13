/**
 * Gather-context phase: steps 5 → 5.4 of the review pipeline.
 *
 *   5     static analysis ∥ memory search ∥ code-intel — ONE literal
 *         `Promise.all` trio: all three start before any resolves.
 *         Do NOT sequentialize (pinned by the parallelism golden).
 *   5.0   negative examples (degrades WITHOUT failedSteps — deliberate)
 *   5.0a  self-improve rules (degrades WITHOUT failedSteps — deliberate)
 *   5.1   progressive context (static + memory fidelity levels)
 *   5.1b  code intelligence context + metadata, then static-results emit
 *   5.4   checklist context
 *
 * Writes the gather-owned state fields (placeholder-initialized by the
 * orchestrator) unconditionally, before any downstream consumer runs.
 * The three `*Safe` degradation helpers live in `gather-safe.ts` —
 * moved byte-intact from pipeline.ts (incl. code-intel's emit-throw-only
 * catch, pinned by the golden suite).
 */

import { buildCodeIntelSection } from '../agents/prompts.js';
import { buildChecklistContext, resolveChecklistConfig } from '../checklist/index.js';
import { buildCodeIntelContext } from '../code-intel/context.js';
import { SqliteMemoryStorage } from '../memory/sqlite.js';
import { formatNegativeExamplesPrompt } from '../negative.js';
import { deriveRules, formatRulesForPrompt, loadFeedback } from '../self-improve/index.js';
import { formatStaticAnalysisContext } from '../tools/runner.js';
import { buildProgressiveContext } from '../utils/context-levels.js';
import { runDegradable } from './degrade.js';
import { queryCodeIntelSafe, runStaticAnalysisSafe, searchMemorySafe } from './gather-safe.js';
import type { PipelineStateBase } from './state.js';

/**
 * Run the gather-context phase. Mutates the gather-owned fields on
 * `state` (static analysis, memory, code-intel, prompts, checklist).
 */
export async function gatherContext(state: PipelineStateBase): Promise<void> {
  const { input, emit, aiEnabled, fileList, failedSteps } = state;

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
  state.staticResult = staticResult;
  state.rawMemoryContext = rawMemoryContext;
  state.codeIntelResults = codeIntelResults;

  // ── Step 5.0: Negative examples (optional) ────────────────────
  // Load dismissed findings for the files in this diff and prepend them
  // to the memory context so agents suppress known false positives.
  if (
    input.features?.negativeExamples !== false &&
    input.memoryStorage instanceof SqliteMemoryStorage
  ) {
    // reportFailure: false is DELIBERATE — negative-examples degrades with a warn
    // only and never lands in failedSteps (pinned by the golden degradation suite).
    // It IS recorded in warnOnlyDegradations → coverageComplete reflects it.
    await runDegradable(
      state,
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
        state.negativeExamplesPrompt = formatNegativeExamplesPrompt(uniqueExamples);
        if (state.negativeExamplesPrompt) {
          emit({
            step: 'negative-examples',
            message: `Loaded ${uniqueExamples.length} dismissed finding(s) — injecting suppression context`,
          });
        }
      },
    );
  }

  // ── Step 5.0a: Self-improve rules (optional) ─────────────────
  if (input.settings.selfImprovePath) {
    const selfImprovePath = input.settings.selfImprovePath;
    // reportFailure: false is DELIBERATE — self-improve degrades with a warn only
    // and never lands in failedSteps (pinned by the golden degradation suite).
    // It IS recorded in warnOnlyDegradations → coverageComplete reflects it.
    await runDegradable(
      state,
      {
        step: 'self-improve',
        warnLabel: '[ghagga] Self-improve rules load failed (degrading gracefully):',
        reportFailure: false,
      },
      async () => {
        const feedback = await loadFeedback(selfImprovePath);
        if (feedback.length > 0) {
          const rules = deriveRules(feedback);
          state.selfImproveRulesPrompt = formatRulesForPrompt(rules);
          if (state.selfImproveRulesPrompt) {
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
    [state.selfImproveRulesPrompt, state.negativeExamplesPrompt, rawMemoryContext]
      .filter(Boolean)
      .join('\n') || null;

  const progressiveContext = buildProgressiveContext({
    staticResult,
    memoryContext: rawMemoryContextWithNegatives,
    stackHints: state.stackHints,
    contextBudget: state.contextBudget,
    fullStaticContext,
  });

  state.staticContext = progressiveContext.staticContext;
  state.memoryContext = progressiveContext.memoryContext;

  // ── Step 5.1b: Build code intelligence context (optional) ───
  const codeIntelContext =
    codeIntelResults.length > 0
      ? buildCodeIntelSection(
          buildCodeIntelContext(codeIntelResults, input.settings.codeIntelMaxTokens),
        )
      : '';
  state.codeIntelContext = codeIntelContext;

  if (input.settings.enableCodeIntel) {
    state.codeIntelMetadata = {
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
  const resolvedChecklist = resolveChecklistConfig(input.settings.checklist);
  state.resolvedChecklist = resolvedChecklist;
  if (resolvedChecklist) {
    state.checklistContext = buildChecklistContext(resolvedChecklist);
    if (state.checklistContext) {
      emit({
        step: 'checklist',
        message: `Checklist active: ${resolvedChecklist.dimensions.filter((d) => d.enabled).length} dimensions`,
      });
    }
  }
}
