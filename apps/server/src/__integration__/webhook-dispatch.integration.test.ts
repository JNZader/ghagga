/**
 * Integration: Webhook -> Review Dispatch
 *
 * Tests the full HTTP flow from GitHub webhook receipt through
 * signature verification, event routing, DB lookups, and BullMQ
 * review queue dispatch. All external services are mocked; the integration
 * boundary being tested is the wiring between these components.
 *
 * Addresses audit item #13: no tests validating webhook -> review dispatch flow.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebhookRouter } from '../routes/webhook.js';

// ─── Mocks ──────────────────────────────────────────────────────

const mockGetRepoByGithubId = vi.fn();
const mockGetEffectiveRepoSettings = vi.fn();
const mockUpsertInstallation = vi.fn();
const mockDeactivateInstallation = vi.fn();
const mockUpsertRepository = vi.fn();
const mockGetInstallationByGitHubId = vi.fn();
const mockDeleteMappingsByInstallationId = vi.fn();

vi.mock('ghagga-db', () => ({
  getRepoByGithubId: (...args: unknown[]) => mockGetRepoByGithubId(...args),
  getEffectiveRepoSettings: (...args: unknown[]) => mockGetEffectiveRepoSettings(...args),
  upsertInstallation: (...args: unknown[]) => mockUpsertInstallation(...args),
  deactivateInstallation: (...args: unknown[]) => mockDeactivateInstallation(...args),
  upsertRepository: (...args: unknown[]) => mockUpsertRepository(...args),
  getInstallationByGitHubId: (...args: unknown[]) => mockGetInstallationByGitHubId(...args),
  deleteMappingsByInstallationId: (...args: unknown[]) =>
    mockDeleteMappingsByInstallationId(...args),
  getDelegatedCiPolicy: vi.fn().mockResolvedValue(null),
  createDelegatedCiRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../delegated-ci/policy.js', () => ({
  evaluateAllJobs: vi.fn().mockReturnValue([]),
  normalizePolicy: vi.fn().mockReturnValue(null),
}));

const mockEnqueueReview = vi.fn();
vi.mock('../queues/review.js', () => ({
  enqueueReview: (...args: unknown[]) => mockEnqueueReview(...args),
}));

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

// ─── Test Data ──────────────────────────────────────────────────

const WEBHOOK_SECRET = 'integration-test-secret';

const TRACKED_REPO = {
  id: 42,
  githubRepoId: 12345,
  installationId: 1,
  fullName: 'acme/webapp',
  llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-20250514',
  reviewMode: 'simple',
  encryptedApiKey: 'encrypted-key-abc',
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

const EFFECTIVE_SETTINGS = {
  providerChain: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      encryptedApiKey: 'encrypted-key-abc',
    },
  ],
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
};

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

function webhookRequest(
  body: string,
  eventType: string,
  options: { signature?: string | null; omitSignature?: boolean } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-github-event': eventType,
  };
  if (!options.omitSignature) {
    headers['x-hub-signature-256'] = options.signature ?? sign(body);
  }
  return new Request('http://localhost/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

// ─── Setup ──────────────────────────────────────────────────────

let router: ReturnType<typeof createWebhookRouter>;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();

  savedEnv = {
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
  };
  process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.GITHUB_APP_ID = '99999';
  process.env.GITHUB_PRIVATE_KEY = 'test-private-key';

  // biome-ignore lint/suspicious/noExplicitAny: mock cast
  router = createWebhookRouter({} as any);

  // Default mock returns
  mockGetRepoByGithubId.mockResolvedValue(TRACKED_REPO);
  mockGetEffectiveRepoSettings.mockResolvedValue(EFFECTIVE_SETTINGS);
  mockEnqueueReview.mockResolvedValue(undefined);
  mockUpsertInstallation.mockResolvedValue({ id: 1 });
  mockUpsertRepository.mockResolvedValue({ id: 1 });
  mockGetInstallationToken.mockResolvedValue('ghs-fake-token');
  mockFetchPRDetails.mockResolvedValue({ headSha: 'abc123def', baseBranch: 'main' });
  mockAddCommentReaction.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
});

// ─── Integration Tests ──────────────────────────────────────────

describe('integration: webhook -> review dispatch', () => {
  // S1.1: Valid PR webhook triggers full dispatch flow
  it('S1.1: valid PR webhook triggers BullMQ enqueueReview with correct data shape', async () => {
    const payload = {
      action: 'opened',
      number: 99,
      pull_request: {
        number: 99,
        head: { sha: 'deadbeef' },
        base: { ref: 'main' },
      },
      repository: { id: 12345, full_name: 'acme/webapp' },
      installation: { id: 777 },
    };

    const body = JSON.stringify(payload);
    const res = await router.fetch(webhookRequest(body, 'pull_request'));

    // Verify HTTP response
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toMatchObject({
      message: 'Review dispatched',
      pr: 99,
      repo: 'acme/webapp',
    });

    // Verify the complete dispatch chain was called
    expect(mockGetRepoByGithubId).toHaveBeenCalledOnce();
    expect(mockGetEffectiveRepoSettings).toHaveBeenCalledOnce();
    expect(mockEnqueueReview).toHaveBeenCalledOnce();

    // Verify enqueueReview job data shape
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const jobData = mockEnqueueReview.mock.calls[0]![0];
    expect(jobData).toMatchObject({
      installationId: 777,
      repoFullName: 'acme/webapp',
      prNumber: 99,
      repositoryId: 42,
      headSha: 'deadbeef',
      baseBranch: 'main',
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: {
        enableSemgrep: true,
        enableTrivy: true,
        enableCpd: false,
        enableMemory: true,
      },
    });
    expect(jobData.providerChain).toBeDefined();
    expect(jobData.providerChain.length).toBeGreaterThan(0);
  });

  // S1.2: Invalid signature rejects and does NOT dispatch
  it('S1.2: invalid signature returns 401 and prevents dispatch', async () => {
    const payload = {
      action: 'opened',
      number: 99,
      pull_request: { number: 99, head: { sha: 'abc' }, base: { ref: 'main' } },
      repository: { id: 12345, full_name: 'acme/webapp' },
      installation: { id: 777 },
    };

    const body = JSON.stringify(payload);
    const res = await router.fetch(
      webhookRequest(body, 'pull_request', { signature: 'sha256=tampered' }),
    );

    expect(res.status).toBe(401);
    expect(mockGetRepoByGithubId).not.toHaveBeenCalled();
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });

  // S1.3: Non-PR events are acknowledged but not dispatched
  it('S1.3: non-PR events (star, push) return 200 without dispatching', async () => {
    for (const eventType of ['star', 'push', 'fork', 'watch']) {
      vi.clearAllMocks();
      const body = JSON.stringify({ action: 'created' });
      const res = await router.fetch(webhookRequest(body, eventType));

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.message).toContain('ignored');
      expect(mockEnqueueReview).not.toHaveBeenCalled();
    }
  });

  // S1.4: Comment trigger dispatches with triggerCommentId
  it('S1.4: comment trigger "ghagga review" dispatches with triggerCommentId and PR details', async () => {
    const payload = {
      action: 'created',
      comment: {
        id: 555,
        body: 'Please ghagga review this PR',
        user: { login: 'dev-user', type: 'User' },
        author_association: 'CONTRIBUTOR',
      },
      issue: {
        number: 42,
        pull_request: { url: 'https://api.github.com/repos/acme/webapp/pulls/42' },
      },
      repository: { id: 12345, full_name: 'acme/webapp' },
      installation: { id: 777 },
    };

    const body = JSON.stringify(payload);
    const res = await router.fetch(webhookRequest(body, 'issue_comment'));

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.message).toContain('comment trigger');
    expect(json.triggeredBy).toBe('dev-user');

    // Verify full chain: token -> reaction -> PR details -> dispatch
    expect(mockGetInstallationToken).toHaveBeenCalledOnce();
    expect(mockAddCommentReaction).toHaveBeenCalledWith(
      'acme',
      'webapp',
      555,
      'eyes',
      'ghs-fake-token',
    );
    expect(mockFetchPRDetails).toHaveBeenCalledWith('acme', 'webapp', 42, 'ghs-fake-token');

    // Verify enqueueReview job includes comment metadata
    expect(mockEnqueueReview).toHaveBeenCalledOnce();
    // biome-ignore lint/style/noNonNullAssertion: test assertion on known mock data
    const jobData = mockEnqueueReview.mock.calls[0]![0];
    expect(jobData.triggerCommentId).toBe(555);
    expect(jobData.headSha).toBe('abc123def');
    expect(jobData.baseBranch).toBe('main');
    expect(jobData.prNumber).toBe(42);
  });

  // S1.5: Unauthorized comment association does NOT dispatch
  it('S1.5: comment from NONE association does not trigger dispatch', async () => {
    const payload = {
      action: 'created',
      comment: {
        id: 666,
        body: 'ghagga review',
        user: { login: 'random-user', type: 'User' },
        author_association: 'NONE',
      },
      issue: {
        number: 10,
        pull_request: { url: 'https://api.github.com/repos/acme/webapp/pulls/10' },
      },
      repository: { id: 12345, full_name: 'acme/webapp' },
      installation: { id: 777 },
    };

    const body = JSON.stringify(payload);
    const res = await router.fetch(webhookRequest(body, 'issue_comment'));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toContain('Insufficient permissions');
    expect(mockEnqueueReview).not.toHaveBeenCalled();
  });
});
