/**
 * Delegated CI API routes (read-only run history and status):
 *   GET /api/delegated-ci/runs       — list runs for a repo
 *   GET /api/delegated-ci/runs/:id   — get a single run
 */

import type { Database } from 'ghagga-db';
import {
  countDelegatedCiRunsByRepoId,
  eq,
  getDelegatedCiRun,
  getDelegatedCiRunsByRepoId,
  getRepoByFullName,
  repositories,
} from 'ghagga-db';
import { Hono } from 'hono';
import type { AuthUser } from '../../middleware/auth.js';
import { generateErrorId, logger } from './utils.js';

/** API view shape for a delegated CI run (mirrors DelegatedCiRunView from @ghagga/types) */
interface RunView {
  id: number;
  repositoryId: number;
  prNumber: number | null;
  jobKey: string;
  classification: string;
  state: string;
  reasonCode: string | null;
  reasonDetail: string | null;
  profile: string;
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Map a DB delegated_ci_runs row to the API view shape */
function toRunView(row: {
  id: number;
  repositoryId: number;
  prNumber: number | null;
  jobKey: string;
  classification: string;
  state: string;
  reasonCode: string | null;
  reasonDetail: string | null;
  profile: string;
  summary: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): RunView {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    prNumber: row.prNumber,
    jobKey: row.jobKey,
    classification: row.classification,
    state: row.state,
    reasonCode: row.reasonCode,
    reasonDetail: row.reasonDetail,
    profile: row.profile,
    summary: row.summary,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDelegatedCiRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/delegated-ci/runs ────────────────────────────────
  router.get('/api/delegated-ci/runs', async (c) => {
    const user = c.get('user') as AuthUser;
    const repoFullName = c.req.query('repo');
    const page = Number.parseInt(c.req.query('page') ?? '1', 10);
    const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '50', 10), 100);
    const offset = (page - 1) * limit;

    if (!repoFullName) {
      return c.json(
        { error: 'VALIDATION_ERROR', message: 'Missing required query parameter: repo' },
        400,
      );
    }

    try {
      const repo = await getRepoByFullName(db, repoFullName);

      if (!repo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      if (!user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      const [rows, total] = await Promise.all([
        getDelegatedCiRunsByRepoId(db, repo.id, { limit, offset }),
        countDelegatedCiRunsByRepoId(db, repo.id),
      ]);

      return c.json({
        data: {
          runs: rows.map(toRunView),
          total,
        },
        pagination: { page, limit, offset },
      });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, repo: repoFullName, user: user.githubLogin },
        'Failed to fetch delegated CI runs',
      );
      return c.json(
        { error: 'FETCH_FAILED', message: 'Failed to fetch delegated CI runs', errorId },
        500,
      );
    }
  });

  // ── GET /api/delegated-ci/runs/:id ────────────────────────────
  router.get('/api/delegated-ci/runs/:id', async (c) => {
    const user = c.get('user') as AuthUser;
    const runId = Number.parseInt(c.req.param('id'), 10);

    if (Number.isNaN(runId)) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid run ID' }, 400);
    }

    try {
      const run = await getDelegatedCiRun(db, runId);

      if (!run) {
        return c.json({ error: 'NOT_FOUND', message: 'Delegated CI run not found' }, 404);
      }

      // Verify ownership: look up the repository by ID and check installation membership
      const [repo] = await db
        .select({ installationId: repositories.installationId })
        .from(repositories)
        .where(eq(repositories.id, run.repositoryId))
        .limit(1);

      if (!repo || !user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      return c.json({ data: toRunView(run) });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, runId, user: user.githubLogin },
        'Failed to fetch delegated CI run',
      );
      return c.json(
        { error: 'FETCH_FAILED', message: 'Failed to fetch delegated CI run', errorId },
        500,
      );
    }
  });

  return router;
}
