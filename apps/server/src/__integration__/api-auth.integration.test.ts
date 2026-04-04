/**
 * Integration: API Endpoints with Auth Middleware
 *
 * Tests the full HTTP flow through auth middleware -> API routes -> DB queries.
 * The auth middleware calls GitHub API to validate tokens; we mock `fetch`
 * globally to simulate GitHub responses. DB functions are mocked at module level.
 *
 * Addresses audit item #13: no tests validating auth middleware + API route wiring.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware } from '../middleware/auth.js';
import { createApiRouter } from '../routes/api.js';

// ─── Mocks ──────────────────────────────────────────────────────

// Mock ghagga-db
const mockGetRepoByFullName = vi.fn();
const mockGetReposByInstallationId = vi.fn();
const mockGetReviewStats = vi.fn();
const mockGetReviewsByDay = vi.fn();
const mockGetReviewsByRepoId = vi.fn();
const mockGetInstallationsByUserId = vi.fn();
const mockGetInstallationsByAccountLogin = vi.fn();
const mockUpsertUserMapping = vi.fn();
const mockGetRawMappingsByUserId = vi.fn();
const mockDeleteStaleUserMappings = vi.fn();
const mockGetInstallationById = vi.fn();
const mockGetInstallationSettings = vi.fn();
const mockUpsertInstallationSettings = vi.fn();
const mockUpdateRepoSettings = vi.fn();
const mockGetSessionsByProject = vi.fn();
const mockGetObservationsBySession = vi.fn();
const mockDeleteMemoryObservation = vi.fn();
const mockClearMemoryObservationsByProject = vi.fn();
const mockClearAllMemoryObservations = vi.fn();
const mockDeleteMemorySession = vi.fn();
const mockClearEmptyMemorySessions = vi.fn();

vi.mock('ghagga-db', () => ({
  getRepoByFullName: (...args: unknown[]) => mockGetRepoByFullName(...args),
  getReposByInstallationId: (...args: unknown[]) => mockGetReposByInstallationId(...args),
  getReviewStats: (...args: unknown[]) => mockGetReviewStats(...args),
  getReviewsByDay: (...args: unknown[]) => mockGetReviewsByDay(...args),
  getReviewsByRepoId: (...args: unknown[]) => mockGetReviewsByRepoId(...args),
  getInstallationsByUserId: (...args: unknown[]) => mockGetInstallationsByUserId(...args),
  getInstallationsByAccountLogin: (...args: unknown[]) =>
    mockGetInstallationsByAccountLogin(...args),
  upsertUserMapping: (...args: unknown[]) => mockUpsertUserMapping(...args),
  getRawMappingsByUserId: (...args: unknown[]) => mockGetRawMappingsByUserId(...args),
  deleteStaleUserMappings: (...args: unknown[]) => mockDeleteStaleUserMappings(...args),
  getInstallationById: (...args: unknown[]) => mockGetInstallationById(...args),
  getInstallationSettings: (...args: unknown[]) => mockGetInstallationSettings(...args),
  upsertInstallationSettings: (...args: unknown[]) => mockUpsertInstallationSettings(...args),
  updateRepoSettings: (...args: unknown[]) => mockUpdateRepoSettings(...args),
  getSessionsByProject: (...args: unknown[]) => mockGetSessionsByProject(...args),
  getObservationsBySession: (...args: unknown[]) => mockGetObservationsBySession(...args),
  encrypt: (v: string) => `encrypted-${v}`,
  decrypt: (v: string) => `decrypted-${v}`,
  deleteMemoryObservation: (...args: unknown[]) => mockDeleteMemoryObservation(...args),
  clearMemoryObservationsByProject: (...args: unknown[]) =>
    mockClearMemoryObservationsByProject(...args),
  clearAllMemoryObservations: (...args: unknown[]) => mockClearAllMemoryObservations(...args),
  deleteMemorySession: (...args: unknown[]) => mockDeleteMemorySession(...args),
  clearEmptyMemorySessions: (...args: unknown[]) => mockClearEmptyMemorySessions(...args),
  DEFAULT_REPO_SETTINGS: {
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: true,
    enableMemory: true,
    customRules: [],
    ignorePatterns: ['*.md', '*.txt', '.gitignore', 'LICENSE', '*.lock'],
    reviewLevel: 'normal',
  },
}));

// Mock logger (suppress noise)
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

// Mock provider validation
vi.mock('../lib/provider-models.js', () => ({
  validateProviderKey: vi.fn().mockResolvedValue({ valid: true, models: ['gpt-4o'] }),
}));

// Mock runner functions
vi.mock('../github/runner.js', () => ({
  injectWorkflow: vi.fn().mockResolvedValue({ sha: 'mock-sha', created: false }),
}));

// ─── Test Data ──────────────────────────────────────────────────

const VALID_TOKEN = 'ghp-valid-test-token';
const INVALID_TOKEN = 'ghp-expired-token';

const GITHUB_USER = {
  id: 42,
  login: 'testuser',
};

const INSTALLATION = {
  id: 100,
  accountLogin: 'testuser',
  accountType: 'User',
  isActive: true,
};

const FAKE_REPO = {
  id: 10,
  githubRepoId: 99999,
  installationId: 100,
  fullName: 'testuser/myapp',
  useGlobalSettings: false,
  aiReviewEnabled: true,
  reviewMode: 'simple',
  providerChain: [],
  settings: {
    enableSemgrep: true,
    enableTrivy: true,
    enableCpd: false,
    enableMemory: true,
    customRules: [],
    ignorePatterns: ['*.md'],
    reviewLevel: 'normal',
  },
};

// ─── Helpers ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: mock cast
const mockDb = {} as any;
let originalFetch: typeof globalThis.fetch;

/**
 * Build a full Hono app with real auth middleware + API routes.
 * The auth middleware will call `fetch` (mocked globally) for GitHub token validation.
 */
function buildApp() {
  const app = new Hono();
  app.use('/api/*', authMiddleware(mockDb));
  app.route('/', createApiRouter(mockDb));
  return app;
}

function apiRequest(path: string, token?: string, init?: RequestInit): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  });
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Save original fetch and replace with mock
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Mock GitHub /user API for auth middleware
    if (url === 'https://api.github.com/user') {
      const authHeader = (_init?.headers as Record<string, string>)?.Authorization ?? '';
      const token = authHeader.replace('Bearer ', '');

      if (token === VALID_TOKEN) {
        return new Response(JSON.stringify(GITHUB_USER), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Invalid token
      return new Response(JSON.stringify({ message: 'Bad credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fallback: 404
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;

  // Auth middleware will call getInstallationsByUserId after GitHub validation
  mockGetRawMappingsByUserId.mockResolvedValue([{ id: 1, installationId: 100 }]);
  mockGetInstallationsByUserId.mockResolvedValue([INSTALLATION]);
  mockGetInstallationsByAccountLogin.mockResolvedValue([INSTALLATION]);
  mockUpsertUserMapping.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Integration Tests ──────────────────────────────────────────

describe('integration: API endpoints with auth', () => {
  // S2.1: Authenticated request to /api/repositories returns data
  it('S2.1: authenticated GET /api/repositories returns repos from user installations', async () => {
    const repos = [
      { id: 10, fullName: 'testuser/myapp' },
      { id: 11, fullName: 'testuser/other' },
    ];
    mockGetReposByInstallationId.mockResolvedValue(repos);

    const app = buildApp();
    const res = await app.request(apiRequest('/api/repositories', VALID_TOKEN));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.data[0].fullName).toBe('testuser/myapp');
    expect(json.data[1].fullName).toBe('testuser/other');

    // Verify the auth chain: fetch /user -> DB lookup -> route handler
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(mockGetReposByInstallationId).toHaveBeenCalledWith(mockDb, 100);
  });

  // S2.2: Authenticated request to /api/stats returns mapped stats
  it('S2.2: authenticated GET /api/stats returns mapped review stats', async () => {
    mockGetRepoByFullName.mockResolvedValue(FAKE_REPO);
    mockGetReviewStats.mockResolvedValue({ total: 50, passed: 40, failed: 5, skipped: 2 });
    mockGetReviewsByDay.mockResolvedValue([{ date: '2026-03-07', total: 3, passed: 2, failed: 1 }]);

    const app = buildApp();
    const res = await app.request(apiRequest('/api/stats?repo=testuser/myapp', VALID_TOKEN));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.totalReviews).toBe(50);
    expect(json.data.passed).toBe(40);
    expect(json.data.failed).toBe(5);
    expect(json.data.skipped).toBe(2);
    expect(json.data.needsHumanReview).toBe(3); // 50 - 40 - 5 - 2
    expect(json.data.passRate).toBe(80); // (40/50) * 100
    expect(json.data.reviewsByDay).toHaveLength(1);
  });

  // S2.3: Missing Authorization header returns 401
  it('S2.3: request without Authorization header returns 401', async () => {
    const app = buildApp();
    const res = await app.request(apiRequest('/api/repositories'));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain('Missing or invalid Authorization');

    // Should NOT reach any DB query
    expect(mockGetReposByInstallationId).not.toHaveBeenCalled();
  });

  // S2.4: Invalid token returns 401
  it('S2.4: request with invalid token returns 401', async () => {
    const app = buildApp();
    const res = await app.request(apiRequest('/api/repositories', INVALID_TOKEN));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toContain('Invalid or expired token');

    // GitHub API was called but returned 401
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    // Should NOT reach DB queries
    expect(mockGetReposByInstallationId).not.toHaveBeenCalled();
  });

  // S2.5: Authenticated user accessing repo from different installation
  it('S2.5: user accessing repo from different installation returns 403', async () => {
    // User has installation 100, but the repo belongs to installation 999
    mockGetRepoByFullName.mockResolvedValue({
      ...FAKE_REPO,
      installationId: 999,
    });

    const app = buildApp();
    const res = await app.request(apiRequest('/api/stats?repo=otherorg/secret-repo', VALID_TOKEN));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('FORBIDDEN');
    expect(json.message).toBe('Forbidden');
  });
});
