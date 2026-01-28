/**
 * Simple Review - Direct LLM code review without workflow or consensus
 *
 * Provides streamlined code review for straightforward PRs using a single
 * model call with repository-specific rules and context.
 */

import type {
  ChatMessage,
  LLMRequestOptions,
  LLMResponse,
} from '../_shared/types/providers.ts';
import type { ReviewFile } from '../_shared/types/database.ts';

/**
 * Context for building review prompts
 */
export interface ReviewContext {
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
  /** Similar past reviews for context (from hybrid search) */
  similarReviews?: string[];
}

/**
 * Result from simple review execution
 */
export interface SimpleReviewResult {
  /** Overall review status */
  status: 'passed' | 'failed';
  /** Summary of the review */
  summary: string;
  /** Detailed findings */
  findings: ReviewFinding[];
  /** Token usage from the LLM call */
  tokensUsed?: number;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Individual finding from the review
 */
export interface ReviewFinding {
  /** Severity level */
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  /** Category of the finding */
  category: string;
  /** Description of the issue */
  message: string;
  /** File path if applicable */
  file?: string;
  /** Line number if applicable */
  line?: number;
  /** Suggested fix if available */
  suggestion?: string;
}

/**
 * LLM caller function type - allows dependency injection
 */
export type LLMCaller = (options: LLMRequestOptions) => Promise<LLMResponse>;

/**
 * System prompt for the code reviewer
 */
const REVIEWER_SYSTEM_PROMPT = `You are an expert code reviewer. Analyze the provided code changes and provide a thorough review.

Your review should:
1. Check for bugs, logic errors, and potential runtime issues
2. Verify proper error handling and edge cases
3. Assess code quality, readability, and maintainability
4. Identify security vulnerabilities (SQL injection, XSS, auth issues, etc.)
5. Evaluate performance implications
6. Check adherence to the repository's coding standards and rules

Format your response as follows:

STATUS: [PASSED or FAILED]

SUMMARY:
[2-3 sentence summary of the overall review]

FINDINGS:
[List each finding in this format]
- SEVERITY: [ERROR|WARNING|INFO|SUGGESTION]
  CATEGORY: [bugs|security|performance|style|logic|error-handling]
  FILE: [filename or "general"]
  LINE: [line number or "N/A"]
  MESSAGE: [description of the issue]
  SUGGESTION: [optional fix suggestion]

If no issues are found, set STATUS: PASSED and note the code quality is acceptable.
Set STATUS: FAILED if there are any ERROR severity findings, or more than 3 WARNING findings.`;

/**
 * Build the prompt for a simple review
 *
 * Constructs a structured prompt including repository rules, PR context,
 * and the code changes to review.
 *
 * @param context - Review context with rules, files, and diff
 * @returns Array of chat messages for the LLM
 */
export function buildSimplePrompt(context: ReviewContext): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: REVIEWER_SYSTEM_PROMPT,
    },
  ];

  // Add repository rules if provided
  if (context.rules && context.rules.trim().length > 0) {
    messages.push({
      role: 'user',
      content: `## Repository Rules and Guidelines\n\n${context.rules}`,
    });
  }

  // Add PR context if available
  if (context.prTitle || context.prBody) {
    let prContext = '## Pull Request Context\n\n';
    if (context.prTitle) {
      prContext += `**Title:** ${context.prTitle}\n\n`;
    }
    if (context.prBody) {
      prContext += `**Description:**\n${context.prBody}\n`;
    }
    messages.push({
      role: 'user',
      content: prContext,
    });
  }

  // Add similar past reviews for context if available
  if (context.similarReviews && context.similarReviews.length > 0) {
    const reviewContext = context.similarReviews
      .slice(0, 3) // Limit to 3 most similar
      .map((r, i) => `### Past Review ${i + 1}\n${r}`)
      .join('\n\n');

    messages.push({
      role: 'user',
      content: `## Similar Past Reviews (for context)\n\n${reviewContext}`,
    });
  }

  // Add file summary
  const fileSummary = context.files
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join('\n');

  messages.push({
    role: 'user',
    content: `## Files Changed\n\n${fileSummary}`,
  });

  // Add the diff content to review
  messages.push({
    role: 'user',
    content: `## Code Changes to Review\n\n\`\`\`diff\n${context.diff}\n\`\`\`\n\nPlease review these changes and provide your analysis.`,
  });

  return messages;
}

/**
 * Parse the LLM response into structured findings
 *
 * @param content - Raw LLM response content
 * @returns Parsed review result
 */
export function parseReviewResponse(content: string): {
  status: 'passed' | 'failed';
  summary: string;
  findings: ReviewFinding[];
} {
  // Extract status
  const statusMatch = content.match(/STATUS:\s*(PASSED|FAILED)/i);
  const status =
    statusMatch?.[1]?.toUpperCase() === 'PASSED' ? 'passed' : 'failed';

  // Extract summary
  const summaryMatch = content.match(/SUMMARY:\s*([\s\S]*?)(?=FINDINGS:|$)/i);
  const summary = summaryMatch?.[1]?.trim() || 'No summary provided';

  // Extract findings
  const findings: ReviewFinding[] = [];
  const findingsSection = content.match(/FINDINGS:\s*([\s\S]*?)$/i)?.[1] || '';

  // Parse each finding block
  const findingBlocks = findingsSection.split(/(?=- SEVERITY:)/i);

  for (const block of findingBlocks) {
    if (!block.trim()) continue;

    const severityMatch = block.match(/SEVERITY:\s*(ERROR|WARNING|INFO|SUGGESTION)/i);
    const categoryMatch = block.match(/CATEGORY:\s*([^\n]+)/i);
    const fileMatch = block.match(/FILE:\s*([^\n]+)/i);
    const lineMatch = block.match(/LINE:\s*(\d+|N\/A)/i);
    const messageMatch = block.match(/MESSAGE:\s*([^\n]+(?:\n(?!SUGGESTION:)[^\n-]*)*)/i);
    const suggestionMatch = block.match(/SUGGESTION:\s*([^\n]+(?:\n(?!- SEVERITY:)[^\n-]*)*)/i);

    if (severityMatch && messageMatch) {
      const severity = severityMatch[1].toLowerCase() as ReviewFinding['severity'];
      const lineStr = lineMatch?.[1];
      const line = lineStr && lineStr !== 'N/A' ? parseInt(lineStr, 10) : undefined;

      findings.push({
        severity,
        category: categoryMatch?.[1]?.trim() || 'general',
        message: messageMatch[1].trim(),
        file: fileMatch?.[1]?.trim() !== 'general' ? fileMatch?.[1]?.trim() : undefined,
        line,
        suggestion: suggestionMatch?.[1]?.trim(),
      });
    }
  }

  return { status, summary, findings };
}

/**
 * Execute a simple review using direct LLM call
 *
 * @param context - Review context with rules, files, and diff
 * @param llmCaller - Function to call the LLM
 * @param maxTokens - Maximum tokens for the response
 * @returns Simple review result
 */
export async function executeSimpleReview(
  context: ReviewContext,
  llmCaller: LLMCaller,
  maxTokens: number = 4096
): Promise<SimpleReviewResult> {
  const startTime = Date.now();

  try {
    const messages = buildSimplePrompt(context);

    const response = await llmCaller({
      messages,
      maxTokens,
      temperature: 0.3, // Lower temperature for consistent analysis
    });

    const parsed = parseReviewResponse(response.content);
    const durationMs = Date.now() - startTime;

    return {
      status: parsed.status,
      summary: parsed.summary,
      findings: parsed.findings,
      tokensUsed: response.usage?.totalTokens,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      status: 'failed',
      summary: `Review failed: ${errorMessage}`,
      findings: [
        {
          severity: 'error',
          category: 'system',
          message: `Review execution failed: ${errorMessage}`,
        },
      ],
      durationMs,
    };
  }
}
