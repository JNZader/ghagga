/**
 * Issue-draft approval API tests (Phase 6).
 *
 * Builds an app from `createIssueDraftsRouter` with an injected auth user and
 * mocked DB + GitHub client. Asserts the security-critical invariants:
 *   - a user CANNOT list/read/approve another repo's drafts (403 / scoped-out)
 *   - approve posts via postComment, records the comment id, transitions POSTED
 *   - approve is idempotent: a POSTED draft does NOT re-post
 *   - reject transitions REJECTED and NEVER posts
 *   - edit persists the body (DRAFT-only)
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── DB mocks ───────────────────────────────────────────────────

const mockGetReposByInstallationId = vi.fn();
const mockGetIssueDraftById = vi.fn();
const mockListIssueDrafts = vi.fn();
const mockUpdateIssueDraftBody = vi.fn();
const mockMarkIssueDraftPosted = vi.fn();
const mockRejectIssueDraft = vi.fn();
const mockGetRepositoryById = vi.fn();
const mockGetInstallationById = vi.fn();

vi.mock('ghagga-db', () => ({
  ISSUE_DRAFT_STATUSES: ['DRAFT', 'APPROVED', 'REJECTED', 'POSTED'],
  getReposByInstallationId: (...a: unknown[]) => mockGetReposByInstallationId(...a),
  getIssueDraftById: (...a: unknown[]) => mockGetIssueDraftById(...a),
  listIssueDrafts: (...a: unknown[]) => mockListIssueDrafts(...a),
  updateIssueDraftBody: (...a: unknown[]) => mockUpdateIssueDraftBody(...a),
  markIssueDraftPosted: (...a: unknown[]) => mockMarkIssueDraftPosted(...a),
  rejectIssueDraft: (...a: unknown[]) => mockRejectIssueDraft(...a),
  getRepositoryById: (...a: unknown[]) => mockGetRepositoryById(...a),
  getInstallationById: (...a: unknown[]) => mockGetInstallationById(...a),
}));

const mockPostComment = vi.fn();
const mockGetInstallationToken = vi.fn();

vi.mock('../../github/client.js', () => ({
  postComment: (...a: unknown[]) => mockPostComment(...a),
  getInstallationToken: (...a: unknown[]) => mockGetInstallationToken(...a),
}));

vi.mock('./utils.js', () => ({
  generateErrorId: () => 'err-test',
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { createIssueDraftsRouter } from './issue-drafts.js';

// ─── Helpers ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: mock cast
const mockDb = {} as any;

const DEFAULT_USER = { githubUserId: 1, githubLogin: 'tester', installationIds: [100] };

function createApp(user = DEFAULT_USER) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', createIssueDraftsRouter(mockDb));
  return app;
}

function makeDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    repositoryId: 7,
    issueNumber: 42,
    issueTitle: 'Something broke',
    status: 'DRAFT',
    draftKind: 'ANALYSIS',
    body: 'analysis body',
    sources: [],
    dedupMatches: [],
    tokensUsed: 0,
    postedCommentId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Caller owns repo id 7 (installation 100 → repo 7). */
function ownRepo7() {
  mockGetReposByInstallationId.mockResolvedValue([{ id: 7 }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_APP_ID = 'app-id';
  process.env.GITHUB_PRIVATE_KEY = 'pk';
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── GET list ───────────────────────────────────────────────────

describe('GET /api/issue-drafts', () => {
  it('returns drafts scoped to the caller repos', async () => {
    ownRepo7();
    mockListIssueDrafts.mockResolvedValue([makeDraft()]);
    const app = createApp();

    const res = await app.request('/api/issue-drafts');
    const json = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    // listIssueDrafts was called with the caller's repo ids only.
    expect(mockListIssueDrafts).toHaveBeenCalledWith(mockDb, [7], expect.any(Object));
  });

  it('returns empty for a user with no installations (never another tenant)', async () => {
    const app = createApp({ githubUserId: 2, githubLogin: 'nobody', installationIds: [] });
    mockListIssueDrafts.mockResolvedValue([]);

    const res = await app.request('/api/issue-drafts');
    const json = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
    expect(mockListIssueDrafts).toHaveBeenCalledWith(mockDb, [], expect.any(Object));
  });

  it('rejects an invalid status filter', async () => {
    ownRepo7();
    const app = createApp();
    const res = await app.request('/api/issue-drafts?status=BOGUS');
    expect(res.status).toBe(400);
  });
});

// ─── GET detail (scoping) ───────────────────────────────────────

describe('GET /api/issue-drafts/:id', () => {
  it('returns 403 when the draft belongs to a repo the caller does not own', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft({ repositoryId: 999 }));
    mockGetReposByInstallationId.mockResolvedValue([{ id: 7 }]); // owns 7, not 999
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9');
    expect(res.status).toBe(403);
  });

  it('returns the draft when owned', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft());
    ownRepo7();
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9');
    expect(res.status).toBe(200);
  });

  it('returns 404 when not found', async () => {
    mockGetIssueDraftById.mockResolvedValue(undefined);
    const app = createApp();
    const res = await app.request('/api/issue-drafts/9');
    expect(res.status).toBe(404);
  });
});

// ─── PATCH edit ─────────────────────────────────────────────────

describe('PATCH /api/issue-drafts/:id', () => {
  it('persists the edited body (DRAFT-only)', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft());
    ownRepo7();
    mockUpdateIssueDraftBody.mockResolvedValue(makeDraft({ body: 'edited' }));
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'edited' }),
    });
    const json = (await res.json()) as { data: { body: string } };

    expect(res.status).toBe(200);
    expect(mockUpdateIssueDraftBody).toHaveBeenCalledWith(mockDb, 9, 'edited');
    expect(json.data.body).toBe('edited');
  });

  it('returns 409 when the draft is no longer in DRAFT', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft());
    ownRepo7();
    mockUpdateIssueDraftBody.mockResolvedValue(undefined); // not DRAFT
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'edited' }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 403 when not owned (cannot edit foreign draft)', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft({ repositoryId: 999 }));
    mockGetReposByInstallationId.mockResolvedValue([{ id: 7 }]);
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'edited' }),
    });
    expect(res.status).toBe(403);
    expect(mockUpdateIssueDraftBody).not.toHaveBeenCalled();
  });
});

// ─── POST approve ───────────────────────────────────────────────

describe('POST /api/issue-drafts/:id/approve', () => {
  it('posts the body, records the comment id, and transitions POSTED', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft());
    ownRepo7();
    mockGetRepositoryById.mockResolvedValue({
      id: 7,
      fullName: 'acme/app',
      installationId: 100,
    });
    mockGetInstallationById.mockResolvedValue({ id: 100, githubInstallationId: 555000 });
    mockGetInstallationToken.mockResolvedValue('tok');
    mockPostComment.mockResolvedValue({ id: 987654321 });
    mockMarkIssueDraftPosted.mockResolvedValue(
      makeDraft({ status: 'POSTED', postedCommentId: 987654321 }),
    );
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9/approve', { method: 'POST' });
    const json = (await res.json()) as { data: { status: string; postedCommentId: number } };

    expect(res.status).toBe(200);
    // posted to the issue comments endpoint with the (edited) body + repo token
    expect(mockPostComment).toHaveBeenCalledWith('acme', 'app', 42, 'analysis body', 'tok');
    // token resolved for the GITHUB installation id, not the internal row id
    expect(mockGetInstallationToken).toHaveBeenCalledWith(555000, 'app-id', 'pk');
    // POSTED transition recorded the github comment id
    expect(mockMarkIssueDraftPosted).toHaveBeenCalledWith(mockDb, 9, 987654321);
    expect(json.data.status).toBe('POSTED');
    expect(json.data.postedCommentId).toBe(987654321);
  });

  it('is idempotent: a POSTED draft does NOT re-post (409, no postComment)', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft({ status: 'POSTED', postedCommentId: 1 }));
    ownRepo7();
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9/approve', { method: 'POST' });

    expect(res.status).toBe(409);
    expect(mockPostComment).not.toHaveBeenCalled();
    expect(mockMarkIssueDraftPosted).not.toHaveBeenCalled();
  });

  it('does NOT post a draft for a repo the caller does not own (403)', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft({ repositoryId: 999 }));
    mockGetReposByInstallationId.mockResolvedValue([{ id: 7 }]);
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9/approve', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(mockPostComment).not.toHaveBeenCalled();
  });

  it('loses the race gracefully: markPosted returns undefined → 409', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft());
    ownRepo7();
    mockGetRepositoryById.mockResolvedValue({ id: 7, fullName: 'acme/app', installationId: 100 });
    mockGetInstallationById.mockResolvedValue({ id: 100, githubInstallationId: 555000 });
    mockGetInstallationToken.mockResolvedValue('tok');
    mockPostComment.mockResolvedValue({ id: 1 });
    mockMarkIssueDraftPosted.mockResolvedValue(undefined); // concurrent approve won
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9/approve', { method: 'POST' });
    expect(res.status).toBe(409);
  });
});

// ─── POST reject ────────────────────────────────────────────────

describe('POST /api/issue-drafts/:id/reject', () => {
  it('transitions REJECTED and NEVER posts', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft());
    ownRepo7();
    mockRejectIssueDraft.mockResolvedValue(makeDraft({ status: 'REJECTED' }));
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9/reject', { method: 'POST' });
    const json = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(json.data.status).toBe('REJECTED');
    expect(mockRejectIssueDraft).toHaveBeenCalledWith(mockDb, 9);
    expect(mockPostComment).not.toHaveBeenCalled();
  });

  it('returns 403 when not owned (cannot reject foreign draft)', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft({ repositoryId: 999 }));
    mockGetReposByInstallationId.mockResolvedValue([{ id: 7 }]);
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9/reject', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(mockRejectIssueDraft).not.toHaveBeenCalled();
  });

  it('returns 409 when already decided', async () => {
    mockGetIssueDraftById.mockResolvedValue(makeDraft());
    ownRepo7();
    mockRejectIssueDraft.mockResolvedValue(undefined);
    const app = createApp();

    const res = await app.request('/api/issue-drafts/9/reject', { method: 'POST' });
    expect(res.status).toBe(409);
  });
});
