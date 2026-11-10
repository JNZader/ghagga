/**
 * TOKEN-SPLIT PERSISTENCE (graph-context-retrieval T5.4).
 *
 * Sibling of review.graph-path.test.ts — same harness (static-analysis
 * dispatch→poll→graph path, all seams mocked), focused on ONE thing: the
 * server persists `metadata.inputTokensUsed`/`outputTokensUsed` into the
 * new nullable `reviews.input_tokens`/`output_tokens` columns via
 * saveReview, null-safe when the split is absent.
 *
 * See review.graph-path.test.ts's header for the full harness rationale
 * (token1 reuse, adapter-routed graph read, fake-timer poll loop).
 */
import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── node:crypto + Date.now determinism (required when static tools ON) ──

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
}));

// ─── Hoisted logger mock ────────────────────────────────────────────

const { mockRootChildFn } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  const mockRootChildFn = vi.fn().mockReturnValue(mockLogger);
  return { mockRootChildFn };
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
  logger: {
    child: (...args: unknown[]) => mockRootChildFn(...args),
  },
}));

// ─── lib/redis.js — poll resolves on first get ──────────────────────
//
// waitForCallbackResult does: setTimeout(10s) → redis.get(key). We return the
// callback payload on the first get so the poll loop resolves after a single
// (fake-timer-advanced) wait.

const mockRedisGet = vi.fn();
const mockRedisDel = vi.fn().mockResolvedValue(1);
vi.mock('../lib/redis.js', async () => {
  // Real ioredis for the BullMQ connection (lazyConnect so no socket opens at
  // import), matching the pre-change behaviour; the get/del calls stay mocked.
  const IORedis = (await import('ioredis')).default;
  return {
    redis: {
      get: (...args: unknown[]) => mockRedisGet(...args),
      del: (...args: unknown[]) => mockRedisDel(...args),
    },
    callbackResultKey: (id: string) => `ghagga:callback:${id}`,
    createRedisClient: () =>
      new IORedis({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      }),
  };
});

// ─── ghagga-core: real formatReviewComment, stubbed pipeline ────────

const mockReviewPipeline = vi.fn();

vi.mock('ghagga-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ghagga-core')>();
  return {
    ...actual,
    reviewPipeline: (...args: unknown[]) => mockReviewPipeline(...args),
  };
});

// ─── ghagga-db ──────────────────────────────────────────────────────

const mockDecrypt = vi.fn((v: string) => `decrypted-${v}`);
const mockSaveReview = vi.fn().mockResolvedValue(undefined);
const mockCreateDatabaseFromEnv = vi.fn();
const mockGetRepositoryById = vi.fn();
const mockGetEffectiveRepoSettings = vi.fn();

// The static-analysis branch reads workflowSha via a drizzle select chain.
// Return a NON-null sha so the worker SKIPS injectWorkflow and goes straight to
// dispatchWorkflow (keeps the path focused on dispatch→poll→graph).
const mockDbSelectChain = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([{ workflowSha: 'existing-sha' }]),
};

vi.mock('ghagga-db', () => ({
  decrypt: (v: string) => mockDecrypt(v),
  saveReview: (...args: unknown[]) => mockSaveReview(...args),
  createDatabaseFromEnv: () => mockCreateDatabaseFromEnv(),
  getRepositoryById: (...args: unknown[]) => mockGetRepositoryById(...args),
  getEffectiveRepoSettings: (...args: unknown[]) => mockGetEffectiveRepoSettings(...args),
  eq: vi.fn(),
  repositories: {},
}));

// ─── GitHub client mock (records tokens for token1-reuse assertions) ──

let tokenSeq = 0;
// P2: worker mints via getInstallationTokenWithExpiry; the credential provider
// TTL-caches. Far-future expiry → the phase-1 token is reused for postback (no
// second mint). Each callLog entry = one ACTUAL upstream mint.
const mockGetInstallationTokenWithExpiry = vi.fn(async () => {
  tokenSeq += 1;
  return { token: `ghp_mint-${tokenSeq}`, expiresAtMs: Date.now() + 60 * 60 * 1000 };
});
const mockFetchPRDiff = vi.fn().mockResolvedValue('diff content');
const mockGetPRCommitMessages = vi.fn().mockResolvedValue(['feat: x']);
const mockGetPRFileList = vi.fn().mockResolvedValue(['src/app.ts']);
const mockPostComment = vi.fn().mockResolvedValue({ id: 2002 });
const mockAddCommentReaction = vi.fn().mockResolvedValue(undefined);
const mockFindExistingComment = vi.fn().mockResolvedValue(null);
const mockDeleteComment = vi.fn().mockResolvedValue(undefined);
const mockUpdateComment = vi.fn().mockResolvedValue(undefined);
// The graph read routes review.ts → adapter1.fetchGraph → client.fetchGraphFromBranch.
// Return a representative graph so PreloadedGraphLoader is constructed.
const mockFetchGraphFromBranch = vi.fn().mockResolvedValue({
  nodes: { 'src/app.ts': { dependencies: [], dependents: [] } },
});

vi.mock('../github/client.js', () => ({
  getInstallationTokenWithExpiry: (...args: unknown[]) =>
    mockGetInstallationTokenWithExpiry(...args),
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

// ─── runner.js: records the token dispatchWorkflow was called with ──

const mockDispatchWorkflow = vi.fn().mockResolvedValue('cb-ok');
const mockInjectWorkflow = vi.fn().mockResolvedValue({ sha: 'abc', created: false });
vi.mock('../github/runner.js', () => ({
  deriveCallbackSecret: vi.fn().mockReturnValue('mock-secret'),
  dispatchWorkflow: (...args: unknown[]) => mockDispatchWorkflow(...args),
  injectWorkflow: (...args: unknown[]) => mockInjectWorkflow(...args),
}));

const mockPostgresMemoryStorage = vi.hoisted(() => vi.fn());
vi.mock('../memory/postgres.js', () => ({
  PostgresMemoryStorage: mockPostgresMemoryStorage,
}));

// ─── Import module & capture processor ──────────────────────────────

import { createReviewWorker, type ReviewJobData } from './review.js';

createReviewWorker(1);

function makeJobData(overrides: Partial<ReviewJobData> = {}): ReviewJobData {
  return {
    reviewId: 'graph-rev-0001',
    installationId: 7777,
    repoFullName: 'acme/widget',
    prNumber: 42,
    repositoryId: 1,
    triggerCommentId: 555,
    prAuthor: 'octocat',
    headSha: 'head-sha',
    baseBranch: 'main',
    llmProvider: 'gateway',
    llmModel: 'claude-sonnet-4',
    reviewMode: 'full',
    encryptedApiKey: 'enc-key',
    settings: {
      // STATIC ANALYSIS ON → drives anyToolEnabled → dispatchWorkflow + poll.
      enableSemgrep: true,
      enableTrivy: false,
      enableCpd: false,
      enableMemory: false,
      customRules: [],
      ignorePatterns: [],
      reviewLevel: 'standard',
      // BLAST RADIUS ON → drives adapter1.fetchGraph(repoRef).
      enableBlastRadius: true,
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

function makeReviewResult() {
  return {
    status: 'NEEDS_HUMAN_REVIEW' as const,
    summary: 'graph path',
    findings: [],
    metadata: {
      mode: 'full',
      provider: 'gateway',
      model: 'claude-sonnet-4',
      tokensUsed: 100,
      executionTimeMs: 10,
      toolsRun: [],
      toolsSkipped: [],
      fileList: ['src/app.ts'],
    },
  };
}

describe('TOKEN SPLIT: server persists measured input/output columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tokenSeq = 0;
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_PRIVATE_KEY = 'priv-key';

    mockCreateDatabaseFromEnv.mockReturnValue(mockDbSelectChain);
    mockGetRepositoryById.mockResolvedValue({ id: 1, encryptedApiKey: 'enc-key' });
    mockGetEffectiveRepoSettings.mockResolvedValue({ providerChain: [] });
    mockDecrypt.mockImplementation((v: string) => `decrypted-${v}`);
    mockRedisGet.mockResolvedValue(JSON.stringify({ semgrep: { findings: [] } }));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY;
  });

  /** Run the processor, advancing fake timers so the single poll wait resolves. */
  async function runFlow(data = makeJobData()): Promise<void> {
    const promise = capturedProcessor?.(makeFakeJob(data));
    await vi.runAllTimersAsync();
    await promise;
  }

  it('persists the full split alongside tokens_used', async () => {
    mockReviewPipeline.mockResolvedValue({
      ...makeReviewResult(),
      metadata: {
        ...makeReviewResult().metadata,
        tokensUsed: 10_000,
        inputTokensUsed: 7_000,
        outputTokensUsed: 3_000,
      },
    });
    await runFlow();

    expect(mockSaveReview).toHaveBeenCalledTimes(1);
    const saved = mockSaveReview.mock.calls[0][1] as Record<string, unknown>;
    expect(saved.tokensUsed).toBe(10_000);
    expect(saved.inputTokens).toBe(7_000);
    expect(saved.outputTokens).toBe(3_000);
  });

  it('missing split → columns omitted (NULL), save still succeeds', async () => {
    mockReviewPipeline.mockResolvedValue(makeReviewResult()); // no split fields
    await runFlow();

    expect(mockSaveReview).toHaveBeenCalledTimes(1);
    const saved = mockSaveReview.mock.calls[0][1] as Record<string, unknown>;
    expect(saved.tokensUsed).toBe(100);
    expect(saved).not.toHaveProperty('inputTokens');
    expect(saved).not.toHaveProperty('outputTokens');
  });
});
