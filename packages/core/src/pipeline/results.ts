/**
 * Skipped / static-only result builders for the review pipeline.
 *
 * Moved verbatim from pipeline.ts (split-review-pipeline refactor).
 */

import { initializeDefaultTools } from '../tools/plugins/index.js';
import { toolRegistry } from '../tools/registry.js';
import { isToolRegistryEnabled } from '../tools/runner.js';
import type { ReviewFinding, ReviewInput, ReviewResult, ReviewStatus } from '../types.js';

/**
 * Dependency / SCA (software-composition-analysis) findings are EXEMPT from
 * the changed-file scope filter. They live in lockfiles / manifests
 * (package-lock.json, go.sum, …) that are usually NOT in the staged diff, yet
 * a vulnerable transitive dependency is still a real risk for the change. We
 * key on BOTH the `source` (Trivy is the SCA scanner) and the
 * `dependency-vulnerability` category to be robust against future SCA tools.
 */
function isScaFinding(f: ReviewFinding): boolean {
  return f.source === 'trivy' || f.category === 'dependency-vulnerability';
}

/**
 * Whether a static-analysis finding may DRIVE the verdict (i.e. flip it to
 * FAILED). Static tools scan the whole repo, so a 1-file change can surface
 * pre-existing findings from unrelated files; those must stay informational
 * and not fail the review.
 *
 * A finding is verdict-driving when it is:
 *   - an SCA / dependency-vulnerability finding (exempt — see isScaFinding), OR
 *   - located in one of the changed / blast-radius "affected" files.
 *
 * `affectedFiles` is the blast-radius-expanded set when available, otherwise
 * the literal changed-file set. When it is undefined or empty we fall back to
 * legacy behavior (every finding counts) — never silently pass everything.
 */
export function isVerdictDrivingFinding(
  f: ReviewFinding,
  affectedFiles: ReadonlySet<string> | undefined,
): boolean {
  if (isScaFinding(f)) return true;
  if (!affectedFiles || affectedFiles.size === 0) return true;
  return affectedFiles.has(f.file);
}

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
  affectedFiles?: readonly string[],
): ReviewResult {
  // Determine status from static findings severity (dynamic — all tools)
  const allFindings = Object.values(staticResult).flatMap((toolResult) =>
    toolResult && typeof toolResult === 'object' && 'findings' in toolResult
      ? toolResult.findings
      : [],
  );

  // Only IN-SCOPE (changed/blast-radius) findings + SCA/dependency findings may
  // drive the verdict. Repo-wide pre-existing findings from unrelated files
  // stay visible (merged informational in enrich step 7) but do NOT fail it.
  const affectedSet =
    affectedFiles && affectedFiles.length > 0 ? new Set(affectedFiles) : undefined;
  const verdictFindings = allFindings.filter((f) => isVerdictDrivingFinding(f, affectedSet));
  const hasCriticalOrHigh = verdictFindings.some(
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
