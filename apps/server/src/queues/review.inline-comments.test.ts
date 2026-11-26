/**
 * Inline comments are posted only for critical and high findings, each with
 * a collapsed verification section and an agent prompt. The summary comment
 * is still posted, and findings that disappeared since the previous review
 * are listed in it. Medium findings stay in the summary only.
 */

import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, mockRootChildFn } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  const mockRootChildFn = vi.fn().mockReturnValue(mockLogger);
  return { mockLogger, mockRootChildFn };
});

let capturedProcessor: ((job: Job) => Promise<unknown>) | undefined;

vi.mock('bullmq', () => {
  class QueueMock {
    add = vi.fn().mockResolvedValue({});
  }
  class WorkerMock {
    on = vi.fn();
    constructor(_name: string, processor: unknown) {
      capturedProcessor = processor as typeof capturedProcessor;
    }
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

vi.mock('ioredis', () => {
  class RedisMock {}
  return { default: RedisMock };
});

vi.mock('../lib/logger.js', () => ({
  logger: { child: (...args: unknown[]) => mockRootChildFn(...args) },
}));

const mockReviewPipeline = vi.fn();

vi.mock('ghagga-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ghagga-core')>();
  return {
    ...actual,
    reviewPipeline: (...args: unknown[]) => mockReviewPipeline(...args),
  };
});

const mockGetLatestReviewFindings = vi.fn();

vi.mock('ghagga-db', () => ({
  decrypt: (value: string) => value,
  saveReview: vi.fn().mockResolvedValue(undefined),
  getLatestReviewFindings: (...args: unknown[]) => mockGetLatestReviewFindings(...args),
  createDatabaseFromEnv: () => ({}),
  getRepositoryById: vi.fn().mockResolvedValue({ id: 1, encryptedApiKey: null }),
  getEffectiveRepoSettings: vi.fn().mockResolvedValue({ providerChain: [] }),
  eq: vi.fn(),
  repositories: {},
}));

const mockPostComment = vi.fn().mockResolvedValue({ id: 2002 });
const mockListPullReviewComments = vi.fn().mockResolvedValue([]);
const mockCreatePullReviewComment = vi.fn().mockResolvedValue({ id: 3003 });

vi.mock('../github/client.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('ghp_mock-token'),
  getInstallationTokenWithExpiry: vi
    .fn()
    .mockResolvedValue({ token: 'ghp_mock-token', expiresAtMs: Date.now() + 60 * 60 * 1000 }),
  fetchPRDiff: vi.fn().mockResolvedValue('diff'),
  getPRCommitMessages: vi.fn().mockResolvedValue(['commit']),
  getPRFileList: vi.fn().mockResolvedValue(['src/a.ts']),
  postComment: (...args: unknown[]) => mockPostComment(...args),
  addCommentReaction: vi.fn().mockResolvedValue(undefined),
  findExistingComment: vi.fn().mockResolvedValue(null),
  deleteComment: vi.fn().mockResolvedValue(undefined),
  updateComment: vi.fn().mockResolvedValue(undefined),
  fetchGraphFromBranch: vi.fn().mockResolvedValue(null),
  listPullReviewComments: (...args: unknown[]) => mockListPullReviewComments(...args),
  createPullReviewComment: (...args: unknown[]) => mockCreatePullReviewComment(...args),
}));

vi.mock('../github/runner.js', () => ({
  deriveCallbackSecret: vi.fn().mockReturnValue('mock-secret'),
  dispatchWorkflow: vi.fn().mockResolvedValue('cb-123'),
  injectWorkflow: vi.fn().mockResolvedValue({ sha: 'abc123', created: false }),
}));

vi.mock('../memory/postgres.js', () => ({
  PostgresMemoryStorage: vi.fn(),
}));

import { createReviewWorker, type ReviewJobData } from './review.js';

createReviewWorker(1);

function finding(
  severity: string,
  file: string,
  line: number,
  message: string,
): Record<string, unknown> {
  return {
    severity,
    category: 'security',
    file,
    line,
    message,
    suggestion: 'Apply the smallest safe change',
    source: 'ai',
  };
}

describe('processReview inline comments and fixed findings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = 'test-app-id';
    process.env.GITHUB_PRIVATE_KEY = 'test-private-key';
    mockGetLatestReviewFindings.mockResolvedValue([
      finding('high', 'src/old.ts', 2, 'Removed unsafe call'),
    ]);
    mockReviewPipeline.mockResolvedValue({
      status: 'FAILED',
      summary: 'Two issues remain.',
      findings: [
        finding('critical', 'src/a.ts', 10, 'SQL injection'),
        finding('medium', 'src/c.ts', 1, 'Naming nit'),
        finding('high', 'src/b.ts', 4, 'Reflected XSS'),
      ],
      metadata: {
        mode: 'simple',
        provider: 'gateway',
        model: 'test-model',
        tokensUsed: 20,
        executionTimeMs: 1000,
        toolsRun: [],
        toolsSkipped: [],
      },
    });
    mockListPullReviewComments.mockResolvedValue([]);
    mockCreatePullReviewComment.mockResolvedValue({ id: 3003 });
  });

  it('posts the summary, inlines only critical and high, and lists the fixed finding', async () => {
    const data: ReviewJobData = {
      reviewId: 'rev-inline',
      installationId: 12345,
      repoFullName: 'acme/my-app',
      prNumber: 42,
      repositoryId: 1,
      headSha: 'abc1234',
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      reviewMode: 'full',
      encryptedApiKey: null,
      settings: {
        enableSemgrep: false,
        enableTrivy: false,
        enableCpd: false,
        enableMemory: false,
        customRules: [],
        ignorePatterns: [],
        reviewLevel: 'standard',
      },
    };

    await expect(
      capturedProcessor?.({
        data,
        updateProgress: vi.fn().mockResolvedValue(undefined),
      } as unknown as Job),
    ).resolves.toEqual({ success: true, reviewId: 'rev-inline' });

    expect(mockPostComment).toHaveBeenCalledOnce();
    const summary = String(mockPostComment.mock.calls[0]?.[3]);
    expect(summary).toContain('### Findings');
    expect(summary).toContain('Naming nit');
    expect(summary).toContain('### Fixed since last review (1)');
    expect(summary).toContain('src/old.ts:2');
    expect(summary).toContain('Removed unsafe call');

    expect(mockCreatePullReviewComment).toHaveBeenCalledTimes(2);
    const paths = mockCreatePullReviewComment.mock.calls.map(
      (call) => (call[3] as { path: string }).path,
    );
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    for (const call of mockCreatePullReviewComment.mock.calls) {
      const body = (call[3] as { body: string }).body;
      expect(body).toContain('<summary>How to verify</summary>');
      expect(body).toContain('<summary>Prompt for an AI agent</summary>');
      expect(body).toContain('<!-- ghagga-inline:');
    }
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Inline review comments skipped',
    );
  });
});
