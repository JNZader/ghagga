/**
 * Integration: `issue_drafts` constraints against a REAL PostgreSQL.
 *
 * The unit suite (../issue-drafts.test.ts) proves the drizzle table
 * DEFINITION shape (columns, types, FK/index declarations). It can NOT prove
 * that the generated DDL actually enforces the constraints at runtime — a
 * mis-declared partial-unique predicate or a missing ON DELETE cascade would
 * only surface against a live database.
 *
 * This test closes that gap by booting a real `postgres:16-alpine` container
 * (aligned with docker-compose.yml), running the Drizzle migrations, and
 * exercising the three behaviours task 1.1 cares about:
 *   1. Draft lifecycle transitions (DRAFT → APPROVED → POSTED / DRAFT → REJECTED).
 *   2. The partial-unique index: at most ONE open DRAFT per (repo, issue),
 *      but re-triaging after a decision is allowed.
 *   3. FK cascade: deleting a repository removes its drafts.
 *
 * REQUIRES DOCKER. Excluded from the default unit run; invoke with:
 *   pnpm --filter ghagga-db test:integration
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../client.js';
import {
  claimIssueDraftForPosting,
  findStaleApprovedDrafts,
  getOpenIssueDraft,
  rejectIssueDraft,
  releaseIssueDraftClaim,
  saveIssueDraft,
} from '../queries.js';
import * as schema from '../schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', '..', 'drizzle');

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
/**
 * A schema-bound drizzle instance matching the `Database` type the real query
 * functions expect. Built once alongside the pool so the query-driven cases
 * below exercise the ACTUAL generated SQL (not raw `pool.query`).
 */
let db: Database;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/** Seed a minimal installation + repository, returning the repository id. */
async function seedRepository(githubRepoId: number): Promise<number> {
  const inst = await pool.query(
    `INSERT INTO installations (github_installation_id, account_login, account_type)
     VALUES ($1, $2, 'User') RETURNING id`,
    [githubRepoId, `acct-${githubRepoId}`],
  );
  const installationId = inst.rows[0].id as number;
  const repo = await pool.query(
    `INSERT INTO repositories (github_repo_id, installation_id, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [githubRepoId, installationId, `owner/repo-${githubRepoId}`],
  );
  return repo.rows[0].id as number;
}

async function insertDraft(
  repositoryId: number,
  issueNumber: number,
  status: string,
  draftKind = 'ANALYSIS',
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO issue_drafts (repository_id, issue_number, issue_title, status, draft_kind, body)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [repositoryId, issueNumber, `Issue #${issueNumber}`, status, draftKind, 'cited body'],
  );
  return res.rows[0].id as number;
}

beforeEach(async () => {
  // installations cascade → repositories cascade → issue_drafts, so this is enough.
  await pool.query('TRUNCATE installations RESTART IDENTITY CASCADE');
});

describe('integration: issue_drafts lifecycle (real PostgreSQL)', () => {
  it('transitions DRAFT → APPROVED → POSTED', async () => {
    const repoId = await seedRepository(1001);
    const draftId = await insertDraft(repoId, 7, 'DRAFT');

    await pool.query(`UPDATE issue_drafts SET status = 'APPROVED' WHERE id = $1`, [draftId]);

    // Read back the intermediate APPROVED state BEFORE transitioning to POSTED,
    // so a silently-ignored UPDATE (e.g. a bad WHERE) can't slip through.
    const approved = await pool.query(`SELECT status FROM issue_drafts WHERE id = $1`, [draftId]);
    expect(approved.rows[0].status).toBe('APPROVED');

    // GitHub comment IDs are 64-bit; use a value > int4 max (2,147,483,647) to
    // prove the bigint column round-trips a real-world id without overflow.
    const bigCommentId = 9_876_543_210;
    await pool.query(
      `UPDATE issue_drafts SET status = 'POSTED', posted_comment_id = $2 WHERE id = $1`,
      [draftId, bigCommentId],
    );

    const { rows } = await pool.query(
      `SELECT status, posted_comment_id FROM issue_drafts WHERE id = $1`,
      [draftId],
    );
    expect(rows[0].status).toBe('POSTED');
    expect(Number(rows[0].posted_comment_id)).toBe(bigCommentId);
  });

  it('transitions DRAFT → REJECTED without ever posting', async () => {
    const repoId = await seedRepository(1002);
    const draftId = await insertDraft(repoId, 8, 'DRAFT');

    await pool.query(`UPDATE issue_drafts SET status = 'REJECTED' WHERE id = $1`, [draftId]);

    const { rows } = await pool.query(
      `SELECT status, posted_comment_id FROM issue_drafts WHERE id = $1`,
      [draftId],
    );
    expect(rows[0].status).toBe('REJECTED');
    expect(rows[0].posted_comment_id).toBeNull();
  });
});

describe('integration: issue_drafts partial-unique constraint (real PostgreSQL)', () => {
  it('rejects a second open DRAFT for the same (repository, issue)', async () => {
    const repoId = await seedRepository(2001);
    await insertDraft(repoId, 42, 'DRAFT');

    await expect(insertDraft(repoId, 42, 'DRAFT')).rejects.toThrow(
      /uq_issue_drafts_open_draft|duplicate key/i,
    );
  });

  it('allows a new DRAFT after the prior one left DRAFT (re-triage)', async () => {
    const repoId = await seedRepository(2002);
    const first = await insertDraft(repoId, 42, 'DRAFT');
    await pool.query(`UPDATE issue_drafts SET status = 'REJECTED' WHERE id = $1`, [first]);

    // Predicate excludes the REJECTED row, so a fresh DRAFT is allowed.
    await expect(insertDraft(repoId, 42, 'DRAFT')).resolves.toBeGreaterThan(0);
  });

  it('allows the same issue number across different repositories', async () => {
    const repoA = await seedRepository(2003);
    const repoB = await seedRepository(2004);
    await insertDraft(repoA, 42, 'DRAFT');

    await expect(insertDraft(repoB, 42, 'DRAFT')).resolves.toBeGreaterThan(0);
  });

  it('does not constrain non-DRAFT rows (multiple POSTED allowed)', async () => {
    const repoId = await seedRepository(2005);
    await insertDraft(repoId, 42, 'POSTED');
    await expect(insertDraft(repoId, 42, 'POSTED')).resolves.toBeGreaterThan(0);
  });
});

describe('integration: issue_drafts CHECK constraints (real PostgreSQL)', () => {
  it('rejects an invalid status value via chk_issue_drafts_status', async () => {
    const repoId = await seedRepository(4001);
    await expect(insertDraft(repoId, 1, 'BOGUS')).rejects.toThrow(
      /chk_issue_drafts_status|violates check constraint/i,
    );
  });

  it('rejects an invalid draft_kind value via chk_issue_drafts_draft_kind', async () => {
    const repoId = await seedRepository(4002);
    await expect(insertDraft(repoId, 1, 'DRAFT', 'WRONG_KIND')).rejects.toThrow(
      /chk_issue_drafts_draft_kind|violates check constraint/i,
    );
  });
});

describe('integration: saveIssueDraft / getOpenIssueDraft real generated query (real PostgreSQL)', () => {
  // These cases drive the ACTUAL drizzle-generated queries (not raw pool.query),
  // proving the `onConflictDoNothing` target+predicate in `saveIssueDraft`
  // MATCHES the partial-unique index `uq_issue_drafts_open_draft`
  // (predicate `status = 'DRAFT'`). A mismatch surfaces here as a Postgres
  // "no unique or exclusion constraint matching the ON CONFLICT specification"
  // error at the first real conflict — never caught by the raw-INSERT cases above.

  it('inserts a DRAFT and returns the row', async () => {
    const repoId = await seedRepository(5001);
    const row = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 10,
      issueTitle: 'Issue #10',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'cited body',
    });

    expect(row).toBeDefined();
    expect(row?.id).toBeGreaterThan(0);
    expect(row?.status).toBe('DRAFT');
    expect(row?.repositoryId).toBe(repoId);
    expect(row?.issueNumber).toBe(10);
  });

  it('returns undefined (no-op, no throw) on a second open DRAFT for the same (repo, issue)', async () => {
    const repoId = await seedRepository(5002);
    const first = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 11,
      issueTitle: 'Issue #11',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'first body',
    });
    expect(first).toBeDefined();

    // THE key assertion: the ON CONFLICT predicate must match the partial index.
    // If it did not, Postgres would raise "no unique or exclusion constraint
    // matching the ON CONFLICT specification" here instead of a clean no-op.
    const second = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 11,
      issueTitle: 'Issue #11 again',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'second body',
    });
    expect(second).toBeUndefined();

    // The original DRAFT is untouched — the no-op did not overwrite it.
    const open = await getOpenIssueDraft(db, repoId, 11);
    expect(open?.id).toBe(first?.id);
    expect(open?.body).toBe('first body');
  });

  it('allows saveIssueDraft again after the prior DRAFT is decided (re-triage)', async () => {
    const repoId = await seedRepository(5003);
    const first = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 12,
      issueTitle: 'Issue #12',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'first body',
    });
    expect(first).toBeDefined();

    // Move the first draft out of DRAFT via the real query — now it falls
    // outside the partial predicate, so a fresh DRAFT is allowed.
    const rejected = await rejectIssueDraft(db, first!.id);
    expect(rejected?.status).toBe('REJECTED');

    const second = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 12,
      issueTitle: 'Issue #12 re-triage',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'second body',
    });
    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.status).toBe('DRAFT');
  });

  it('getOpenIssueDraft returns the open DRAFT, then undefined once it is decided', async () => {
    const repoId = await seedRepository(5004);
    const draft = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 13,
      issueTitle: 'Issue #13',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'body',
    });
    expect(draft).toBeDefined();

    const open = await getOpenIssueDraft(db, repoId, 13);
    expect(open?.id).toBe(draft?.id);
    await rejectIssueDraft(db, draft!.id);
    const afterDecision = await getOpenIssueDraft(db, repoId, 13);
    expect(afterDecision).toBeUndefined();
  });

  it('claimIssueDraftForPosting is a single-winner CAS (second claim returns undefined)', async () => {
    const repoId = await seedRepository(5005);
    const draft = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 14,
      issueTitle: 'Issue #14',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'body',
    });
    expect(draft).toBeDefined();
    const won = await claimIssueDraftForPosting(db, draft!.id);
    expect(won?.status).toBe('APPROVED');
    // The claim stamps the posting lease (claimedAt) — RES-001 orphan detection.
    expect(won?.claimedAt).not.toBeNull();
    expect(won?.claimedAt).toBeInstanceOf(Date);

    // The row is no longer DRAFT, so the second claim matches ZERO rows.
    const lost = await claimIssueDraftForPosting(db, draft!.id);
    expect(lost).toBeUndefined();
  });

  it('releaseIssueDraftClaim clears the posting lease (claimedAt → null)', async () => {
    const repoId = await seedRepository(5006);
    const draft = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 15,
      issueTitle: 'Issue #15',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'body',
    });
    expect(draft).toBeDefined();

    const claimed = await claimIssueDraftForPosting(db, draft!.id);
    expect(claimed?.claimedAt).not.toBeNull();

    // Releasing back to DRAFT must clear the lease so a re-claim gets a fresh one.
    const released = await releaseIssueDraftClaim(db, draft!.id);
    expect(released?.status).toBe('DRAFT');
    expect(released?.claimedAt).toBeNull();
  });
});

describe('integration: findStaleApprovedDrafts reaper detection (real PostgreSQL)', () => {
  it('returns an APPROVED draft whose lease predates olderThan, and excludes it otherwise', async () => {
    const repoId = await seedRepository(6001);
    const draft = await saveIssueDraft(db, {
      repositoryId: repoId,
      issueNumber: 20,
      issueTitle: 'Issue #20',
      status: 'DRAFT',
      draftKind: 'ANALYSIS',
      body: 'body',
    });
    expect(draft).toBeDefined();

    // Claim to move DRAFT → APPROVED and stamp claimedAt, then backdate the lease
    // to one hour ago to simulate a poster that crashed and left the row stuck.
    // Backdate with a SERVER-side interval (now() - 1h) rather than a client JS
    // Date: node-pg serializes a Date param in the client's LOCAL tz while drizzle
    // serializes `olderThan` in UTC, so a client-Date write would skew the compare
    // by the local offset. Server now() and drizzle's UTC params are both UTC.
    await claimIssueDraftForPosting(db, draft!.id);
    await pool.query(
      `UPDATE issue_drafts SET claimed_at = now() - interval '1 hour' WHERE id = $1`,
      [draft!.id],
    );

    // olderThan AFTER the lease (30 min ago) → the stale draft is detected.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const stale = await findStaleApprovedDrafts(db, thirtyMinAgo);
    expect(stale.map((r) => r.id)).toContain(draft!.id);

    // olderThan BEFORE the lease (2 h ago) → the draft is NOT yet stale.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const notYetStale = await findStaleApprovedDrafts(db, twoHoursAgo);
    expect(notYetStale.map((r) => r.id)).not.toContain(draft!.id);
  });

  it('excludes non-APPROVED rows and APPROVED rows with a NULL lease', async () => {
    const repoId = await seedRepository(6002);
    // A plain DRAFT (never claimed → claimedAt NULL) must never be returned.
    await insertDraft(repoId, 21, 'DRAFT');
    // An APPROVED row with a NULL claimed_at (defensive: should not exist in
    // practice, but the query must still exclude it — it filters IS NOT NULL).
    const orphanId = await insertDraft(repoId, 22, 'APPROVED');
    // claimed_at is NULL here (insertDraft does not set it).

    const future = new Date(Date.now() + 60 * 60 * 1000);
    const stale = await findStaleApprovedDrafts(db, future);
    expect(stale.map((r) => r.id)).not.toContain(orphanId);
  });
});

describe('integration: issue_drafts FK cascade (real PostgreSQL)', () => {
  it('deletes drafts when their repository is deleted', async () => {
    const repoId = await seedRepository(3001);
    await insertDraft(repoId, 1, 'DRAFT');
    await insertDraft(repoId, 2, 'POSTED');

    await pool.query(`DELETE FROM repositories WHERE id = $1`, [repoId]);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM issue_drafts WHERE repository_id = $1`,
      [repoId],
    );
    expect(rows[0].n).toBe(0);
  });
});
