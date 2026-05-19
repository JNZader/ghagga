/**
 * Review Queue – unit tests for the LLM fallback / provider resolution logic.
 *
 * The processReview function is an internal handler passed to BullMQ's Worker.
 * We capture it via a vi.mock factory and invoke it directly with crafted
 * JobData to verify that missing API keys degrade gracefully to
 * static-analysis-only mode instead of throwing.
 */

import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────

const { mockLogger, mockRootChildFn } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  // child() returns self so that log.child({...}).info() works
  mockLogger.child.mockReturnValue(mockLogger);
  const mockRootChildFn = vi.fn().mockReturnValue(mockLogger);
  return { mockLogger, mockRootChildFn };
});

// Capture the processor function passed to new Worker(...)
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
  logger: {
    child: (...args: unknown[]) => mockRootChildFn(...args),
  },
}));

const mockReviewPipeline = vi.fn();
const mockFormatReviewComment = vi.fn();

vi.mock('ghagga-core', () => ({
  reviewPipeline: (...args: unknown[]) => mockReviewPipeline(...args),
  formatReviewComment: (...args: unknown[]) => mockFormatReviewComment(...args),
  REVIEW_COMMENT_MARKER: '<!-- ghagga-review -->',
}));

const mockDecrypt = vi.fn((v: string) => `decrypted-${v}`);
const mockSaveReview = vi.fn().mockResolvedValue(undefined);
const mockCreateDatabaseFromEnv = vi.fn();

vi.mock('ghagga-db', () => ({
  decrypt: (v: string) => mockDecrypt(v),
  saveReview: (...args: unknown[]) => mockSaveReview(...args),
  createDatabaseFromEnv: () => mockCreateDatabaseFromEnv(),
}));

const mockGetInstallationToken = vi.fn().mockResolvedValue('ghp_mock-token');
const mockFetchPRDiff = vi.fn().mockResolvedValue('diff content');
const mockGetPRCommitMessages = vi.fn().mockResolvedValue(['commit 1']);
const mockGetPRFileList = vi.fn().mockResolvedValue(['file1.ts']);
const mockPostComment = vi.fn().mockResolvedValue(undefined);
const mockAddCommentReaction = vi.fn().mockResolvedValue(undefined);
const mockFindExistingComment = vi.fn().mockResolvedValue(null);
const mockUpdateComment = vi.fn().mockResolvedValue(undefined);

vi.mock('../github/client.js', () => ({
  getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
  fetchPRDiff: (...args: unknown[]) => mockFetchPRDiff(...args),
  getPRCommitMessages: (...args: unknown[]) => mockGetPRCommitMessages(...args),
  getPRFileList: (...args: unknown[]) => mockGetPRFileList(...args),
  postComment: (...args: unknown[]) => mockPostComment(...args),
  addCommentReaction: (...args: unknown[]) => mockAddCommentReaction(...args),
  findExistingComment: (...args: unknown[]) => mockFindExistingComment(...args),
  updateComment: (...args: unknown[]) => mockUpdateComment(...args),
}));

vi.mock('../github/runner.js', () => ({
  deriveCallbackSecret: vi.fn().mockReturnValue('mock-secret'),
  dispatchWorkflow: vi.fn().mockResolvedValue('cb-123'),
  injectWorkflow: vi.fn().mockResolvedValue({ sha: 'abc123', created: false }),
}));

vi.mock('../memory/postgres.js', () => ({
  PostgresMemoryStorage: vi.fn(),
}));

// ─── Import module & trigger Worker constructor to capture processor ──

import { createReviewWorker, type ReviewJobData } from './review.js';

// Call createReviewWorker so the Worker constructor mock captures the processor
createReviewWorker(1);

// ─── Helpers ────────────────────────────────────────────────────

function makeJobData(overrides: Partial<ReviewJobData> = {}): ReviewJobData {
  return {
    reviewId: 'rev-001',
    installationId: 12345,
    repoFullName: 'acme/my-app',
    prNumber: 42,
    repositoryId: 1,
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
    ...overrides,
  };
}

function makeFakeJob(data: ReviewJobData): Job<ReviewJobData> {
  return {
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<ReviewJobData>;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('processReview – LLM fallback to static-analysis-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = 'test-app-id';
    process.env.GITHUB_PRIVATE_KEY = 'test-private-key';
    // Ensure no LLM API key is set
    delete process.env.OPENAI_API_KEY;

    mockCreateDatabaseFromEnv.mockReturnValue({});
    mockReviewPipeline.mockResolvedValue({
      status: 'completed',
      summary: 'Static analysis only',
      findings: [],
      metadata: {
        mode: 'full',
        provider: undefined,
        model: undefined,
        tokensUsed: 0,
        executionTimeMs: 100,
      },
    });
    mockFormatReviewComment.mockReturnValue('Review comment body');
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('captured the processor from Worker constructor', () => {
    expect(capturedProcessor).toBeDefined();
    expect(typeof capturedProcessor).toBe('function');
  });

  it('does NOT throw when no API key is configured — falls back gracefully', async () => {
    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: undefined,
    });
    const job = makeFakeJob(data);

    // Should NOT throw
    await expect(capturedProcessor?.(job)).resolves.toEqual({
      success: true,
      reviewId: 'rev-001',
    });
  });

  it('logs a warning about missing API key', async () => {
    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: undefined,
    });
    const job = makeFakeJob(data);

    await capturedProcessor?.(job);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { provider: 'openai' },
      expect.stringContaining('No API key configured for provider openai'),
    );
  });

  it('logs info about AI review being disabled', async () => {
    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: undefined,
    });
    const job = makeFakeJob(data);

    await capturedProcessor?.(job);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'No LLM provider available — AI review disabled, static analysis only',
    );
  });

  it('passes aiReviewEnabled: false to reviewPipeline when no provider available', async () => {
    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: undefined,
      aiReviewEnabled: true, // explicitly true in job data
    });
    const job = makeFakeJob(data);

    await capturedProcessor?.(job);

    expect(mockReviewPipeline).toHaveBeenCalledOnce();
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.aiReviewEnabled).toBe(false);
    expect(input.provider).toBeUndefined();
    expect(input.apiKey).toBeUndefined();
  });

  it('passes aiReviewEnabled: true when env API key IS available', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: undefined,
    });
    const job = makeFakeJob(data);

    await capturedProcessor?.(job);

    expect(mockReviewPipeline).toHaveBeenCalledOnce();
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.aiReviewEnabled).toBe(true);
    // Legacy 'openai' is normalized to 'gateway' before reaching the pipeline.
    expect(input.provider).toBe('gateway');
    expect(input.apiKey).toBe('sk-test-key');
  });

  it('passes aiReviewEnabled: true when encrypted per-repo key is provided', async () => {
    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: 'encrypted-key-123',
      providerChain: undefined,
    });
    const job = makeFakeJob(data);

    await capturedProcessor?.(job);

    expect(mockReviewPipeline).toHaveBeenCalledOnce();
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.aiReviewEnabled).toBe(true);
    // Legacy 'openai' is normalized to 'gateway' before reaching the pipeline.
    expect(input.provider).toBe('gateway');
    expect(input.apiKey).toBe('decrypted-encrypted-key-123');
  });

  it('passes aiReviewEnabled: true when providerChain is available', async () => {
    const data = makeJobData({
      providerChain: [{ provider: 'openai', model: 'gpt-4o', encryptedApiKey: 'enc-key' }],
    });
    const job = makeFakeJob(data);

    await capturedProcessor?.(job);

    expect(mockReviewPipeline).toHaveBeenCalledOnce();
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.aiReviewEnabled).toBe(true);
    expect(input.providerChain).toBeDefined();
    expect(input.providerChain).toHaveLength(1);
  });

  it('does NOT set aiReviewEnabled when user explicitly disabled it, even with provider', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: undefined,
      aiReviewEnabled: false,
    });
    const job = makeFakeJob(data);

    await capturedProcessor?.(job);

    expect(mockReviewPipeline).toHaveBeenCalledOnce();
    const input = mockReviewPipeline.mock.calls[0][0];
    // false && true = false
    expect(input.aiReviewEnabled).toBe(false);
  });
});
