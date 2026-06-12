/**
 * Graceful-degradation helpers for the gather-context trio (step 5).
 *
 * Moved BYTE-INTACT from pipeline.ts (split-review-pipeline B5) — only
 * `export` was added and relative import paths adjusted. They are
 * private to the gather-context phase.
 *
 * ⚠️ queryCodeIntelSafe's catch is UNREACHABLE via provider failures
 * (Promise.allSettled swallows per-file rejections); it only fires when
 * the emit callback throws on the success message. Pinned by the golden
 * suite — preserve the catch literally.
 */

import type { CodeIntelResult } from '../code-intel/types.js';
import { searchMemoryForContext } from '../memory/search.js';
import { runStaticAnalysis } from '../tools/runner.js';
import type { ReviewInput } from '../types.js';

/**
 * Run static analysis with graceful degradation.
 * Returns a result with all tools skipped if anything goes wrong.
 */
export async function runStaticAnalysisSafe(
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
export async function searchMemorySafe(
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
export async function queryCodeIntelSafe(
  input: ReviewInput,
  fileList: string[],
  emit: (event: import('../types.js').ProgressEvent) => void,
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
