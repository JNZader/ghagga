/**
 * Unit tests for the `digests` table schema shape + digest queries
 * (nightly-health-digest T3.1/T3.2).
 *
 * Schema tests assert the drizzle table DEFINITION (columns, FK cascade,
 * partial-unique WHERE `issue_open = true`, CHECK value list) using
 * `getTableConfig`/`PgDialect` — no database connection (issue-drafts.test.ts
 * precedent). Query tests use the house explicit-mock-chain pattern from
 * queries.test.ts: delegation, row mapping, WHERE cutoffs, rotate flip+insert.
 * Live partial-unique enforcement needs real Postgres — covered separately by
 * `__integration__/digests.integration.test.ts` (Docker-gated).
 */

import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client.js';
import {
  getOpenDigest,
  getReviewsSinceWatermark,
  insertDigestRun,
  rotateOpenDigest,
} from './queries.js';
import { DIGEST_STATUSES, digests, repositories } from './schema.js';

// ─── Table definition (T3.1) ────────────────────────────────────

const config = getTableConfig(digests);
const columns = new Map(config.columns.map((c) => [c.name, c]));

const dialect = new PgDialect();
const renderSql = (expr: SQL | undefined): string => (expr ? dialect.sqlToQuery(expr).sql : '');

describe('digests table', () => {
  it('is named "digests"', () => {
    expect(config.name).toBe('digests');
  });

  it('declares all expected columns', () => {
    expect([...columns.keys()].sort()).toEqual(
      [
        'id',
        'repository_id',
        'run_at',
        'status',
        'issue_number',
        'issue_open',
        'watermark',
        'findings_count',
        'score',
        'error',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('uses a serial primary key on id', () => {
    const id = columns.get('id');
    expect(id?.primary).toBe(true);
    expect(id?.notNull).toBe(true);
  });

  it('marks the NOT NULL columns', () => {
    for (const name of [
      'repository_id',
      'run_at',
      'status',
      'issue_open',
      'findings_count',
      'created_at',
      'updated_at',
    ]) {
      expect(columns.get(name)?.notNull, name).toBe(true);
    }
  });

  it('marks the nullable columns (issueNumber/score/error/watermark)', () => {
    for (const name of ['issue_number', 'watermark', 'score', 'error']) {
      expect(columns.get(name)?.notNull, name).toBe(false);
    }
  });

  it('defaults issue_open to false, findings_count to 0, run_at to now()', () => {
    expect(columns.get('issue_open')?.hasDefault).toBe(true);
    expect(columns.get('issue_open')?.default).toBe(false);
    expect(columns.get('findings_count')?.hasDefault).toBe(true);
    expect(columns.get('findings_count')?.default).toBe(0);
    expect(columns.get('run_at')?.hasDefault).toBe(true);
  });

  it('has a single FK on repository_id → repositories.id ON DELETE cascade', () => {
    expect(config.foreignKeys).toHaveLength(1);
    const fk = config.foreignKeys[0].reference();
    expect(fk.columns.map((c) => c.name)).toEqual(['repository_id']);
    expect(fk.foreignTable).toBe(repositories);
    expect(fk.foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(config.foreignKeys[0].onDelete).toBe('cascade');
  });

  it('enforces ONE open digest row per repository via a partial-unique index', () => {
    const byName = new Map(config.indexes.map((i) => [i.config.name, i.config]));
    const partial = byName.get('uq_digests_open_issue');
    expect(partial, 'partial-unique index must exist').toBeDefined();
    expect(partial?.unique).toBe(true);
    expect(partial?.columns.map((c) => (c as { name?: string }).name)).toEqual(['repository_id']);
    // The predicate must reference the real column semantics — assert the
    // rendered SQL, not merely that *a* predicate exists.
    expect(partial?.where, 'partial index must carry a WHERE predicate').toBeDefined();
    const rendered = renderSql(partial?.where);
    expect(rendered).toContain('issue_open');
    expect(rendered).toContain('true');
  });

  it('declares a DB-level CHECK on status mirroring DIGEST_STATUSES', () => {
    const checks = new Map(config.checks.map((c) => [c.name, c]));
    const statusCheck = checks.get('chk_digests_status');
    expect(statusCheck, 'status CHECK must exist').toBeDefined();
    const statusSql = renderSql(statusCheck?.value);
    for (const value of DIGEST_STATUSES) {
      expect(statusSql).toContain(`'${value}'`);
    }
  });

  it('indexes repository_id', () => {
    const byName = new Map(config.indexes.map((i) => [i.config.name, i.config]));
    const repoIdx = byName.get('idx_digests_repository');
    expect(repoIdx?.unique).toBe(false);
    expect(repoIdx?.columns.map((c) => (c as { name?: string }).name)).toEqual(['repository_id']);
  });
});

// ─── Queries (T3.2) ─────────────────────────────────────────────

const NOW = new Date('2026-11-10T03:00:00.000Z');
const WATERMARK = new Date('2026-11-07T03:00:00.000Z');
// 30-day ranking window boundary anchored at NOW.
const WINDOW_START = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

describe('getReviewsSinceWatermark', () => {
  it('WHERE cutoffs exclude pre-watermark rows (R0 out) and bound the 30d window', async () => {
    const mockOrderBy = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await getReviewsSinceWatermark(db, 7, WATERMARK, NOW);

    // The condition must carry BOTH cutoffs as bound params: the watermark
    // (R0 last-week excluded) and the 30-day ranking window start.
    const condition = mockWhere.mock.calls[0]?.[0] as SQL;
    const rendered = dialect.sqlToQuery(condition);
    expect(rendered.sql).toContain('>');
    // drizzle serializes Date params to ISO strings.
    expect(rendered.params).toContain(WATERMARK.toISOString());
    expect(rendered.params).toContain(WINDOW_START.toISOString());
    // Row shape: exactly the three digest inputs.
    expect(mockSelect.mock.calls[0]?.[0]).toEqual({
      findings: expect.anything(),
      metadata: expect.anything(),
      createdAt: expect.anything(),
    });
  });

  it('first run (no watermark) still applies the 30-day ranking window only', async () => {
    const mockOrderBy = vi.fn().mockResolvedValue([]);
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    await getReviewsSinceWatermark(db, 7, undefined, NOW);

    const condition = mockWhere.mock.calls[0]?.[0] as SQL;
    const rendered = dialect.sqlToQuery(condition);
    expect(rendered.params).toContain(WINDOW_START.toISOString());
    expect(rendered.params).not.toContain(WATERMARK.toISOString());
  });

  it('maps the returned rows through unchanged (findings/metadata/createdAt)', async () => {
    const rows = [
      {
        findings: [{ severity: 'high' }],
        metadata: { blastRadius: { blastRadiusFiles: 3 } },
        createdAt: WATERMARK,
      },
      { findings: null, metadata: null, createdAt: new Date('2026-11-09T00:00:00Z') },
    ];
    const mockOrderBy = vi.fn().mockResolvedValue(rows);
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getReviewsSinceWatermark(db, 7, WATERMARK, NOW);
    expect(result).toEqual(rows);
  });
});

describe('insertDigestRun', () => {
  it('inserts the run row and returns it', async () => {
    const inserted = { id: 1, repositoryId: 7, status: 'POSTED' };
    const mockReturning = vi.fn().mockResolvedValue([inserted]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    const db = { insert: mockInsert } as unknown as Database;

    const result = await insertDigestRun(db, {
      repositoryId: 7,
      runAt: NOW,
      status: 'POSTED',
      issueNumber: 42,
      issueOpen: true,
      watermark: NOW,
      findingsCount: 3,
      score: 65,
    });

    expect(result).toEqual(inserted);
    expect(mockInsert.mock.calls[0]?.[0]).toBe(digests);
    expect(mockValues.mock.calls[0]?.[0]).toMatchObject({
      repositoryId: 7,
      status: 'POSTED',
      issueOpen: true,
      issueNumber: 42,
    });
  });
});

describe('getOpenDigest', () => {
  it('selects the single issueOpen=true row for the repository', async () => {
    const open = { id: 9, repositoryId: 7, issueOpen: true, issueNumber: 42 };
    const mockLimit = vi.fn().mockResolvedValue([open]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    const result = await getOpenDigest(db, 7);
    expect(result).toEqual(open);

    // The WHERE condition pins repositoryId AND issueOpen = true.
    const condition = mockWhere.mock.calls[0]?.[0] as SQL;
    const rendered = dialect.sqlToQuery(condition);
    expect(rendered.sql.toLowerCase()).toContain('issue_open');
    expect(rendered.params).toContain(true);
    expect(rendered.params).toContain(7);
  });

  it('returns undefined when there is no open row (first run)', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const db = { select: mockSelect } as unknown as Database;

    expect(await getOpenDigest(db, 7)).toBeUndefined();
  });
});

describe('rotateOpenDigest', () => {
  it('is ONE transaction: flip old open row false, then insert successor open row', async () => {
    const successor = { id: 11, repositoryId: 7, issueOpen: true, status: 'POSTED' };
    const txInsertReturning = vi.fn().mockResolvedValue([successor]);
    const txInsertValues = vi.fn().mockReturnValue({ returning: txInsertReturning });
    const txInsert = vi.fn().mockReturnValue({ values: txInsertValues });
    const txUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere });
    const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet });
    const tx = { update: txUpdate, insert: txInsert } as unknown as Parameters<
      Parameters<Database['transaction']>[0]
    >[0];
    const mockTransaction = vi
      .fn()
      .mockImplementation(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx));
    const db = { transaction: mockTransaction } as unknown as Database;

    const result = await rotateOpenDigest(db, {
      repositoryId: 7,
      successor: {
        runAt: NOW,
        issueNumber: 99,
        watermark: NOW,
        findingsCount: 5,
        score: 70,
      },
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual(successor);

    // Flip: old open row → issueOpen = false.
    expect(txUpdate.mock.calls[0]?.[0]).toBe(digests);
    expect(txUpdateSet.mock.calls[0]?.[0]).toMatchObject({ issueOpen: false });

    // Insert: successor lands open with the new issue number.
    expect(txInsert.mock.calls[0]?.[0]).toBe(digests);
    expect(txInsertValues.mock.calls[0]?.[0]).toMatchObject({
      repositoryId: 7,
      status: 'POSTED',
      issueNumber: 99,
      issueOpen: true,
      watermark: NOW,
    });
  });
});
