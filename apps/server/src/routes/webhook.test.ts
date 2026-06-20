/**
 * Webhook handler integration tests.
 *
 * Tests the actual HTTP routing, signature verification, event dispatching,
 * and error handling of the webhook router using mocked dependencies.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookRouter, parseCommentCommand } from './webhook.js';

// ─── Mocks ──────────────────────────────────────────────────────

// Mock ghagga-db
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

// Mock BullMQ review queue
const mockEnqueueReview = vi.fn();
vi.mock('../queues/review.js', () => ({
  enqueueReview: (...args: unknown[]) => mockEnqueueReview(...args),
}));

// Mock GitHub client functions used by issue_comment handler
const mockAddCommentReaction = vi.fn();
const mockGetInstallationToken = vi.fn();
const mockFetchPRDetails = vi.fn();
vi.mock('../github/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../github/client.js')>();
  return {
    ...original,
    addCommentReaction: (...args: unknown[]) => mockAddCommentReaction(...args),
    getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
    fetchPRDetails: (...args: unknown[]) => mockFetchPRDetails(...args),
  };
});

// ─── Helpers ────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-secret-key';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

function makeRequest(
  body: string,
  eventType: string,
  options: { signature?: string | null; skipSignature?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-github-event': eventType,
  };

  if (!options.skipSignature) {
    headers['x-hub-signature-256'] = options.signature ?? sign(body);
  }

  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

const FAKE_REPO = {
  id: 42,
  githubRepoId: 12345,
  installationId: 1,
  fullName: 'owner/repo',
  llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-20250514',
  reviewMode: 'simple',
  encryptedApiKey: 'encrypted-key-123',
  settings: {
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: false,
    enableMemory: true,
    customRules: [],
    ignorePatterns: ['*.md'],
    reviewLevel: 'standard',
  },
};

// ─── Setup ──────────────────────────────────────────────────────

let router: ReturnType<typeof createWebhookRouter>;
let originalEnv: string | undefined;
let originalAppId: string | undefined;
let originalPrivateKey: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalEnv = process.env.GITHUB_WEBHOOK_SECRET;
  originalAppId = process.env.GITHUB_APP_ID;
  originalPrivateKey = process.env.GITHUB_PRIVATE_KEY;
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_PRIVATE_KEY = 'fake-private-key';
  // biome-ignore lint/suspicious/noExplicitAny: mock cast
  router = createWebhookRouter({} as any); // db is mocked at module level

  // Default mock returns
  mockUpsertInstallation.mockResolvedValue({ id: 1 });
  mockUpsertRepository.mockResolvedValue({ id: 1 });
  mockDeactivateInstallation.mockResolvedValue(undefined);
  mockGetInstallationByGitHubId.mockResolvedValue(null);
  mockDeleteMappingsByInstallationId.mockResolvedValue(undefined);
  mockGetRepoByGithubId.mockResolvedValue(null);
  mockAddCommentReaction.mockResolvedValue(undefined);
  mockGetInstallationToken.mockResolvedValue('fake-installation-token');
  mockFetchPRDetails.mockResolvedValue({ headSha: 'pr-head-sha-abc', baseBranch: 'main' });
  mockGetEffectiveRepoSettings.mockResolvedValue({
    providerChain: [],
    aiReviewEnabled: true,
    reviewMode: 'simple',
    settings: {
      enableSemgrep: true,
      enableTrivy: true,
      enableCpd: false,
      enableMemory: true,
      customRules: [],
      ignorePatterns: ['*.md'],
      reviewLevel: 'standard',
    },
    source: 'repo',
  });
  mockEnqueueReview.mockResolvedValue({ id: 'mock-job-id' });
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env.GITHUB_WEBHOOK_SECRET = originalEnv;
  } else {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  }
  if (originalAppId !== undefined) {
    process.env.GITHUB_APP_ID = originalAppId;
  } else {
    delete process.env.GITHUB_APP_ID;
  }
  if (originalPrivateKey !== undefined) {
    process.env.GITHUB_PRIVATE_KEY = originalPrivateKey;
  } else {
    delete process.env.GITHUB_PRIVATE_KEY;
  }
});

// ─── Signature Verification ─────────────────────────────────────

describe('webhook signature verification', () => {
  it('returns 401 for missing signature', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const req = makeRequest(body, 'pull_request', { skipSignature: true });
    const res = await router.fetch(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toHaveProperty('error', 'Invalid signature');
  });

  it('returns 401 for invalid signature', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const req = makeRequest(body, 'pull_request', { signature: 'sha256=invalid' });
    const res = await router.fetch(req);
    expect(res.status).toBe(401);
  });

  it('returns 500 with errorId when GITHUB_WEBHOOK_SECRET is not set', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const body = JSON.stringify({ action: 'opened' });
    const req = makeRequest(body, 'pull_request');
    const res = await router.fetch(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toHaveProperty('error', 'INTERNAL_ERROR');
    expect(json).toHaveProperty('message', 'Server misconfiguration');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ─── Event Routing ──────────────────────────────────────────────

describe('webhook event routing', () => {
  it('returns 400 when x-github-event header is missing', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const signature = sign(body);
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': signature,
      },
      body,
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty('error', 'Missing x-github-event header');
  });

  it('returns 400 for invalid JSON payload', async () => {
    const body = 'not-valid-json{{{';
    const req = makeRequest(body, 'pull_request');
    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty('error', 'Invalid JSON payload');
  });

  it('returns 200 for unknown event types', async () => {
    const body = JSON.stringify({ action: 'whatever' });
    const req = makeRequest(body, 'star');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('message', 'Event star ignored');
  });
});

// ─── Pull Request Events ────────────────────────────────────────

describe('pull_request event handling', () => {
  const prPayload = {
    action: 'opened',
    number: 42,
    pull_request: {
      number: 42,
      head: { sha: 'abc123' },
      base: { ref: 'main' },
      user: { login: 'pr-author' },
    },
    repository: { id: 12345, full_name: 'owner/repo' },
    installation: { id: 999 },
  };

  it('dispatches review via BullMQ for opened PR', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(prPayload);
    const req = makeRequest(body, 'pull_request');
    const res = await router.fetch(req);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('message', 'Review dispatched');
    expect(json).toHaveProperty('pr', 42);
    expect(json).toHaveProperty('repo', 'owner/repo');
    // Correlation ID: 8-char UUID prefix
    expect(json).toHaveProperty('reviewId');
    expect(json.reviewId).toHaveLength(8);

    expect(mockEnqueueReview).toHaveBeenCalledOnce();
    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.installationId).toBe(999);
    expect(jobData.repoFullName).toBe('owner/repo');
    expect(jobData.prNumber).toBe(42);
    // IMMUTABLE numeric GitHub repo id threaded for FREE from the webhook payload
    // (payload.repository.id) → worker uses it for RepoRef.nativeId, no DB/API call.
    expect(jobData.githubRepoId).toBe(12345);
    // reviewId propagated to BullMQ job
    expect(jobData.reviewId).toBe(json.reviewId);
  });

  it('dispatches review for synchronize action', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify({ ...prPayload, action: 'synchronize' });
    const req = makeRequest(body, 'pull_request');
    const res = await router.fetch(req);
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('dispatches review for reopened action', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify({ ...prPayload, action: 'reopened' });
    const req = makeRequest(body, 'pull_request');
    const res = await router.fetch(req);
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('ignores non-reviewable actions (closed, edited, labeled)', async () => {
    for (const action of ['closed', 'edited', 'labeled', 'assigned']) {
      vi.clearAllMocks();
      const body = JSON.stringify({ ...prPayload, action });
      const req = makeRequest(body, 'pull_request');
      const res = await router.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.message).toContain('ignored');
      expect(mockEnqueueReview).not.toHaveBeenCalled();
    }
  });

  it('returns 400 when installation ID is missing', async () => {
    const body = JSON.stringify({ ...prPayload, installation: undefined });
    const req = makeRequest(body, 'pull_request');
    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty('error', 'Missing installation ID');
  });

  it('returns 200 when repository is not tracked', async () => {
    mockGetRepoByGithubId.mockResolvedValue(null);
    const body = JSON.stringify(prPayload);
    const req = makeRequest(body, 'pull_request');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('not tracked');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('passes repo settings to BullMQ job data', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(prPayload);
    const req = makeRequest(body, 'pull_request');
    await router.fetch(req);

    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.settings.enableSemgrep).toBe(true);
    expect(jobData.settings.enableTrivy).toBe(true);
    expect(jobData.settings.enableCpd).toBe(false);
    expect(jobData.settings.enableMemory).toBe(true);
    expect(jobData.settings.ignorePatterns).toEqual(['*.md']);
    // SECURITY: encrypted credentials must NOT be enqueued — the worker
    // re-fetches them from the DB by repositoryId at processing time.
    expect(jobData.encryptedApiKey).toBeUndefined();
    expect(jobData.providerChain).toBeUndefined();
    expect(jobData.llmProvider).toBe('anthropic');
  });
});

// ─── Installation Events ────────────────────────────────────────

describe('installation event handling', () => {
  const installPayload = {
    action: 'created',
    installation: {
      id: 555,
      account: { login: 'my-org', type: 'Organization' },
    },
    repositories: [
      { id: 100, full_name: 'my-org/repo-a' },
      { id: 200, full_name: 'my-org/repo-b' },
    ],
  };

  it('creates installation and upserts repositories on created', async () => {
    const body = JSON.stringify(installPayload);
    const req = makeRequest(body, 'installation');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('message', 'Installation tracked');

    expect(mockUpsertInstallation).toHaveBeenCalledOnce();
    expect(mockUpsertInstallation.mock.calls[0]?.[1]).toMatchObject({
      githubInstallationId: 555,
      accountLogin: 'my-org',
      accountType: 'Organization',
    });

    expect(mockUpsertRepository).toHaveBeenCalledTimes(2);
  });

  it('deactivates installation and cleans up mappings on deleted', async () => {
    // Internal installation record found
    mockGetInstallationByGitHubId.mockResolvedValueOnce({ id: 42, githubInstallationId: 555 });
    const body = JSON.stringify({ ...installPayload, action: 'deleted' });
    const req = makeRequest(body, 'installation');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('message', 'Installation deactivated');
    expect(mockDeactivateInstallation).toHaveBeenCalledOnce();
    // Should look up internal installation and delete mappings
    expect(mockGetInstallationByGitHubId).toHaveBeenCalledOnce();
    expect(mockDeleteMappingsByInstallationId).toHaveBeenCalledWith(expect.anything(), 42);
  });

  it('ignores unknown installation actions (suspend, etc)', async () => {
    const body = JSON.stringify({ ...installPayload, action: 'suspend' });
    const req = makeRequest(body, 'installation');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('ignored');
  });
});

// ─── Installation Repositories Events ───────────────────────────

describe('installation_repositories event handling', () => {
  const repoEvent = {
    action: 'added',
    installation: {
      id: 555,
      account: { login: 'my-org', type: 'Organization' },
    },
    repositories_added: [{ id: 300, full_name: 'my-org/repo-c' }],
    repositories_removed: [],
  };

  it('upserts added repositories', async () => {
    const body = JSON.stringify(repoEvent);
    const req = makeRequest(body, 'installation_repositories');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('message', 'Repositories updated');

    // Ensures installation is upserted first
    expect(mockUpsertInstallation).toHaveBeenCalledOnce();
    expect(mockUpsertRepository).toHaveBeenCalledOnce();
    expect(mockUpsertRepository.mock.calls[0]?.[1]).toMatchObject({
      githubRepoId: 300,
      fullName: 'my-org/repo-c',
    });
  });

  it('handles removed repositories (looks up existing)', async () => {
    mockGetRepoByGithubId.mockResolvedValue({ id: 1, fullName: 'my-org/old-repo' });
    const body = JSON.stringify({
      ...repoEvent,
      repositories_added: [],
      repositories_removed: [{ id: 400, full_name: 'my-org/old-repo' }],
    });
    const req = makeRequest(body, 'installation_repositories');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    expect(mockGetRepoByGithubId).toHaveBeenCalledOnce();
  });
});

// ─── Issue Comment Events (ghagga review trigger) ───────────────

describe('issue_comment event handling', () => {
  const commentPayload = {
    action: 'created',
    comment: {
      id: 777,
      body: 'ghagga review',
      user: { login: 'contributor-user', type: 'User' },
      author_association: 'CONTRIBUTOR',
    },
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/42' },
    },
    repository: { id: 12345, full_name: 'owner/repo' },
    installation: { id: 999 },
  };

  it('dispatches review when "ghagga review" keyword is found in PR comment', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(commentPayload);
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('message', 'Review dispatched (comment trigger)');
    expect(json).toHaveProperty('pr', 42);
    expect(json).toHaveProperty('triggeredBy', 'contributor-user');
    // Correlation ID: 8-char UUID prefix
    expect(json).toHaveProperty('reviewId');
    expect(json.reviewId).toHaveLength(8);

    expect(mockEnqueueReview).toHaveBeenCalledOnce();
    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.prNumber).toBe(42);
    expect(jobData.triggerCommentId).toBe(777);
    expect(jobData.headSha).toBe('pr-head-sha-abc');
    expect(jobData.baseBranch).toBe('main');
    // IMMUTABLE numeric GitHub repo id threaded for FREE from payload.repository.id.
    expect(jobData.githubRepoId).toBe(12345);
    // reviewId propagated to BullMQ job
    expect(jobData.reviewId).toBe(json.reviewId);
  });

  it('fetches PR details to include headSha and baseBranch', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    mockFetchPRDetails.mockResolvedValue({ headSha: 'def456', baseBranch: 'develop' });
    const body = JSON.stringify(commentPayload);
    const req = makeRequest(body, 'issue_comment');
    await router.fetch(req);

    expect(mockFetchPRDetails).toHaveBeenCalledWith('owner', 'repo', 42, 'fake-installation-token');
    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.headSha).toBe('def456');
    expect(jobData.baseBranch).toBe('develop');
  });

  it('dispatches review without headSha when PR details fetch fails', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    mockFetchPRDetails.mockRejectedValue(new Error('API rate limit'));
    const body = JSON.stringify(commentPayload);
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    // Should still dispatch the review without headSha/baseBranch
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.headSha).toBeUndefined();
    expect(jobData.baseBranch).toBeUndefined();
  });

  it('adds 👀 reaction to acknowledge the trigger', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(commentPayload);
    const req = makeRequest(body, 'issue_comment');
    await router.fetch(req);

    expect(mockGetInstallationToken).toHaveBeenCalledOnce();
    expect(mockAddCommentReaction).toHaveBeenCalledWith(
      'owner',
      'repo',
      777,
      'eyes',
      'fake-installation-token',
    );
  });

  it('triggers on case-insensitive "GHAGGA REVIEW"', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    // Leading-line form (command must lead the line); case-insensitivity preserved.
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, body: 'GHAGGA REVIEW' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('does NOT trigger when keyword is embedded mid-sentence (anchored to line start)', async () => {
    // BEHAVIOR CHANGE: the trigger is now anchored to the line start to prevent
    // quoting-injection, so a command buried in prose no longer fires.
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify({
      ...commentPayload,
      comment: {
        ...commentPayload.comment,
        body: 'Hey can you do a ghagga review on this? Thanks!',
      },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('ignores comments without the trigger keyword', async () => {
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, body: 'Looks good to me!' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('No review trigger keyword');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('ignores bot comments (self-trigger prevention)', async () => {
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, user: { login: 'ghagga[bot]', type: 'Bot' } },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('Bot comment ignored');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('ignores edited or deleted comment actions', async () => {
    for (const action of ['edited', 'deleted']) {
      vi.clearAllMocks();
      const body = JSON.stringify({ ...commentPayload, action });
      const req = makeRequest(body, 'issue_comment');
      const res = await router.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.message).toContain('ignored');
      expect(mockEnqueueReview).not.toHaveBeenCalled();
    }
  });

  it('ignores comments on regular issues (not PRs)', async () => {
    const body = JSON.stringify({
      ...commentPayload,
      issue: { number: 10 }, // No pull_request field
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('not on a pull request');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('rejects users with NONE association', async () => {
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, author_association: 'NONE' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('Insufficient permissions');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('rejects MANNEQUIN association', async () => {
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, author_association: 'MANNEQUIN' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('allows OWNER association', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, author_association: 'OWNER' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('allows MEMBER association', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, author_association: 'MEMBER' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('allows FIRST_TIMER association', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, author_association: 'FIRST_TIMER' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('allows FIRST_TIME_CONTRIBUTOR association', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify({
      ...commentPayload,
      comment: { ...commentPayload.comment, author_association: 'FIRST_TIME_CONTRIBUTOR' },
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('returns 400 when installation ID is missing', async () => {
    const body = JSON.stringify({
      ...commentPayload,
      installation: undefined,
    });
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('returns 200 when repository is not tracked', async () => {
    mockGetRepoByGithubId.mockResolvedValue(null);
    const body = JSON.stringify(commentPayload);
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('not tracked');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('continues dispatching even if reaction fails', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    mockGetInstallationToken.mockRejectedValue(new Error('Token failed'));
    const body = JSON.stringify(commentPayload);
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    // Should still dispatch the review despite reaction failure
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });

  it('handles a forge 401 on a freshly-minted token gracefully (BL-WEBHOOK-401-RETRY)', async () => {
    // A 401/403 on the just-minted installation token is surfaced as a clear,
    // diagnosable auth error (not retried — the webhook mints fresh per request,
    // so a re-mint would fail identically) and MUST NOT crash the webhook. Both
    // forge calls (ack reaction + fetch PR details) reject with a status:401 the
    // adapter reclassifies to ForgeAuthError. The review still dispatches (202).
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const authError = Object.assign(new Error('GitHub API error: 401 Unauthorized'), {
      status: 401,
    });
    mockAddCommentReaction.mockRejectedValue(authError);
    mockFetchPRDetails.mockRejectedValue(authError);

    const body = JSON.stringify(commentPayload);
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    // Webhook survives the auth failure (best-effort calls stay non-critical)
    // and still dispatches the review without headSha/baseBranch.
    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.headSha).toBeUndefined();
    expect(jobData.baseBranch).toBeUndefined();
  });
});

// ─── parseCommentCommand Unit Tests ───────────────────────────────

describe('parseCommentCommand', () => {
  it('parses "/ghagga review" with slash prefix', () => {
    const result = parseCommentCommand('/ghagga review');
    expect(result).toEqual({ command: 'review', reviewMode: null });
  });

  it('parses "ghagga review" without slash (backward compat)', () => {
    const result = parseCommentCommand('ghagga review');
    expect(result).toEqual({ command: 'review', reviewMode: null });
  });

  it('parses "/ghagga security" as workflow mode', () => {
    const result = parseCommentCommand('/ghagga security');
    expect(result).toEqual({ command: 'security', reviewMode: 'workflow' });
  });

  it('parses "/ghagga perf" as workflow mode', () => {
    const result = parseCommentCommand('/ghagga perf');
    expect(result).toEqual({ command: 'perf', reviewMode: 'workflow' });
  });

  it('parses "/ghagga describe" as simple mode', () => {
    const result = parseCommentCommand('/ghagga describe');
    expect(result).toEqual({ command: 'describe', reviewMode: 'simple' });
  });

  it('is case-insensitive', () => {
    expect(parseCommentCommand('/GHAGGA SECURITY')).toEqual({
      command: 'security',
      reviewMode: 'workflow',
    });
    expect(parseCommentCommand('Ghagga Review')).toEqual({ command: 'review', reviewMode: null });
  });

  it('does NOT trigger mid-sentence (command must lead the line)', () => {
    // BEHAVIOR CHANGE: previously this matched. The trigger is now anchored to
    // the line start to prevent quoting-injection, so a command embedded in
    // prose no longer fires.
    expect(parseCommentCommand('Please /ghagga review this PR, thanks!')).toBeNull();
  });

  it('parses a command on a clean line within a multi-line body', () => {
    const body = 'Some context paragraph.\n/ghagga review\nThanks!';
    expect(parseCommentCommand(body)).toEqual({ command: 'review', reviewMode: null });
  });

  it('allows leading indentation but not a markdown quote', () => {
    expect(parseCommentCommand('  /ghagga security')).toEqual({
      command: 'security',
      reviewMode: 'workflow',
    });
  });

  it('captures the hyphenated fan-out command', () => {
    expect(parseCommentCommand('/ghagga fan-out')).toEqual({
      command: 'fan-out',
      reviewMode: 'fan-out',
    });
  });

  it('does NOT trigger on quoted, inline, or code-fenced commands (quoting-injection)', () => {
    expect(parseCommentCommand('> /ghagga review')).toBeNull();
    expect(parseCommentCommand('> ghagga review')).toBeNull();
    expect(parseCommentCommand('lorem /ghagga review ipsum')).toBeNull();
    expect(parseCommentCommand('```/ghagga review```')).toBeNull();
  });

  it('does NOT trigger on a command on its own line inside a multi-line fenced block', () => {
    // The command line is a clean line-start, so the anchor alone would match it.
    // Stripping fenced blocks before matching is what neutralizes this.
    const body = 'Here is an example:\n```\n/ghagga review\n```\nDo not run it.';
    expect(parseCommentCommand(body)).toBeNull();
  });

  it('does NOT trigger when keyword and subcommand are on different lines', () => {
    expect(parseCommentCommand('/ghagga\nreview')).toBeNull();
  });

  it('does NOT trigger on a pseudo-line-break with a bare carriage return (Q8)', () => {
    // A bare \r renders as a line break in some viewers but is NOT a \n: the
    // scanner splits on \n only, so this stays one logical line and the command
    // is not at a real line-start.
    expect(parseCommentCommand('blah\r/ghagga review')).toBeNull();
  });

  it('does NOT trigger on a pseudo-line-break with a unicode line separator (Q8)', () => {
    expect(parseCommentCommand('blah /ghagga review')).toBeNull();
    expect(parseCommentCommand('blah /ghagga review')).toBeNull();
  });

  it('does NOT trigger inside an UNTERMINATED fenced block (Q7)', () => {
    // The opening fence is never closed; everything after it stays in-fence.
    expect(parseCommentCommand('```\n/ghagga review')).toBeNull();
  });

  it('does NOT trigger inside a terminated fenced block on its own line', () => {
    const body = 'Example:\n```\n/ghagga review\n```\nDo not run.';
    expect(parseCommentCommand(body)).toBeNull();
  });

  it('triggers on a clean (non-fenced) command line within a multi-line body', () => {
    const body = 'Some context.\n```\nfenced noise\n```\n/ghagga review\nthanks';
    expect(parseCommentCommand(body)).toEqual({ command: 'review', reviewMode: null });
  });

  it('handles CRLF line endings (trailing \\r does not break the match)', () => {
    // The line passed to COMMAND_REGEX is "/ghagga review\r"; [\w-]+ stops before
    // the \r, so the command captures cleanly as "review".
    expect(parseCommentCommand('/ghagga review\r\n')).toEqual({
      command: 'review',
      reviewMode: null,
    });
  });

  it('returns "unknown" for unrecognized command', () => {
    expect(parseCommentCommand('/ghagga foobar')).toBe('unknown');
    expect(parseCommentCommand('ghagga deploy')).toBe('unknown');
  });

  it('returns null when no ghagga mention at all', () => {
    expect(parseCommentCommand('Looks good to me!')).toBeNull();
    expect(parseCommentCommand('review this please')).toBeNull();
  });
});

// ─── Comment Command Dispatch (integration) ──────────────────────

describe('comment command dispatch', () => {
  const makeCommentPayload = (body: string) => ({
    action: 'created',
    comment: {
      id: 777,
      body,
      user: { login: 'contributor-user', type: 'User' },
      author_association: 'CONTRIBUTOR',
    },
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/42' },
    },
    repository: { id: 12345, full_name: 'owner/repo' },
    installation: { id: 999 },
  });

  it('dispatches /ghagga security with workflow mode override', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(makeCommentPayload('/ghagga security'));
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('command', 'security');

    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.reviewMode).toBe('workflow');
  });

  it('dispatches /ghagga perf with workflow mode override', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(makeCommentPayload('/ghagga perf'));
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('command', 'perf');

    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.reviewMode).toBe('workflow');
  });

  it('dispatches /ghagga describe with simple mode override', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(makeCommentPayload('/ghagga describe'));
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('command', 'describe');

    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.reviewMode).toBe('simple');
  });

  it('dispatches /ghagga review using repo default mode (no override)', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    mockGetEffectiveRepoSettings.mockResolvedValue({
      providerChain: [],
      aiReviewEnabled: true,
      reviewMode: 'consensus',
      settings: {
        enableSemgrep: true,
        enableTrivy: true,
        enableCpd: false,
        enableMemory: true,
        customRules: [],
        ignorePatterns: ['*.md'],
        reviewLevel: 'standard',
      },
      source: 'repo',
    });
    const body = JSON.stringify(makeCommentPayload('/ghagga review'));
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toHaveProperty('command', 'review');

    // Should use repo's effective reviewMode, not an override
    const jobData = mockEnqueueReview.mock.calls[0]?.[0];
    expect(jobData.reviewMode).toBe('consensus');
  });

  it('returns 200 with message for unknown command /ghagga foobar', async () => {
    const body = JSON.stringify(makeCommentPayload('/ghagga foobar'));
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('Unknown ghagga command');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  it('backward compat: "ghagga review" without slash still dispatches', async () => {
    mockGetRepoByGithubId.mockResolvedValue(FAKE_REPO);
    const body = JSON.stringify(makeCommentPayload('ghagga review'));
    const req = makeRequest(body, 'issue_comment');
    const res = await router.fetch(req);

    expect(res.status).toBe(202);
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
  });
});

// ─── Installation Deleted — Mapping Cleanup ─────────────────────

describe('installation.deleted — mapping cleanup', () => {
  const deletePayload = {
    action: 'deleted',
    installation: {
      id: 12345,
      account: { login: 'my-org', type: 'Organization' },
    },
  };

  it('S-R10.1: deactivates installation and deletes associated mappings', async () => {
    // Internal installation record exists with id=5
    mockGetInstallationByGitHubId.mockResolvedValueOnce({
      id: 5,
      githubInstallationId: 12345,
      accountLogin: 'my-org',
    });

    const body = JSON.stringify(deletePayload);
    const req = makeRequest(body, 'installation');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty('message', 'Installation deactivated');

    // Deactivation happens first
    expect(mockDeactivateInstallation).toHaveBeenCalledWith(expect.anything(), 12345);
    // Then lookup internal installation
    expect(mockGetInstallationByGitHubId).toHaveBeenCalledWith(expect.anything(), 12345);
    // Then delete mappings by internal ID
    expect(mockDeleteMappingsByInstallationId).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('S-R10.2: no error when no mappings exist for installation', async () => {
    // Internal installation exists but no mappings (deleteMappingsByInstallationId is a no-op)
    mockGetInstallationByGitHubId.mockResolvedValueOnce({
      id: 5,
      githubInstallationId: 12345,
      accountLogin: 'my-org',
    });
    mockDeleteMappingsByInstallationId.mockResolvedValueOnce(undefined);

    const body = JSON.stringify(deletePayload);
    const req = makeRequest(body, 'installation');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    expect(mockDeleteMappingsByInstallationId).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('handles case when internal installation record is not found', async () => {
    // getInstallationByGitHubId returns null (e.g., DB inconsistency)
    mockGetInstallationByGitHubId.mockResolvedValueOnce(null);

    const body = JSON.stringify(deletePayload);
    const req = makeRequest(body, 'installation');
    const res = await router.fetch(req);

    expect(res.status).toBe(200);
    expect(mockDeactivateInstallation).toHaveBeenCalledOnce();
    // Should NOT attempt to delete mappings without internal ID
    expect(mockDeleteMappingsByInstallationId).not.toHaveBeenCalled();
  });
});
