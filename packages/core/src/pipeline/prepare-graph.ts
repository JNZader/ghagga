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
 *   golden degradation suite).
 */

import { computeBlastRadius } from '../graph/blast-radius.js';
import { buildCallChainFromDiff } from '../graph/call-chain.js';
import { buildReverseDependencyMap, findDependents } from '../graph/reverse-deps.js';
import type { BlastRadiusMetadata } from '../graph/schema.js';
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

  return { filteredFiles, filteredDiff, blastRadiusMetadata };
}

/**
 * Step 2.6: Call-chain + reverse-deps context (optional, runs when
 * blast-radius is enabled). Returns the prompt context string ('' when
 * disabled, no symbols affected, or degraded).
 */
export async function buildCallChainContext(args: GraphStepArgs): Promise<string> {
  const { input, emit, failedSteps, fileList, filteredDiff } = args;
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

  return callChainContext;
}
