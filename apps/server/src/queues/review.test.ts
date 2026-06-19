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

// safe-url's validateOutboundUrl resolves hostnames via node:dns/promises.
// IP-literal cases never touch DNS, but the hostname (DNS-rebinding) cases
// below need a controllable resolver so no real DNS traffic happens.
const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: (...args: unknown[]) => mockRootChildFn(...args),
  },
}));

const mockReviewPipeline = vi.fn();
const mockFormatReviewComment = vi.fn();
const mockFetchGatewayModels = vi.fn();
const mockFetchGatewayProviders = vi.fn();

vi.mock('ghagga-core', async (importOriginal) => {
  // Keep the REAL validateProviderChain (pure) so the wiring is tested for
  // real; stub the network fetchers so tests control discovery results.
  const actual = await importOriginal<typeof import('ghagga-core')>();
  return {
    reviewPipeline: (...args: unknown[]) => mockReviewPipeline(...args),
    formatReviewComment: (...args: unknown[]) => mockFormatReviewComment(...args),
    REVIEW_COMMENT_MARKER: '<!-- ghagga-review -->',
    validateProviderChain: actual.validateProviderChain,
    fetchGatewayModels: (...args: unknown[]) => mockFetchGatewayModels(...args),
    fetchGatewayProviders: (...args: unknown[]) => mockFetchGatewayProviders(...args),
  };
});

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
// Returns the realistic GitHub-native shape `{ id }` (matches client.postComment's
// declared `Promise<{ id: number }>` contract). The forge adapter consumes
// `posted.id` to build its UpsertSummaryResult, so an `undefined` return — a
// mock-fidelity gap, not a behavior change — would crash the adapter.
const mockPostComment = vi.fn().mockResolvedValue({ id: 2002 });
const mockAddCommentReaction = vi.fn().mockResolvedValue(undefined);
const mockFindExistingComment = vi.fn().mockResolvedValue(null);
const mockUpdateComment = vi.fn().mockResolvedValue(undefined);
// deleteComment is invoked by the adapter's upsertSummaryComment ONLY when
// findExistingComment returns a non-null result. mockFindExistingComment returns
// null here, so the delete loop never runs today — but omitting the mock would
// crash any future test that returns a non-null existing comment with
// `githubClient.deleteComment is not a function`. Mirror the baseline mock's
// completeness so the client port is fully satisfied. (Same rationale for
// fetchGraphFromBranch, reached only when blast-radius is enabled.)
const mockDeleteComment = vi.fn().mockResolvedValue(undefined);
const mockFetchGraphFromBranch = vi.fn().mockResolvedValue(null);

vi.mock('../github/client.js', () => ({
  getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
  fetchPRDiff: (...args: unknown[]) => mockFetchPRDiff(...args),
  getPRCommitMessages: (...args: unknown[]) => mockGetPRCommitMessages(...args),
  getPRFileList: (...args: unknown[]) => mockGetPRFileList(...args),
  postComment: (...args: unknown[]) => mockPostComment(...args),
  addCommentReaction: (...args: unknown[]) => mockAddCommentReaction(...args),
  findExistingComment: (...args: unknown[]) => mockFindExistingComment(...args),
  deleteComment: (...args: unknown[]) => mockDeleteComment(...args),
  updateComment: (...args: unknown[]) => mockUpdateComment(...args),
  fetchGraphFromBranch: (...args: unknown[]) => mockFetchGraphFromBranch(...args),
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

import {
  createReviewWorker,
  type ReviewJobData,
  revalidateGatewayChain,
  validateChainAgainstBridge,
} from './review.js';

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
        if (v === 'garbage-key')
          throw new Error('Unsupported state or unable to authenticate data');
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

  // ── All-dropped visibility (SSRF re-validation) ──
  // When a non-empty chain is fully emptied by SSRF re-validation, the worker
  // degrades to the no-key path. That degradation is intentional, but it must
  // be VISIBLE so an operator can tell it apart from "no AI key configured".
  it('logs an explicit warning when SSRF re-validation drops the ENTIRE chain', async () => {
    // Both gateway URLs resolve (by hostname) to a private/metadata address →
    // validateOutboundUrl rejects both → revalidateGatewayChain returns [].
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    const data = makeJobData({
      llmProvider: 'openai',
      encryptedApiKey: null,
      providerChain: [
        {
          provider: 'gateway',
          model: 'auto',
          encryptedApiKey: null,
          gatewayUrl: 'https://rebind-a.example/',
        },
        {
          provider: 'gateway',
          model: 'auto',
          encryptedApiKey: null,
          gatewayUrl: 'https://rebind-b.example/',
        },
      ] as ReviewJobData['providerChain'],
    });
    const job = makeFakeJob(data);

    await expect(capturedProcessor?.(job)).resolves.toEqual({
      success: true,
      reviewId: 'rev-001',
    });

    // The explicit all-dropped visibility warning fired with the entry count.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { entriesIn: 2 },
      expect.stringContaining('All provider chain entries dropped by SSRF re-validation'),
    );

    // Degradation semantics preserved: no provider reaches the pipeline.
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.providerChain).toBeUndefined();
    expect(input.aiReviewEnabled).toBe(false);

    // No-echo invariant holds across the whole degradation path.
    const warnPayloads = mockLogger.warn.mock.calls.map((c) => JSON.stringify(c));
    for (const payload of warnPayloads) {
      expect(payload).not.toContain('rebind-a.example');
      expect(payload).not.toContain('rebind-b.example');
    }
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
    expect(mockGetRepositoryById.mock.calls[0][0]).toBe(mockPostgresMemoryStorage.mock.calls[0][0]);
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
    await revalidateGatewayChain(
      [{ provider: 'gateway', gatewayUrl: secretUrl, model: 'auto' }],
      log,
    );

    const payloads = log.warn.mock.calls.map((c) => JSON.stringify(c));
    for (const p of payloads) {
      expect(p).not.toContain('secret-internal-path');
      expect(p).not.toContain('10.0.0.7');
    }
  });

  it('keeps a gateway entry pointing at a public IP literal', async () => {
    const chain = [{ provider: 'gateway', gatewayUrl: 'https://8.8.8.8/v1', model: 'auto' }];
    const result = await revalidateGatewayChain(chain, log);
    // Object integrity: the kept entry is returned untouched, not just counted.
    expect(result).toEqual(chain);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('leaves non-gateway entries untouched (no URL to validate)', async () => {
    const chain = [{ provider: 'cli-bridge', model: 'opencode' }];
    const result = await revalidateGatewayChain(chain, log);
    expect(result).toEqual(chain);
    expect(log.warn).not.toHaveBeenCalled();
  });

  // ─── per-entry bypass: gatewayUrl on a non-gateway provider ─────
  // The runtime mapping loop assigns `entry.gatewayUrl` onto the provider chain
  // unconditionally (regardless of provider). A non-gateway entry that still
  // carries a gatewayUrl (legacy/tampered DB row) must NOT skip the SSRF guard.

  it('drops a NON-gateway entry whose gatewayUrl resolves to a private/loopback IP', async () => {
    const chain = [
      // provider !== 'gateway' but a gatewayUrl is present — must still be validated.
      { provider: 'cli-bridge', gatewayUrl: 'http://127.0.0.1:6379/', model: 'opencode' },
      { provider: 'gateway', gatewayUrl: 'https://8.8.8.8/', model: 'auto' },
    ];

    const result = await revalidateGatewayChain(chain, log);

    // Loopback entry dropped despite its non-gateway provider; public one kept.
    expect(result).toHaveLength(1);
    expect(result.map((e) => e.provider)).toEqual(['gateway']);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('keeps a NON-gateway entry whose gatewayUrl points at a public IP', async () => {
    const chain = [{ provider: 'ollama', gatewayUrl: 'https://8.8.8.8/v1', model: 'llama3' }];
    const result = await revalidateGatewayChain(chain, log);
    expect(result).toEqual(chain);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never echoes the rejected URL of a non-gateway entry', async () => {
    const secretUrl = 'http://192.168.1.42:8080/internal-admin';
    await revalidateGatewayChain(
      [{ provider: 'cli-bridge', gatewayUrl: secretUrl, model: 'opencode' }],
      log,
    );

    const payloads = log.warn.mock.calls.map((c) => JSON.stringify(c));
    for (const p of payloads) {
      expect(p).not.toContain('internal-admin');
      expect(p).not.toContain('192.168.1.42');
    }
  });

  // ─── all-dropped (function-level) ───────────────────────────────
  // When EVERY entry of a non-empty chain fails re-validation, the pure
  // function returns []. (The "AI review may degrade to static-only"
  // visibility warning lives at the call-site in processReview — see the
  // SSRF re-validation all-dropped test in the processReview describe.)
  it('returns [] and warns per entry when ALL entries fail re-validation', async () => {
    const chain = [
      { provider: 'gateway', gatewayUrl: 'http://169.254.169.254/', model: 'auto' },
      { provider: 'cli-bridge', gatewayUrl: 'http://127.0.0.1:6379/', model: 'opencode' },
    ];

    const result = await revalidateGatewayChain(chain, log);

    expect(result).toEqual([]);
    // One drop warning per invalid entry.
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  // ─── no-echo with a DNS-based (hostname) rejection ──────────────
  // The IP-literal no-echo tests above never hit DNS. This exercises the
  // hostname → private-IP rebind path: the attacker hostname must NOT appear
  // in the logged reason (safe-url returns a generic reason with no host).
  it('never echoes the attacker HOSTNAME on a DNS-rebind rejection', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.7', family: 4 }]);
    const attackerHost = 'rebind-attacker.internal.example';

    await revalidateGatewayChain(
      [{ provider: 'gateway', gatewayUrl: `https://${attackerHost}/v1`, model: 'auto' }],
      log,
    );

    expect(log.warn).toHaveBeenCalledOnce();
    const payloads = log.warn.mock.calls.map((c) => JSON.stringify(c));
    for (const p of payloads) {
      expect(p).not.toContain(attackerHost);
      expect(p).not.toContain('10.0.0.7');
    }
  });
});

describe('validateChainAgainstBridge', () => {
  const log = { warn: vi.fn() };
  const GW = 'https://gw.example.com';

  beforeEach(() => {
    log.warn.mockClear();
    mockFetchGatewayModels.mockReset();
    mockFetchGatewayProviders.mockReset();
  });

  it('drops entries the bridge cannot serve and keeps the valid ones', async () => {
    mockFetchGatewayModels.mockResolvedValue([{ id: 'gpt-5.5', provider: 'codex-cli' }]);
    mockFetchGatewayProviders.mockResolvedValue([
      { id: 'codex-cli', name: 'Codex', type: 'cli', available: true },
    ]);
    const result = await validateChainAgainstBridge(
      [
        {
          provider: 'gateway',
          model: 'gpt-5.5',
          apiKey: 'tok',
          gatewayUrl: GW,
          targetProvider: 'codex-cli',
        },
        {
          provider: 'gateway',
          model: 'ghost-model',
          apiKey: 'tok',
          gatewayUrl: GW,
          targetProvider: 'codex-cli',
        },
      ],
      log,
    );
    expect(result.map((e) => e.model)).toEqual(['gpt-5.5']);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('fails OPEN when discovery throws (chain untouched)', async () => {
    mockFetchGatewayModels.mockRejectedValue(new Error('bridge down'));
    mockFetchGatewayProviders.mockResolvedValue([]);
    const chain = [
      {
        provider: 'gateway' as const,
        model: 'gpt-5.5',
        apiKey: 'tok',
        gatewayUrl: GW,
        targetProvider: 'codex-cli',
      },
    ];
    const result = await validateChainAgainstBridge(chain, log);
    expect(result).toEqual(chain);
  });

  it('returns the chain unchanged when there is no gateway entry (no discovery)', async () => {
    const chain = [{ provider: 'cli-bridge' as const, model: 'x', apiKey: '' }];
    const result = await validateChainAgainstBridge(chain, log);
    expect(result).toEqual(chain);
    expect(mockFetchGatewayModels).not.toHaveBeenCalled();
  });
});
