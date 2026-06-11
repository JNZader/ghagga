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
const mockGetRepositoryById = vi.fn();
const mockGetEffectiveRepoSettings = vi.fn();

vi.mock('ghagga-db', () => ({
  decrypt: (v: string) => mockDecrypt(v),
  saveReview: (...args: unknown[]) => mockSaveReview(...args),
  createDatabaseFromEnv: () => mockCreateDatabaseFromEnv(),
  getRepositoryById: (...args: unknown[]) => mockGetRepositoryById(...args),
  getEffectiveRepoSettings: (...args: unknown[]) => mockGetEffectiveRepoSettings(...args),
  eq: vi.fn(),
  repositories: {},
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

const mockPostgresMemoryStorage = vi.hoisted(() => vi.fn());
vi.mock('../memory/postgres.js', () => ({
  PostgresMemoryStorage: mockPostgresMemoryStorage,
}));

// ─── Import module & trigger Worker constructor to capture processor ──

import { createReviewWorker, type ReviewJobData, revalidateGatewayChain } from './review.js';

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
    // Default DB re-fetch: repo exists but has no key / empty chain → forces the
    // worker down the no-key static-analysis-only fallback unless a test overrides.
    mockGetRepositoryById.mockResolvedValue({ id: 1, encryptedApiKey: null });
    mockGetEffectiveRepoSettings.mockResolvedValue({ providerChain: [] });
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

  // ── Decrypt failure degradation (Sprint 2) ──

  describe('decrypt failure degradation', () => {
    afterEach(() => {
      // Restore the default decrypt implementation — vi.clearAllMocks()
      // clears call history but NOT implementations set in these tests.
      mockDecrypt.mockImplementation((v: string) => `decrypted-${v}`);
    });

  it('skips a chain entry whose encryptedApiKey fails to decrypt, keeps the rest', async () => {
    mockDecrypt.mockImplementation((v: string) => {
      if (v === 'garbage-key') throw new Error('Unsupported state or unable to authenticate data');
      return `decrypted-${v}`;
    });

    const data = makeJobData({
      providerChain: [
        { provider: 'openai', model: 'gpt-4o', encryptedApiKey: 'garbage-key' },
        { provider: 'gateway', model: 'auto', encryptedApiKey: 'good-key' },
      ],
    });
    const job = makeFakeJob(data);

    await expect(capturedProcessor?.(job)).resolves.toEqual({
      success: true,
      reviewId: 'rev-001',
    });

    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.providerChain).toHaveLength(1);
    expect(input.providerChain[0].provider).toBe('gateway');
    expect(input.providerChain[0].apiKey).toBe('decrypted-good-key');

    // Warning mentions only the provider name — never the encrypted value
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { provider: 'openai' },
      expect.stringContaining('credential decryption failed'),
    );
    const warnPayloads = mockLogger.warn.mock.calls.map((c) => JSON.stringify(c));
    for (const payload of warnPayloads) {
      expect(payload).not.toContain('garbage-key');
    }
  });

  it('degrades to the no-key fallback when ALL chain entries fail to decrypt', async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error('bad decrypt');
    });

    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: [{ provider: 'openai', model: 'gpt-4o', encryptedApiKey: 'corrupt-1' }],
    });
    const job = makeFakeJob(data);

    await expect(capturedProcessor?.(job)).resolves.toEqual({
      success: true,
      reviewId: 'rev-001',
    });

    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.providerChain).toBeUndefined();
    expect(input.aiReviewEnabled).toBe(false);
  });

  it('treats a corrupt legacy encryptedApiKey as absent (static-analysis fallback)', async () => {
    mockDecrypt.mockImplementation(() => {
      throw new Error('bad decrypt');
    });

    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: 'corrupt-legacy-key',
      providerChain: undefined,
    });
    const job = makeFakeJob(data);

    await expect(capturedProcessor?.(job)).resolves.toEqual({
      success: true,
      reviewId: 'rev-001',
    });

    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.aiReviewEnabled).toBe(false);
    expect(input.apiKey).toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { provider: 'openai' },
      expect.stringContaining('credential decryption failed'),
    );
    const warnPayloads = mockLogger.warn.mock.calls.map((c) => JSON.stringify(c));
    for (const payload of warnPayloads) {
      expect(payload).not.toContain('corrupt-legacy-key');
    }
  });
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

// ─── Credential re-fetch (secrets out of the Redis payload) ─────────

describe('processReview – encrypted credentials re-fetched from DB, not the job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = 'test-app-id';
    process.env.GITHUB_PRIVATE_KEY = 'test-private-key';
    delete process.env.OPENAI_API_KEY;

    mockCreateDatabaseFromEnv.mockReturnValue({});
    mockReviewPipeline.mockResolvedValue({
      status: 'completed',
      summary: 'ok',
      findings: [],
      metadata: { mode: 'full', tokensUsed: 0, executionTimeMs: 1 },
    });
    mockFormatReviewComment.mockReturnValue('Review comment body');
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('re-fetches the provider chain from the DB by repositoryId and resolves the same providers', async () => {
    // Job carries NO secrets — only the repositoryId identifier.
    mockGetRepositoryById.mockResolvedValue({ id: 7, encryptedApiKey: null });
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [{ provider: 'gateway', model: 'claude-sonnet-4', encryptedApiKey: 'enc-db' }],
    });

    const data = makeJobData({
      repositoryId: 7,
      encryptedApiKey: undefined,
      providerChain: undefined,
    });
    await capturedProcessor?.(makeFakeJob(data));

    // DB lookup happened with the job's repositoryId.
    expect(mockGetRepositoryById).toHaveBeenCalledWith(expect.anything(), 7);
    expect(mockGetEffectiveRepoSettings).toHaveBeenCalledOnce();

    // The freshly-fetched chain reached the pipeline, decrypted.
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.providerChain).toHaveLength(1);
    expect(input.providerChain[0].provider).toBe('gateway');
    expect(input.providerChain[0].apiKey).toBe('decrypted-enc-db');
    expect(mockDecrypt).toHaveBeenCalledWith('enc-db');
  });

  it('re-fetches the legacy single key from the DB when no chain exists', async () => {
    mockGetRepositoryById.mockResolvedValue({ id: 7, encryptedApiKey: 'enc-legacy' });
    mockGetEffectiveRepoSettings.mockResolvedValue({ providerChain: [] });

    const data = makeJobData({
      repositoryId: 7,
      llmProvider: 'openai',
      encryptedApiKey: undefined,
      providerChain: undefined,
    });
    await capturedProcessor?.(makeFakeJob(data));

    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.apiKey).toBe('decrypted-enc-legacy');
    expect(input.aiReviewEnabled).toBe(true);
  });

  it('degrades gracefully (static-only, no crash) when settings were deleted between enqueue and process', async () => {
    // Repo removed (installation uninstalled / repo deleted) → null lookup.
    mockGetRepositoryById.mockResolvedValue(null);

    const data = makeJobData({
      repositoryId: 999,
      encryptedApiKey: undefined,
      providerChain: undefined,
    });

    await expect(capturedProcessor?.(makeFakeJob(data))).resolves.toEqual({
      success: true,
      reviewId: 'rev-001',
    });

    // No provider available → AI review disabled, static analysis only.
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.aiReviewEnabled).toBe(false);
    expect(input.providerChain).toBeUndefined();
    // getEffectiveRepoSettings is never reached when the repo is gone.
    expect(mockGetEffectiveRepoSettings).not.toHaveBeenCalled();
  });

  it('degrades gracefully when the DB throws while resolving credentials', async () => {
    mockGetRepositoryById.mockRejectedValue(new Error('db down'));

    const data = makeJobData({
      repositoryId: 5,
      encryptedApiKey: undefined,
      providerChain: undefined,
    });

    await expect(capturedProcessor?.(makeFakeJob(data))).resolves.toEqual({
      success: true,
      reviewId: 'rev-001',
    });
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.aiReviewEnabled).toBe(false);
  });

  it('FF-2: reuses ONE db handle for credential re-fetch AND memory storage (no second pool)', async () => {
    // Sentinel db instance — every createDatabaseFromEnv() in this test returns
    // THIS same object, so we can assert the SAME instance is threaded into both
    // the credential resolver (getRepositoryById) and the memory adapter.
    const dbHandle = { __sentinel: 'single-pool' };
    mockCreateDatabaseFromEnv.mockReturnValue(dbHandle);
    mockGetRepositoryById.mockResolvedValue({ id: 7, encryptedApiKey: null });
    mockGetEffectiveRepoSettings.mockResolvedValue({ providerChain: [] });

    const data = makeJobData({
      repositoryId: 7,
      encryptedApiKey: undefined,
      providerChain: undefined,
      settings: {
        enableSemgrep: false,
        enableTrivy: false,
        enableCpd: false,
        enableMemory: true, // construct PostgresMemoryStorage
        customRules: [],
        ignorePatterns: [],
        reviewLevel: 'standard',
      },
    });
    await capturedProcessor?.(makeFakeJob(data));

    // Credential resolver received the shared handle...
    expect(mockGetRepositoryById).toHaveBeenCalledWith(dbHandle, 7);
    // ...and the memory adapter was constructed with the SAME instance.
    expect(mockPostgresMemoryStorage).toHaveBeenCalledWith(dbHandle, 12345);
    // The resolver no longer mints its own pool: createDatabaseFromEnv is invoked
    // ONCE for the credential+memory concern (the single top-of-job handle).
    // saveReview() reuses its own call later, so we assert the resolver+memory
    // pair never triggered an EXTRA mint beyond the shared handle by checking the
    // identity threading above rather than a brittle global count.
    expect(mockGetRepositoryById.mock.calls[0][0]).toBe(
      mockPostgresMemoryStorage.mock.calls[0][0],
    );
  });

  it('TOLERANCE: old-format in-flight job with encryptedApiKey still works without a DB re-fetch', async () => {
    const data = makeJobData({
      llmProvider: 'openai',
      repositoryId: 7,
      encryptedApiKey: 'old-inflight-key', // old shape still carries the secret
      providerChain: undefined,
    });
    await capturedProcessor?.(makeFakeJob(data));

    // Tolerance path: payload secret is honoured, DB is NOT consulted.
    expect(mockGetRepositoryById).not.toHaveBeenCalled();
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.apiKey).toBe('decrypted-old-inflight-key');
  });

  it('TOLERANCE: old-format in-flight job with providerChain still works without a DB re-fetch', async () => {
    const data = makeJobData({
      providerChain: [{ provider: 'gateway', model: 'm', encryptedApiKey: 'old-chain-key' }],
      repositoryId: 7,
      encryptedApiKey: null,
    });
    await capturedProcessor?.(makeFakeJob(data));

    expect(mockGetRepositoryById).not.toHaveBeenCalled();
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.providerChain).toHaveLength(1);
    expect(input.providerChain[0].apiKey).toBe('decrypted-old-chain-key');
  });
});

// ─── SSRF re-validation at execution time (DNS-rebinding TOCTOU) ──

describe('revalidateGatewayChain', () => {
  const log = { warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY;
  });

  it('drops a gateway entry whose URL now resolves to a metadata/private IP', async () => {
    const chain = [
      { provider: 'gateway', gatewayUrl: 'http://169.254.169.254/', model: 'auto' },
      { provider: 'gateway', gatewayUrl: 'https://8.8.8.8/', model: 'auto' },
      { provider: 'cli-bridge', model: 'opencode' },
    ];

    const result = await revalidateGatewayChain(chain, log);

    // Metadata entry dropped; public gateway + non-gateway entries kept.
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.gatewayUrl)).toEqual(['https://8.8.8.8/', undefined]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('never echoes the rejected URL in the warning payload', async () => {
    const secretUrl = 'http://10.0.0.7:6379/secret-internal-path';
    await revalidateGatewayChain([{ provider: 'gateway', gatewayUrl: secretUrl, model: 'auto' }], log);

    const payloads = log.warn.mock.calls.map((c) => JSON.stringify(c));
    for (const p of payloads) {
      expect(p).not.toContain('secret-internal-path');
      expect(p).not.toContain('10.0.0.7');
    }
  });

  it('keeps a gateway entry pointing at a public IP literal', async () => {
    const result = await revalidateGatewayChain(
      [{ provider: 'gateway', gatewayUrl: 'https://8.8.8.8/v1', model: 'auto' }],
      log,
    );
    expect(result).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('leaves non-gateway entries untouched (no URL to validate)', async () => {
    const chain = [{ provider: 'cli-bridge', model: 'opencode' }];
    const result = await revalidateGatewayChain(chain, log);
    expect(result).toEqual(chain);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
