/**
 * Unit tests for ReviewService orchestrator
 *
 * Tests mode determination, rule enrichment with static analysis + memory context,
 * and comment formatting integration.
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
  ReviewService,
  formatReviewComment,
  type ReviewInput,
  type ReviewMode,
  type ReviewServiceDeps,
} from '../index.ts';
import type { ReviewFinding } from '../simple.ts';
import type { LLMRequestOptions, LLMResponse } from '../../_shared/types/providers.ts';
import type { RepoConfig, ReviewStatus } from '../../_shared/types/database.ts';

// --- Mocks ---

function createMockRepoConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    id: 'config-1',
    installation_id: 1,
    repo_full_name: 'owner/repo',
    enabled: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    rules: 'Follow best practices',
    file_patterns: ['**/*.ts'],
    exclude_patterns: ['node_modules/**'],
    workflow_enabled: false,
    consensus_enabled: false,
    hebbian_enabled: false,
    static_analysis_enabled: false,
    ai_attribution_check: false,
    security_patterns_check: false,
    semgrep_service_url: '',
    commit_message_check: false,
    stack_aware_prompts: false,
    memory_enabled: false,
    ...overrides,
  };
}

function createMockLLMCaller(response: string): (options: LLMRequestOptions) => Promise<LLMResponse> {
  return async () => ({
    content: response,
    model: 'mock-model',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  });
}

function createMockSupabase() {
  return {
    from: (_table: string) => ({
      insert: (_data: unknown) => ({
        select: (_cols: string) => ({
          single: () => Promise.resolve({ data: { id: 'review-1' }, error: null }),
        }),
      }),
      select: (_cols: string) => ({
        in: (_col: string, _ids: string[]) =>
          Promise.resolve({ data: [], error: null }),
        eq: (_col: string, _val: unknown) => ({
          eq: (_col2: string, _val2: unknown) => ({
            eq: (_col3: string, _val3: unknown) => ({
              single: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }),
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

function createMockDeps(llmResponse: string): ReviewServiceDeps {
  return {
    supabase: createMockSupabase() as never,
    llmCaller: createMockLLMCaller(llmResponse),
    embeddingConfig: {
      provider: 'openai' as const,
      fallback: 'none' as const,
      model: 'text-embedding-3-small',
      openaiApiKey: 'test-key',
    },
  };
}

// --- Tests ---

describe({ name: 'ReviewService.determineReviewMode (via executeReview)', sanitizeOps: false, sanitizeResources: false }, () => {
  it('should use simple mode by default', async () => {
    const mockResponse = `STATUS: PASSED\n\nSUMMARY:\nAll good.\n\nFINDINGS:\nNone.`;
    const deps = createMockDeps(mockResponse);
    const service = new ReviewService(deps);

    const result = await service.executeReview({
      repoFullName: 'owner/repo',
      prNumber: 1,
      files: [],
      diff: '+ const x = 1;',
      repoConfig: createMockRepoConfig(),
    });

    assertEquals(result.mode, 'simple');
  });

  it('should use workflow mode when enabled', async () => {
    const mockResponse = `STATUS: PASSED\n\nSUMMARY:\nAll good.\n\nFINDINGS:\nNone.`;
    const deps = createMockDeps(mockResponse);
    const service = new ReviewService(deps);

    const result = await service.executeReview({
      repoFullName: 'owner/repo',
      prNumber: 1,
      files: [],
      diff: '+ const x = 1;',
      repoConfig: createMockRepoConfig({ workflow_enabled: true }),
    });

    assertEquals(result.mode, 'workflow');
  });

  it('should use consensus mode when enabled (takes priority)', async () => {
    const mockResponse = `DECISION: approve\nCONFIDENCE: 0.9\nREASONING: Good code.`;
    const deps = createMockDeps(mockResponse);
    const service = new ReviewService(deps);

    const result = await service.executeReview({
      repoFullName: 'owner/repo',
      prNumber: 1,
      files: [],
      diff: '+ const x = 1;',
      repoConfig: createMockRepoConfig({
        workflow_enabled: true,
        consensus_enabled: true,
      }),
    });

    assertEquals(result.mode, 'consensus');
  });
});

describe({ name: 'ReviewService enrichedRules', sanitizeOps: false, sanitizeResources: false }, () => {
  it('should include memory context in rules when provided', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const mockCaller = async (options: LLMRequestOptions): Promise<LLMResponse> => {
      capturedMessages = options.messages;
      return {
        content: `STATUS: PASSED\n\nSUMMARY:\nAll good.\n\nFINDINGS:\nNone.`,
        model: 'mock-model',
      };
    };

    const deps: ReviewServiceDeps = {
      supabase: createMockSupabase() as never,
      llmCaller: mockCaller,
      embeddingConfig: {
        provider: 'openai' as const,
        fallback: 'none' as const,
        model: 'text-embedding-3-small',
        openaiApiKey: 'test-key',
      },
    };

    const service = new ReviewService(deps);
    const memoryContext = '## Past Review Memory\n- [bugfix] Auth issue in auth.ts';

    await service.executeReview({
      repoFullName: 'owner/repo',
      prNumber: 1,
      files: [],
      diff: '+ const x = 1;',
      repoConfig: createMockRepoConfig({ rules: 'Use strict mode' }),
      memoryContext,
    });

    // The memory context should appear in the system/rules message
    const allContent = capturedMessages.map((m) => m.content).join('\n');
    assertStringIncludes(allContent, 'Past Review Memory');
    assertStringIncludes(allContent, 'Use strict mode');
  });
});

describe({ name: 'ReviewService static analysis merge', sanitizeOps: false, sanitizeResources: false }, () => {
  it('should merge static findings into review findings', async () => {
    const mockResponse = `STATUS: PASSED\n\nSUMMARY:\nAll good.\n\nFINDINGS:\n- SEVERITY: INFO\n  CATEGORY: docs\n  MESSAGE: Add docs`;
    const deps = createMockDeps(mockResponse);
    const service = new ReviewService(deps);

    const result = await service.executeReview({
      repoFullName: 'owner/repo',
      prNumber: 1,
      files: [],
      diff: '+ const x = 1;',
      repoConfig: createMockRepoConfig(),
      staticAnalysisResult: {
        detectedStack: 'node-npm',
        findings: [
          {
            severity: 'error',
            category: 'ai-attribution',
            message: 'AI attribution detected',
            file: 'file.ts',
            source: 'static-analysis',
            ruleId: 'ai-attr-1',
          },
        ],
        summary: {
          aiAttribution: { fileFindings: 1, commitFindings: 0 },
          security: { findings: 0, serviceAvailable: false },
          commitMessage: { valid: 1, invalid: 0 },
        },
        totalTimeMs: 10,
        hasBlockingFindings: true,
      },
    });

    // Should include both static and LLM findings
    assertEquals(result.findings.length >= 2, true);
    // Should force failed status because of blocking static findings
    assertEquals(result.status, 'failed');
  });
});

describe('formatReviewComment with static analysis', () => {
  it('should include static analysis result in comment', () => {
    const comment = formatReviewComment({
      status: 'failed' as ReviewStatus,
      summary: 'Issues found.',
      findings: [
        { severity: 'error', category: 'security', message: 'XSS risk' },
      ],
      mode: 'simple' as ReviewMode,
      staticAnalysisResult: {
        detectedStack: 'node-npm',
        findings: [],
        summary: {
          aiAttribution: { fileFindings: 0, commitFindings: 0 },
          security: { findings: 0, serviceAvailable: true },
          commitMessage: { valid: 1, invalid: 0 },
        },
        totalTimeMs: 15,
        hasBlockingFindings: false,
      },
    });

    assertStringIncludes(comment, 'Failed');
    assertStringIncludes(comment, 'XSS risk');
  });
});
