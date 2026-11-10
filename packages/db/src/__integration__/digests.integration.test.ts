/**
 * Integration: `digests` constraints against a REAL PostgreSQL
 * (nightly-health-digest T3.1).
 *
 * The unit suite (../digests.test.ts) proves the drizzle table DEFINITION
 * shape. It can NOT prove that the generated DDL enforces the one-open-digest
 * invariant at runtime — a mis-declared partial-unique predicate would only
 * surface against a live database. This test closes that gap:
 *   1. The partial-unique index: a SECOND open digest row is rejected.
 *   2. Rotation (flip old open → insert successor) succeeds, leaving one open.
 *   3. The status CHECK rejects values outside POSTED | SKIPPED | FAILED.
 *   4. FK cascade: deleting a repository removes its digest rows.
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../client.js';
import { getOpenDigest, rotateOpenDigest } from '../queries.js';
import * as schema from '../schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(__dirname, '..', '..', 'drizzle');

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
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

async function insertDigestRow(
  repositoryId: number,
  issueNumber: number,
  issueOpen: boolean,
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO digests (repository_id, status, issue_number, issue_open, watermark, findings_count, score)
     VALUES ($1, 'POSTED', $2, $3, now(), 3, 65) RETURNING id`,
    [repositoryId, issueNumber, issueOpen],
  );
  return res.rows[0].id as number;
}

describe('digests constraints (real PostgreSQL)', () => {
  it('rejects a SECOND open digest row for the same repository (partial unique)', async () => {
    const repositoryId = await seedRepository(9001);
    await insertDigestRow(repositoryId, 42, true);

    await expect(insertDigestRow(repositoryId, 43, true)).rejects.toThrow(/uq_digests_open_issue/);
  });

  it('allows closed history rows alongside the one open row', async () => {
    const repositoryId = await seedRepository(9002);
    await insertDigestRow(repositoryId, 41, false);
    await insertDigestRow(repositoryId, 42, false);
    await insertDigestRow(repositoryId, 43, true); // the single open row
    await insertDigestRow(repositoryId, 44, false);

    const open = await getOpenDigest(db, repositoryId);
    expect(open?.issueNumber).toBe(43);
  });

  it('rotation (flip + insert) leaves exactly ONE open row referencing the new issue', async () => {
    const repositoryId = await seedRepository(9003);
    await insertDigestRow(repositoryId, 42, true);

    const successor = await rotateOpenDigest(db, {
      repositoryId,
      successor: {
        runAt: new Date(),
        issueNumber: 99,
        watermark: new Date(),
        findingsCount: 5,
        score: 70,
      },
    });

    expect(successor.issueNumber).toBe(99);
    expect(successor.issueOpen).toBe(true);
    expect(successor.status).toBe('POSTED');

    const open = await getOpenDigest(db, repositoryId);
    expect(open?.id).toBe(successor.id);
    expect(open?.issueNumber).toBe(99);

    // The old row is still there as history, closed.
    const old = await pool.query(
      'SELECT issue_number, issue_open FROM digests WHERE repository_id = $1 AND issue_number = 42',
      [repositoryId],
    );
    expect(old.rows[0]?.issue_open).toBe(false);
  });

  it('CHECK rejects a status outside POSTED | SKIPPED | FAILED', async () => {
    const repositoryId = await seedRepository(9004);
    await expect(
      pool.query(
        `INSERT INTO digests (repository_id, status, issue_open) VALUES ($1, 'MAILED', false)`,
        [repositoryId],
      ),
    ).rejects.toThrow(/chk_digests_status/);
  });

  it('FK cascade: deleting the repository removes its digest rows', async () => {
    const repositoryId = await seedRepository(9005);
    await insertDigestRow(repositoryId, 42, true);
    await insertDigestRow(repositoryId, 41, false);

    await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    const rows = await pool.query('SELECT * FROM digests WHERE repository_id = $1', [repositoryId]);
    expect(rows.rowCount).toBe(0);
  });
});
