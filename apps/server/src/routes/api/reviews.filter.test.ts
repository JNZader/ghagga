/**
 * Server-side reviews filtering (PRODOPS-005) + pagination validation
 * (PRODOPS-007).
 *
 * These exercise the FILTERED query path (status/search applied in SQL before
 * pagination, totals counted over the filtered predicate) and the runtime query
 * validation that rejects bad page/limit before any DB access.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetRepoByFullName = vi.fn();
const mockGetReviewsByRepoId = vi.fn();
const mockCountReviewsByRepoId = vi.fn();
const mockGetReviewsByInstallationIds = vi.fn();
const mockCountReviewsByInstallationIds = vi.fn();

// ghagga-db mock: the query fns used by the default path plus the drizzle
// primitives (eq/sql/tables) the filtered path composes. The primitives are
// inert markers — the chainable db mock ignores them and returns canned rows.
vi.mock('ghagga-db', () => ({
  getRepoByFullName: (...a: unknown[]) => mockGetRepoByFullName(...a),
  getReviewsByRepoId: (...a: unknown[]) => mockGetReviewsByRepoId(...a),
  countReviewsByRepoId: (...a: unknown[]) => mockCountReviewsByRepoId(...a),
  getReviewsByInstallationIds: (...a: unknown[]) => mockGetReviewsByInstallationIds(...a),
  countReviewsByInstallationIds: (...a: unknown[]) => mockCountReviewsByInstallationIds(...a),
  getReviewStats: vi.fn(),
  getReviewsByDay: vi.fn(),
  deleteReviewById: vi.fn(),
  deleteReviewsByIds: vi.fn(),
  deleteReviewsByRepoId: vi.fn(),
  clearMemoryObservationsByProject: vi.fn(),
  eq: (col: unknown, val: unknown) => ({ _tag: 'eq', col, val }),
  sql: (_strings: TemplateStringsArray, ..._vals: unknown[]) => ({ _tag: 'sql' }),
  repositories: { id: {}, installationId: {}, fullName: {} },
  reviews: {
    id: {},
    repositoryId: {},
    prNumber: {},
    status: {},
    mode: {},
    summary: {},
    findings: {},
    tokensUsed: {},
    executionTimeMs: {},
    metadata: {},
    createdAt: {},
  },
}));

vi.mock('./utils.js', () => ({
  generateErrorId: () => 'err-test',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createReviewsRouter } from './reviews.js';

/** Chainable drizzle-query stub: each db.select() call consumes the next result. */
function makeDb(results: unknown[]) {
  let i = 0;
  const makeChain = () => {
    const result = results[i++];
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
      chain[m] = () => chain;
    }
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mimics drizzle's awaitable query builder
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return chain;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double
  return { select: () => makeChain() } as any;
}

function appWith(db: unknown, installationIds: number[] = [42]) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { installationIds, githubLogin: 'tester' });
    await next();
  });
  // biome-ignore lint/suspicious/noExplicitAny: test double
  app.route('/', createReviewsRouter(db as any));
  return app;
}

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    repositoryId: 42,
    prNumber: 10,
    status: 'PASSED',
    mode: 'simple',
    summary: 'hello',
    findings: [],
    tokensUsed: 0,
    executionTimeMs: 0,
    metadata: { mode: 'simple' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/reviews — pagination validation (PRODOPS-007)', () => {
  it('rejects a negative page with a structured 400', async () => {
    const app = appWith(makeDb([]));
    const res = await app.request('/api/reviews?repo=o/r&page=-1');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('VALIDATION_ERROR');
    // No DB access on invalid input.
    expect(mockGetRepoByFullName).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit with 400', async () => {
    const app = appWith(makeDb([]));
    const res = await app.request('/api/reviews?repo=o/r&limit=abc');
    expect(res.status).toBe(400);
  });

  it('rejects page=0 with 400', async () => {
    const app = appWith(makeDb([]));
    const res = await app.request('/api/reviews?repo=o/r&page=0');
    expect(res.status).toBe(400);
  });

  it('clamps an over-large limit to 100 (default path, not rejected)', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({ id: 42, installationId: 42, fullName: 'o/r' });
    mockGetReviewsByRepoId.mockResolvedValueOnce([]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(0);

    const app = appWith(makeDb([]));
    const res = await app.request('/api/reviews?repo=o/r&limit=9999');
    expect(res.status).toBe(200);
    expect(mockGetReviewsByRepoId).toHaveBeenCalledWith(expect.anything(), 42, {
      limit: 100,
      offset: 0,
    });
  });
});

describe('GET /api/reviews — server-side filtering (PRODOPS-005)', () => {
  it('per-repo: applies status filter server-side and totals over the filtered set', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({ id: 42, installationId: 42, fullName: 'o/r' });
    // Filtered rows + filtered count come from the chainable db, NOT the
    // default getReviewsByRepoId helper.
    const db = makeDb([[dbRow({ id: 7, status: 'FAILED' })], [{ total: 1 }]]);

    const app = appWith(db);
    const res = await app.request('/api/reviews?repo=o/r&status=FAILED');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe(7);
    expect(json.data[0].status).toBe('FAILED');
    // Total reflects the FILTERED count, not the whole set.
    expect(json.pagination.total).toBe(1);
    // The unfiltered default path must NOT be used when filters are present.
    expect(mockGetReviewsByRepoId).not.toHaveBeenCalled();
    expect(mockCountReviewsByRepoId).not.toHaveBeenCalled();
  });

  it('per-repo: search filter routes to the server-side path', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({ id: 42, installationId: 42, fullName: 'o/r' });
    const db = makeDb([[dbRow({ id: 9, summary: 'matches query' })], [{ total: 1 }]]);

    const app = appWith(db);
    const res = await app.request('/api/reviews?repo=o/r&q=query');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data[0].id).toBe(9);
    expect(mockGetReviewsByRepoId).not.toHaveBeenCalled();
  });

  it('cross-installation: filters + filtered total across installations', async () => {
    const db = makeDb([
      [{ ...dbRow({ id: 3, status: 'FAILED' }), fullName: 'o/r' }],
      [{ total: 1 }],
    ]);

    const app = appWith(db, [42, 43]);
    const res = await app.request('/api/reviews?status=FAILED');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].repo).toBe('o/r');
    expect(json.pagination.total).toBe(1);
    expect(mockGetReviewsByInstallationIds).not.toHaveBeenCalled();
  });

  it('no filters → uses the unchanged default (tested) query path', async () => {
    mockGetRepoByFullName.mockResolvedValueOnce({ id: 42, installationId: 42, fullName: 'o/r' });
    mockGetReviewsByRepoId.mockResolvedValueOnce([dbRow({ id: 1 })]);
    mockCountReviewsByRepoId.mockResolvedValueOnce(5);

    const app = appWith(makeDb([]));
    const res = await app.request('/api/reviews?repo=o/r');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pagination.total).toBe(5);
    expect(mockGetReviewsByRepoId).toHaveBeenCalledOnce();
  });
});
