/**
 * `toReviewDto` blast-radius diagram projection tests
 * (blast-radius-diagram T4.2).
 *
 * Sibling of reviews.filter.test.ts — same ghagga-db mock harness. Covers
 * the server-delta scenarios: diagram data present → key projected
 * verbatim (lists + flags, no transformation loss); counts-only metadata →
 * key OMITTED (never `null`/`{}`); legacy pre-change rows never produce
 * the key; mixed list responses stay shape-identical elsewhere.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetRepoByFullName = vi.fn();
const mockGetReviewsByRepoId = vi.fn();
const mockCountReviewsByRepoId = vi.fn();
const mockGetReviewsByInstallationIds = vi.fn();
const mockCountReviewsByInstallationIds = vi.fn();

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

// ─── Harness (same pattern as reviews.filter.test.ts) ───────────

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

/** A realistic persisted diagram artifact (as core would have written it). */
function persistedDiagram() {
  return {
    mermaid: [
      'flowchart TD',
      '  classDef changed fill:#fef3c7,stroke:#d97706,stroke-width:2px',
      '  classDef dependent fill:#dbeafe,stroke:#2563eb',
      '  classDef test fill:#dcfce7,stroke:#16a34a',
      '  subgraph c0["src"]',
      '    n0["src/a.ts"]',
      '  end',
      '  class n0 changed',
    ].join('\n'),
    nodes: [
      { id: 'n0', label: 'src/a.ts', role: 'changed', cluster: 'src' },
      { id: 'n1', label: 'src/b.ts', role: 'changed', cluster: 'src' },
      { id: 'n2', label: 'src/c.ts', role: 'changed', cluster: 'src' },
      { id: 'n3', label: 'lib/u.ts', role: 'dependent', cluster: 'lib' },
      { id: 'n4', label: 'lib/v.ts', role: 'dependent', cluster: 'lib' },
    ],
    edges: [
      { from: 'n0', to: 'n3' },
      { from: 'n1', to: 'n3' },
      { from: 'n1', to: 'n4' },
      { from: 'n2', to: 'n4' },
    ],
    meta: { stale: false, exceededCap: false, truncated: false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

async function listReviews(dbRows: unknown[]) {
  mockGetRepoByFullName.mockResolvedValueOnce({ id: 42, installationId: 42, fullName: 'o/r' });
  mockGetReviewsByRepoId.mockResolvedValueOnce(dbRows);
  mockCountReviewsByRepoId.mockResolvedValueOnce(dbRows.length);
  const app = appWith({});
  const res = await app.request('/api/reviews?repo=o/r');
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Array<Record<string, unknown>> };
}

// ─── Scenarios ──────────────────────────────────────────────────

describe('GET /api/reviews — blastRadiusDiagram projection (T4.2)', () => {
  it('review with diagram data returns the key, projected without transformation loss', async () => {
    const diagram = persistedDiagram();
    const json = await listReviews([
      dbRow({
        metadata: {
          mode: 'simple',
          blastRadius: {
            enabled: true,
            graphAvailable: true,
            totalFiles: 5,
            blastRadiusFiles: 5,
            diagram,
          },
        },
      }),
    ]);

    const dto = json.data[0]!;
    expect(dto.blastRadiusDiagram).toEqual(diagram); // verbatim: same lists, same flags
    expect(dto.blastRadiusDiagram).toHaveProperty('nodes.length', 5);
    expect(dto.blastRadiusDiagram).toHaveProperty('edges.length', 4);
    expect((dto.blastRadiusDiagram as { meta: Record<string, unknown> }).meta).toEqual({
      stale: false,
      exceededCap: false,
      truncated: false,
    });
    // Truncation flags ride through untouched when present.
    const json2 = await listReviews([
      dbRow({
        metadata: {
          blastRadius: {
            enabled: true,
            graphAvailable: true,
            totalFiles: 40,
            blastRadiusFiles: 25,
            diagram: {
              ...persistedDiagram(),
              meta: {
                stale: true,
                exceededCap: false,
                truncated: true,
                clusterCounts: { src: 15 },
              },
            },
          },
        },
      }),
    ]);
    expect(json2.data[0]!.blastRadiusDiagram).toMatchObject({
      meta: { stale: true, truncated: true, clusterCounts: { src: 15 } },
    });
  });

  it('counts-only metadata (no diagram lists) omits the key entirely', async () => {
    const json = await listReviews([
      dbRow({
        metadata: {
          mode: 'simple',
          blastRadius: { enabled: true, graphAvailable: true, totalFiles: 9, blastRadiusFiles: 9 },
        },
      }),
    ]);
    const dto = json.data[0]!;
    expect('blastRadiusDiagram' in dto).toBe(false);
    expect(dto.blastRadiusDiagram).toBeUndefined();
  });

  it('legacy pre-change rows never produce the key', async () => {
    const json = await listReviews([
      dbRow({ metadata: { mode: 'simple' } }), // never had blastRadius at all
      dbRow({ metadata: null }), // null jsonb
    ]);
    for (const dto of json.data) {
      expect('blastRadiusDiagram' in dto).toBe(false);
    }
  });

  it('corrupt diagram jsonb (primitive/array) fails closed to key omission', async () => {
    const json = await listReviews([
      dbRow({ metadata: { blastRadius: { diagram: 'flowchart TD' } } }), // string, not object
      dbRow({ metadata: { blastRadius: { diagram: [] } } }), // array
    ]);
    for (const dto of json.data) {
      expect('blastRadiusDiagram' in dto).toBe(false);
    }
  });

  it('meta-less diagram blobs (4R RES-002) fail closed to key omission', async () => {
    const json = await listReviews([
      dbRow({ metadata: { blastRadius: { diagram: {} } } }), // no meta, no mermaid
      dbRow({ metadata: { blastRadius: { diagram: { mermaid: 'flowchart TD' } } } }), // mermaid, no meta
      dbRow({ metadata: { blastRadius: { diagram: { meta: {} } } } }), // meta, no mermaid
    ]);
    for (const dto of json.data) {
      expect('blastRadiusDiagram' in dto).toBe(false);
    }
  });

  it('mixed list response: shape identical elsewhere, key only on the diagram row', async () => {
    const withDiagram = dbRow({
      id: 7,
      metadata: { blastRadius: { enabled: true, diagram: persistedDiagram() } },
    });
    const without = dbRow({ id: 8, metadata: { mode: 'workflow' } });
    const json = await listReviews([withDiagram, without]);

    expect(json.data).toHaveLength(2);
    const dtoWith = json.data.find((d) => d.id === 7);
    const dtoWithout = json.data.find((d) => d.id === 8);
    expect(dtoWith?.blastRadiusDiagram).toBeDefined();
    expect('blastRadiusDiagram' in (dtoWithout ?? {})).toBe(false);
    // Every other key is identical between the two rows.
    const keysWith = Object.keys(dtoWith ?? {}).sort();
    const keysWithout = Object.keys(dtoWithout ?? {}).sort();
    expect(keysWithout).not.toContain('blastRadiusDiagram');
    expect(keysWith.filter((k) => k !== 'blastRadiusDiagram')).toEqual(keysWithout);
  });
});
