/**
 * Skipped / static-only result builders for the review pipeline.
 *
 * Moved verbatim from pipeline.ts (split-review-pipeline refactor).
 */

import { initializeDefaultTools } from '../tools/plugins/index.js';
import { toolRegistry } from '../tools/registry.js';
import { isToolRegistryEnabled } from '../tools/runner.js';
import type { ReviewInput, ReviewResult, ReviewStatus } from '../types.js';

/**
 * Create a SKIPPED result when all files are filtered out.
 */
export function createSkippedResult(input: ReviewInput, startTime: number): ReviewResult {
  const primary = input.providerChain?.[0];

  // Build a dynamic skipped result (legacy keys always present)
  const skippedToolResult = { status: 'skipped' as const, findings: [], executionTimeMs: 0 };
  const staticAnalysis: import('../types.js').StaticAnalysisResult = {
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
export function createStaticOnlyResult(
  staticResult: import('../types.js').StaticAnalysisResult,
  mode: import('../types.js').ReviewMode,
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
