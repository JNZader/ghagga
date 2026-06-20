/**
 * POSTBACK 401-RECOVERY — in-job bounded retry (P2 401-recovery FIX 3).
 *
 * Pins the regression fix: with P2 token caching, the postback reuses the cached
 * phase-1 token. If that token is REVOKED mid-job, the postback's first
 * upsertSummaryComment fails with a 401 (surfaced as a ForgeAuthError by the
 * adapter). The worker must then invalidate() the credential cache, re-mint a
 * FRESH token, rebuild the adapter, and retry the postback ONCE.
 *
 * This file mirrors review.baseline.test.ts's harness but makes postComment
 * controllable per-call so we can inject a 401 on the first attempt.
 *
 * Tests:
 *   - 401-on-postback → invalidate + re-mint + retry SUCCEEDS (2nd mint, retried).
 *   - 401-on-postback AND 401-on-retry → propagates (job fails, no infinite loop).
 *
 * Happy-path byte-identical behavior is pinned by review.baseline.test.ts — this
 * file ONLY exercises the 401 branch, which never fires on the happy path.
 */

import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted logger mock ───────────────────────────────────────────
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

const mockReviewPipeline = vi.fn();
vi.mock('ghagga-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ghagga-core')>();
  return {
    ...actual,
    reviewPipeline: (...args: unknown[]) => mockReviewPipeline(...args),
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

// ─── GitHub client mock (status-tagged 401 control on postComment) ──

/** A 401 error shaped like the real client.ts GitHubApiError (carries status). */
function authError(status = 401): Error {
  return Object.assign(new Error(`GitHub API error posting comment: ${status} Unauthorized`), {
    status,
  });
}

let tokenSeq = 0;
const mockGetInstallationTokenWithExpiry = vi.fn(async () => {
  tokenSeq += 1;
  // Far-future expiry: the provider would normally reuse the cached token; the
  // ONLY reason a second mint happens is invalidate() on the 401 path.
  return { token: `ghp_mint-${tokenSeq}`, expiresAtMs: Date.now() + 60 * 60 * 1000 };
});

// postComment is controlled per-test via this queue of behaviors.
let postCommentBehaviors: Array<'401' | 'ok'> = [];
let postCommentCalls = 0;
const postCommentTokens: string[] = [];
const mockPostComment = vi.fn(
  async (_owner: string, _repo: string, _pr: number, _body: string, token: string) => {
    const behavior = postCommentBehaviors[postCommentCalls] ?? 'ok';
    postCommentCalls += 1;
    postCommentTokens.push(token);
    if (behavior === '401') throw authError(401);
    return { id: 2002 };
  },
);

const mockFetchPRDiff = vi.fn().mockResolvedValue('diff --git a/x b/x\n+1\n');
const mockGetPRCommitMessages = vi.fn().mockResolvedValue(['feat: x']);
const mockGetPRFileList = vi.fn().mockResolvedValue(['src/app.ts']);
const mockFindExistingComment = vi.fn().mockResolvedValue(null);
const mockDeleteComment = vi.fn().mockResolvedValue(undefined);
const mockAddCommentReaction = vi.fn().mockResolvedValue(undefined);
const mockUpdateComment = vi.fn().mockResolvedValue(undefined);
const mockFetchGraphFromBranch = vi.fn().mockResolvedValue(null);

vi.mock('../github/client.js', () => ({
  getInstallationTokenWithExpiry: (...args: unknown[]) =>
    mockGetInstallationTokenWithExpiry(
      ...(args as Parameters<typeof mockGetInstallationTokenWithExpiry>),
    ),
  fetchPRDiff: (...args: unknown[]) => mockFetchPRDiff(...args),
  getPRCommitMessages: (...args: unknown[]) => mockGetPRCommitMessages(...args),
  getPRFileList: (...args: unknown[]) => mockGetPRFileList(...args),
  findExistingComment: (...args: unknown[]) => mockFindExistingComment(...args),
  deleteComment: (...args: unknown[]) => mockDeleteComment(...args),
  postComment: (...args: unknown[]) =>
    mockPostComment(...(args as Parameters<typeof mockPostComment>)),
  addCommentReaction: (...args: unknown[]) => mockAddCommentReaction(...args),
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

import { createReviewWorker, type ReviewJobData } from './review.js';

createReviewWorker(1);

function makeJobData(): ReviewJobData {
  return {
    reviewId: 'auth-retry-rev-0001',
    installationId: 7777,
    repoFullName: 'acme/widget',
    prNumber: 42,
    repositoryId: 1,
    triggerCommentId: 555,
    prAuthor: 'octocat',
    llmProvider: 'gateway',
    llmModel: 'claude-sonnet-4',
    reviewMode: 'full',
    encryptedApiKey: 'enc-key',
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
    summary: 'one issue',
    findings: [
      {
        severity: 'medium',
        category: 'best-practice',
        file: 'src/app.ts',
        line: 1,
        message: 'avoid console.log',
        source: 'ai',
      },
    ],
    metadata: {
      mode: 'full',
      provider: 'gateway',
      model: 'claude-sonnet-4',
      tokensUsed: 100,
      executionTimeMs: 10,
      toolsRun: [],
      toolsSkipped: [],
      totalAdditions: 1,
      totalDeletions: 0,
      fileList: ['src/app.ts'],
    },
  };
}

describe('POSTBACK 401-recovery (P2 FIX 3) — in-job bounded retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenSeq = 0;
    postCommentCalls = 0;
    postCommentTokens.length = 0;
    postCommentBehaviors = [];
    process.env.GITHUB_APP_ID = 'app-id';
    process.env.GITHUB_PRIVATE_KEY = 'priv-key';
    mockCreateDatabaseFromEnv.mockReturnValue({});
    mockGetRepositoryById.mockResolvedValue({ id: 1, encryptedApiKey: 'enc-key' });
    mockGetEffectiveRepoSettings.mockResolvedValue({ providerChain: [] });
    mockDecrypt.mockImplementation((v: string) => `decrypted-${v}`);
    mockReviewPipeline.mockResolvedValue(makeReviewResult());
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY;
  });

  it('401-on-postback → invalidate + re-mint + retry SUCCEEDS', async () => {
    // First postComment 401s, retry succeeds.
    postCommentBehaviors = ['401', 'ok'];

    await expect(capturedProcessor?.(makeFakeJob(makeJobData()))).resolves.toMatchObject({
      success: true,
    });

    // postComment was attempted TWICE (initial + the single retry).
    expect(mockPostComment).toHaveBeenCalledTimes(2);

    // A SECOND mint happened: the happy path is 1 mint (cached reuse); the 401
    // forced invalidate() → a fresh mint for the retry → 2 total.
    expect(mockGetInstallationTokenWithExpiry).toHaveBeenCalledTimes(2);

    // The retry used a DIFFERENT (freshly minted) token than the failed attempt.
    expect(postCommentTokens).toHaveLength(2);
    expect(postCommentTokens[0]).toBe('ghp_mint-1');
    expect(postCommentTokens[1]).toBe('ghp_mint-2');
    expect(postCommentTokens[0]).not.toBe(postCommentTokens[1]);

    // The completion reaction still fired (job completed normally after retry).
    expect(mockAddCommentReaction).toHaveBeenCalledTimes(1);
  });

  it('401-on-postback AND 401-on-retry → propagates (job fails, no infinite loop)', async () => {
    // Both the initial attempt AND the retry 401 → must propagate, retry ONCE only.
    postCommentBehaviors = ['401', '401', '401'];

    await expect(capturedProcessor?.(makeFakeJob(makeJobData()))).rejects.toThrow(/401/);

    // EXACTLY two postComment attempts: initial + ONE bounded retry. NOT a loop.
    expect(mockPostComment).toHaveBeenCalledTimes(2);
    // Exactly one re-mint (the bounded recovery), not an unbounded mint storm.
    expect(mockGetInstallationTokenWithExpiry).toHaveBeenCalledTimes(2);
    // The reaction step is never reached because the postback ultimately failed.
    expect(mockAddCommentReaction).not.toHaveBeenCalled();
  });
});
