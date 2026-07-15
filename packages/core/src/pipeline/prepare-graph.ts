/**
 * Graph-powered prepare steps: 2.5 blast-radius filter + 2.6 call-chain
 * / reverse-deps context.
 *
 * Phase-private sibling of `prepare.ts` — split out so prepare stays under
 * the 300-line module cap (same precedent as `gather-safe.ts` for the
 * gather-context phase). Exported only because TS module boundaries
 * require it; the ONLY intended importer is `prepare.ts`.
 *
 * Step bodies are moved LITERAL from the original `reviewPipeline`:
 * - Blast-radius keeps its BESPOKE catch (sets a fallback
 *   `blastRadiusMetadata` and warns with the RAW error, not `.message`) —
 *   deliberately NOT migrated to `runDegradable` (see degrade.ts).
 * - Call-chain degrades via `runDegradable` with `reportFailure: false`
 *   (DELIBERATE — warn only, never lands in failedSteps; pinned by the
 *   golden degradation suite). The degradation IS recorded in
 *   `warnOnlyDegradations` so `coverageComplete` reflects it.
 */

import { computeBlastRadius } from '../graph/blast-radius.js';
import { buildCallChainFromDiff, extractChangedSymbolsFromDiff } from '../graph/call-chain.js';
import { computeChangedSymbolsComplete } from '../graph/changed-symbols.js';
import { isExactCommitFresh, narrowBySymbols } from '../graph/narrow-symbols.js';
import { buildReverseDependencyMap, findDependents } from '../graph/reverse-deps.js';
import type { BlastRadiusMetadata, DependencyGraph } from '../graph/schema.js';
import { isGraphStale } from '../graph/schema.js';
import type { ProgressEvent, ReviewInput } from '../types.js';
import type { DiffFile } from '../utils/diff.js';
import { runDegradable } from './degrade.js';
import type { FailedStep } from './state.js';

interface GraphStepArgs {
  input: ReviewInput;
  emit: (event: ProgressEvent) => void;
  failedSteps: FailedStep[];
  /** ⚠️ PRE-blast-radius file list (see state.ts — load-bearing). */
  fileList: string[];
  filteredDiff: string;
}

/** Outcome of the blast-radius filter (step 2.5). */
export interface BlastRadiusOutcome {
  filteredFiles: DiffFile[];
  filteredDiff: string;
  blastRadiusMetadata: BlastRadiusMetadata | undefined;
  /**
   * The dependency graph successfully loaded during this step, if any.
   * Threaded into step 2.6 (`buildCallChainContext`) so the Symbol
   * Impact block can reuse it WITHOUT calling `input.graphLoader.load()`
   * a second time — a second load call would double-invoke the loader
   * (breaking `toHaveBeenCalledOnce()` call-count assertions) and, on a
   * failing loader, produce an EXTRA call-chain warn/failedSteps entry
   * that the golden degradation snapshots don't expect. `undefined` when
   * blast-radius is disabled, no loader is configured, the graph is
   * unavailable, or loading errored (already handled by this step's own
   * bespoke catch).
   */
  graph: DependencyGraph | undefined;
}

/**
 * Step 2.5: Blast-radius filter (optional).
 * Narrows `filteredFiles`/`filteredDiff` to the blast radius when a
 * dependency graph is available; falls back to the full diff otherwise.
 */
export async function applyBlastRadius(
  args: GraphStepArgs & { filteredFiles: DiffFile[] },
): Promise<BlastRadiusOutcome> {
  const { input, emit, failedSteps, fileList } = args;
  let { filteredFiles, filteredDiff } = args;
  let blastRadiusMetadata: BlastRadiusMetadata | undefined;
  let loadedGraph: DependencyGraph | undefined;

  if (input.settings.enableBlastRadius && input.graphLoader) {
    try {
      const graph = await input.graphLoader.load();
      if (graph) {
        loadedGraph = graph;
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
          // Symbol-precise narrowing (scip-symbol-exclusion) — a PURE
          // SUBTRACTIVE post-filter over `blastResult`, gated on THREE
          // fail-closed pillars: the opt-in flag, a recognized `builtVia`,
          // and Pillar 0 exact-commit freshness (`isExactCommitFresh`). ANY
          // gate failing ⇒ zero narrowing, `blastResult.files` untouched —
          // `computeBlastRadius`/`buildReverseIndex` themselves are NEVER
          // modified (0-diff, D4).
          let narrowedDependents = 0;
          const builtVia = metadata?.builtVia;
          if (
            input.settings.enableSymbolExclusion &&
            builtVia &&
            isExactCommitFresh(metadata, input.currentHead)
          ) {
            const changedByFile = computeChangedSymbolsComplete(filteredDiff, graph);
            const changedFileSet = new Set(fileList);
            const excludedDependents = narrowBySymbols(
              blastResult.dependents,
              changedByFile,
              graph,
              builtVia,
              blastResult.files,
              changedFileSet,
            );
            for (const excludedPath of excludedDependents) {
              blastResult.files.delete(excludedPath);
            }
            narrowedDependents = excludedDependents.size;
          }

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
              ...(narrowedDependents > 0 ? [`  narrowed: ${narrowedDependents}`] : []),
            ].join('\n'),
          });
          blastRadiusMetadata = {
            enabled: true,
            graphAvailable: true,
            totalFiles: fileList.length,
            blastRadiusFiles: blastResult.files.size,
            graphStale: stale,
            ...(narrowedDependents > 0 ? { narrowedDependents } : {}),
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

  return { filteredFiles, filteredDiff, blastRadiusMetadata, graph: loadedGraph };
}

/**
 * Build the additive `## Symbol Impact` block (Slice 2 of
 * symbol-precise-context, upgraded by scip-symbol-ranges D5). For each
 * changed file B, walks every node A in the graph whose `imports`
 * includes B — the SAME resolved-path edge `computeBlastRadius`/
 * `buildReverseIndex` already traverse — and reports which symbols A
 * references from B (`A.importSymbols[B]`) against which symbols the
 * diff actually changed in B.
 *
 * Changed-symbol source (D5): when ANY node in the graph carries
 * `symbolRanges` (SCIP-only — see graph/scip/builder.ts), uses the
 * COMPLETE line-range mapping (`computeChangedSymbolsComplete`), which
 * also catches body-only changes to an unchanged signature. Otherwise
 * falls back to the declaration-level `extractChangedSymbolsFromDiff`
 * (D5 fallback) — output is BYTE-IDENTICAL to the pre-scip-symbol-ranges
 * behavior when no graph in play has `symbolRanges`.
 *
 * STRICTLY ADDITIVE: never excludes a file, never claims "unaffected" when
 * the data is insufficient to know (barrel edges, missing symbol data, or
 * `hasUnattributedChanges` on the complete-mapping path). Returns '' when
 * the graph has NO `importSymbols` data anywhere (keeps output
 * byte-identical to pre-change context — no regression when no symbol
 * data exists in the graph, per spec).
 */
function buildSymbolImpactBlock(
  graph: import('../graph/schema.js').DependencyGraph,
  fileList: string[],
  filteredDiff: string,
): string {
  const anySymbolData = Object.values(graph.nodes).some(
    (n) => n.importSymbols && Object.keys(n.importSymbols).length > 0,
  );
  if (!anySymbolData) return '';

  // D5: prefer the complete (range-based) mapping whenever ANY node has
  // symbolRanges; otherwise fall back to the old declaration-level
  // extractor untouched, for byte-identical no-regression output.
  const anyRanges = Object.values(graph.nodes).some(
    (n) => n.symbolRanges && Object.keys(n.symbolRanges).length > 0,
  );
  const completeByFile = anyRanges ? computeChangedSymbolsComplete(filteredDiff, graph) : undefined;
  const changedByFile = anyRanges ? undefined : extractChangedSymbolsFromDiff(filteredDiff);

  const changedFileSet = new Set(fileList);
  const lines: string[] = [];

  for (const b of changedFileSet) {
    for (const [aPath, aNode] of Object.entries(graph.nodes)) {
      if (aPath === b || !aNode.imports.includes(b)) continue;

      const used = aNode.importSymbols?.[b];
      if (!used || used.length === 0) {
        // No symbol data for this edge (non-TS extractor, namespace/side-
        // effect import, or SCIP occurrence gap) — degrade to file-level,
        // never claim the dependent is unaffected.
        lines.push(`- ${aPath} depends on ${b} (no symbol-level data available)`);
        continue;
      }

      const usedList = used.join(', ');

      let changedSet: Set<string> | undefined;
      if (completeByFile) {
        const complete = completeByFile.get(b);
        // D5 spec: hasUnattributedChanges (or no entry at all) → MUST fall
        // back to the existing conservative "unknown" reporting, never
        // compute a partial hit from incomplete data.
        changedSet =
          !complete || complete.hasUnattributedChanges ? undefined : complete.changedSymbols;
      } else {
        changedSet = changedByFile?.get(b);
      }

      if (!changedSet || changedSet.size === 0) {
        lines.push(
          `- ${aPath} uses {${usedList}} from ${b}; changed symbols: unknown (diff parsing found no symbol-level change markers for this file)`,
        );
        continue;
      }

      const hit = used.filter((s) => changedSet.has(s));
      const changedText =
        hit.length > 0 ? hit.join(', ') : 'none of the used symbols (conservatively still listed)';
      lines.push(`- ${aPath} uses {${usedList}} from ${b}; changed: ${changedText}`);
    }
  }

  if (lines.length === 0) return '';
  return `\n## Symbol Impact\n${lines.join('\n')}\n`;
}

/**
 * Step 2.6: Call-chain + reverse-deps context (optional, runs when
 * blast-radius is enabled). Returns the prompt context string ('' when
 * disabled, no symbols affected, or degraded).
 */
export async function buildCallChainContext(
  args: GraphStepArgs & {
    warnOnlyDegradations: string[];
    /**
     * The graph already loaded by step 2.5 (`applyBlastRadius`), if any —
     * reused here for the Symbol Impact block instead of calling
     * `input.graphLoader.load()` a second time (see `BlastRadiusOutcome`
     * for why). `undefined` is a normal, non-error state (blast-radius
     * disabled, no loader, or graph unavailable) — Symbol Impact is
     * simply skipped in that case.
     */
    graph?: DependencyGraph;
  },
): Promise<string> {
  const { input, emit, failedSteps, warnOnlyDegradations, fileList, filteredDiff, graph } = args;
  let callChainContext = '';

  if (input.settings.enableBlastRadius) {
    // reportFailure: false is DELIBERATE — call-chain degrades with a warn only
    // and never lands in failedSteps (pinned by the golden degradation suite).
    // It IS recorded in warnOnlyDegradations → coverageComplete reflects it.
    await runDegradable(
      { failedSteps, warnOnlyDegradations, emit },
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

        // Symbol Impact (Slice 2 of symbol-precise-context) — strictly
        // additive, appended onto the SAME callChainContext string. Reuses
        // the graph step 2.5 already loaded (see the `graph` param doc)
        // rather than calling `input.graphLoader.load()` again. Never
        // excludes a file from anything — this block is advisory text
        // only.
        if (graph) {
          const symbolImpactBlock = buildSymbolImpactBlock(graph, fileList, filteredDiff);
          if (symbolImpactBlock) {
            callChainContext += symbolImpactBlock;
            emit({
              step: 'symbol-impact',
              message: 'Symbol Impact: symbol-precise import context added',
            });
          }
        }
      },
    );
  }

  return callChainContext;
}
