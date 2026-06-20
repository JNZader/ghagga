/**
 * Static analysis tool runner.
 *
 * Uses the registry-driven orchestrator to run all enabled static analysis
 * tools sequentially to avoid memory pressure in constrained containers.
 */

import type { ReviewFinding, ReviewSettings, StaticAnalysisResult, ToolResult } from '../types.js';
import { createNodeExecutionContext } from './execution.js';
import { runTools } from './orchestrator.js';
import { initializeDefaultTools } from './plugins/index.js';
import { toolRegistry } from './registry.js';
import { resolveActivatedTools } from './resolve.js';

/** Maximum number of findings to include in LLM context */
const FINDING_CAP = 200;

/**
 * Whether the tool registry is enabled.
 * @deprecated Always returns true. Kept for backward compatibility with existing imports.
 */
export function isToolRegistryEnabled(): boolean {
  return true;
}

/**
 * Run all enabled static analysis tools using the registry-driven orchestrator.
 *
 * @param files - Map of file paths to file contents
 * @param scanPath - Directory path on disk
 * @param settings - Which tools are enabled
 */
export async function runStaticAnalysis(
  files: Map<string, string>,
  scanPath: string,
  settings: Pick<
    ReviewSettings,
    'enableSemgrep' | 'enableTrivy' | 'enableCpd' | 'customRules' | 'enabledTools' | 'disabledTools'
  >,
): Promise<StaticAnalysisResult> {
  return runStaticAnalysisWithRegistry(scanPath, Array.from(files.keys()), settings);
}

/**
 * Run static analysis using the registry-driven orchestrator.
 * @internal
 */
async function runStaticAnalysisWithRegistry(
  scanPath: string,
  fileList: string[],
  settings: Pick<
    ReviewSettings,
    'enableSemgrep' | 'enableTrivy' | 'enableCpd' | 'enabledTools' | 'disabledTools'
  >,
): Promise<StaticAnalysisResult> {
  // Diagnostic/progress → stderr; stdout is reserved for machine output (SARIF/JSON).
  console.error('[ghagga:tools] Running static analysis with registry-driven orchestrator');

  // Ensure plugins are registered
  initializeDefaultTools();

  // Resolve which tools should run
  const activatedTools = resolveActivatedTools({
    registry: toolRegistry,
    files: fileList,
    enabledTools: settings.enabledTools,
    disabledTools: settings.disabledTools,
    enableSemgrep: settings.enableSemgrep,
    enableTrivy: settings.enableTrivy,
    enableCpd: settings.enableCpd,
  });

  // Run tools with Node execution context
  const ctx = createNodeExecutionContext();
  const results = await runTools(ctx, activatedTools, scanPath, fileList);

  return results as StaticAnalysisResult;
}

/** Severity sort order for finding cap (most severe first) */
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Format static analysis findings into a prompt context block.
 * This is injected into LLM prompts so agents don't repeat findings.
 *
 * Iterates all tool results dynamically (not hardcoded to semgrep/trivy/cpd).
 * Applies a finding cap of 200 with severity-priority sorting.
 */
export function formatStaticAnalysisContext(result: StaticAnalysisResult): string {
  // Collect findings from ALL tools dynamically
  const allFindings: ReviewFinding[] = [];
  for (const toolResult of Object.values(result)) {
    if (toolResult && typeof toolResult === 'object' && 'findings' in toolResult) {
      allFindings.push(...(toolResult as ToolResult).findings);
    }
  }

  if (allFindings.length === 0) return '';

  // Sort by severity (most severe first) for the cap
  allFindings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));

  // Apply finding cap
  const totalCount = allFindings.length;
  const cappedFindings = allFindings.slice(0, FINDING_CAP);

  const lines = ['## Pre-Review Static Analysis (confirmed issues - do NOT repeat these)', ''];

  for (const finding of cappedFindings) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(
      `- **[${finding.source.toUpperCase()}]** [${finding.severity}] ${location}: ${finding.message}`,
    );
  }

  if (totalCount > FINDING_CAP) {
    lines.push('');
    lines.push(`> Showing ${FINDING_CAP} of ${totalCount} findings (sorted by severity).`);
  }

  lines.push('');
  lines.push('> These issues were detected by automated tools. Do NOT repeat them in your review.');
  lines.push('> Focus on logic, architecture, and issues that static analysis cannot detect.');

  return lines.join('\n');
}
