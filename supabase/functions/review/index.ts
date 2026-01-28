/**
 * Review Function - Central orchestrator for code review operations
 *
 * This module provides the main entry point for code reviews, handling:
 * - Mode selection (simple/workflow/consensus)
 * - Review execution
 * - Persistence to database with embeddings
 * - Hebbian learning updates
 * - PR comment formatting
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import type {
  Review,
  ReviewInsert,
  ReviewStatus,
  ReviewFile,
  RepoConfig,
} from '../_shared/types/database.ts';
import type { LLMRequestOptions, LLMResponse } from '../_shared/types/providers.ts';
import { EmbeddingService, type EmbeddingServiceConfig } from '../_shared/embeddings/service.ts';
import { HebbianLearner, type AssociationType } from '../_shared/hebbian/learner.ts';
import { HybridSearch } from '../_shared/search/hybrid.ts';
import {
  executeSimpleReview,
  type ReviewContext,
  type ReviewFinding,
  type SimpleReviewResult,
} from './simple.ts';
import {
  executeWorkflowReview,
  type WorkflowReviewContext,
  type WorkflowReviewResult,
} from './workflow.ts';
import {
  executeConsensusReview,
  type ConsensusReviewContext,
  type ConsensusReviewConfig,
  type ConsensusReviewResult,
} from './consensus.ts';

/**
 * Review mode determines which review strategy to use
 */
export type ReviewMode = 'simple' | 'workflow' | 'consensus';

/**
 * Input for executing a review
 */
export interface ReviewInput {
  /** Repository full name (owner/repo) */
  repoFullName: string;
  /** Pull request number */
  prNumber: number;
  /** PR title */
  prTitle?: string;
  /** PR description/body */
  prBody?: string;
  /** Files changed in the PR */
  files: ReviewFile[];
  /** Combined diff content */
  diff: string;
  /** Repository configuration */
  repoConfig: RepoConfig;
}

/**
 * Result from review execution
 */
export interface ReviewOutput {
  /** Review ID in database */
  reviewId: string;
  /** Overall status */
  status: ReviewStatus;
  /** Review summary */
  summary: string;
  /** Detailed findings */
  findings: ReviewFinding[];
  /** Formatted comment for PR */
  prComment: string;
  /** Review mode used */
  mode: ReviewMode;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Dependencies for the ReviewService
 */
export interface ReviewServiceDeps {
  supabase: SupabaseClient;
  llmCaller: (options: LLMRequestOptions) => Promise<LLMResponse>;
  embeddingConfig: EmbeddingServiceConfig;
}

/**
 * ReviewService orchestrates code review operations
 */
export class ReviewService {
  private supabase: SupabaseClient;
  private llmCaller: (options: LLMRequestOptions) => Promise<LLMResponse>;
  private embeddingService: EmbeddingService;
  private hebbianLearner: HebbianLearner;
  private hybridSearch: HybridSearch;

  constructor(deps: ReviewServiceDeps) {
    this.supabase = deps.supabase;
    this.llmCaller = deps.llmCaller;
    this.embeddingService = new EmbeddingService(deps.embeddingConfig);
    this.hebbianLearner = new HebbianLearner(deps.supabase);
    this.hybridSearch = new HybridSearch(
      deps.supabase,
      this.embeddingService
    );
  }

  /**
   * Execute a code review based on repository configuration
   *
   * @param input - Review input with PR details and configuration
   * @returns Review output with results and formatted comment
   */
  async executeReview(input: ReviewInput): Promise<ReviewOutput> {
    const startTime = Date.now();

    // Determine review mode based on configuration
    const mode = this.determineReviewMode(input.repoConfig);

    // Fetch similar past reviews for context
    const similarReviews = await this.fetchSimilarReviews(
      input.repoFullName,
      input.diff
    );

    // Execute review based on mode
    let result: SimpleReviewResult | WorkflowReviewResult | ConsensusReviewResult;
    let status: ReviewStatus;
    let summary: string;
    let findings: ReviewFinding[];

    switch (mode) {
      case 'workflow': {
        const context: WorkflowReviewContext = {
          rules: input.repoConfig.rules || '',
          files: input.files,
          diff: input.diff,
          prTitle: input.prTitle,
          prBody: input.prBody,
        };
        result = await executeWorkflowReview(context, this.llmCaller);
        status = result.status === 'error' ? 'failed' : result.status;
        summary = result.summary;
        findings = result.findings;
        break;
      }

      case 'consensus': {
        const context: ConsensusReviewContext = {
          rules: input.repoConfig.rules || '',
          files: input.files,
          diff: input.diff,
          prTitle: input.prTitle,
          prBody: input.prBody,
        };
        result = await executeConsensusReview(context, this.llmCaller);
        status = result.status === 'discuss' ? 'pending' : result.status;
        summary = result.summary;
        findings = result.findings;
        break;
      }

      case 'simple':
      default: {
        const context: ReviewContext = {
          rules: input.repoConfig.rules || '',
          files: input.files,
          diff: input.diff,
          prTitle: input.prTitle,
          prBody: input.prBody,
          similarReviews,
        };
        result = await executeSimpleReview(context, this.llmCaller);
        status = result.status;
        summary = result.summary;
        findings = result.findings;
        break;
      }
    }

    // Save review to database with embedding
    const reviewId = await this.saveReview({
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      prTitle: input.prTitle,
      status,
      summary,
      findings,
      filesReviewed: input.files.map((f) => f.filename),
    });

    // Update Hebbian learning if enabled
    if (input.repoConfig.hebbian_enabled) {
      await this.updateHebbian(
        input.repoFullName,
        input.files,
        findings
      );
    }

    // Format PR comment
    const prComment = formatReviewComment({
      status,
      summary,
      findings,
      mode,
      prTitle: input.prTitle,
    });

    const durationMs = Date.now() - startTime;

    return {
      reviewId,
      status,
      summary,
      findings,
      prComment,
      mode,
      durationMs,
    };
  }

  /**
   * Determine which review mode to use based on configuration
   */
  private determineReviewMode(config: RepoConfig): ReviewMode {
    if (config.consensus_enabled) {
      return 'consensus';
    }
    if (config.workflow_enabled) {
      return 'workflow';
    }
    return 'simple';
  }

  /**
   * Fetch similar past reviews using hybrid search
   */
  private async fetchSimilarReviews(
    repoFullName: string,
    diff: string
  ): Promise<string[]> {
    try {
      // Use first 1000 chars of diff as query
      const query = diff.slice(0, 1000);
      const results = await this.hybridSearch.search(query, repoFullName);

      if (results.length === 0) {
        return [];
      }

      // Fetch the actual review summaries
      const reviewIds = results.map((r) => r.id);
      const { data, error } = await this.supabase
        .from('reviews')
        .select('result_summary')
        .in('id', reviewIds);

      if (error || !data) {
        return [];
      }

      return data.map((r) => r.result_summary);
    } catch {
      // Silently fail - similar reviews are optional context
      return [];
    }
  }

  /**
   * Save review to database with embedding
   */
  private async saveReview(params: {
    repoFullName: string;
    prNumber: number;
    prTitle?: string;
    status: ReviewStatus;
    summary: string;
    findings: ReviewFinding[];
    filesReviewed: string[];
  }): Promise<string> {
    // Generate embedding for the review summary
    let embedding: number[] | undefined;
    try {
      const result = await this.embeddingService.embed(params.summary);
      embedding = result.embedding;
    } catch {
      // Continue without embedding if generation fails
      console.warn('Failed to generate embedding for review');
    }

    // Prepare review record
    const reviewInsert: ReviewInsert = {
      repo_full_name: params.repoFullName,
      pr_number: params.prNumber,
      pr_title: params.prTitle,
      status: params.status,
      result_summary: params.summary,
      result_full: { findings: params.findings },
      files_reviewed: params.filesReviewed,
      embedding,
    };

    const { data, error } = await this.supabase
      .from('reviews')
      .insert(reviewInsert)
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to save review: ${error.message}`);
    }

    return data.id;
  }

  /**
   * Update Hebbian associations based on review results
   *
   * Strengthens associations between:
   * - File patterns and finding categories
   * - Error types and fix patterns
   * - Review patterns that co-occur
   */
  async updateHebbian(
    repoFullName: string,
    files: ReviewFile[],
    findings: ReviewFinding[]
  ): Promise<void> {
    try {
      // Extract patterns from files
      const filePatterns = files.map((f) => extractFilePattern(f.filename));

      // Extract finding categories
      const findingCategories = findings.map((f) => `finding:${f.category}`);

      // Extract severity patterns
      const severityPatterns = findings
        .filter((f) => f.severity === 'error' || f.severity === 'warning')
        .map((f) => `severity:${f.severity}`);

      // Combine all concepts
      const concepts = [
        ...filePatterns,
        ...findingCategories,
        ...severityPatterns,
      ].filter((c, i, arr) => arr.indexOf(c) === i); // Unique

      // Strengthen associations between all concepts
      if (concepts.length >= 2) {
        await this.hebbianLearner.strengthenAll(repoFullName, concepts, {
          associationType: 'review_pattern' as AssociationType,
          learningRate: 0.1,
        });
      }

      // Strengthen file-to-finding associations specifically
      for (const file of files) {
        const pattern = extractFilePattern(file.filename);
        const fileFindings = findings.filter((f) => f.file === file.filename);

        for (const finding of fileFindings) {
          await this.hebbianLearner.strengthen(
            repoFullName,
            pattern,
            `finding:${finding.category}`,
            { associationType: 'code_pattern' as AssociationType }
          );
        }
      }
    } catch {
      // Silently fail - Hebbian updates are non-critical
      console.warn('Failed to update Hebbian associations');
    }
  }
}

/**
 * Extract a pattern from a filename for Hebbian learning
 */
function extractFilePattern(filename: string): string {
  // Extract extension
  const ext = filename.split('.').pop() || 'unknown';

  // Extract directory pattern
  const parts = filename.split('/');
  if (parts.length > 1) {
    return `file:${parts[0]}/*.${ext}`;
  }

  return `file:*.${ext}`;
}

/**
 * Options for formatting the PR comment
 */
interface FormatCommentOptions {
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
  mode: ReviewMode;
  prTitle?: string;
}

/**
 * Format review results as a PR comment
 *
 * Creates a well-structured markdown comment suitable for
 * posting to GitHub pull requests.
 */
export function formatReviewComment(options: FormatCommentOptions): string {
  const { status, summary, findings, mode } = options;

  const lines: string[] = [];

  // Header with status badge
  const statusEmoji = getStatusEmoji(status);
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  lines.push(`## ${statusEmoji} Code Review: ${statusLabel}`);
  lines.push('');

  // Mode indicator
  const modeLabel = getModeLabel(mode);
  lines.push(`*Review type: ${modeLabel}*`);
  lines.push('');

  // Summary section
  lines.push('### Summary');
  lines.push('');
  lines.push(summary);
  lines.push('');

  // Findings section (if any)
  if (findings.length > 0) {
    lines.push('### Findings');
    lines.push('');

    // Group findings by severity
    const groupedFindings = groupFindingsBySeverity(findings);

    for (const [severity, severityFindings] of Object.entries(groupedFindings)) {
      if (severityFindings.length === 0) continue;

      const severityEmoji = getSeverityEmoji(severity as ReviewFinding['severity']);
      const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
      lines.push(`#### ${severityEmoji} ${severityLabel}s (${severityFindings.length})`);
      lines.push('');

      for (const finding of severityFindings) {
        let findingLine = `- **[${finding.category}]** ${finding.message}`;

        if (finding.file) {
          findingLine += ` *(${finding.file}`;
          if (finding.line) {
            findingLine += `:${finding.line}`;
          }
          findingLine += ')*';
        }

        lines.push(findingLine);

        if (finding.suggestion) {
          lines.push(`  - *Suggestion:* ${finding.suggestion}`);
        }
      }

      lines.push('');
    }
  } else {
    lines.push('### Findings');
    lines.push('');
    lines.push('No issues found. The code looks good!');
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('*Automated code review*');

  return lines.join('\n');
}

/**
 * Get emoji for status
 */
function getStatusEmoji(status: ReviewStatus): string {
  switch (status) {
    case 'passed':
      return ':white_check_mark:';
    case 'failed':
      return ':x:';
    case 'pending':
      return ':hourglass:';
    case 'in_progress':
      return ':arrows_counterclockwise:';
    case 'skipped':
      return ':fast_forward:';
    default:
      return ':grey_question:';
  }
}

/**
 * Get emoji for severity
 */
function getSeverityEmoji(severity: ReviewFinding['severity']): string {
  switch (severity) {
    case 'error':
      return ':red_circle:';
    case 'warning':
      return ':warning:';
    case 'info':
      return ':information_source:';
    case 'suggestion':
      return ':bulb:';
    default:
      return ':grey_question:';
  }
}

/**
 * Get human-readable label for review mode
 */
function getModeLabel(mode: ReviewMode): string {
  switch (mode) {
    case 'simple':
      return 'Standard Review';
    case 'workflow':
      return 'Multi-Agent Workflow';
    case 'consensus':
      return 'Multi-Model Consensus';
    default:
      return 'Review';
  }
}

/**
 * Group findings by severity
 */
function groupFindingsBySeverity(
  findings: ReviewFinding[]
): Record<string, ReviewFinding[]> {
  const groups: Record<string, ReviewFinding[]> = {
    error: [],
    warning: [],
    info: [],
    suggestion: [],
  };

  for (const finding of findings) {
    groups[finding.severity].push(finding);
  }

  return groups;
}

// Re-export types and functions for external use
export type {
  ReviewContext,
  ReviewFinding,
  SimpleReviewResult,
} from './simple.ts';
export type {
  WorkflowReviewContext,
  WorkflowReviewConfig,
  WorkflowReviewResult,
} from './workflow.ts';
export type {
  ConsensusReviewContext,
  ConsensusReviewConfig,
  ConsensusReviewResult,
} from './consensus.ts';
export {
  buildSimplePrompt,
  executeSimpleReview,
} from './simple.ts';
export { executeWorkflowReview } from './workflow.ts';
export { executeConsensusReview } from './consensus.ts';
