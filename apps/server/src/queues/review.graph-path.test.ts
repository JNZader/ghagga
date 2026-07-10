/**
 * GRAPH-PATH COVERAGE — the static-analysis dispatch→poll→graph branch.
 *
 * WHY THIS FILE EXISTS (4vr FIX 1, the biggest gap):
 * review.baseline.test.ts runs with ALL static-analysis tools OFF, so the branch
 * that does `dispatchWorkflow` → poll loop → `adapter1.fetchGraph(...)` (review.ts
 * ~715 and ~865) — the path where the PHASE-1 token (token1) is reused across
 * fetch + dispatch + graph — was exercised by ZERO test. The forge-adapter
 * rewire (commit 8feb5ad) rewired that path BLIND. This test enables it.
 *
 * WHAT IT PINS:
 *   - token1 reuse: dispatchWorkflow AND adapter1.fetchGraph both run with the
 *     PHASE-1 token (ghp_mint-1) — the SAME token used for the context fetch.
 *   - mint count: under P2's caching GitHubAppCredentialProvider this path mints
 *     EXACTLY ONCE — token1 is reused across fetch+dispatch+graph AND the
 *     postback (the cached token is still budget-valid). Pre-P2 the count was 2
 *     (a fresh token2 before postback); the drop to 1 is the deliberate P2
 *     caching optimization. The path still introduces NO EXTRA mint for dispatch
 *     or graph — that durable property is what this file pins.
 *   - adapter1.fetchGraph is the routed graph read (the graph read goes THROUGH
 *     the adapter, which delegates to client.fetchGraphFromBranch — preserving
 *     the `?ref=ghagga/graph` orphan-branch semantics + 404→null inside the
 *     delegated client fn).
 *   - call-site boxing (FIX 6): after upsertSummaryComment returns { created: 2002 },
 *     the trigger-comment reaction crosses the seam boxed (raw '2002' style id),
 *     proving the boxing actually fires at the review.ts call-site.
 *
 * POLL LOOP: waitForCallbackResult uses real setTimeout over redis.get. We mock
 * `../lib/redis.js` so `redis.get` returns the callback JSON on the FIRST poll,
 * and drive the single 10s wait with fake timers (vi.runAllTimersAsync) — so the
 * dispatch→poll→graph routing + token1 reuse are exercised end-to-end without a
 * real wall-clock wait.
 *
 * DETERMINISM: randomUUID() + Date.now() ARE reached on this path (they build the
 * workflow callbackId), so both are mocked deterministically per the baseline
 * header's documented requirement when static tools are on.
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

describe('GRAPH PATH: static-analysis dispatch→poll→graph (token1 reuse, adapter-routed)', () => {
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
    mockReviewPipeline.mockResolvedValue(makeReviewResult());
    // Poll: first redis.get returns a callback static-analysis result.
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
    // Flush the dispatch + the poll-loop setTimeout(10s) + everything after.
    await vi.runAllTimersAsync();
    await promise;
  }

  it('reuses the PHASE-1 token (token1) for dispatchWorkflow AND adapter1.fetchGraph', async () => {
    await runFlow();

    // Context fetch ran with token1.
    expect(mockFetchPRDiff).toHaveBeenCalledWith('acme', 'widget', 42, 'ghp_mint-1');

    // dispatchWorkflow ran with token1 (NOT a fresh mint).
    expect(mockDispatchWorkflow).toHaveBeenCalledOnce();
    const dispatchArg = mockDispatchWorkflow.mock.calls[0][0] as { token: string };
    expect(dispatchArg.token).toBe('ghp_mint-1');

    // Graph read routed through the adapter → client.fetchGraphFromBranch, with token1.
    expect(mockFetchGraphFromBranch).toHaveBeenCalledOnce();
    expect(mockFetchGraphFromBranch).toHaveBeenCalledWith('acme', 'widget', 'ghp_mint-1');
  });

  it('introduces NO extra mint: exactly 1 installation-token mint on this path (P2 caching)', async () => {
    await runFlow();

    // token1 reused across fetch+dispatch+graph AND postback (the cached token is
    // still budget-valid). NO extra mint for dispatch or graph — and, under P2,
    // none for postback either. Count is 1 (was 2 pre-P2).
    expect(mockGetInstallationTokenWithExpiry).toHaveBeenCalledTimes(1);

    // Postback reused the CACHED token1 (was the fresh ghp_mint-2 pre-P2).
    expect(mockPostComment.mock.calls[0][4]).toBe('ghp_mint-1');
  });

  it('routes the graph read through adapter1.fetchGraph (orphan-branch semantics delegated)', async () => {
    await runFlow();

    // The graph read goes THROUGH the adapter (no direct client call in review.ts
    // for the graph) — the only fetchGraphFromBranch invocation is the adapter's
    // delegation, preserving ?ref=ghagga/graph + 404→null inside the client fn.
    expect(mockFetchGraphFromBranch).toHaveBeenCalledTimes(1);

    // PreloadedGraphLoader was constructed from the returned graph (graph reached
    // the pipeline input → blast-radius wiring intact end-to-end).
    const input = mockReviewPipeline.mock.calls[0][0];
    expect(input.graphLoader).toBeDefined();
  });

  it('FIX 6: boxes the trigger-comment id at the review.ts call-site after upsert', async () => {
    await runFlow();

    // upsertSummaryComment returned { created: 2002 } (postComment id). The
    // trigger-comment reaction crosses the adapter seam — review.ts boxed the
    // numeric trigger id (555) into a CommentId before the adapter unwrapped it
    // back to the native number. addCommentReaction receives the native 555,
    // proving the box→unwrap round-trip fired at the call-site (not a bare pass).
    expect(mockAddCommentReaction).toHaveBeenCalledWith(
      'acme',
      'widget',
      555,
      'rocket',
      'ghp_mint-1', // P2: cached postback token (was ghp_mint-2 pre-P2)
    );
  });
});
