/**
 * Unit tests for the `issue_drafts` table schema shape.
 *
 * These assert the drizzle table DEFINITION (columns, types, nullability,
 * FK cascade, indexes incl. the partial-unique) using `getTableConfig` —
 * no database connection or mocking is required. The live constraint
 * behaviour (DRAFT lifecycle transitions, FK cascade, partial-unique
 * enforcement against a real Postgres) is covered separately by
 * `__integration__/issue-drafts.integration.test.ts` (Docker-gated).
 */

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_KINDS, ISSUE_DRAFT_STATUSES, issueDrafts, repositories } from './schema.js';

const config = getTableConfig(issueDrafts);
const columns = new Map(config.columns.map((c) => [c.name, c]));

describe('issue_drafts table', () => {
  it('is named "issue_drafts"', () => {
    expect(config.name).toBe('issue_drafts');
  });

  it('declares all expected columns', () => {
    expect([...columns.keys()].sort()).toEqual(
      [
        'id',
        'repository_id',
        'issue_number',
        'issue_title',
        'status',
        'draft_kind',
        'body',
        'sources',
        'dedup_matches',
        'tokens_used',
        'posted_comment_id',
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
      'issue_number',
      'issue_title',
      'status',
      'draft_kind',
      'body',
      'created_at',
      'updated_at',
    ]) {
      expect(columns.get(name)?.notNull, name).toBe(true);
    }
  });

  it('marks the nullable columns', () => {
    for (const name of ['sources', 'dedup_matches', 'posted_comment_id']) {
      expect(columns.get(name)?.notNull, name).toBe(false);
    }
  });

  it('sizes the varchar columns per design', () => {
    // status / draft_kind are varchar(20); issue_title is varchar(500).
    expect(columns.get('status')?.columnType).toBe('PgVarchar');
    expect(columns.get('draft_kind')?.columnType).toBe('PgVarchar');
    expect(columns.get('issue_title')?.columnType).toBe('PgVarchar');
    expect((columns.get('status') as { length?: number }).length).toBe(20);
    expect((columns.get('draft_kind') as { length?: number }).length).toBe(20);
    expect((columns.get('issue_title') as { length?: number }).length).toBe(500);
  });

  it('uses jsonb for sources and dedup_matches', () => {
    expect(columns.get('sources')?.columnType).toBe('PgJsonb');
    expect(columns.get('dedup_matches')?.columnType).toBe('PgJsonb');
  });

  it('defaults tokens_used to 0', () => {
    expect(columns.get('tokens_used')?.hasDefault).toBe(true);
    expect(columns.get('tokens_used')?.default).toBe(0);
  });

  it('defaults created_at and updated_at to now()', () => {
    expect(columns.get('created_at')?.hasDefault).toBe(true);
    expect(columns.get('updated_at')?.hasDefault).toBe(true);
  });

  it('has a single FK on repository_id → repositories.id ON DELETE cascade', () => {
    expect(config.foreignKeys).toHaveLength(1);
    const fk = config.foreignKeys[0].reference();
    expect(fk.columns.map((c) => c.name)).toEqual(['repository_id']);
    expect(fk.foreignTable).toBe(repositories);
    expect(fk.foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(config.foreignKeys[0].onDelete).toBe('cascade');
  });

  it('indexes repository_id and status', () => {
    const byName = new Map(config.indexes.map((i) => [i.config.name, i.config]));
    expect(byName.has('idx_issue_drafts_repository')).toBe(true);
    expect(byName.has('idx_issue_drafts_status')).toBe(true);

    const repoIdx = byName.get('idx_issue_drafts_repository');
    expect(repoIdx?.unique).toBe(false);
    expect(repoIdx?.columns.map((c) => (c as { name?: string }).name)).toEqual(['repository_id']);

    const statusIdx = byName.get('idx_issue_drafts_status');
    expect(statusIdx?.unique).toBe(false);
    expect(statusIdx?.columns.map((c) => (c as { name?: string }).name)).toEqual(['status']);
  });

  it('enforces ONE open DRAFT per (repository_id, issue_number) via a partial-unique index', () => {
    const byName = new Map(config.indexes.map((i) => [i.config.name, i.config]));
    const partial = byName.get('uq_issue_drafts_open_draft');
    expect(partial, 'partial-unique index must exist').toBeDefined();
    expect(partial?.unique).toBe(true);
    expect(partial?.columns.map((c) => (c as { name?: string }).name)).toEqual([
      'repository_id',
      'issue_number',
    ]);
    // The partial predicate (WHERE status = 'DRAFT') is what makes it "open draft only".
    expect(partial?.where, 'partial index must carry a WHERE predicate').toBeDefined();
  });
});

describe('issue draft enums', () => {
  it('exposes the status lifecycle values', () => {
    expect([...ISSUE_DRAFT_STATUSES]).toEqual(['DRAFT', 'APPROVED', 'REJECTED', 'POSTED']);
  });

  it('exposes the draft-kind values', () => {
    expect([...ISSUE_DRAFT_KINDS]).toEqual(['ANALYSIS', 'DUPLICATE', 'NEEDS_INFO']);
  });
});
