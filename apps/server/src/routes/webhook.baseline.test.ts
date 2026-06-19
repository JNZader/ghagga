/**
 * BASELINE CAPTURE — GitHub issue_comment forge behavior (SDD forge-agnostic 1.4b)
 *
 * This file is a REGRESSION NET, not a refactor. It pins the CURRENT, live
 * GitHub issue_comment (`ghagga review` trigger) forge behavior of the webhook
 * handler (routes/webhook.ts) so the later forge-adapter rewire (task 1.4b)
 * can be proven OBSERVABLY EQUIVALENT (R-NObehavior).
 *
 * It MUST pass against the CURRENT, UNCHANGED webhook.ts/client.ts. When this
 * file is committed FIRST (before the rewire), it pins HEAD's direct-call flow.
 *
 * The issue_comment path is the SECOND forge consumer (audit found it 1.4
 * missed). Unlike the review worker it is far simpler:
 *   1. mint exactly ONE installation token (getInstallationToken).
 *   2. addCommentReaction(owner, repo, payload.comment.id, 'eyes', token) on the
 *      TRIGGER comment to acknowledge.
 *   3. fetchPRDetails(owner, repo, prNumber, token) and consume EXACTLY three
 *      fields: headSha, baseBranch, prAuthor — threaded into the enqueued job.
 *
 * What is pinned here:
 *   1. The 'eyes' reaction call args (owner, repo, comment.id, 'eyes', token).
 *   2. The fetchPRDetails call args (owner, repo, prNumber, token).
 *   3. Which fields of fetchPRDetails' result are consumed → headSha,
 *      baseBranch, prAuthor flow into the enqueued ReviewJobData.
 *   4. Token mint count == 1 (single mint for this whole path).
 *   5. The ordered (method+endpoint) forge sequence for this path:
 *        mint → addCommentReaction(eyes) → fetchPRDetails.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookRouter } from './webhook.js';

// ─── ghagga-db mock (matches webhook.test.ts) ──────────────────────

const mockUpsertInstallation = vi.fn();
const mockDeactivateInstallation = vi.fn();
const mockUpsertRepository = vi.fn();
const mockGetRepoByGithubId = vi.fn();
const mockGetEffectiveRepoSettings = vi.fn();
const mockGetInstallationByGitHubId = vi.fn();
const mockDeleteMappingsByInstallationId = vi.fn();

vi.mock('ghagga-db', () => ({
  upsertInstallation: (...args: unknown[]) => mockUpsertInstallation(...args),
  deactivateInstallation: (...args: unknown[]) => mockDeactivateInstallation(...args),
  upsertRepository: (...args: unknown[]) => mockUpsertRepository(...args),
  getRepoByGithubId: (...args: unknown[]) => mockGetRepoByGithubId(...args),
  getEffectiveRepoSettings: (...args: unknown[]) => mockGetEffectiveRepoSettings(...args),
  getInstallationByGitHubId: (...args: unknown[]) => mockGetInstallationByGitHubId(...args),
  deleteMappingsByInstallationId: (...args: unknown[]) =>
    mockDeleteMappingsByInstallationId(...args),
}));

const mockEnqueueReview = vi.fn();
vi.mock('../queues/review.js', () => ({
  enqueueReview: (...args: unknown[]) => mockEnqueueReview(...args),
}));

// ─── GitHub client: RECORDING adapters (mirrors review.baseline.test.ts) ──
//
// Each forge function pushes a structured (method + endpoint + body) record
// into `callLog`, in call order. This is the CURRENT forge contract the adapter
// rewire (1.4b) must reproduce. Endpoints are the literal GitHub REST paths.

interface CallRecord {
  fn: string;
  method: string;
  endpoint: string;
  body?: unknown;
}

const callLog: CallRecord[] = [];
let tokenSeq = 0;

const mockGetInstallationToken = vi.fn(async (installationId: number) => {
  tokenSeq += 1;
  const token = `ghp_mint-${tokenSeq}`;
  callLog.push({
    fn: 'getInstallationToken',
    method: 'POST',
    endpoint: `/app/installations/${installationId}/access_tokens`,
    body: undefined,
  });
  return token;
});

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

const mockFetchPRDetails = vi.fn(async (owner: string, repo: string, prNumber: number) => {
  callLog.push({
    fn: 'fetchPRDetails',
    method: 'GET',
    endpoint: `/repos/${owner}/${repo}/pulls/${prNumber}`,
  });
  return { headSha: 'pr-head-sha-abc', baseBranch: 'develop', prAuthor: 'octocat' };
});

vi.mock('../github/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../github/client.js')>();
  return {
    ...original,
    getInstallationToken: (...args: unknown[]) =>
      mockGetInstallationToken(...(args as Parameters<typeof mockGetInstallationToken>)),
    addCommentReaction: (...args: unknown[]) =>
      mockAddCommentReaction(...(args as Parameters<typeof mockAddCommentReaction>)),
    fetchPRDetails: (...args: unknown[]) =>
      mockFetchPRDetails(...(args as Parameters<typeof mockFetchPRDetails>)),
  };
});

// ─── HTTP helpers (matches webhook.test.ts) ────────────────────────

const WEBHOOK_SECRET = 'test-secret-key';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

function makeRequest(body: string, eventType: string): Request {
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': eventType,
      'x-hub-signature-256': sign(body),
    },
    body,
  });
}

const FAKE_REPO = {
  id: 42,
  githubRepoId: 12345,
  installationId: 1,
  fullName: 'acme/widget',
  llmProvider: 'gateway',
  llmModel: 'claude-sonnet-4',
  reviewMode: 'full',
  encryptedApiKey: 'enc-key',
};

const COMMENT_PAYLOAD = {
  action: 'created',
  comment: {
    id: 555,
    body: 'ghagga review',
    user: { login: 'contributor-user', type: 'User' },
    author_association: 'CONTRIBUTOR',
  },
  issue: {
    number: 42,
    pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/42' },
  },
  repository: { id: 12345, full_name: 'acme/widget' },
  installation: { id: 7777 },
};

// ─── Setup ─────────────────────────────────────────────────────────

let router: ReturnType<typeof createWebhookRouter>;

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  tokenSeq = 0;

  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.GITHUB_APP_ID = 'baseline-app-id';
  process.env.GITHUB_PRIVATE_KEY = 'baseline-private-key';

  // biome-ignore lint/suspicious/noExplicitAny: mock cast
  router = createWebhookRouter({} as any); // db is mocked at module level

  mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
  mockGetEffectiveRepoSettings.mockResolvedValue({
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'full',
    settings: {
      enableSemgrep: false,
      enableTrivy: false,
      enableCpd: false,
      enableMemory: false,
      customRules: [],
      ignorePatterns: [],
      reviewLevel: 'standard',
    },
    source: 'repo',
  });
  mockEnqueueReview.mockResolvedValue({ id: 'mock-job-id' });
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_PRIVATE_KEY;
});

async function runBaselineFlow(): Promise<Response> {
  const body = JSON.stringify(COMMENT_PAYLOAD);
  return router.fetch(makeRequest(body, 'issue_comment'));
}

describe('BASELINE: GitHub issue_comment forge behavior (forge-rewire regression net)', () => {
  // ── 1. The 'eyes' acknowledgment reaction on the TRIGGER comment ──
  it("1. reacts 'eyes' on the trigger comment with the minted token", async () => {
    await runBaselineFlow();

    expect(mockAddCommentReaction).toHaveBeenCalledTimes(1);
    expect(mockAddCommentReaction).toHaveBeenCalledWith(
      'acme',
      'widget',
      555, // payload.comment.id
      'eyes',
      'ghp_mint-1',
    );

    const reaction = callLog.find((c) => c.fn === 'addCommentReaction');
    expect(reaction?.body).toEqual({ content: 'eyes' });
  });

  // ── 2. fetchPRDetails call args ──────────────────────────────────
  it('2. fetches PR details with (owner, repo, prNumber, token)', async () => {
    await runBaselineFlow();

    expect(mockFetchPRDetails).toHaveBeenCalledTimes(1);
    expect(mockFetchPRDetails).toHaveBeenCalledWith('acme', 'widget', 42, 'ghp_mint-1');
  });

  // ── 3. Consumed fields → enqueued job ────────────────────────────
  it('3. threads headSha + baseBranch + prAuthor from fetchPRDetails into the job', async () => {
    await runBaselineFlow();

    expect(mockEnqueueReview).toHaveBeenCalledTimes(1);
    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    // EXACTLY the three fields fetchPRDetails returns are consumed.
    expect(jobData.headSha).toBe('pr-head-sha-abc');
    expect(jobData.baseBranch).toBe('develop');
    expect(jobData.prAuthor).toBe('octocat');
    // And the trigger comment id is preserved.
    expect(jobData.triggerCommentId).toBe(555);
    expect(jobData.prNumber).toBe(42);
  });

  // ── 4. Token mint count == 1 ─────────────────────────────────────
  it('4. mints the installation token exactly once for this path', async () => {
    await runBaselineFlow();

    const mints = callLog.filter((c) => c.fn === 'getInstallationToken');
    expect(mints).toHaveLength(1);
    expect(mints[0]?.endpoint).toBe('/app/installations/7777/access_tokens');
    expect(mints[0]?.method).toBe('POST');
    expect(mockGetInstallationToken).toHaveBeenCalledWith(
      7777,
      'baseline-app-id',
      'baseline-private-key',
    );
  });

  // ── 5. Ordered forge sequence ────────────────────────────────────
  it('5. issues the forge calls in the exact recorded order', async () => {
    await runBaselineFlow();

    const sequence = callLog.map((c) => `${c.method} ${c.endpoint}`);
    expect(sequence).toMatchInlineSnapshot(`
      [
        "POST /app/installations/7777/access_tokens",
        "POST /repos/acme/widget/issues/comments/555/reactions",
        "GET /repos/acme/widget/pulls/42",
      ]
    `);
  });

  // ── 6. The reaction is minted BEFORE fetchPRDetails ──────────────
  it('6. reacts BEFORE fetching PR details', async () => {
    await runBaselineFlow();

    const order = callLog.map((c) => c.fn);
    expect(order.indexOf('addCommentReaction')).toBeLessThan(order.indexOf('fetchPRDetails'));
    expect(order.indexOf('getInstallationToken')).toBeLessThan(order.indexOf('addCommentReaction'));
  });
});
