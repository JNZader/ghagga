/**
 * Workflow Review - Multi-agent code review using the WorkflowEngine
 *
 * Orchestrates specialized review agents (security, performance, style, etc.)
 * for comprehensive code analysis with parallel or sequential execution.
 */

import type { LLMRequestOptions, LLMResponse } from '../_shared/types/providers.ts';
import type { ReviewFile } from '../_shared/types/database.ts';
import {
  WorkflowEngine,
  type WorkflowEngineConfig,
  type WorkflowExecutionResult,
} from '../_shared/workflow/engine.ts';
import type { ReviewFinding } from './simple.ts';

/**
 * Context for workflow review execution
 */
export interface WorkflowReviewContext {
  /** Repository rules and guidelines */
  rules: string;
  /** Files changed in the PR */
  files: ReviewFile[];
  /** Combined diff/patch content */
  diff: string;
  /** PR title */
  prTitle?: string;
  /** PR description/body */
  prBody?: string;
}

/**
 * Configuration for workflow review
 */
export interface WorkflowReviewConfig {
  /** Execute steps in parallel (true) or sequential (false) */
  parallel?: boolean;
  /** Maximum tokens per step */
  maxTokensPerStep?: number;
  /** Timeout per step in milliseconds */
  stepTimeoutMs?: number;
  /** Maximum retries per step */
  maxRetries?: number;
}

/**
 * Result from workflow review execution
 */
export interface WorkflowReviewResult {
  /** Overall review status */
  status: 'passed' | 'failed' | 'error';
  /** Summary from the synthesis step */
  summary: string;
  /** All findings from workflow steps */
  findings: ReviewFinding[];
  /** Detailed results from each step */
  stepResults: StepSummary[];
  /** Total execution time in milliseconds */
  durationMs: number;
  /** Error message if status is error */
  error?: string;
}

/**
 * Summary of a workflow step result
 */
export interface StepSummary {
  /** Step identifier */
  stepId: string;
  /** Step name */
  stepName: string;
  /** Step execution status */
  status: 'success' | 'failed';
  /** Duration in milliseconds */
  durationMs: number;
  /** Error if failed */
  error?: string;
}

/**
 * LLM caller function type - allows dependency injection
 */
export type LLMCaller = (options: LLMRequestOptions) => Promise<LLMResponse>;

/**
 * Default workflow review configuration
 */
const DEFAULT_CONFIG: Required<WorkflowReviewConfig> = {
  parallel: true,
  maxTokensPerStep: 2048,
  stepTimeoutMs: 60000,
  maxRetries: 2,
};

/**
 * Execute a workflow review using the multi-agent WorkflowEngine
 *
 * The workflow consists of specialized agents:
 * 1. Scope Analysis - Assesses change scope and impact
 * 2. Coding Standards - Checks style and conventions
 * 3. Error Handling - Evaluates error handling patterns
 * 4. Security Audit - Identifies security vulnerabilities
 * 5. Performance Review - Analyzes performance implications
 * 6. Final Synthesis - Combines all findings
 *
 * @param context - Review context with rules, files, and diff
 * @param llmCaller - Function to call the LLM
 * @param config - Optional workflow configuration
 * @returns Workflow review result
 */
export async function executeWorkflowReview(
  context: WorkflowReviewContext,
  llmCaller: LLMCaller,
  config: WorkflowReviewConfig = {}
): Promise<WorkflowReviewResult> {
  const startTime = Date.now();
  const mergedConfig: Required<WorkflowReviewConfig> = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  try {
    // Build the content to review
    const content = buildReviewContent(context);

    // Create workflow engine with injected LLM caller
    const engineConfig: WorkflowEngineConfig = {
      provider: {
        provider: 'anthropic', // Placeholder, actual model selection via llmCaller
        model: 'claude-sonnet-4-20250514',
        maxTokens: mergedConfig.maxTokensPerStep,
      },
      stepTimeout: mergedConfig.stepTimeoutMs,
      maxRetries: mergedConfig.maxRetries,
      continueOnFailure: true,
    };

    const engine = new WorkflowEngine(engineConfig, llmCaller);

    // Execute workflow in parallel or sequential mode
    const result: WorkflowExecutionResult = mergedConfig.parallel
      ? await engine.runParallel(content, context.rules)
      : await engine.runSequential(content, context.rules);

    const durationMs = Date.now() - startTime;

    // Parse findings from step results
    const findings = parseWorkflowFindings(result);

    // Build step summaries
    const stepResults: StepSummary[] = result.findings.map((f) => ({
      stepId: f.stepId,
      stepName: f.stepName,
      status: f.status,
      durationMs: f.duration_ms,
      error: f.error,
    }));

    // Add synthesis step
    stepResults.push({
      stepId: result.synthesis.stepId,
      stepName: result.synthesis.stepName,
      status: result.synthesis.status,
      durationMs: result.synthesis.duration_ms,
      error: result.synthesis.error,
    });

    return {
      status: result.status,
      summary: extractSummary(result.synthesis.findings),
      findings,
      stepResults,
      durationMs,
      error: result.error,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      status: 'error',
      summary: `Workflow review failed: ${errorMessage}`,
      findings: [
        {
          severity: 'error',
          category: 'system',
          message: `Workflow execution failed: ${errorMessage}`,
        },
      ],
      stepResults: [],
      durationMs,
      error: errorMessage,
    };
  }
}

/**
 * Build the content string for workflow review
 */
function buildReviewContent(context: WorkflowReviewContext): string {
  const parts: string[] = [];

  // Add PR context
  if (context.prTitle) {
    parts.push(`## Pull Request: ${context.prTitle}`);
  }

  if (context.prBody) {
    parts.push(`### Description\n${context.prBody}`);
  }

  // Add file summary
  const fileSummary = context.files
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join('\n');

  parts.push(`### Files Changed\n${fileSummary}`);

  // Add the diff
  parts.push(`### Code Changes\n\`\`\`diff\n${context.diff}\n\`\`\``);

  return parts.join('\n\n');
}

/**
 * Parse findings from workflow step results
 */
function parseWorkflowFindings(result: WorkflowExecutionResult): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Parse findings from each step
  for (const step of result.findings) {
    if (step.status === 'success' && step.findings) {
      const stepFindings = parseStepFindings(step.findings, step.stepId);
      findings.push(...stepFindings);
    }
  }

  // Parse findings from synthesis (may have deduplicated/prioritized findings)
  if (result.synthesis.status === 'success' && result.synthesis.findings) {
    const synthesisFindings = parseSynthesisFindings(result.synthesis.findings);
    // Merge synthesis findings, avoiding duplicates
    for (const finding of synthesisFindings) {
      if (!isDuplicateFinding(findings, finding)) {
        findings.push(finding);
      }
    }
  }

  // Sort by severity
  const severityOrder: Record<string, number> = {
    error: 0,
    warning: 1,
    info: 2,
    suggestion: 3,
  };

  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return findings;
}

/**
 * Parse findings from a step's output
 */
function parseStepFindings(content: string, stepId: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Match severity patterns in the content
  const severityPatterns: Array<{
    pattern: RegExp;
    severity: ReviewFinding['severity'];
  }> = [
    { pattern: /(?:CRITICAL|ERROR):\s*(.+?)(?=\n(?:CRITICAL|ERROR|HIGH|WARNING|MEDIUM|INFO|LOW|SUGGESTION)|$)/gis, severity: 'error' },
    { pattern: /(?:HIGH|WARNING|MEDIUM):\s*(.+?)(?=\n(?:CRITICAL|ERROR|HIGH|WARNING|MEDIUM|INFO|LOW|SUGGESTION)|$)/gis, severity: 'warning' },
    { pattern: /(?:INFO|LOW):\s*(.+?)(?=\n(?:CRITICAL|ERROR|HIGH|WARNING|MEDIUM|INFO|LOW|SUGGESTION)|$)/gis, severity: 'info' },
    { pattern: /SUGGESTION:\s*(.+?)(?=\n(?:CRITICAL|ERROR|HIGH|WARNING|MEDIUM|INFO|LOW|SUGGESTION)|$)/gis, severity: 'suggestion' },
  ];

  for (const { pattern, severity } of severityPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const message = match[1].trim();
      if (message) {
        findings.push({
          severity,
          category: mapStepIdToCategory(stepId),
          message,
        });
      }
    }
  }

  return findings;
}

/**
 * Parse findings from synthesis output
 */
function parseSynthesisFindings(content: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Look for structured findings in synthesis
  const findingBlocks = content.split(/(?=(?:CRITICAL|ERROR|HIGH|WARNING|MEDIUM|INFO|LOW|SUGGESTION):)/i);

  for (const block of findingBlocks) {
    const severityMatch = block.match(/^(CRITICAL|ERROR|HIGH|WARNING|MEDIUM|INFO|LOW|SUGGESTION):/i);
    if (!severityMatch) continue;

    const severityStr = severityMatch[1].toUpperCase();
    const message = block.slice(severityMatch[0].length).trim().split('\n')[0];

    if (!message) continue;

    let severity: ReviewFinding['severity'];
    switch (severityStr) {
      case 'CRITICAL':
      case 'ERROR':
        severity = 'error';
        break;
      case 'HIGH':
      case 'WARNING':
      case 'MEDIUM':
        severity = 'warning';
        break;
      case 'SUGGESTION':
        severity = 'suggestion';
        break;
      default:
        severity = 'info';
    }

    findings.push({
      severity,
      category: 'synthesis',
      message,
    });
  }

  return findings;
}

/**
 * Map step ID to finding category
 */
function mapStepIdToCategory(stepId: string): string {
  const categoryMap: Record<string, string> = {
    scope: 'scope',
    standards: 'style',
    errors: 'error-handling',
    security: 'security',
    performance: 'performance',
    synthesis: 'general',
  };

  return categoryMap[stepId] || 'general';
}

/**
 * Check if a finding is a duplicate of an existing one
 */
function isDuplicateFinding(
  existingFindings: ReviewFinding[],
  newFinding: ReviewFinding
): boolean {
  return existingFindings.some(
    (f) =>
      f.severity === newFinding.severity &&
      f.message.toLowerCase().includes(newFinding.message.toLowerCase().slice(0, 50))
  );
}

/**
 * Extract summary from synthesis findings
 */
function extractSummary(content: string): string {
  // Look for explicit summary section
  const summaryMatch = content.match(/(?:SUMMARY|OVERVIEW|CONCLUSION):\s*([\s\S]*?)(?=\n\n|STATUS:|FINDINGS:|$)/i);
  if (summaryMatch) {
    return summaryMatch[1].trim();
  }

  // Fall back to first paragraph
  const firstParagraph = content.split('\n\n')[0];
  if (firstParagraph && firstParagraph.length > 20) {
    return firstParagraph.slice(0, 500);
  }

  return 'Workflow review completed. See findings for details.';
}
