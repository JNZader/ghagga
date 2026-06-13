/**
 * Enrich phase: steps 7 → 7.8 of the review pipeline, IN ONE FUNCTION,
 * in LITERAL sequence: 7 merge static findings + enhance-APPLY +
 * metadata; 7.4 exploitability (mutates findings in-place);
 * 7.5 checklist scoring; 7.6 recursive review (appends regressions);
 * 7.7 doc validation (pushes findings); 7.8 semantic ranking (reorders).
 *
 * ⚠️ The final order of `result.findings` is output-visible and pinned
 * by the golden snapshot suite: in-place → append → push → reorder.
 * Do NOT split, reorder, or "tidy" this sequence.
 */

import { scoreFindings } from '../checklist/index.js';
import {
  extractChangedSymbols as extractChangedSymbolsFromDiff,
  scanDocsForSymbols as scanDocsForSymbolRefs,
} from '../doc-validation/index.js';
import { analyzeExploitability, analyzeUsage } from '../exploitability/index.js';
import { rankFindings } from '../ranking/index.js';
import { recursiveReview } from '../recursive/index.js';
import { extractSemanticDiff } from '../semantic-diff/index.js';
import { runDegradable } from './degrade.js';
import { resolveGenerateTextFns } from './providers.js';
import type { PipelineState } from './state.js';

/**
 * Size gate for semantic-diff extraction: filteredDiff above this length
 * (in chars) skips the extract entirely. 2 000 000 chars ≈ 2 MB of diff —
 * roughly 40 000+ lines, an order of magnitude past any human-reviewable
 * PR and well past the flood-detection threshold (5 000 changed lines →
 * lightweight). filteredDiff is NEVER truncated (truncateDiff writes the
 * separate truncatedDiff field), so without a cap a flood-scale diff would
 * pay regex work proportional to its full size for a purely cosmetic
 * comment section. The extract is O(n) single-pass, so 2 MB itself is
 * cheap — the cap exists to bound the tail, not the typical case.
 */
export const SEMANTIC_DIFF_MAX_DIFF_CHARS = 2_000_000;

/**
 * Run the enrich phase. Mutates `state.result` in-place.
 */
export async function enrich(state: PipelineState): Promise<void> {
  const { input, emit, result } = state;

  // ── Step 7: Merge static analysis into result ──────────────
  result.staticAnalysis = state.staticResult;
  result.memoryContext = state.memoryContext;

  // Add static analysis findings to the result's findings array (dynamic — all tools)
  const staticFindings = Object.values(state.staticResult).flatMap((toolResult) =>
    toolResult && typeof toolResult === 'object' && 'findings' in toolResult
      ? toolResult.findings
      : [],
  );
  result.findings = [...result.findings, ...staticFindings];

  // ── Merge enhanced static findings into result ──────────────
  // enhance-APPLY: the COMPUTE half ran in step 5.5 — do NOT fuse them.
  if (state.enhancedStaticFindings && state.enhanceMetadata) {
    result.enhanced = true;
    result.enhanceMetadata = state.enhanceMetadata;
    // Replace static-sourced findings with enhanced versions
    const nonStaticFindings = result.findings.filter((f) => f.source === 'ai');
    result.findings = [...state.enhancedStaticFindings, ...nonStaticFindings];
  }

  // Track which tools ran successfully
  result.metadata.toolsRun = [];
  result.metadata.toolsSkipped = [];
  for (const [name, tool] of Object.entries(state.staticResult)) {
    if (tool.status === 'success') {
      result.metadata.toolsRun.push(name);
    } else {
      result.metadata.toolsSkipped.push(name);
    }
  }

  // Update execution time to cover the full pipeline
  result.metadata.executionTimeMs = Date.now() - state.startTime;

  // Add file stats metadata (for emoji stats bar in comment)
  // Note: metadata.fileList uses allFiles (pre-filter), NOT state.fileList.
  result.metadata.totalAdditions = state.allFiles.reduce((sum, f) => sum + f.additions, 0);
  result.metadata.totalDeletions = state.allFiles.reduce((sum, f) => sum + f.deletions, 0);
  result.metadata.fileList = state.allFiles.map((f) => f.path);

  // Add entity-level semantic diff ("What changed" comment section).
  // Computed over filteredDiff — settled in prepare and NEVER truncated
  // (truncateDiff writes the separate truncatedDiff field), so entity and
  // import counts stay honest even when the prompt diff was cut.
  // reportFailure: false is DELIBERATE — a cosmetic comment section must not
  // enter failedSteps (no PARTIAL downgrade), but the degradation is still
  // recorded in warnOnlyDegradations so coverageComplete tells the whole
  // truth (call-chain / negative-examples pattern, see pipeline/degrade.ts).
  //
  // Size gate: skipping an oversized diff is POLICY (flood-style gate),
  // not an error — semanticDiff simply stays undefined (the comment
  // renderer shows nothing) and warnOnlyDegradations is NOT touched, so
  // coverageComplete stays true. Nothing failed; we chose not to compute.
  if (state.filteredDiff.length <= SEMANTIC_DIFF_MAX_DIFF_CHARS) {
    await runDegradable(
      state,
      {
        step: 'semantic-diff',
        warnLabel: '[ghagga] Semantic diff extraction failed (non-fatal):',
        reportFailure: false,
      },
      () => {
        result.semanticDiff = extractSemanticDiff(state.filteredDiff);
      },
    );
  }

  // Add blast-radius metadata (if applicable)
  if (state.blastRadiusMetadata) {
    result.metadata.blastRadius = state.blastRadiusMetadata;
  }

  // Add code intelligence metadata (if applicable)
  if (state.codeIntelMetadata) {
    result.codeIntelMetadata = state.codeIntelMetadata;
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
      await runDegradable(
        state,
        {
          step: 'exploitability',
          warnLabel: '[ghagga] Exploitability analysis failed (non-fatal):',
          failEmit: {
            step: 'exploitability',
            message: 'Exploitability analysis failed — continuing without',
          },
        },
        async () => {
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
        },
      );
    }
  }

  // ── Step 7.5: Score findings against checklist (optional) ───
  if (state.resolvedChecklist && result.findings.length > 0) {
    result.checklistScore = scoreFindings(result.findings, state.resolvedChecklist);
    emit({
      step: 'checklist-score',
      message: `Checklist score: ${result.checklistScore.totalScore} (${result.checklistScore.findings.length} matched findings)`,
    });
  }

  // ── Step 7.6: Recursive review (optional) ──────────────────────
  if (input.settings.enableRecursiveReview && state.aiEnabled && result.findings.length > 0) {
    emit({ step: 'recursive-review', message: 'Running recursive review on suggested fixes...' });
    await runDegradable(
      state,
      {
        step: 'recursive-review',
        warnLabel: '[ghagga] Recursive review failed (non-fatal):',
        failEmit: {
          step: 'recursive-review',
          message: 'Recursive review failed — continuing without',
        },
      },
      async () => {
        // Re-resolved fresh on purpose (not reused from the dispatch) — preserve.
        const generateFns = resolveGenerateTextFns(
          input,
          state.isCliBridge,
          state.isGateway,
          state.isOllama,
        );
        const report = await recursiveReview({
          originalDiff: state.truncatedDiff,
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
      },
    );
  }

  // ── Step 7.7: Code-doc validation (optional) ───────────────────
  if (input.settings.enableDocValidation && state.filteredFiles.length > 0) {
    await runDegradable(
      state,
      {
        step: 'doc-validation',
        warnLabel: '[ghagga] Doc validation failed (non-fatal):',
        failEmit: { step: 'doc-validation', message: 'Doc validation failed — continuing without' },
      },
      () => {
        const changedSymbols = extractChangedSymbolsFromDiff(state.filteredDiff);
        if (changedSymbols.length > 0) {
          emit({
            step: 'doc-validation',
            message: `Scanning docs for ${changedSymbols.length} changed symbol(s)...`,
          });

          const docResult = scanDocsForSymbolRefs(changedSymbols, state.allFiles, state.fileList);
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
      },
    );
  }

  // ── Step 7.8: Semantic ranking of findings (optional) ─────────
  const semanticRankingEnabled =
    input.features?.semanticRanking !== false && !!input.embeddingProvider;
  if (semanticRankingEnabled && result.findings.length > 1) {
    emit({ step: 'semantic-ranking', message: 'Reranking findings by semantic relevance...' });
    await runDegradable(
      state,
      {
        step: 'semantic-ranking',
        warnLabel: '[ghagga] Semantic ranking failed (non-fatal):',
        failEmit: {
          step: 'semantic-ranking',
          message: 'Semantic ranking failed — continuing without',
        },
      },
      async () => {
        result.findings = await rankFindings(result.findings, input.embeddingProvider);
        emit({
          step: 'semantic-ranking',
          message: `Semantic ranking complete (${result.findings.length} findings reranked)`,
        });
      },
    );
  }
}
