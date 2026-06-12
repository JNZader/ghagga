/**
 * Dashboard API route tests.
 *
 * Tests all routes in createApiRouter with mocked DB functions,
 * injected auth user context, and comprehensive edge cases.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiRouter } from './api.js';

// ─── Mocks ──────────────────────────────────────────────────────

const mockGetReviewsByDay = vi.fn();
const mockGetReviewsByRepoId = vi.fn();
const mockCountReviewsByRepoId = vi.fn();
const mockGetReviewsByInstallationIds = vi.fn();
const mockCountReviewsByInstallationIds = vi.fn();
const mockGetReviewStats = vi.fn();
const mockGetRepoByFullName = vi.fn();
const mockGetReposByInstallationId = vi.fn();
const mockUpdateRepoSettings = vi.fn();
const mockGetInstallationSettings = vi.fn();
const mockGetInstallationSettingsBatch = vi.fn();
const mockUpsertInstallationSettings = vi.fn();
const mockGetInstallationById = vi.fn();
const mockGetSessionById = vi.fn();
const mockGetSessionsByProject = vi.fn();
const mockGetObservationsBySession = vi.fn();
const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();
const mockDeleteMemoryObservation = vi.fn();
const mockDeleteMemoryObservationsByIds = vi.fn();
const mockClearMemoryObservationsByProject = vi.fn();
const mockClearAllMemoryObservations = vi.fn();
const mockDeleteReviewById = vi.fn();
const mockDeleteReviewsByIds = vi.fn();
const mockDeleteReviewsByRepoId = vi.fn();
const mockDeleteMemorySession = vi.fn();
const mockClearEmptyMemorySessions = vi.fn();
const mockGetRepositoryById = vi.fn();
const mockUpdateWorkflowStatus = vi.fn();

vi.mock('ghagga-db', () => ({
  getReviewsByDay: (...args: unknown[]) => mockGetReviewsByDay(...args),
  getReviewsByRepoId: (...args: unknown[]) => mockGetReviewsByRepoId(...args),
  countReviewsByRepoId: (...args: unknown[]) => mockCountReviewsByRepoId(...args),
  getReviewsByInstallationIds: (...args: unknown[]) => mockGetReviewsByInstallationIds(...args),
  countReviewsByInstallationIds: (...args: unknown[]) => mockCountReviewsByInstallationIds(...args),
  getReviewStats: (...args: unknown[]) => mockGetReviewStats(...args),
  getRepoByFullName: (...args: unknown[]) => mockGetRepoByFullName(...args),
  getReposByInstallationId: (...args: unknown[]) => mockGetReposByInstallationId(...args),
  updateRepoSettings: (...args: unknown[]) => mockUpdateRepoSettings(...args),
  getInstallationSettings: (...args: unknown[]) => mockGetInstallationSettings(...args),
  getInstallationSettingsBatch: (...args: unknown[]) => mockGetInstallationSettingsBatch(...args),
  upsertInstallationSettings: (...args: unknown[]) => mockUpsertInstallationSettings(...args),
  getInstallationById: (...args: unknown[]) => mockGetInstallationById(...args),
  getRepositoryById: (...args: unknown[]) => mockGetRepositoryById(...args),
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  getSessionsByProject: (...args: unknown[]) => mockGetSessionsByProject(...args),
  getObservationsBySession: (...args: unknown[]) => mockGetObservationsBySession(...args),
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  deleteMemoryObservation: (...args: unknown[]) => mockDeleteMemoryObservation(...args),
  deleteMemoryObservationsByIds: (...args: unknown[]) => mockDeleteMemoryObservationsByIds(...args),
  clearMemoryObservationsByProject: (...args: unknown[]) =>
    mockClearMemoryObservationsByProject(...args),
  clearAllMemoryObservations: (...args: unknown[]) => mockClearAllMemoryObservations(...args),
  deleteReviewById: (...args: unknown[]) => mockDeleteReviewById(...args),
  deleteReviewsByIds: (...args: unknown[]) => mockDeleteReviewsByIds(...args),
  deleteReviewsByRepoId: (...args: unknown[]) => mockDeleteReviewsByRepoId(...args),
  deleteMemorySession: (...args: unknown[]) => mockDeleteMemorySession(...args),
  clearEmptyMemorySessions: (...args: unknown[]) => mockClearEmptyMemorySessions(...args),
  updateWorkflowStatus: (...args: unknown[]) => mockUpdateWorkflowStatus(...args),
  DEFAULT_REPO_SETTINGS: {
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: true,
    enableMemory: true,
    customRules: [],
    ignorePatterns: ['*.md', '*.txt', '.gitignore', 'LICENSE', '*.lock'],
    reviewLevel: 'normal',
    enabledTools: undefined,
    disabledTools: [],
  },
}));

// Mock tool registry for settings API validation
vi.mock('ghagga-core', () => ({
  toolRegistry: {
    getAll: () => [
      { name: 'semgrep', displayName: 'Semgrep', category: 'security', tier: 'always-on' },
      { name: 'trivy', displayName: 'Trivy', category: 'sca', tier: 'always-on' },
      { name: 'cpd', displayName: 'CPD', category: 'duplication', tier: 'always-on' },
      { name: 'gitleaks', displayName: 'Gitleaks', category: 'secrets', tier: 'always-on' },
      { name: 'shellcheck', displayName: 'ShellCheck', category: 'linting', tier: 'always-on' },
      { name: 'markdownlint', displayName: 'markdownlint', category: 'docs', tier: 'always-on' },
      { name: 'lizard', displayName: 'Lizard', category: 'complexity', tier: 'always-on' },
      { name: 'ruff', displayName: 'Ruff', category: 'linting', tier: 'auto-detect' },
      { name: 'bandit', displayName: 'Bandit', category: 'security', tier: 'auto-detect' },
      {
        name: 'golangci-lint',
        displayName: 'golangci-lint',
        category: 'linting',
        tier: 'auto-detect',
      },
      { name: 'biome', displayName: 'Biome', category: 'linting', tier: 'auto-detect' },
      { name: 'pmd', displayName: 'PMD', category: 'quality', tier: 'auto-detect' },
      { name: 'psalm', displayName: 'Psalm', category: 'quality', tier: 'auto-detect' },
      { name: 'clippy', displayName: 'Clippy', category: 'linting', tier: 'auto-detect' },
      { name: 'hadolint', displayName: 'Hadolint', category: 'linting', tier: 'auto-detect' },
    ],
  },
}));

const mockValidateProviderKey = vi.fn();

vi.mock('../lib/provider-models.js', () => ({
  validateProviderKey: (...args: unknown[]) => mockValidateProviderKey(...args),
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Mock workflow injection
const mockInjectWorkflow = vi.fn();

vi.mock('../github/runner.js', () => ({
  injectWorkflow: (...args: unknown[]) => mockInjectWorkflow(...args),
}));

// Mock GitHub client
const mockGetInstallationToken = vi.fn();

vi.mock('../github/client.js', () => ({
  getInstallationToken: (...args: unknown[]) => mockGetInstallationToken(...args),
  verifyWebhookSignature: vi.fn(),
  postComment: vi.fn(),
  addCommentReaction: vi.fn(),
  fetchPRDetails: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: mock cast
const mockDb = {} as any;

const DEFAULT_USER = {
  githubUserId: 1,
  githubLogin: 'testuser',
  installationIds: [100],
};

function createApp(user = DEFAULT_USER) {
  const app = new Hono();
  // Inject mock user for testing (simulates auth middleware)
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', createApiRouter(mockDb));
  return app;
}

const FAKE_REPO = {
  id: 42,
  githubRepoId: 12345,
  installationId: 100,
  fullName: 'owner/repo',
  useGlobalSettings: false,
  aiReviewEnabled: true,
  reviewMode: 'simple',
  providerChain: [{ provider: 'gateway', model: 'auto', encryptedApiKey: 'enc-key-1' }],
  settings: {
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: false,
    enableMemory: true,
    customRules: ['no-console', 'no-debugger'],
    ignorePatterns: ['*.md'],
    reviewLevel: 'strict',
  },
};

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDecrypt.mockImplementation((v: string) => `decrypted-${v}`);
  mockEncrypt.mockImplementation((v: string) => `encrypted-${v}`);
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/reviews
// ═══════════════════════════════════════════════════════════════════

/**
 * Builds a full `reviews` DB row as the query layer returns it (storage shape:
 * repositoryId instead of repo, nullable summary/findings, Date createdAt,
 * internal columns like tokensUsed). The route maps this to the wire Review.
 */
function fakeDbReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    repositoryId: 42,
    prNumber: 10,
    status: 'PASSED',
    mode: 'simple',
    // Defaults mirror the REAL storage state: both columns are nullable and
    // rows commonly carry NULL — tests asserting non-null values opt in
    // explicitly via overrides.
    summary: null,
    findings: null,
    tokensUsed: 100,
    executionTimeMs: 1200,
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GET /api/reviews', () => {
  it('returns paginated reviews mapped to the wire Review contract (repo populated)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewsByRepoId.mockResolvedValueOnce([
      fakeDbReviewRow({
        id: 1,
        prNumber: 10,
        status: 'PASSED',
        summary: 'All good',
        findings: [],
        // New rows carry coverageComplete inside the metadata jsonb blob
        // (folded in by the review queue) — the DTO surfaces it on the wire.
        metadata: { mode: 'simple', coverageComplete: true },
      }),
      fakeDbReviewRow({ id: 2, prNumber: 11, status: 'FAILED', summary: null, findings: null }),
    ]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(2);

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo&page=1&limit=10');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([
      {
        id: 1,
        repo: 'owner/repo',
        prNumber: 10,
        status: 'PASSED',
        mode: 'simple',
        summary: 'All good',
        findings: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        coverageComplete: true,
      },
      {
        id: 2,
        repo: 'owner/repo',
        prNumber: 11,
        status: 'FAILED',
        mode: 'simple',
        // DB nullables are normalized so the contract's non-null fields hold.
        summary: '',
        findings: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    // Contract pin: EXACTLY the Review keys — no storage columns leak
    // (repositoryId, tokensUsed, executionTimeMs, metadata) and no fullName.
    // `coverageComplete` is emitted ONLY when the row's metadata blob carries
    // a boolean (row 1 here); legacy/SKIPPED rows omit the key entirely.
    expect(Object.keys(json.data[0]).sort()).toEqual([
      'coverageComplete',
      'createdAt',
      'findings',
      'id',
      'mode',
      'prNumber',
      'repo',
      'status',
      'summary',
    ]);
    expect(Object.keys(json.data[1])).not.toContain('coverageComplete');
    expect(json.pagination).toEqual({ page: 1, limit: 10, offset: 0, total: 2 });

    expect(mockGetReviewsByRepoId).toHaveBeenCalledWith(mockDb, 42, { limit: 10, offset: 0 });
    expect(mockCountReviewsByRepoId).toHaveBeenCalledWith(mockDb, 42);
  });

  it('uses default pagination when params not provided', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewsByRepoId.mockResolvedValueOnce([]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(0);

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pagination).toEqual({ page: 1, limit: 50, offset: 0, total: 0 });
  });

  // FIX A (DSH-A2): pagination.total reflects the FULL count, not the page
  // length. With more reviews than fit on a page, total must exceed data.length
  // so the dashboard can compute totalPages and reach pages beyond the first.
  it('returns pagination.total reflecting full count beyond the current page', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewsByRepoId.mockResolvedValueOnce([
      fakeDbReviewRow({ id: 1, prNumber: 10, status: 'PASSED' }),
      fakeDbReviewRow({ id: 2, prNumber: 11, status: 'FAILED' }),
    ]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(137);

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo&page=1&limit=50');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.pagination.total).toBe(137);
    expect(json.pagination.total).not.toBe(json.data.length);
  });

  it('caps limit at 100', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewsByRepoId.mockResolvedValueOnce([]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(0);

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo&limit=500');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pagination.limit).toBe(100);
  });

  it('calculates correct offset for page 3', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewsByRepoId.mockResolvedValueOnce([]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(0);

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo&page=3&limit=20');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pagination).toEqual({ page: 3, limit: 20, offset: 40, total: 0 });
  });

  it('returns 404 when repo is not found', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/reviews?repo=unknown/repo');

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
    expect(json.message).toBe('Repository not found');
  });

  it('returns 403 when user does not have access to repo installation', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999, // Not in user's installationIds
    });

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo');

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe('Forbidden');
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetRepoByFullName.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('FETCH_FAILED');
    expect(json.message).toBe('Failed to fetch reviews');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });

  // PR #185 follow-up M3: PARTIAL roundtrip — verify that a DB row with the
  // PARTIAL status survives the pipeline → DB → API → wire contract chain
  // without being rewritten, stripped, or coerced. This is the lightweight
  // integration test that replaces a full e2e (DB + frontend runner) until a
  // broader e2e harness exists.
  it('passes PARTIAL status through verbatim in the API response', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    const partialRow = fakeDbReviewRow({
      id: 99,
      prNumber: 42,
      status: 'PARTIAL' as const,
      summary: 'Static analysis ran but the AI agent failed midway.',
    });
    mockGetReviewsByRepoId.mockResolvedValueOnce([partialRow]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(1);

    const app = createApp();
    const res = await app.request('/api/reviews?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].status).toBe('PARTIAL');
    expect(json.data[0]).toEqual({
      id: 99,
      repo: 'owner/repo',
      prNumber: 42,
      status: 'PARTIAL',
      mode: 'simple',
      summary: 'Static analysis ran but the AI agent failed midway.',
      findings: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/reviews — "All repositories" (no repo param)  [FIX B / DSH-A3]
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/reviews (no repo → all caller installations)', () => {
  it('lists reviews across the caller installations and never another tenant', async () => {
    // Caller owns installations 100 and 200. The query layer is responsible
    // for excluding foreign tenants; we assert the route passes EXACTLY the
    // caller's installationIds down and returns the scoped rows unchanged.
    const user = { ...DEFAULT_USER, installationIds: [100, 200] };
    // Joined rows: each carries its repository fullName (storage shape).
    mockGetReviewsByInstallationIds.mockResolvedValueOnce([
      fakeDbReviewRow({
        id: 1,
        repositoryId: 42,
        prNumber: 10,
        fullName: 'owner/repo-a',
        // coverageComplete travels inside the metadata jsonb blob (see the
        // per-repo path test) — pinned here for the cross-installation path.
        metadata: { mode: 'simple', coverageComplete: false },
      }),
      fakeDbReviewRow({
        id: 2,
        repositoryId: 77,
        prNumber: 11,
        status: 'FAILED',
        fullName: 'owner/repo-b',
      }),
    ]);
    mockCountReviewsByInstallationIds.mockResolvedValueOnce(2);

    const app = createApp(user);
    const res = await app.request('/api/reviews');

    expect(res.status).toBe(200);
    const json = await res.json();
    // The join's fullName is mapped into the wire `repo` field per row.
    expect(json.data.map((r: { id: number; repo: string }) => [r.id, r.repo])).toEqual([
      [1, 'owner/repo-a'],
      [2, 'owner/repo-b'],
    ]);
    // Contract pin: EXACTLY the Review keys — no storage columns leak
    // (repositoryId, tokensUsed, executionTimeMs, metadata) and no fullName.
    // `coverageComplete` is emitted ONLY when the row's metadata blob carries
    // a boolean (row 1 here); legacy/SKIPPED rows omit the key entirely.
    expect(Object.keys(json.data[0]).sort()).toEqual([
      'coverageComplete',
      'createdAt',
      'findings',
      'id',
      'mode',
      'prNumber',
      'repo',
      'status',
      'summary',
    ]);
    expect(json.data[0].coverageComplete).toBe(false);
    expect(Object.keys(json.data[1])).not.toContain('coverageComplete');
    // Authz: the query layer is invoked with the caller's installations ONLY.
    expect(mockGetReviewsByInstallationIds).toHaveBeenCalledWith(mockDb, [100, 200], {
      limit: 50,
      offset: 0,
    });
    expect(mockCountReviewsByInstallationIds).toHaveBeenCalledWith(mockDb, [100, 200]);
    // The per-repo single-repo path must NOT have been touched.
    expect(mockGetRepoByFullName).not.toHaveBeenCalled();
    expect(mockGetReviewsByRepoId).not.toHaveBeenCalled();
    // No row belongs to a foreign tenant repo.
    expect(json.data.every((r: { repo: string }) => r.repo.startsWith('owner/'))).toBe(true);
  });

  it('returns pagination.total reflecting the full cross-installation count', async () => {
    const user = { ...DEFAULT_USER, installationIds: [100] };
    mockGetReviewsByInstallationIds.mockResolvedValueOnce([
      fakeDbReviewRow({ id: 1, repositoryId: 42, prNumber: 10, fullName: 'owner/repo-a' }),
    ]);
    mockCountReviewsByInstallationIds.mockResolvedValueOnce(83);

    const app = createApp(user);
    const res = await app.request('/api/reviews?page=2&limit=50');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pagination).toEqual({ page: 2, limit: 50, offset: 50, total: 83 });
    expect(json.pagination.total).not.toBe(json.data.length);
    expect(mockGetReviewsByInstallationIds).toHaveBeenCalledWith(mockDb, [100], {
      limit: 50,
      offset: 50,
    });
  });

  it('returns 200 with empty data + total 0 when caller has no installations', async () => {
    const user = { ...DEFAULT_USER, installationIds: [] };

    const app = createApp(user);
    const res = await app.request('/api/reviews');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
    expect(json.pagination).toEqual({ page: 1, limit: 50, offset: 0, total: 0 });
    // No query should run for an empty-installation caller.
    expect(mockGetReviewsByInstallationIds).not.toHaveBeenCalled();
    expect(mockCountReviewsByInstallationIds).not.toHaveBeenCalled();
  });

  it('returns 500 with errorId when the cross-installation query fails', async () => {
    mockGetReviewsByInstallationIds.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/reviews');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('FETCH_FAILED');
    expect(json.message).toBe('Failed to fetch reviews');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/stats
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/stats', () => {
  it('returns mapped review stats with reviewsByDay data', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewStats.mockResolvedValueOnce({
      total: 100,
      passed: 70,
      failed: 10,
      skipped: 5,
    });
    const fakeReviewsByDay = [
      { date: '2026-03-01', total: 3, passed: 2, failed: 1 },
      { date: '2026-03-02', total: 5, passed: 4, failed: 0 },
    ];
    mockGetReviewsByDay.mockResolvedValueOnce(fakeReviewsByDay);

    const app = createApp();
    const res = await app.request('/api/stats?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalReviews).toBe(100);
    expect(json.data.passed).toBe(70);
    expect(json.data.failed).toBe(10);
    expect(json.data.skipped).toBe(5);
    expect(json.data.needsHumanReview).toBe(15); // 100 - 70 - 10 - 5
    expect(json.data.passRate).toBe(70); // (70/100) * 100
    expect(json.data.reviewsByDay).toEqual(fakeReviewsByDay);
  });

  it('calls getReviewsByDay with correct repository id', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewStats.mockResolvedValueOnce({ total: 0, passed: 0, failed: 0, skipped: 0 });
    mockGetReviewsByDay.mockResolvedValueOnce([]);

    const app = createApp();
    await app.request('/api/stats?repo=owner/repo');

    expect(mockGetReviewsByDay).toHaveBeenCalledWith(mockDb, 42);
  });

  it('returns empty reviewsByDay when no reviews exist', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewStats.mockResolvedValueOnce({ total: 0, passed: 0, failed: 0, skipped: 0 });
    mockGetReviewsByDay.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/api/stats?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.reviewsByDay).toEqual([]);
  });

  it('handles zero total reviews (passRate = 0)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewStats.mockResolvedValueOnce({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    });
    mockGetReviewsByDay.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/api/stats?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.passRate).toBe(0);
    expect(json.data.needsHumanReview).toBe(0);
  });

  it('handles null stat values', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewStats.mockResolvedValueOnce({
      total: null,
      passed: null,
      failed: null,
      skipped: null,
    });
    mockGetReviewsByDay.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/api/stats?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalReviews).toBe(0);
    expect(json.data.passed).toBe(0);
    expect(json.data.failed).toBe(0);
    expect(json.data.skipped).toBe(0);
  });

  it('reviewsByDay entries contain date, total, passed, and failed', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetReviewStats.mockResolvedValueOnce({ total: 10, passed: 7, failed: 3, skipped: 0 });
    mockGetReviewsByDay.mockResolvedValueOnce([
      { date: '2026-03-05', total: 5, passed: 3, failed: 1 },
      { date: '2026-03-06', total: 5, passed: 4, failed: 2 },
    ]);

    const app = createApp();
    const res = await app.request('/api/stats?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    const days = json.data.reviewsByDay;
    expect(days).toHaveLength(2);
    expect(days[0]).toEqual({ date: '2026-03-05', total: 5, passed: 3, failed: 1 });
    expect(days[1]).toEqual({ date: '2026-03-06', total: 5, passed: 4, failed: 2 });
  });

  it('returns 400 when repo param is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/stats');

    expect(res.status).toBe(400);
  });

  it('returns 404 when repo not found', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/stats?repo=unknown/repo');

    expect(res.status).toBe(404);
  });

  it('returns 403 when user lacks access', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999,
    });

    const app = createApp();
    const res = await app.request('/api/stats?repo=owner/repo');

    expect(res.status).toBe(403);
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetRepoByFullName.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/stats?repo=owner/repo');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('FETCH_FAILED');
    expect(json.message).toBe('Failed to fetch stats');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/reviews/:repoFullName
// ═══════════════════════════════════════════════════════════════════

describe('DELETE /api/reviews/:repoFullName', () => {
  it('returns 200 with deletedReviews count (happy path)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockDeleteReviewsByRepoId.mockResolvedValueOnce(15);

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedReviews: 15, clearedMemory: null });
    expect(mockDeleteReviewsByRepoId).toHaveBeenCalledWith(mockDb, 42);
    expect(mockClearMemoryObservationsByProject).not.toHaveBeenCalled();
  });

  it('returns 200 with both counts when includeMemory=true', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockDeleteReviewsByRepoId.mockResolvedValueOnce(10);
    mockClearMemoryObservationsByProject.mockResolvedValueOnce(25);

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo?includeMemory=true', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedReviews: 10, clearedMemory: 25 });
    expect(mockDeleteReviewsByRepoId).toHaveBeenCalledWith(mockDb, 42);
    expect(mockClearMemoryObservationsByProject).toHaveBeenCalledWith(mockDb, 100, 'owner/repo');
  });

  it('returns clearedMemory: null when includeMemory is not set (default)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockDeleteReviewsByRepoId.mockResolvedValueOnce(5);

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.clearedMemory).toBeNull();
    expect(mockClearMemoryObservationsByProject).not.toHaveBeenCalled();
  });

  it('returns 200 with deletedReviews: 0 when no reviews exist', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockDeleteReviewsByRepoId.mockResolvedValueOnce(0);

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedReviews: 0, clearedMemory: null });
  });

  it('returns 404 when repo is not found', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/reviews/nonexistent%2Frepo', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
    expect(json.message).toBe('Repository not found');
    expect(mockDeleteReviewsByRepoId).not.toHaveBeenCalled();
  });

  it('returns 403 when user lacks access to repo installation', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999, // Not in user's installationIds
    });

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo', {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe('Forbidden');
    expect(mockDeleteReviewsByRepoId).not.toHaveBeenCalled();
  });

  it('URL-decodes the repoFullName parameter', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockDeleteReviewsByRepoId.mockResolvedValueOnce(3);

    const app = createApp();
    await app.request('/api/reviews/owner%2Frepo', {
      method: 'DELETE',
    });

    expect(mockGetRepoByFullName).toHaveBeenCalledWith(mockDb, 'owner/repo');
  });

  it('returns 500 with errorId on DB error during delete', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockDeleteReviewsByRepoId.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo', {
      method: 'DELETE',
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('DELETE_FAILED');
    expect(json.message).toBe('Failed to delete reviews');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });

  it('returns 500 with errorId when memory clear fails (partial failure)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockDeleteReviewsByRepoId.mockResolvedValueOnce(10);
    mockClearMemoryObservationsByProject.mockRejectedValueOnce(new Error('Memory clear failed'));

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo?includeMemory=true', {
      method: 'DELETE',
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('DELETE_FAILED');
    expect(json.message).toBe('Failed to delete reviews');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });

  it('returns 500 with errorId when getRepoByFullName throws', async () => {
    mockGetRepoByFullName.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/reviews/owner%2Frepo', {
      method: 'DELETE',
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('DELETE_FAILED');
    expect(json.message).toBe('Failed to delete reviews');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/repositories
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/repositories', () => {
  it('returns repos from all user installations (parallelized)', async () => {
    const user = { ...DEFAULT_USER, installationIds: [100, 200] };
    mockGetReposByInstallationId
      .mockResolvedValueOnce([{ id: 1, fullName: 'org/repo-a' }])
      .mockResolvedValueOnce([{ id: 2, fullName: 'org/repo-b' }]);

    const app = createApp(user);
    const res = await app.request('/api/repositories');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.data[0].fullName).toBe('org/repo-a');
    expect(json.data[1].fullName).toBe('org/repo-b');

    expect(mockGetReposByInstallationId).toHaveBeenCalledTimes(2);
    expect(mockGetReposByInstallationId).toHaveBeenCalledWith(mockDb, 100);
    expect(mockGetReposByInstallationId).toHaveBeenCalledWith(mockDb, 200);
  });

  it('returns empty array when user has no installations', async () => {
    const user = { ...DEFAULT_USER, installationIds: [] };
    const app = createApp(user);
    const res = await app.request('/api/repositories');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetReposByInstallationId.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/repositories');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('FETCH_FAILED');
    expect(json.message).toBe('Failed to fetch repositories');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/installations
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/installations', () => {
  it('returns installations the user has access to', async () => {
    mockGetInstallationById.mockResolvedValueOnce({
      id: 100,
      accountLogin: 'my-org',
      accountType: 'Organization',
    });

    const app = createApp();
    const res = await app.request('/api/installations');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([{ id: 100, accountLogin: 'my-org', accountType: 'Organization' }]);
  });

  it('skips installations that are not found in DB', async () => {
    const user = { ...DEFAULT_USER, installationIds: [100, 200] };
    mockGetInstallationById
      .mockResolvedValueOnce({ id: 100, accountLogin: 'org', accountType: 'Organization' })
      .mockResolvedValueOnce(null); // Installation 200 not found

    const app = createApp(user);
    const res = await app.request('/api/installations');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe(100);
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetInstallationById.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/installations');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('FETCH_FAILED');
    expect(json.message).toBe('Failed to fetch installations');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/installation-settings
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/installation-settings', () => {
  it('returns existing installation settings with masked keys', async () => {
    mockGetInstallationById.mockResolvedValueOnce({
      id: 100,
      accountLogin: 'my-org',
    });
    mockGetInstallationSettings.mockResolvedValueOnce({
      providerChain: [
        { provider: 'gateway', model: 'claude-sonnet-4-20250514', encryptedApiKey: 'enc-key' },
        { provider: 'cli-bridge', model: 'gpt-4o', encryptedApiKey: null },
      ],
      aiReviewEnabled: true,
      reviewMode: 'consensus',
      settings: {
        enableSemgrep: true,
        enableTrivy: false,
        enableCpd: true,
        enableMemory: false,
        customRules: ['rule-a', 'rule-b'],
        ignorePatterns: ['*.lock'],
      },
    });

    const app = createApp();
    const res = await app.request('/api/installation-settings?installation_id=100');

    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.data;

    expect(data.installationId).toBe(100);
    expect(data.accountLogin).toBe('my-org');
    expect(data.aiReviewEnabled).toBe(true);
    expect(data.reviewMode).toBe('consensus');
    expect(data.enableSemgrep).toBe(true);
    expect(data.enableTrivy).toBe(false);
    expect(data.enableCpd).toBe(true);
    expect(data.enableMemory).toBe(false);
    expect(data.customRules).toBe('rule-a\nrule-b');
    expect(data.ignorePatterns).toEqual(['*.lock']);

    // Provider chain: first entry has key, second doesn't
    expect(data.providerChain).toHaveLength(2);
    expect(data.providerChain[0].hasApiKey).toBe(true);
    expect(data.providerChain[0].maskedApiKey).toBeDefined();
    expect(data.providerChain[1].hasApiKey).toBe(false);
    expect(data.providerChain[1].maskedApiKey).toBeUndefined();
  });

  it('returns defaults when no settings exist', async () => {
    mockGetInstallationById.mockResolvedValueOnce({
      id: 100,
      accountLogin: 'my-org',
    });
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/installation-settings?installation_id=100');

    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.data;

    expect(data.providerChain).toEqual([]);
    expect(data.aiReviewEnabled).toBe(true);
    expect(data.reviewMode).toBe('simple');
    expect(data.enableSemgrep).toBe(true);
    expect(data.enableTrivy).toBe(true);
    expect(data.enableCpd).toBe(true);
    expect(data.enableMemory).toBe(true);
    expect(data.customRules).toBe('');
  });

  it('returns 400 when installation_id is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings');

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain('Missing or invalid installation_id');
  });

  it('returns 400 when installation_id is not a number', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings?installation_id=abc');

    expect(res.status).toBe(400);
  });

  it('returns 403 when user does not have access to installation', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings?installation_id=999');

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe('Forbidden');
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetInstallationById.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/installation-settings?installation_id=100');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('FETCH_FAILED');
    expect(json.message).toBe('Failed to fetch installation settings');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/installation-settings
// ═══════════════════════════════════════════════════════════════════

describe('PUT /api/installation-settings', () => {
  it('updates installation settings and encrypts new API keys', async () => {
    mockGetInstallationSettings.mockResolvedValueOnce(null); // No existing settings
    mockUpsertInstallationSettings.mockResolvedValueOnce({});

    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: 100,
        providerChain: [{ provider: 'gateway', model: 'auto', apiKey: 'sk-gw-new-key' }],
        aiReviewEnabled: false,
        reviewMode: 'consensus',
        enableSemgrep: false,
        enableTrivy: true,
        enableCpd: false,
        enableMemory: true,
        customRules: 'rule-one\nrule-two',
        ignorePatterns: ['*.lock', '*.md'],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.message).toBe('Installation settings updated');

    // Verify encrypt was called with the new key
    expect(mockEncrypt).toHaveBeenCalledWith('sk-gw-new-key');

    // Verify upsert was called with correct args
    expect(mockUpsertInstallationSettings).toHaveBeenCalledOnce();
    const [_db, installId, updates] = mockUpsertInstallationSettings.mock.calls[0];
    expect(installId).toBe(100);
    expect(updates.providerChain[0].encryptedApiKey).toBe('encrypted-sk-gw-new-key');
    expect(updates.aiReviewEnabled).toBe(false);
    expect(updates.reviewMode).toBe('consensus');
    expect(updates.settings.enableSemgrep).toBe(false);
    expect(updates.settings.customRules).toEqual(['rule-one', 'rule-two']);
    expect(updates.settings.ignorePatterns).toEqual(['*.lock', '*.md']);
  });

  it('preserves existing API key when no new key provided', async () => {
    mockGetInstallationSettings.mockResolvedValueOnce({
      providerChain: [
        {
          provider: 'gateway',
          model: 'auto',
          encryptedApiKey: 'existing-enc-key',
        },
      ],
      settings: {
        enableSemgrep: true,
        enableTrivy: true,
        enableCpd: true,
        enableMemory: true,
        customRules: [],
        ignorePatterns: [],
        reviewLevel: 'normal',
      },
    });
    mockUpsertInstallationSettings.mockResolvedValueOnce({});

    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: 100,
        providerChain: [
          { provider: 'gateway', model: 'auto' }, // No apiKey
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockEncrypt).not.toHaveBeenCalled();

    const [, , updates] = mockUpsertInstallationSettings.mock.calls[0];
    expect(updates.providerChain[0].encryptedApiKey).toBe('existing-enc-key');
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid JSON body');
  });

  it('returns 400 when installationId is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerChain: [] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain('Missing or invalid installationId');
  });

  it('returns 400 when installationId is not a number', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 'not-a-number' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 403 when user does not have access', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 999 }),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid provider (ollama)', async () => {
    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: 100,
        providerChain: [{ provider: 'ollama', model: 'llama3' }],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain("Provider 'ollama' is not available");
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetInstallationSettings.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/installation-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: 100,
        providerChain: [{ provider: 'gateway', model: 'auto', apiKey: 'key' }],
      }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('UPDATE_FAILED');
    expect(json.message).toBe('Failed to update installation settings');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/settings
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/settings', () => {
  it('returns repo settings with masked keys and global settings', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    // Global settings for reference
    mockGetInstallationSettings.mockResolvedValueOnce({
      providerChain: [{ provider: 'gateway', model: 'auto', encryptedApiKey: 'global-enc-key' }],
      aiReviewEnabled: true,
      reviewMode: 'simple',
      settings: {
        enableSemgrep: true,
        enableTrivy: true,
        enableCpd: true,
        enableMemory: true,
        customRules: ['global-rule'],
        ignorePatterns: ['*.lock'],
      },
    });

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.data;

    expect(data.repoId).toBe(42);
    expect(data.repoFullName).toBe('owner/repo');
    expect(data.useGlobalSettings).toBe(false);
    expect(data.aiReviewEnabled).toBe(true);
    expect(data.reviewMode).toBe('simple');
    expect(data.enableSemgrep).toBe(true);
    expect(data.enableTrivy).toBe(true);
    expect(data.enableCpd).toBe(false);
    expect(data.enableMemory).toBe(true);
    expect(data.customRules).toBe('no-console\nno-debugger');
    expect(data.ignorePatterns).toEqual(['*.md']);

    // Provider chain: keys are masked
    expect(data.providerChain).toHaveLength(1);
    expect(data.providerChain[0].provider).toBe('gateway');
    expect(data.providerChain[0].hasApiKey).toBe(true);
    expect(data.providerChain[0].maskedApiKey).toBeDefined();
    // No encryptedApiKey exposed
    expect(data.providerChain[0].encryptedApiKey).toBeUndefined();

    // Global settings reference
    expect(data.globalSettings).toBeDefined();
    expect(data.globalSettings.providerChain[0].provider).toBe('gateway');
    expect(data.globalSettings.providerChain[0].hasApiKey).toBe(true);
  });

  it('returns null globalSettings when no installation settings exist', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.globalSettings).toBeUndefined();
  });

  it('handles repo with empty providerChain and null settings fields', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      providerChain: [],
      settings: {
        enableSemgrep: false,
        enableTrivy: false,
        enableCpd: false,
        enableMemory: false,
        customRules: null,
        ignorePatterns: null,
        reviewLevel: 'soft',
      },
    });
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.providerChain).toEqual([]);
    expect(json.data.customRules).toBe('');
    expect(json.data.ignorePatterns).toEqual([]);
  });

  it('returns 400 when repo param is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/settings');

    expect(res.status).toBe(400);
  });

  it('returns 404 when repo not found', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=unknown/repo');

    expect(res.status).toBe(404);
  });

  it('returns 403 when user lacks access', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999,
    });

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    expect(res.status).toBe(403);
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetRepoByFullName.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PUT /api/settings
// ═══════════════════════════════════════════════════════════════════

describe('PUT /api/settings', () => {
  // Bug 2 fix: PUT /api/settings now calls getInstallationSettings to fetch the global
  // provider chain as a fallback when the repo has no key for a provider.
  // Default to returning null (no global settings) for all tests unless overridden.
  beforeEach(() => {
    mockGetInstallationSettings.mockResolvedValue(null);
  });

  it('updates repo settings with encrypted new API keys', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [{ provider: 'gateway', model: 'auto', apiKey: 'sk-new-gw-key' }],
        aiReviewEnabled: true,
        reviewMode: 'workflow',
        enableSemgrep: true,
        enableTrivy: false,
        enableCpd: true,
        enableMemory: false,
        customRules: 'my-rule-1\nmy-rule-2',
        ignorePatterns: ['*.md', '*.txt'],
        useGlobalSettings: false,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.message).toBe('Settings updated');

    expect(mockEncrypt).toHaveBeenCalledWith('sk-new-gw-key');
    expect(mockUpdateRepoSettings).toHaveBeenCalledOnce();

    const [_db, repoId, updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(repoId).toBe(42);
    expect(updates.providerChain[0].provider).toBe('gateway');
    expect(updates.providerChain[0].encryptedApiKey).toBe('encrypted-sk-new-gw-key');
    expect(updates.aiReviewEnabled).toBe(true);
    expect(updates.reviewMode).toBe('workflow');
    expect(updates.useGlobalSettings).toBe(false);
    expect(updates.settings.enableSemgrep).toBe(true);
    expect(updates.settings.enableTrivy).toBe(false);
    expect(updates.settings.customRules).toEqual(['my-rule-1', 'my-rule-2']);
    expect(updates.settings.ignorePatterns).toEqual(['*.md', '*.txt']);
  });

  it('rejects persisting a gateway entry with a private gatewayUrl (SSRF guard)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [
          {
            provider: 'gateway',
            model: 'auto',
            apiKey: 'sk-new-gw-key',
            gatewayUrl: 'http://127.0.0.1:6379',
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    // Generic message only — no IP/range details leaked to the client
    expect(json.message).toBe('Gateway URL not allowed');
    expect(mockUpdateRepoSettings).not.toHaveBeenCalled();
  });

  it('accepts persisting a gateway entry with a public gatewayUrl', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [
          {
            provider: 'gateway',
            model: 'auto',
            apiKey: 'sk-new-gw-key',
            gatewayUrl: 'https://8.8.8.8/v1',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateRepoSettings).toHaveBeenCalledOnce();
  });

  it('preserves existing encrypted key when no new key provided', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [
          { provider: 'gateway', model: 'auto' }, // No apiKey
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockEncrypt).not.toHaveBeenCalled();

    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    // Should preserve existing encryptedApiKey from FAKE_REPO's providerChain
    expect(updates.providerChain[0].encryptedApiKey).toBe('enc-key-1');
  });

  it('sets null for provider with no existing key and no new key', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [
          { provider: 'cli-bridge', model: 'auto' }, // No existing key in FAKE_REPO (FAKE_REPO uses gateway)
        ],
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.providerChain[0].encryptedApiKey).toBeNull();
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid JSON body');
  });

  it('returns 400 when repoFullName is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerChain: [] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Missing repoFullName');
  });

  it('returns 404 when repo not found', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'unknown/repo' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 403 when user lacks access', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999,
    });

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'owner/repo' }),
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid provider (ollama)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [{ provider: 'ollama', model: 'llama3' }],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain("Provider 'ollama' is not available");
  });

  it('handles empty providerChain', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [],
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.providerChain).toEqual([]);
  });

  it('preserves current settings when fields are not provided', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        // No settings fields provided — should preserve FAKE_REPO.settings
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.settings.enableSemgrep).toBe(true); // From FAKE_REPO
    expect(updates.settings.enableCpd).toBe(false); // From FAKE_REPO
    expect(updates.aiReviewEnabled).toBeUndefined(); // Not passed
    expect(updates.reviewMode).toBeUndefined(); // Not passed
    expect(updates.useGlobalSettings).toBeUndefined(); // Not passed
  });

  it('returns 500 with errorId on DB error', async () => {
    mockGetRepoByFullName.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoFullName: 'owner/repo' }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('UPDATE_FAILED');
    expect(json.message).toBe('Failed to update settings');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });

  // ── Negative Zod schema validation tests ────────────────────

  it('returns 400 for invalid reviewLevel enum value', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        reviewLevel: 'invalid',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid settings');
    expect(json.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'reviewLevel' })]),
    );
  });

  it('returns 400 when boolean field receives string "true"', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        enableSemgrep: 'true',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid settings');
    expect(json.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'enableSemgrep' })]),
    );
  });

  it('returns 400 when ignorePatterns contains non-string items', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        ignorePatterns: [123, true],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid settings');
    expect(json.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('ignorePatterns') }),
      ]),
    );
  });

  it('returns 400 when multiple boolean fields receive wrong types', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        enableTrivy: 'false',
        enableCpd: 1,
        enableMemory: null,
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.details.length).toBeGreaterThanOrEqual(2);
  });

  it('ignores unknown top-level fields (not passed to Zod schema)', async () => {
    // The endpoint extracts only known SETTINGS_KEYS before Zod validation,
    // so unknown fields never reach .strict() and are silently ignored.
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        unknownField: 'test',
        anotherUnknown: 42,
      }),
    });

    // Unknown fields are filtered out before reaching the schema,
    // so the request succeeds (no settings fields to validate).
    expect(res.status).toBe(200);
  });

  // ── Bug 2: fallback to global chain when repo has no key ──────

  it('copies encrypted key from global chain when repo has no key for provider (Bug 2 fix)', async () => {
    // Repo with no key for 'cli-bridge' (only has 'gateway')
    const repoWithoutCliBridgeKey = {
      ...FAKE_REPO,
      providerChain: [{ provider: 'gateway', model: 'auto', encryptedApiKey: 'enc-key-1' }],
    };
    mockGetRepoByFullName.mockResolvedValueOnce(repoWithoutCliBridgeKey);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    // Global installation settings DO have a cli-bridge key
    mockGetInstallationSettings.mockResolvedValueOnce({
      providerChain: [{ provider: 'cli-bridge', model: 'auto', encryptedApiKey: 'enc-global-cli' }],
    });

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [
          // User pre-filled from global — no apiKey sent (only hasExistingKey was shown)
          { provider: 'cli-bridge', model: 'auto' },
        ],
        useGlobalSettings: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockEncrypt).not.toHaveBeenCalled(); // No new key was encrypted

    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    // Key should be copied from global chain, NOT silently set to null
    expect(updates.providerChain[0].provider).toBe('cli-bridge');
    expect(updates.providerChain[0].encryptedApiKey).toBe('enc-global-cli');
  });

  it('still returns null when neither repo nor global chain has a key for the provider', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);
    // Global chain also has no key for 'cli-bridge' (null from beforeEach is already set)

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        providerChain: [{ provider: 'cli-bridge', model: 'auto' }],
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.providerChain[0].encryptedApiKey).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/providers/keys
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/providers/keys', () => {
  // Endpoint now uses getInstallationSettingsBatch (single query) instead of
  // N individual getInstallationSettings calls.
  it('returns masked keys grouped by provider from installation settings', async () => {
    mockGetInstallationSettingsBatch.mockResolvedValueOnce([
      {
        providerChain: [
          { provider: 'gateway', model: 'claude-sonnet-4-20250514', encryptedApiKey: 'enc-gw' },
          { provider: 'cli-bridge', model: 'gpt-4o', encryptedApiKey: 'enc-cli' },
        ],
      },
    ]);

    const app = createApp();
    const res = await app.request('/api/providers/keys');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveProperty('gateway');
    expect(json.data).toHaveProperty('cli-bridge');
    // Keys must be masked, not raw/encrypted
    expect(json.data.gateway.maskedApiKey).toMatch(/\.\.\./);
    expect(json.data.gateway.source).toBe('global');
    // Verify single batch query was called (not N individual queries)
    expect(mockGetInstallationSettingsBatch).toHaveBeenCalledOnce();
    expect(mockGetInstallationSettings).not.toHaveBeenCalled();
  });

  it('returns empty object when no installations have saved keys', async () => {
    mockGetInstallationSettingsBatch.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/api/providers/keys');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({});
  });

  it('skips providers without encrypted keys (e.g., cli-bridge)', async () => {
    mockGetInstallationSettingsBatch.mockResolvedValueOnce([
      {
        providerChain: [
          { provider: 'cli-bridge', model: 'gpt-4o-mini', encryptedApiKey: null },
          { provider: 'gateway', model: 'gpt-4o', encryptedApiKey: 'enc-gw' },
        ],
      },
    ]);

    const app = createApp();
    const res = await app.request('/api/providers/keys');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).not.toHaveProperty('cli-bridge');
    expect(json.data).toHaveProperty('gateway');
  });

  it('never exposes raw or encrypted key values', async () => {
    mockGetInstallationSettingsBatch.mockResolvedValueOnce([
      {
        providerChain: [
          { provider: 'gateway', model: 'claude-sonnet-4-20250514', encryptedApiKey: 'enc-gw' },
        ],
      },
    ]);

    const app = createApp();
    const res = await app.request('/api/providers/keys');
    const json = await res.json();

    const body = JSON.stringify(json);
    expect(body).not.toContain('enc-gw');
    expect(json.data.gateway.maskedApiKey).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/providers/validate
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/providers/validate', () => {
  it('returns 400 for invalid JSON body', async () => {
    const app = createApp();
    const res = await app.request('/api/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid JSON body');
  });

  it('returns 400 when provider is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'some-key' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Missing provider field');
  });

  it('returns 400 for ollama provider', async () => {
    const app = createApp();
    const res = await app.request('/api/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', apiKey: 'key' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain('Ollama is not available');
  });

  it('returns 400 for unknown provider', async () => {
    const app = createApp();
    const res = await app.request('/api/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'mistral', apiKey: 'key' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain('Unknown provider');
  });

  // ── SSRF guard on gateway health check ──

  it('rejects a private gateway URL without fetching it (SSRF guard)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const app = createApp();
    const res = await app.request('/api/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'gateway',
        gatewayUrl: 'http://169.254.169.254/latest/meta-data',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toBe('Gateway URL not allowed');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns generic "Gateway unreachable" on fetch failure (no err.message echo)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 8.8.8.8:443 internal-details'));

    const app = createApp();
    const res = await app.request('/api/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gateway', gatewayUrl: 'https://8.8.8.8' }),
    });

    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toBe('Gateway unreachable');
    expect(JSON.stringify(json)).not.toContain('ECONNREFUSED');
    fetchSpy.mockRestore();
  });

  it('returns generic "Gateway unreachable" on non-OK health status (no status echo)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const app = createApp();
    const res = await app.request('/api/providers/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gateway', gatewayUrl: 'https://8.8.8.8' }),
    });

    const json = await res.json();
    expect(json.valid).toBe(false);
    expect(json.error).toBe('Gateway unreachable');
    expect(JSON.stringify(json)).not.toContain('403');
    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/memory/sessions
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/memory/sessions', () => {
  it('returns sessions for an accessible project', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    const fakeSessions = [
      { id: 1, project: 'owner/repo', createdAt: '2025-01-01', observationCount: 3 },
      { id: 2, project: 'owner/repo', createdAt: '2025-01-02', observationCount: 0 },
    ];
    mockGetSessionsByProject.mockResolvedValueOnce(fakeSessions);

    const app = createApp();
    const res = await app.request('/api/memory/sessions?project=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual(fakeSessions);
    expect(mockGetSessionsByProject).toHaveBeenCalledWith(mockDb, 'owner/repo');
  });

  it('returns 400 when project param is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/memory/sessions');

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain('Missing required query parameter: project');
  });

  it('returns 404 when project repo not found', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/memory/sessions?project=unknown/repo');

    expect(res.status).toBe(404);
  });

  it('returns 403 when user lacks access', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999,
    });

    const app = createApp();
    const res = await app.request('/api/memory/sessions?project=owner/repo');

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/memory/sessions/:id/observations
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/memory/sessions/:id/observations', () => {
  it('returns observations when user owns the session installation', async () => {
    mockGetSessionById.mockResolvedValueOnce({ id: 5, project: 'owner/repo' });
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    const fakeObservations = [
      { id: 1, title: 'Decision A', type: 'decision' },
      { id: 2, title: 'Pattern B', type: 'pattern' },
    ];
    mockGetObservationsBySession.mockResolvedValueOnce(fakeObservations);

    const app = createApp();
    const res = await app.request('/api/memory/sessions/5/observations');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual(fakeObservations);
    expect(mockGetSessionById).toHaveBeenCalledWith(mockDb, 5);
    expect(mockGetRepoByFullName).toHaveBeenCalledWith(mockDb, 'owner/repo');
    expect(mockGetObservationsBySession).toHaveBeenCalledWith(mockDb, 5);
  });

  it('returns 403 when session belongs to another installation', async () => {
    mockGetSessionById.mockResolvedValueOnce({ id: 5, project: 'other/repo' });
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999,
      fullName: 'other/repo',
    });

    const app = createApp();
    const res = await app.request('/api/memory/sessions/5/observations');

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe('Forbidden');
    expect(mockGetObservationsBySession).not.toHaveBeenCalled();
  });

  it('returns 404 when session does not exist', async () => {
    mockGetSessionById.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/memory/sessions/999/observations');

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
    expect(json.message).toBe('Session not found');
    expect(mockGetObservationsBySession).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid (non-numeric) session ID', async () => {
    const app = createApp();
    const res = await app.request('/api/memory/sessions/abc/observations');

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid session ID');
  });

  it('returns 403 when session project has no matching repo', async () => {
    mockGetSessionById.mockResolvedValueOnce({ id: 5, project: 'orphan/repo' });
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/memory/sessions/5/observations');

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe('Forbidden');
    expect(mockGetObservationsBySession).not.toHaveBeenCalled();
  });

  it('returns empty array when authorized session has no observations', async () => {
    mockGetSessionById.mockResolvedValueOnce({ id: 99, project: 'owner/repo' });
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockGetObservationsBySession.mockResolvedValueOnce([]);

    const app = createApp();
    const res = await app.request('/api/memory/sessions/99/observations');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// maskApiKey helper (tested via GET routes that expose maskedApiKey)
// ═══════════════════════════════════════════════════════════════════

describe('maskApiKey (via GET /api/settings)', () => {
  it('masks normal-length keys showing prefix and suffix', async () => {
    // Use a key that when "decrypted" is long enough (> 8 chars)
    const longKey = 'sk-abcdef-long-key-1234';
    mockDecrypt.mockReturnValue(longKey);

    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      providerChain: [
        { provider: 'gateway', model: 'claude-sonnet-4-20250514', encryptedApiKey: 'enc' },
      ],
    });
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    const json = await res.json();
    const masked = json.data.providerChain[0].maskedApiKey;

    // Should show first 3 + "..." + last 4
    expect(masked).toBe('sk-...1234');
  });

  it('masks short keys (<=8 chars) as ***', async () => {
    mockDecrypt.mockReturnValue('shortkey'); // exactly 8 chars

    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      providerChain: [
        { provider: 'gateway', model: 'claude-sonnet-4-20250514', encryptedApiKey: 'enc' },
      ],
    });
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    const json = await res.json();
    expect(json.data.providerChain[0].maskedApiKey).toBe('***');
  });

  it('masks very short keys as ***', async () => {
    mockDecrypt.mockReturnValue('ab'); // 2 chars

    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      providerChain: [
        { provider: 'gateway', model: 'claude-sonnet-4-20250514', encryptedApiKey: 'enc' },
      ],
    });
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    const json = await res.json();
    expect(json.data.providerChain[0].maskedApiKey).toBe('***');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/runner/install-workflow/status/:owner/:repo
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/runner/install-workflow/status/:owner/:repo', () => {
  it('returns installed: false when workflow not installed', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'testuser/test-repo',
      installationId: 100,
      workflowInstalledAt: null,
      workflowSha: null,
    });

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/status/testuser/test-repo', {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ installed: false, workflowInstalledAt: null, workflowSha: null });
  });

  it('returns installed: true when workflow is installed', async () => {
    const installedAt = new Date('2026-01-15T10:00:00Z');
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'testuser/test-repo',
      installationId: 100,
      workflowInstalledAt: installedAt,
      workflowSha: 'abc123sha',
    });

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/status/testuser/test-repo', {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.installed).toBe(true);
    expect(json.data.workflowSha).toBe('abc123sha');
  });

  it('returns 404 when repo is not tracked', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/status/unknown/repo', {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(404);
  });

  it('returns 404 (identical to not-tracked) when repo belongs to another installation', async () => {
    // Anti-enumeration: a foreign repo must be indistinguishable from an
    // untracked repo, so the guard returns 404 instead of 403.
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'victim/repo',
      installationId: 999, // NOT in DEFAULT_USER.installationIds ([100])
      workflowInstalledAt: null,
      workflowSha: null,
    });

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/status/victim/repo', {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(404);
    const forbiddenBody = await res.json();

    // Body must be byte-identical to the genuine not-found response
    mockGetRepoByFullName.mockResolvedValueOnce(null);
    const notFoundRes = await app.request('/api/runner/install-workflow/status/unknown/repo', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(notFoundRes.status).toBe(404);
    expect(forbiddenBody).toEqual(await notFoundRes.json());
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/runner/install-workflow/:owner/:repo
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/runner/install-workflow/:owner/:repo', () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = 'test-app-id';
    process.env.GITHUB_PRIVATE_KEY = 'test-private-key';
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_PRIVATE_KEY;
  });

  it('installs workflow and returns result', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'testuser/test-repo',
      installationId: 100,
      workflowInstalledAt: null,
      workflowSha: null,
    });
    mockGetInstallationToken.mockResolvedValueOnce('ghp_installation-token');
    mockInjectWorkflow.mockResolvedValueOnce({ sha: 'newsha123', created: true });
    mockUpdateWorkflowStatus.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/testuser/test-repo', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ installed: true, sha: 'newsha123', created: true });
  });

  it('returns 404 when repo is not tracked', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/unknown/repo', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(404);
  });

  it('returns 404 (identical to not-tracked) when repo belongs to another installation', async () => {
    // Cross-tenant attack: user from installation 100 tries to inject a
    // workflow into a repo owned by installation 999. The guard must block
    // BEFORE any token is minted or workflow injected, and the response must
    // be indistinguishable from "repo not tracked" (anti-enumeration 404).
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'victim/repo',
      installationId: 999, // NOT in DEFAULT_USER.installationIds ([100])
      workflowInstalledAt: null,
      workflowSha: null,
    });

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/victim/repo', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(404);
    const forbiddenBody = await res.json();

    // No installation token minted, no workflow injected, no DB write
    expect(mockGetInstallationToken).not.toHaveBeenCalled();
    expect(mockInjectWorkflow).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowStatus).not.toHaveBeenCalled();

    // Body must be byte-identical to the genuine not-found response
    mockGetRepoByFullName.mockResolvedValueOnce(null);
    const notFoundRes = await app.request('/api/runner/install-workflow/unknown/repo', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(notFoundRes.status).toBe(404);
    expect(forbiddenBody).toEqual(await notFoundRes.json());
  });

  it('allows an authorized user from the repo installation', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'testuser/test-repo',
      installationId: 100, // matches DEFAULT_USER.installationIds
      workflowInstalledAt: null,
      workflowSha: null,
    });
    mockGetInstallationToken.mockResolvedValueOnce('ghp_installation-token');
    mockInjectWorkflow.mockResolvedValueOnce({ sha: 'authzsha', created: true });
    mockUpdateWorkflowStatus.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/testuser/test-repo', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    expect(mockInjectWorkflow).toHaveBeenCalled();
  });

  it('returns 403 when branch protection blocks injection', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'testuser/protected-repo',
      installationId: 100,
      workflowInstalledAt: null,
      workflowSha: null,
    });
    mockGetInstallationToken.mockResolvedValueOnce('ghp_installation-token');
    mockInjectWorkflow.mockRejectedValueOnce(
      new Error('branch_protection: cannot write workflow file'),
    );

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/testuser/protected-repo', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('BRANCH_PROTECTION');
  });

  it('returns 502 on unexpected GitHub API error', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      id: 1,
      fullName: 'testuser/test-repo',
      installationId: 100,
      workflowInstalledAt: null,
      workflowSha: null,
    });
    mockGetInstallationToken.mockResolvedValueOnce('ghp_installation-token');
    mockInjectWorkflow.mockRejectedValueOnce(new Error('GitHub API timeout'));

    const app = createApp();
    const res = await app.request('/api/runner/install-workflow/testuser/test-repo', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe('WORKFLOW_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/reviews/batch
// ═══════════════════════════════════════════════════════════════════

describe('DELETE /api/reviews/batch', () => {
  it('returns 200 with deletedCount for valid batch', async () => {
    mockDeleteReviewsByIds.mockResolvedValueOnce(3);

    const app = createApp();
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [10, 20, 30] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedCount: 3 });
    expect(mockDeleteReviewsByIds).toHaveBeenCalledWith(mockDb, 100, [10, 20, 30]);
  });

  it('returns correct count when only some IDs are owned (partial ownership)', async () => {
    mockDeleteReviewsByIds.mockResolvedValueOnce(2); // Only 2 of 3 owned

    const app = createApp();
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [10, 20, 30] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedCount: 2 });
  });

  it('sums counts across multiple installations', async () => {
    mockDeleteReviewsByIds
      .mockResolvedValueOnce(1) // installation 100
      .mockResolvedValueOnce(2); // installation 200

    const multiInstallUser = {
      githubUserId: 1,
      githubLogin: 'testuser',
      installationIds: [100, 200],
    };

    const app = createApp(multiInstallUser);
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [10, 20, 30] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedCount: 3 });
    expect(mockDeleteReviewsByIds).toHaveBeenCalledTimes(2);
  });

  it('returns 400 for empty ids array', async () => {
    const app = createApp();
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);

    const app = createApp();
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-integer ids', async () => {
    const app = createApp();
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 'abc', 3] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for missing ids field', async () => {
    const app = createApp();
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 500 with errorId on server error', async () => {
    mockDeleteReviewsByIds.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/reviews/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('DELETE_FAILED');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/reviews/:reviewId (single review)
// ═══════════════════════════════════════════════════════════════════

describe('DELETE /api/reviews/:reviewId', () => {
  it('returns 200 with deleted:true when review is deleted', async () => {
    mockDeleteReviewById.mockResolvedValueOnce(true);

    const app = createApp();
    const res = await app.request('/api/reviews/42', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deleted: true });
    expect(mockDeleteReviewById).toHaveBeenCalledWith(mockDb, 100, 42);
  });

  it('returns 404 when review is not found', async () => {
    mockDeleteReviewById.mockResolvedValueOnce(false);

    const app = createApp();
    const res = await app.request('/api/reviews/9999', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
    expect(json.message).toBe('Review not found');
  });

  it('returns 404 when review belongs to another installation (unowned)', async () => {
    mockDeleteReviewById.mockResolvedValueOnce(false);

    const app = createApp();
    const res = await app.request('/api/reviews/42', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
  });

  it('tries each installationId until review is found', async () => {
    mockDeleteReviewById
      .mockResolvedValueOnce(false) // installation 100 — not found
      .mockResolvedValueOnce(true); // installation 200 — found

    const multiInstallUser = {
      githubUserId: 1,
      githubLogin: 'testuser',
      installationIds: [100, 200],
    };

    const app = createApp(multiInstallUser);
    const res = await app.request('/api/reviews/42', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deleted: true });
    expect(mockDeleteReviewById).toHaveBeenCalledTimes(2);
    expect(mockDeleteReviewById).toHaveBeenCalledWith(mockDb, 100, 42);
    expect(mockDeleteReviewById).toHaveBeenCalledWith(mockDb, 200, 42);
  });

  it('falls through to repoFullName handler for non-numeric param', async () => {
    // Non-numeric param is handled by the :repoFullName branch, not the :reviewId branch
    // 'abc' is treated as a repo full name; since it doesn't exist, returns 404
    mockGetRepoByFullName.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/reviews/abc', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
    expect(json.message).toBe('Repository not found');
  });

  it('returns 500 with errorId on server error', async () => {
    mockDeleteReviewById.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/reviews/42', {
      method: 'DELETE',
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('DELETE_FAILED');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/memory/observations/batch
// ═══════════════════════════════════════════════════════════════════

describe('DELETE /api/memory/observations/batch', () => {
  it('returns 200 with deletedCount for valid batch', async () => {
    mockDeleteMemoryObservationsByIds.mockResolvedValueOnce(3);

    const app = createApp();
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [5, 10, 15] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedCount: 3 });
    expect(mockDeleteMemoryObservationsByIds).toHaveBeenCalledWith(mockDb, 100, [5, 10, 15]);
  });

  it('returns correct count for partial ownership', async () => {
    mockDeleteMemoryObservationsByIds.mockResolvedValueOnce(2);

    const app = createApp();
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [5, 10, 15] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedCount: 2 });
  });

  it('sums counts across multiple installations', async () => {
    mockDeleteMemoryObservationsByIds
      .mockResolvedValueOnce(1) // installation 100
      .mockResolvedValueOnce(2); // installation 200

    const multiInstallUser = {
      githubUserId: 1,
      githubLogin: 'testuser',
      installationIds: [100, 200],
    };

    const app = createApp(multiInstallUser);
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [5, 10, 15] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ deletedCount: 3 });
    expect(mockDeleteMemoryObservationsByIds).toHaveBeenCalledTimes(2);
  });

  it('returns 400 for empty ids array', async () => {
    const app = createApp();
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);

    const app = createApp();
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for non-integer ids', async () => {
    const app = createApp();
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 'x'] }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for missing ids field', async () => {
    const app = createApp();
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 500 with errorId on server error', async () => {
    mockDeleteMemoryObservationsByIds.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/memory/observations/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('DELETE_FAILED');
    expect(json).toHaveProperty('errorId');
    expect(json.errorId).toHaveLength(8);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 6: Settings — enabledTools / disabledTools
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/settings — tool fields', () => {
  it('returns enabledTools, disabledTools, and registeredTools in response', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      settings: {
        ...FAKE_REPO.settings,
        enabledTools: [],
        disabledTools: ['cpd', 'markdownlint'],
      },
    });
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.data;

    expect(data.enabledTools).toEqual([]);
    expect(data.disabledTools).toEqual(['cpd', 'markdownlint']);
    expect(data.registeredTools).toBeDefined();
    expect(data.registeredTools).toHaveLength(15);
    expect(data.registeredTools[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        displayName: expect.any(String),
        category: expect.any(String),
        tier: expect.stringMatching(/^(always-on|auto-detect)$/),
      }),
    );
  });

  it('defaults enabledTools to [] and disabledTools to [] when not in DB', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      settings: {
        enableSemgrep: true,
        enableTrivy: true,
        enableCpd: true,
        enableMemory: true,
        customRules: [],
        ignorePatterns: [],
        reviewLevel: 'normal',
        // No enabledTools or disabledTools in DB
      },
    });
    mockGetInstallationSettings.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings?repo=owner/repo');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.enabledTools).toEqual([]);
    expect(json.data.disabledTools).toEqual([]);
  });
});

describe('PUT /api/settings — tool fields', () => {
  it('accepts disabledTools array and saves it', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        disabledTools: ['cpd', 'markdownlint'],
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.settings.disabledTools).toEqual(['cpd', 'markdownlint']);
    // Backward compat: disabledTools syncs to boolean fields
    expect(updates.settings.enableCpd).toBe(false);
    expect(updates.settings.enableSemgrep).toBe(true);
    expect(updates.settings.enableTrivy).toBe(true);
  });

  it('accepts enabledTools array and saves it', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        enabledTools: ['semgrep', 'trivy', 'gitleaks'],
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.settings.enabledTools).toEqual(['semgrep', 'trivy', 'gitleaks']);
  });

  it('returns 400 for invalid tool names in disabledTools', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        disabledTools: ['nonexistent-tool'],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain('nonexistent-tool');
  });

  it('returns 400 for invalid tool names in enabledTools', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        enabledTools: ['fake-tool', 'another-fake'],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toContain('fake-tool');
    expect(json.message).toContain('another-fake');
  });

  it('returns 400 when disabledTools is a string instead of array', async () => {
    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        disabledTools: 'semgrep',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    expect(json.message).toBe('Invalid settings');
  });

  it('new array fields take precedence over old booleans (spec: new fields override deprecated)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        enableSemgrep: false,
        enableTrivy: true,
        disabledTools: ['cpd', 'gitleaks'],
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    // disabledTools was explicitly sent — new fields take precedence over deprecated booleans
    expect(updates.settings.disabledTools).toEqual(['cpd', 'gitleaks']);
    expect(updates.settings.enableCpd).toBe(false); // 'cpd' in disabledTools → false
    // enableSemgrep: new array takes precedence — semgrep not in disabledTools → true
    expect(updates.settings.enableSemgrep).toBe(true);
    expect(updates.settings.enableTrivy).toBe(true);
  });

  it('translates old boolean enableSemgrep:false to disabledTools when new fields not sent', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      settings: {
        ...FAKE_REPO.settings,
        disabledTools: [],
      },
    });
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        enableSemgrep: false,
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.settings.enableSemgrep).toBe(false);
    // Should have added 'semgrep' to disabledTools
    expect(updates.settings.disabledTools).toContain('semgrep');
  });

  it('accepts valid tool names without error', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce(FAKE_REPO);
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        disabledTools: ['semgrep', 'trivy', 'cpd', 'gitleaks', 'ruff'],
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    expect(updates.settings.disabledTools).toEqual(['semgrep', 'trivy', 'cpd', 'gitleaks', 'ruff']);
  });

  it('preserves existing disabledTools when not sent in update', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({
      ...FAKE_REPO,
      settings: {
        ...FAKE_REPO.settings,
        disabledTools: ['cpd', 'markdownlint'],
      },
    });
    mockUpdateRepoSettings.mockResolvedValueOnce(undefined);

    const app = createApp();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoFullName: 'owner/repo',
        enableMemory: false,
      }),
    });

    expect(res.status).toBe(200);
    const [, , updates] = mockUpdateRepoSettings.mock.calls[0];
    // Should preserve existing disabledTools since we didn't send it
    expect(updates.settings.disabledTools).toEqual(['cpd', 'markdownlint']);
    expect(updates.settings.enableMemory).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/settings/copy-to-global
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/settings/copy-to-global', () => {
  it('copies repo settings to installation-level global settings', async () => {
    mockGetRepositoryById.mockResolvedValueOnce(FAKE_REPO);
    mockUpsertInstallationSettings.mockResolvedValueOnce({});

    const app = createApp();
    const res = await app.request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: 42 }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.message).toBe('Settings copied to global');

    // Verify upsertInstallationSettings was called with the repo's config
    expect(mockUpsertInstallationSettings).toHaveBeenCalledWith(
      mockDb,
      100, // installationId from FAKE_REPO
      expect.objectContaining({
        providerChain: FAKE_REPO.providerChain,
        aiReviewEnabled: FAKE_REPO.aiReviewEnabled,
        reviewMode: FAKE_REPO.reviewMode,
        settings: expect.objectContaining({
          enableSemgrep: true,
          enableTrivy: true,
          enableCpd: false,
          enableMemory: true,
        }),
      }),
    );
  });

  it('returns 400 when repoId is missing', async () => {
    const app = createApp();
    const res = await app.request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp();
    const res = await app.request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when repo does not exist', async () => {
    mockGetRepositoryById.mockResolvedValueOnce(null);

    const app = createApp();
    const res = await app.request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: 999 }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('NOT_FOUND');
  });

  it('returns 403 when user does not own the installation', async () => {
    mockGetRepositoryById.mockResolvedValueOnce({
      ...FAKE_REPO,
      installationId: 999, // Different installation
    });

    const app = createApp();
    const res = await app.request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: 42 }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
  });

  it('returns 500 when upsert fails', async () => {
    mockGetRepositoryById.mockResolvedValueOnce(FAKE_REPO);
    mockUpsertInstallationSettings.mockRejectedValueOnce(new Error('DB error'));

    const app = createApp();
    const res = await app.request('/api/settings/copy-to-global', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId: 42 }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('COPY_FAILED');
  });
});
