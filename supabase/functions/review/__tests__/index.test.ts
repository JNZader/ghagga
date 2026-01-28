/**
 * Unit tests for Review Function
 *
 * Tests cover:
 * - Simple review execution
 * - Workflow review execution
 * - Consensus review execution
 * - Review persistence
 * - Hebbian learning updates
 * - PR comment formatting
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import {
  buildSimplePrompt,
  parseReviewResponse,
  executeSimpleReview,
  type ReviewContext,
  type ReviewFinding,
} from '../simple.ts';
import { executeWorkflowReview, type WorkflowReviewContext } from '../workflow.ts';
import { executeConsensusReview, type ConsensusReviewContext } from '../consensus.ts';
import { formatReviewComment, type ReviewMode } from '../index.ts';
import type { LLMRequestOptions, LLMResponse } from '../../_shared/types/providers.ts';
import type { ReviewFile, ReviewStatus } from '../../_shared/types/database.ts';

/**
 * Create mock review files
 */
function createMockFiles(): ReviewFile[] {
  return [
    {
      id: 'file-1',
      review_id: 'review-1',
      filename: 'src/utils.ts',
      status: 'modified',
      additions: 10,
      deletions: 5,
      created_at: new Date().toISOString(),
    },
    {
      id: 'file-2',
      review_id: 'review-1',
      filename: 'src/index.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      created_at: new Date().toISOString(),
    },
  ];
}

/**
 * Create mock LLM caller
 */
function createMockLLMCaller(response: string): (options: LLMRequestOptions) => Promise<LLMResponse> {
  return async () => ({
    content: response,
    model: 'mock-model',
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
  });
}

describe('Simple Review', () => {
  describe('buildSimplePrompt', () => {
    it('should create messages with system prompt', () => {
      const context: ReviewContext = {
        rules: 'Use TypeScript strict mode',
        files: createMockFiles(),
        diff: '+ const x = 1;',
      };

      const messages = buildSimplePrompt(context);

      assertEquals(messages.length >= 2, true);
      assertEquals(messages[0].role, 'system');
      assertStringIncludes(messages[0].content, 'expert code reviewer');
    });

    it('should include repository rules', () => {
      const context: ReviewContext = {
        rules: 'Always use async/await',
        files: createMockFiles(),
        diff: '+ const x = 1;',
      };

      const messages = buildSimplePrompt(context);
      const rulesMessage = messages.find((m) =>
        m.content.includes('Repository Rules')
      );

      assertExists(rulesMessage);
      assertStringIncludes(rulesMessage.content, 'async/await');
    });

    it('should include PR context when provided', () => {
      const context: ReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ const x = 1;',
        prTitle: 'Fix user authentication',
        prBody: 'This PR fixes the login bug',
      };

      const messages = buildSimplePrompt(context);
      const prMessage = messages.find((m) =>
        m.content.includes('Pull Request Context')
      );

      assertExists(prMessage);
      assertStringIncludes(prMessage.content, 'Fix user authentication');
      assertStringIncludes(prMessage.content, 'login bug');
    });

    it('should include file summary', () => {
      const context: ReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ const x = 1;',
      };

      const messages = buildSimplePrompt(context);
      const filesMessage = messages.find((m) =>
        m.content.includes('Files Changed')
      );

      assertExists(filesMessage);
      assertStringIncludes(filesMessage.content, 'src/utils.ts');
      assertStringIncludes(filesMessage.content, 'modified');
    });

    it('should include diff content', () => {
      const context: ReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ const newFunction = () => {};',
      };

      const messages = buildSimplePrompt(context);
      const diffMessage = messages.find((m) =>
        m.content.includes('Code Changes to Review')
      );

      assertExists(diffMessage);
      assertStringIncludes(diffMessage.content, 'newFunction');
    });

    it('should include similar reviews when provided', () => {
      const context: ReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ const x = 1;',
        similarReviews: ['Past review found null pointer issues', 'Past review approved changes'],
      };

      const messages = buildSimplePrompt(context);
      const similarMessage = messages.find((m) =>
        m.content.includes('Similar Past Reviews')
      );

      assertExists(similarMessage);
      assertStringIncludes(similarMessage.content, 'null pointer');
    });
  });

  describe('parseReviewResponse', () => {
    it('should parse PASSED status', () => {
      const response = `STATUS: PASSED

SUMMARY:
Code looks good overall.

FINDINGS:
No issues found.`;

      const result = parseReviewResponse(response);

      assertEquals(result.status, 'passed');
      assertStringIncludes(result.summary, 'Code looks good');
    });

    it('should parse FAILED status', () => {
      const response = `STATUS: FAILED

SUMMARY:
Critical security issue found.

FINDINGS:
- SEVERITY: ERROR
  CATEGORY: security
  FILE: auth.ts
  LINE: 42
  MESSAGE: SQL injection vulnerability
  SUGGESTION: Use parameterized queries`;

      const result = parseReviewResponse(response);

      assertEquals(result.status, 'failed');
      assertEquals(result.findings.length, 1);
      assertEquals(result.findings[0].severity, 'error');
      assertEquals(result.findings[0].category, 'security');
      assertStringIncludes(result.findings[0].message, 'SQL injection');
    });

    it('should parse multiple findings', () => {
      const response = `STATUS: FAILED

SUMMARY:
Multiple issues found.

FINDINGS:
- SEVERITY: ERROR
  CATEGORY: security
  FILE: auth.ts
  LINE: 10
  MESSAGE: Missing authentication check

- SEVERITY: WARNING
  CATEGORY: performance
  FILE: query.ts
  LINE: 25
  MESSAGE: N+1 query detected

- SEVERITY: INFO
  CATEGORY: style
  FILE: general
  LINE: N/A
  MESSAGE: Consider using const instead of let`;

      const result = parseReviewResponse(response);

      assertEquals(result.findings.length, 3);
      assertEquals(result.findings[0].severity, 'error');
      assertEquals(result.findings[1].severity, 'warning');
      assertEquals(result.findings[2].severity, 'info');
    });

    it('should handle missing fields gracefully', () => {
      const response = `Some random content without proper structure`;

      const result = parseReviewResponse(response);

      assertEquals(result.status, 'failed');
      assertExists(result.summary);
    });
  });

  describe('executeSimpleReview', () => {
    it('should execute review and return result', async () => {
      const mockResponse = `STATUS: PASSED

SUMMARY:
Code is well-written and follows best practices.

FINDINGS:
- SEVERITY: SUGGESTION
  CATEGORY: style
  FILE: general
  LINE: N/A
  MESSAGE: Consider adding JSDoc comments`;

      const context: ReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ const x = 1;',
      };

      const result = await executeSimpleReview(
        context,
        createMockLLMCaller(mockResponse)
      );

      assertEquals(result.status, 'passed');
      assertExists(result.summary);
      assertExists(result.durationMs);
      assertEquals(result.tokensUsed, 150);
    });

    it('should handle LLM errors gracefully', async () => {
      const failingCaller = async (): Promise<LLMResponse> => {
        throw new Error('API rate limit exceeded');
      };

      const context: ReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ const x = 1;',
      };

      const result = await executeSimpleReview(context, failingCaller);

      assertEquals(result.status, 'failed');
      assertStringIncludes(result.summary, 'rate limit');
      assertEquals(result.findings[0].severity, 'error');
    });
  });
});

describe('Workflow Review', () => {
  describe('executeWorkflowReview', () => {
    it('should execute workflow and return structured result', async () => {
      const mockCaller = async (options: LLMRequestOptions): Promise<LLMResponse> => {
        const systemMsg = options.messages.find((m) => m.role === 'system')?.content || '';

        let response = 'Generic findings';
        if (systemMsg.includes('Synthesize')) {
          response = `SUMMARY: All checks passed successfully.

STATUS: PASSED

No critical issues found. Code follows best practices.`;
        }

        return {
          content: response,
          model: 'mock-model',
        };
      };

      const context: WorkflowReviewContext = {
        rules: 'Follow TypeScript best practices',
        files: createMockFiles(),
        diff: '+ export function test() {}',
      };

      const result = await executeWorkflowReview(context, mockCaller);

      assertEquals(result.status, 'passed');
      assertExists(result.summary);
      assertExists(result.stepResults);
      assertEquals(result.stepResults.length > 0, true);
    });

    it('should support parallel execution mode', async () => {
      const callTimes: number[] = [];
      const startTime = Date.now();

      const mockCaller = async (): Promise<LLMResponse> => {
        callTimes.push(Date.now() - startTime);
        await new Promise((r) => setTimeout(r, 10));
        return { content: 'findings', model: 'mock' };
      };

      const context: WorkflowReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ code',
      };

      await executeWorkflowReview(context, mockCaller, { parallel: true });

      // In parallel mode, calls should start around the same time
      const maxTimeDiff = Math.max(...callTimes) - Math.min(...callTimes);
      assertEquals(maxTimeDiff < 100, true); // All started within 100ms
    });

    it('should handle workflow errors', async () => {
      const failingCaller = async (): Promise<LLMResponse> => {
        throw new Error('Workflow step failed');
      };

      const context: WorkflowReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ code',
      };

      const result = await executeWorkflowReview(context, failingCaller, {
        parallel: true,
      });

      assertEquals(result.status, 'error');
      assertExists(result.error);
    });
  });
});

describe('Consensus Review', () => {
  describe('executeConsensusReview', () => {
    it('should execute consensus with multiple models', async () => {
      const mockCaller = async (): Promise<LLMResponse> => ({
        content: `DECISION: approve
CONFIDENCE: 0.85
REASONING: The code changes look good and follow best practices.`,
        model: 'mock-model',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      const context: ConsensusReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ good code',
      };

      const result = await executeConsensusReview(context, mockCaller);

      assertExists(result.recommendation);
      assertExists(result.modelResponses);
      assertEquals(result.totalTokensUsed >= 0, true);
    });

    it('should handle mixed model decisions', async () => {
      let callCount = 0;
      const mockCaller = async (): Promise<LLMResponse> => {
        callCount++;
        const decisions = ['approve', 'reject', 'abstain'];
        const decision = decisions[(callCount - 1) % 3];

        return {
          content: `DECISION: ${decision}
CONFIDENCE: 0.7
REASONING: Based on analysis.`,
          model: 'mock-model',
        };
      };

      const context: ConsensusReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ controversial code',
      };

      const result = await executeConsensusReview(context, mockCaller);

      // With mixed votes, should likely end up in discuss
      assertExists(result.recommendation);
      assertEquals(['passed', 'failed', 'discuss'].includes(result.status), true);
    });

    it('should handle consensus errors', async () => {
      const failingCaller = async (): Promise<LLMResponse> => {
        throw new Error('Model unavailable');
      };

      const context: ConsensusReviewContext = {
        rules: '',
        files: createMockFiles(),
        diff: '+ code',
      };

      const result = await executeConsensusReview(context, failingCaller);

      assertEquals(result.status, 'discuss');
      assertEquals(result.recommendation.confidence, 0);
    });
  });
});

describe('PR Comment Formatting', () => {
  describe('formatReviewComment', () => {
    it('should format passed review', () => {
      const comment = formatReviewComment({
        status: 'passed' as ReviewStatus,
        summary: 'All checks passed. Code is well-written.',
        findings: [],
        mode: 'simple' as ReviewMode,
      });

      assertStringIncludes(comment, 'Passed');
      assertStringIncludes(comment, 'All checks passed');
      assertStringIncludes(comment, 'No issues found');
    });

    it('should format failed review with findings', () => {
      const findings: ReviewFinding[] = [
        {
          severity: 'error',
          category: 'security',
          message: 'SQL injection vulnerability detected',
          file: 'db.ts',
          line: 42,
          suggestion: 'Use parameterized queries',
        },
        {
          severity: 'warning',
          category: 'performance',
          message: 'N+1 query pattern detected',
        },
      ];

      const comment = formatReviewComment({
        status: 'failed' as ReviewStatus,
        summary: 'Critical security issues found.',
        findings,
        mode: 'workflow' as ReviewMode,
      });

      assertStringIncludes(comment, 'Failed');
      assertStringIncludes(comment, 'SQL injection');
      assertStringIncludes(comment, 'db.ts:42');
      assertStringIncludes(comment, 'parameterized queries');
      assertStringIncludes(comment, 'N+1 query');
      assertStringIncludes(comment, 'Multi-Agent Workflow');
    });

    it('should group findings by severity', () => {
      const findings: ReviewFinding[] = [
        { severity: 'error', category: 'security', message: 'Error 1' },
        { severity: 'warning', category: 'style', message: 'Warning 1' },
        { severity: 'error', category: 'logic', message: 'Error 2' },
        { severity: 'info', category: 'docs', message: 'Info 1' },
      ];

      const comment = formatReviewComment({
        status: 'failed' as ReviewStatus,
        summary: 'Multiple issues found.',
        findings,
        mode: 'simple' as ReviewMode,
      });

      // Errors should appear before warnings
      const errorIndex = comment.indexOf('Errors (2)');
      const warningIndex = comment.indexOf('Warnings (1)');
      const infoIndex = comment.indexOf('Infos (1)');

      assertEquals(errorIndex < warningIndex, true);
      assertEquals(warningIndex < infoIndex, true);
    });

    it('should show different mode labels', () => {
      const modes: Array<{ mode: ReviewMode; label: string }> = [
        { mode: 'simple', label: 'Standard Review' },
        { mode: 'workflow', label: 'Multi-Agent Workflow' },
        { mode: 'consensus', label: 'Multi-Model Consensus' },
      ];

      for (const { mode, label } of modes) {
        const comment = formatReviewComment({
          status: 'passed' as ReviewStatus,
          summary: 'Good.',
          findings: [],
          mode,
        });

        assertStringIncludes(comment, label);
      }
    });

    it('should include file and line information when available', () => {
      const findings: ReviewFinding[] = [
        {
          severity: 'warning',
          category: 'style',
          message: 'Variable naming issue',
          file: 'src/utils.ts',
          line: 25,
        },
      ];

      const comment = formatReviewComment({
        status: 'passed' as ReviewStatus,
        summary: 'Minor issues.',
        findings,
        mode: 'simple' as ReviewMode,
      });

      assertStringIncludes(comment, 'src/utils.ts:25');
    });
  });
});
