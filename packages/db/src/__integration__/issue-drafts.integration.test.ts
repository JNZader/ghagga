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

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', '..', 'drizzle');

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await migrate(drizzle(pool), { migrationsFolder });
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
