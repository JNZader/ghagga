/**
 * Tool Orchestrator — runs all enabled static analysis tools sequentially.
 *
 * Uses the registry-driven orchestrator to run up to 15 static analysis
 * tools via plugins. Each tool's failure is isolated — one tool failing
 * does not prevent others from running.
 *
 * Returns a StaticAnalysisResult matching the core type contract.
 */

import * as core from '@actions/core';
import { initializeDefaultTools, resolveActivatedTools, runTools, toolRegistry } from 'ghagga-core';
import { createActionsExecutionContext } from './execution.js';
import type { StaticAnalysisResult } from './types.js';

/**
 * Run all enabled static analysis tools locally on the runner.
 * Tools run sequentially to keep peak memory under 4GB.
 * Never throws — each tool failure is isolated.
 */
export async function runLocalAnalysis(options: {
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  repoDir: string;
  /** Changed paths from the PR diff. Empty means a whole-repo scan. */
  files?: string[];
  /** Unified PR diff. Gitleaks reports only added lines when this is set. */
  diff?: string;
}): Promise<StaticAnalysisResult> {
  return runLocalAnalysisWithRegistry(options);
}

/**
 * Run static analysis using the registry-driven orchestrator.
 * Uses ActionsExecutionContext for @actions/exec + @actions/cache.
 * @internal
 */
async function runLocalAnalysisWithRegistry(options: {
  enableSemgrep: boolean;
  enableTrivy: boolean;
  enableCpd: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  repoDir: string;
  files?: string[];
  diff?: string;
}): Promise<StaticAnalysisResult> {
  core.info('[ghagga:tools] Running static analysis with registry-driven orchestrator');

  // Ensure plugins are registered
  initializeDefaultTools();

  // Auto-detect stays opt-in (enabled-tools). Passing the diff file list into
  // the resolver would install biome/ruff/… on every matching PR. The file
  // list is the scan scope for tools that already run (gitleaks, shellcheck, …).
  const fileList = options.files ?? [];

  // Resolve which tools should run
  const activatedTools = resolveActivatedTools({
    registry: toolRegistry,
    files: [],
    enabledTools: options.enabledTools,
    disabledTools: options.disabledTools,
    enableSemgrep: options.enableSemgrep,
    enableTrivy: options.enableTrivy,
    enableCpd: options.enableCpd,
  });

  core.info(
    `[ghagga:tools] Activated tools: ${activatedTools.map((t) => t.definition.name).join(', ')}`,
  );

  // Run tools with Actions execution context
  const ctx = createActionsExecutionContext();
  const results = await runTools(
    ctx,
    activatedTools,
    options.repoDir,
    fileList,
    600_000,
    options.diff !== undefined ? { diff: options.diff } : undefined,
  );

  return results as StaticAnalysisResult;
}
