/**
 * BASELINE CAPTURE — GitHub PR-review observable behavior (SDD forge-agnostic 1.0)
 *
 * This file is a REGRESSION NET, not a refactor. It pins the CURRENT, live
 * GitHub PR-review behavior of `processReview` (queues/review.ts) so the later
 * forge-adapter rewire (tasks 1.3/1.4 credential-provider wrap, 1.8 golden,
 * 1.9 call-sequence) can be proven OBSERVABLY EQUIVALENT (R-NObehavior).
 *
 * It MUST pass against the CURRENT, UNCHANGED review.ts/client.ts. P0 changed
 * zero call-sites, so HEAD's worker code == the original GitHub flow.
 *
 * What is pinned here:
 *   1. Golden summary-comment BODY — the exact byte string posted to the PR,
 *      built with the REAL formatReviewComment (NOT the stub used in
 *      review.test.ts) over a fixed, representative review result.
 *   2. PR-flow CALL SEQUENCE — the ordered list of (HTTP method + endpoint)
 *      forge calls across the whole flow, plus each request body.
 *   3. Token MINT count + order — under P2's caching GitHubAppCredentialProvider
 *      the installation token is minted exactly ONCE: the phase-1 token is still
 *      budget-valid at postback, so the second getToken() returns it from cache
 *      (no second mint). The DURABLE invariant (getToken resolved at BOTH phase
 *      boundaries; postback token budget-valid) is pinned by test 3c. Pre-P2 the
 *      count was 2 (TemporaryGitHubTokenSource minted per call); the drop to 1 is
 *      the deliberate, documented P2 optimization — NOT a regression.
 *   4. Stale-delete-then-repost — find existing → delete ALL stale (best
 *      effort) → post fresh at bottom, with the delete-before-post ordering.
 *   5. Trigger-comment reaction — addCommentReaction on the trigger comment.
 *
 * DETERMINISM (documented for the eventual 1.8/1.9 tests):
 *   - executionTimeMs + tokensUsed + model are taken from the mocked
 *     reviewResult (we control them) → cost footer + time line are stable.
 *   - reviewId is fixed in the job data → the trailing `<!-- reviewId: … -->`
 *     marker is stable.
 *   - randomUUID()/Date.now() are ONLY used to build the workflow callbackId,
 *     which is reached ONLY when a static-analysis tool is enabled. We keep ALL
 *     static tools DISABLED, so that nondeterministic branch is never entered
 *     and NO clock/uuid mocking is required for the golden/sequence capture.
 */

import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted logger mock (matches review.test.ts convention) ───────

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

// Capture the processor passed to new Worker(...)
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

// ─── ghagga-core: keep the REAL formatReviewComment (golden body) ──
//
// review.test.ts STUBS formatReviewComment to a fixed string; for a TRUE
// byte-exact golden we must run the REAL renderer over a controlled result.
// reviewPipeline is still stubbed (we don't want a real LLM/static run) and
// returns the fixed result the golden snapshot is built from.

const mockReviewPipeline = vi.fn();

vi.mock('ghagga-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ghagga-core')>();
  return {
    ...actual,
    reviewPipeline: (...args: unknown[]) => mockReviewPipeline(...args),
  };
});

// ─── ghagga-db (matches review.test.ts) ────────────────────────────

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

// ─── GitHub client: RECORDING adapters ─────────────────────────────
//
// Instead of opaque vi.fn() stubs, each forge function pushes a structured
// record (method + endpoint + body) into `callLog`, in call order. This is the
// CURRENT forge contract that the adapter rewire must reproduce. Endpoints are
// the literal GitHub REST paths the real client.ts builds (see client.ts).

interface CallRecord {
  fn: string;
  method: string;
  endpoint: string;
  body?: unknown;
}

const callLog: CallRecord[] = [];
let tokenSeq = 0;

// P2: the worker now mints via getInstallationTokenWithExpiry and the
// GitHubAppCredentialProvider TTL-caches the result. Each ACTUAL upstream mint
// (one callLog entry) returns a token + a FAR-FUTURE expiry so the cache stays
// valid across the whole job → the second getToken() returns the cached token
// and NO second mint occurs (the deliberate P2 mint-count optimization).
const mockGetInstallationTokenWithExpiry = vi.fn(async (installationId: number) => {
  tokenSeq += 1;
  const token = `ghp_mint-${tokenSeq}`;
  callLog.push({
    fn: 'getInstallationToken',
    method: 'POST',
    endpoint: `/app/installations/${installationId}/access_tokens`,
    body: undefined,
  });
  // 1h out — comfortably beyond SKEW_SECONDS + BUDGET_SECONDS, so the provider
  // reuses this token for the postback instead of re-minting.
  return { token, expiresAtMs: Date.now() + 60 * 60 * 1000 };
});

const mockFetchPRDiff = vi.fn(async (owner: string, repo: string, prNumber: number) => {
  callLog.push({
    fn: 'fetchPRDiff',
    method: 'GET',
    endpoint: `/repos/${owner}/${repo}/pulls/${prNumber} (Accept: diff)`,
  });
  return 'diff --git a/src/app.ts b/src/app.ts\n+console.log("hi")\n';
});

const mockGetPRCommitMessages = vi.fn(async (owner: string, repo: string, prNumber: number) => {
  callLog.push({
    fn: 'getPRCommitMessages',
    method: 'GET',
    endpoint: `/repos/${owner}/${repo}/pulls/${prNumber}/commits`,
  });
  return ['feat: add app entrypoint'];
});

const mockGetPRFileList = vi.fn(async (owner: string, repo: string, prNumber: number) => {
  callLog.push({
    fn: 'getPRFileList',
    method: 'GET',
    endpoint: `/repos/${owner}/${repo}/pulls/${prNumber}/files`,
  });
  return ['src/app.ts'];
});

const mockFindExistingComment = vi.fn(async (owner: string, repo: string, prNumber: number) => {
  callLog.push({
    fn: 'findExistingComment',
    method: 'GET',
    endpoint: `/repos/${owner}/${repo}/issues/${prNumber}/comments (list)`,
  });
  // Representative: one latest + two stale duplicates → exercises the
  // delete-ALL-stale loop ordering.
  return { latestId: 1001, staleIds: [900, 950] };
});

const mockDeleteComment = vi.fn(async (owner: string, repo: string, commentId: number) => {
  callLog.push({
    fn: 'deleteComment',
    method: 'DELETE',
    endpoint: `/repos/${owner}/${repo}/issues/comments/${commentId}`,
  });
});

const mockPostComment = vi.fn(
  async (owner: string, repo: string, prNumber: number, body: string) => {
    callLog.push({
      fn: 'postComment',
      method: 'POST',
      endpoint: `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      body: { body },
    });
    return { id: 2002 };
  },
);

const mockAddCommentReaction = vi.fn(
  async (owner: string, repo: string, commentId: number, reaction: string) => {
    callLog.push({
      fn: 'addCommentReaction',
      method: 'POST',
      endpoint: `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
      body: { content: reaction },
    });
  },
);

const mockUpdateComment = vi.fn().mockResolvedValue(undefined);
const mockFetchGraphFromBranch = vi.fn().mockResolvedValue(null);

vi.mock('../github/client.js', () => ({
  getInstallationTokenWithExpiry: (...args: unknown[]) =>
    mockGetInstallationTokenWithExpiry(
      ...(args as Parameters<typeof mockGetInstallationTokenWithExpiry>),
    ),
  fetchPRDiff: (...args: unknown[]) =>
    mockFetchPRDiff(...(args as Parameters<typeof mockFetchPRDiff>)),
  getPRCommitMessages: (...args: unknown[]) =>
    mockGetPRCommitMessages(...(args as Parameters<typeof mockGetPRCommitMessages>)),
  getPRFileList: (...args: unknown[]) =>
    mockGetPRFileList(...(args as Parameters<typeof mockGetPRFileList>)),
  findExistingComment: (...args: unknown[]) =>
    mockFindExistingComment(...(args as Parameters<typeof mockFindExistingComment>)),
  deleteComment: (...args: unknown[]) =>
    mockDeleteComment(...(args as Parameters<typeof mockDeleteComment>)),
  postComment: (...args: unknown[]) =>
    mockPostComment(...(args as Parameters<typeof mockPostComment>)),
  addCommentReaction: (...args: unknown[]) =>
    mockAddCommentReaction(...(args as Parameters<typeof mockAddCommentReaction>)),
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

// ─── Import module & capture processor ─────────────────────────────

import { createReviewWorker, type ReviewJobData } from './review.js';

createReviewWorker(1);

// ─── Fixed, representative inputs ──────────────────────────────────

const BASELINE_REVIEW_ID = 'baseline-rev-0001';

function makeJobData(overrides: Partial<ReviewJobData> = {}): ReviewJobData {
  return {
    reviewId: BASELINE_REVIEW_ID,
    installationId: 7777,
    repoFullName: 'acme/widget',
    prNumber: 42,
    repositoryId: 1,
    triggerCommentId: 555,
    prAuthor: 'octocat',
    llmProvider: 'gateway',
    llmModel: 'claude-sonnet-4',
    reviewMode: 'full',
    encryptedApiKey: 'enc-baseline-key',
    settings: {
      // ALL static tools DISABLED → no workflow dispatch → no UUID/clock in the
      // flow → deterministic golden + sequence (see file header).
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

// The fixed ReviewResult the golden snapshot is built from. Deterministic:
// no time/uuid/random — executionTimeMs + tokensUsed + model are pinned here.
function makeReviewResult() {
  return {
    status: 'NEEDS_HUMAN_REVIEW' as const,
    summary: 'Found one potential issue in the diff. Please review the logged statement.',
    findings: [
      {
        severity: 'medium',
        category: 'best-practice',
        file: 'src/app.ts',
        line: 1,
        message: 'Avoid console.log in production code.',
        source: 'ai',
      },
    ],
    metadata: {
      mode: 'full',
      provider: 'gateway',
      model: 'claude-sonnet-4',
      tokensUsed: 12500,
      executionTimeMs: 4200,
      toolsRun: [],
      toolsSkipped: [],
      totalAdditions: 1,
      totalDeletions: 0,
      fileList: ['src/app.ts'],
    },
  };
}

// ─── Shared run helper ─────────────────────────────────────────────

async function runBaselineFlow(): Promise<void> {
  callLog.length = 0;
  tokenSeq = 0;
  mockReviewPipeline.mockResolvedValue(makeReviewResult());
  await capturedProcessor?.(makeFakeJob(makeJobData()));
}

describe('BASELINE: GitHub PR-review observable behavior (forge-rewire regression net)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = 'baseline-app-id';
    process.env.GITHUB_PRIVATE_KEY = 'baseline-private-key';

    mockCreateDatabaseFromEnv.mockReturnValue({});
    // Legacy single-key path with a real (decryptable) key → AI review ON,
    // exercising the full postback (golden body has the cost footer + findings).
    mockGetRepositoryById.mockResolvedValue({ id: 1, encryptedApiKey: 'enc-baseline-key' });
    mockGetEffectiveRepoSettings.mockResolvedValue({ providerChain: [] });
    mockDecrypt.mockImplementation((v: string) => `decrypted-${v}`);
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY;
  });

  it('captured the processor from the Worker constructor', () => {
    expect(capturedProcessor).toBeDefined();
    expect(typeof capturedProcessor).toBe('function');
  });

  // ── 1. Golden summary-comment BODY (byte-exact) ──────────────────
  it('1. posts a byte-identical summary-comment body (golden snapshot)', async () => {
    await runBaselineFlow();

    const post = callLog.find((c) => c.fn === 'postComment');
    expect(post).toBeDefined();
    const body = (post?.body as { body: string }).body;

    // Inline snapshot = committed golden. If the rewire changes a single byte
    // of the posted body, this fails. The trailing reviewId marker uses the
    // fixed BASELINE_REVIEW_ID, so it is stable.
    expect(body).toMatchInlineSnapshot(`
      "<!-- ghagga-review -->
      ## 🤖 GHAGGA Code Review

      **Status:** ⚠️ NEEDS_HUMAN_REVIEW
      **Mode:** full | **Model:** claude-sonnet-4 | **Time:** 4.2s
      🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 +1 / -0 (net +1)

      ### Summary
      Found one potential issue in the diff. Please review the logged statement.

      ### Findings (1)

      **🤖 AI Review (1)**
      | Severity | Category | File | Message |
      |----------|----------|------|----------|
      | 🟡 medium | best-practice | src/app.ts:1 | Avoid console.log in production code. |

      ### Files Changed (1)
      🔧 **Core**: \`app.ts\`


      <sub>📊 13K tokens · $0.0825 · \`claude-sonnet-4\`</sub>
      ---
      *Powered by [GHAGGA](https://github.com/JNZader/ghagga) — AI Code Review* — @octocat
      <!-- reviewId: baseline-rev-0001 -->"
    `);
  });

  // ── 2. PR-flow CALL SEQUENCE (ordered method + endpoint) ─────────
  it('2. issues the forge calls in the exact recorded order', async () => {
    await runBaselineFlow();

    const sequence = callLog.map((c) => `${c.method} ${c.endpoint}`);
    // P2 DELTA: the SECOND `POST /app/installations/7777/access_tokens` (the
    // pre-postback mint) is GONE — the provider returns the still-budget-valid
    // phase-1 token from cache. Every OTHER call (method + endpoint + order) is
    // byte-identical to the pre-P2 baseline: same fetch reads, same
    // find→delete-all-stale→post, same reaction. The ONLY change is the absent
    // second mint (caching).
    expect(sequence).toMatchInlineSnapshot(`
      [
        "POST /app/installations/7777/access_tokens",
        "GET /repos/acme/widget/pulls/42 (Accept: diff)",
        "GET /repos/acme/widget/pulls/42/commits",
        "GET /repos/acme/widget/pulls/42/files",
        "GET /repos/acme/widget/issues/42/comments (list)",
        "DELETE /repos/acme/widget/issues/comments/1001",
        "DELETE /repos/acme/widget/issues/comments/900",
        "DELETE /repos/acme/widget/issues/comments/950",
        "POST /repos/acme/widget/issues/42/comments",
        "POST /repos/acme/widget/issues/comments/555/reactions",
      ]
    `);
  });

  it('2b. records the postComment + reaction request bodies', async () => {
    await runBaselineFlow();

    const post = callLog.find((c) => c.fn === 'postComment');
    const reaction = callLog.find((c) => c.fn === 'addCommentReaction');
    expect(
      (post?.body as { body: string }).body.endsWith(`<!-- reviewId: ${BASELINE_REVIEW_ID} -->`),
    ).toBe(true);
    expect(reaction?.body).toEqual({ content: 'rocket' });
  });

  // ── 3. Token MINT count + order ──────────────────────────────────
  it('3. mints the installation token exactly ONCE (P2 caching), before the fetch', async () => {
    await runBaselineFlow();

    const mints = callLog.filter((c) => c.fn === 'getInstallationToken');
    // P2 behavior: GitHubAppCredentialProvider TTL-caches the installation token.
    // The phase-1 token (minted before the context fetch) is still budget-valid
    // at postback time, so the postback's getToken() returns it FROM CACHE — no
    // second mint occurs. The count collapses from the pre-P2 value of 2 to 1.
    //
    // This is the DELIBERATE, documented P2 optimization (see the P2-READINESS
    // NOTE the P1 baseline left here, now realised). User-observable output is
    // unchanged; only the mint count drops. The caching-DURABLE invariant —
    // getToken() resolved at BOTH phase boundaries, postback token budget-valid —
    // is pinned by test 3c below.
    expect(mints).toHaveLength(1);

    // The single mint precedes the context fetch (and therefore the postback).
    const idx = (fn: string) => callLog.findIndex((c) => c.fn === fn);
    const mintIdx = idx('getInstallationToken');
    expect(mintIdx).toBeLessThan(idx('fetchPRDiff'));
    expect(mintIdx).toBeLessThan(idx('findExistingComment'));
    expect(mintIdx).toBeLessThan(idx('postComment'));

    // It targets the installation's access-token endpoint.
    expect(mints[0]?.endpoint).toBe('/app/installations/7777/access_tokens');
    expect(mints[0]?.method).toBe('POST');
  });

  it('3b. the postback reuses the CACHED phase-1 token (P2 caching — no fresh mint)', async () => {
    await runBaselineFlow();
    // The single mint feeds the fetch phase; the postback phase reuses the SAME
    // cached token (ghp_mint-1) — pins the P2 caching behavior. Pre-P2 these
    // differed (ghp_mint-1 vs ghp_mint-2, fresh-before-postback). They are now
    // EQUAL because the cached token is still budget-valid at postback.
    expect(mockFetchPRDiff).toHaveBeenCalledWith('acme', 'widget', 42, 'ghp_mint-1');
    expect(mockFindExistingComment).toHaveBeenCalledWith('acme', 'widget', 42, 'ghp_mint-1');
    expect(mockPostComment.mock.calls[0][4]).toBe('ghp_mint-1');
    expect(mockAddCommentReaction).toHaveBeenCalledWith(
      'acme',
      'widget',
      555,
      'rocket',
      'ghp_mint-1',
    );
  });

  // ── 3c. DURABLE phase-boundary invariant (survives P2 caching) ────
  //
  // Tests 3/3b pin the per-call MINT behavior, which legitimately collapses to
  // 1 under P2's caching provider (see the P2-READINESS NOTE in test 3). This
  // test pins the invariant that holds REGARDLESS of caching: the token source's
  // getToken() is resolved at EXACTLY TWO phase boundaries —
  //   (1) the fetch phase (token consumed by fetchPRDiff), and
  //   (2) the postback phase (token consumed by findExistingComment/postComment).
  // getToken() is not directly spy-able (TemporaryGitHubTokenSource is
  // constructed inside review.ts), so we assert the two boundary RESOLUTIONS via
  // the token each phase consumed: each phase consumes exactly one resolved
  // token, and there are exactly two such boundaries. Under P2 caching the two
  // tokens become EQUAL (same cached value) but there are STILL two resolutions,
  // so this assertion stays green across the swap — unlike the mint count.
  it('3c. resolves a token at exactly the two phase boundaries (caching-durable)', async () => {
    await runBaselineFlow();

    // Phase-1 boundary: every fetch-phase forge call consumed the SAME token.
    const fetchToken = mockFetchPRDiff.mock.calls[0][3];
    expect(typeof fetchToken).toBe('string');
    expect(mockGetPRCommitMessages).toHaveBeenCalledWith('acme', 'widget', 42, fetchToken);
    expect(mockGetPRFileList).toHaveBeenCalledWith('acme', 'widget', 42, fetchToken);

    // Phase-2 boundary: every postback-phase forge call consumed the SAME token.
    const postbackToken = mockPostComment.mock.calls[0][4];
    expect(typeof postbackToken).toBe('string');
    expect(mockFindExistingComment).toHaveBeenCalledWith('acme', 'widget', 42, postbackToken);
    expect(mockAddCommentReaction).toHaveBeenCalledWith(
      'acme',
      'widget',
      555,
      'rocket',
      postbackToken,
    );

    // EXACTLY two distinct boundary resolutions were threaded into the worker:
    // one shared across the whole fetch phase, one shared across the whole
    // postback phase. (Two boundaries — caching may make the VALUES equal in P2;
    // the COUNT of boundaries is the durable invariant.)
    const fetchPhaseTokens = new Set([
      mockFetchPRDiff.mock.calls[0][3],
      mockGetPRCommitMessages.mock.calls[0][3],
      mockGetPRFileList.mock.calls[0][3],
    ]);
    const postbackPhaseTokens = new Set([
      mockFindExistingComment.mock.calls[0][3],
      mockPostComment.mock.calls[0][4],
    ]);
    expect(fetchPhaseTokens.size).toBe(1);
    expect(postbackPhaseTokens.size).toBe(1);
  });

  // ── 4. Stale-delete-then-repost ──────────────────────────────────
  it('4. deletes ALL stale comments BEFORE posting the fresh one', async () => {
    await runBaselineFlow();

    const order = callLog.map((c) => c.fn);
    const findIdx = order.indexOf('findExistingComment');
    const postIdx = order.indexOf('postComment');
    const deleteIdxs = order
      .map((fn, i) => (fn === 'deleteComment' ? i : -1))
      .filter((i) => i >= 0);

    // find → deletes → post (all deletes strictly between find and post).
    expect(findIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdxs.length).toBe(3); // latest 1001 + stale 900, 950
    for (const d of deleteIdxs) {
      expect(d).toBeGreaterThan(findIdx);
      expect(d).toBeLessThan(postIdx);
    }

    // The exact set + order of deleted IDs: [latestId, ...staleIds].
    const deletedIds = mockDeleteComment.mock.calls.map((c) => c[2]);
    expect(deletedIds).toEqual([1001, 900, 950]);
  });

  // ── 5. Trigger-comment reaction ──────────────────────────────────
  it('5. reacts on the trigger comment with rocket, after the postback', async () => {
    await runBaselineFlow();

    expect(mockAddCommentReaction).toHaveBeenCalledTimes(1);
    expect(mockAddCommentReaction).toHaveBeenCalledWith(
      'acme',
      'widget',
      555, // triggerCommentId
      'rocket',
      'ghp_mint-1', // P2: cached postback token (was ghp_mint-2 pre-P2)
    );

    const order = callLog.map((c) => c.fn);
    expect(order.indexOf('addCommentReaction')).toBeGreaterThan(order.indexOf('postComment'));
  });
});
