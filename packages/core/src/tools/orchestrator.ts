/**
 * Tool Orchestrator — runs tools sequentially with failure isolation.
 *
 * - Sequential install → run → parse loop
 * - Per-tool try/catch for failure isolation
 * - Timeout enforcement per tool
 * - Budget rollover from fast tools
 * - Legacy keys (semgrep, trivy, cpd) always present
 */

import type { ToolResult } from '../types.js';
import { allocateTimeBudget, getEffectiveBudget } from './budget.js';
import type { ActivatedTool } from './resolve.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition, ToolScanScope } from './types.js';

/** Skipped result for tools that didn't run */
const SKIPPED_RESULT: ToolResult = {
  status: 'skipped',
  findings: [],
  error: undefined,
  executionTimeMs: 0,
};

/** Legacy tool names that must always be present in results */
const LEGACY_TOOL_NAMES = ['semgrep', 'trivy', 'cpd'] as const;

/**
 * Run all activated tools sequentially with budget management and failure isolation.
 *
 * @param ctx - Execution context (Node, Actions, or Mock)
 * @param activatedTools - Tools to execute (from resolveActivatedTools)
 * @param targetDir - Repository directory to scan
 * @param files - List of changed file paths
 * @param totalBudgetMs - Total time budget in ms (default 600_000)
 * @returns Record of tool name → ToolResult
 */
export async function runTools(
  ctx: ExecutionContext,
  activatedTools: ActivatedTool[],
  targetDir: string,
  files: string[],
  totalBudgetMs: number = 600_000,
  scope?: ToolScanScope,
): Promise<Record<string, ToolResult>> {
  const results: Record<string, ToolResult> = {};
  const budget = allocateTimeBudget(activatedTools, totalBudgetMs);
  const elapsedByTool = new Map<string, number>();
  let totalElapsed = 0;

  ctx.log('info', `[ghagga:tools] Running ${activatedTools.length} tools sequentially...`);

  for (const activated of activatedTools) {
    const tool = activated.definition;

    // Check if total budget is exhausted
    if (totalElapsed >= budget.totalMs) {
      ctx.log('warn', `[ghagga:tools] Total budget exhausted, skipping ${tool.name}`);
      results[tool.name] = {
        status: 'skipped',
        findings: [],
        error: 'total-budget-exhausted',
        executionTimeMs: 0,
      };
      continue;
    }

    const effectiveBudget = getEffectiveBudget(tool.name, budget, elapsedByTool);
    const start = Date.now();

    try {
      // Install
      await tool.install(ctx);

      // Run
      const raw = await tool.run(ctx, targetDir, files, effectiveBudget, scope);

      // Check for timeout
      if (raw.timedOut) {
        const durationMs = Date.now() - start;
        ctx.log('warn', `[ghagga:tools] ${tool.name}: timeout after ${durationMs}ms`);
        results[tool.name] = {
          status: 'error',
          findings: [],
          error: 'timeout',
          executionTimeMs: durationMs,
        };
        elapsedByTool.set(tool.name, durationMs);
        totalElapsed += durationMs;
        continue;
      }

      // Parse
      const findings = parseSafe(tool, raw, targetDir, ctx);

      const durationMs = Date.now() - start;
      ctx.log(
        'info',
        `[ghagga:tools] ${tool.name}: success (${findings.length} findings, ${durationMs}ms)`,
      );

      results[tool.name] = {
        status: 'success',
        findings,
        executionTimeMs: durationMs,
      };
      elapsedByTool.set(tool.name, durationMs);
      totalElapsed += durationMs;
    } catch (error) {
      const durationMs = Date.now() - start;
      const errorMessage = error instanceof Error ? error.message : String(error);
      ctx.log('error', `[ghagga:tools] ${tool.name}: error — ${errorMessage}`);

      results[tool.name] = {
        status: 'error',
        findings: [],
        error: errorMessage,
        executionTimeMs: durationMs,
      };
      elapsedByTool.set(tool.name, durationMs);
      totalElapsed += durationMs;
    }
  }

  // Ensure legacy keys always present
  ensureLegacyKeys(results);

  // Log summary
  const totalFindings = Object.values(results).reduce((sum, r) => sum + r.findings.length, 0);
  ctx.log(
    'info',
    `[ghagga:tools] Complete: ${activatedTools.length} tools, ${totalFindings} findings, ${totalElapsed}ms total`,
  );

  return results;
}

/**
 * Parse raw output safely — if parse throws, return empty findings.
 */
function parseSafe(
  tool: ToolDefinition,
  raw: RawToolOutput,
  repoDir: string,
  ctx: ExecutionContext,
) {
  try {
    return tool.parse(raw, repoDir);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.log('warn', `[ghagga:tools] ${tool.name}: parse error — ${msg}`);
    return [];
  }
}

/**
 * Ensure semgrep, trivy, cpd keys are always present in results.
 * Missing legacy tools get a skipped status.
 */
function ensureLegacyKeys(results: Record<string, ToolResult>): void {
  for (const name of LEGACY_TOOL_NAMES) {
    if (!results[name]) {
      results[name] = { ...SKIPPED_RESULT };
    }
  }
}
