/**
 * Review-related API routes:
 *   GET  /api/reviews
 *   GET  /api/stats
 *   DELETE /api/reviews/batch
 *   DELETE /api/reviews/:param  (numeric → single review by ID, non-numeric → by repo full name)
 */

import type { Finding, Review, ReviewMode, ReviewStatus } from '@ghagga/types';
import type { Database } from 'ghagga-db';
import {
  clearMemoryObservationsByProject,
  countReviewsByInstallationIds,
  countReviewsByRepoId,
  deleteReviewById,
  deleteReviewsByIds,
  deleteReviewsByRepoId,
  getRepoByFullName,
  getReviewStats,
  getReviewsByDay,
  getReviewsByInstallationIds,
  getReviewsByRepoId,
} from 'ghagga-db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthUser } from '../../middleware/auth.js';
import { generateErrorId, logger } from './utils.js';

/**
 * Structural view of a `reviews` DB row — the subset the wire contract needs.
 * Both `getReviewsByRepoId` rows and `ReviewWithRepo` rows satisfy it.
 */
interface ReviewRow {
  id: number;
  prNumber: number;
  status: string;
  mode: string;
  summary: string | null;
  findings: unknown[] | null;
  /** jsonb blob persisted by the review queue (ReviewMetadata + coverageComplete). */
  metadata: unknown;
  createdAt: Date;
}

/**
 * Map a DB review row to the wire `Review` contract (@ghagga/types).
 *
 * This is where `repo` becomes REAL: reviews rows only store `repositoryId`,
 * so the repository full name ("owner/name") is composed here —
 *   - per-repo path: from the repo row the route already validated (no extra join)
 *   - cross-installation path: from the `fullName` the query's join provides
 *
 * Also normalizes DB nullables (`summary`, `findings`) so the contract's
 * non-nullable fields tell the truth, and serializes `createdAt` to ISO.
 *
 * `coverageComplete` lives inside the `metadata` jsonb blob (the queue folds
 * it in at saveReview time — queues/review.ts). It is emitted ONLY when the
 * blob carries a real boolean: rows persisted before the field existed, and
 * SKIPPED reviews (pipeline never ran), simply lack the key on the wire.
 */
function toReviewDto(row: ReviewRow, repoFullName: string): Review {
  const coverageComplete = (row.metadata as { coverageComplete?: unknown } | null)
    ?.coverageComplete;
  return {
    id: row.id,
    repo: repoFullName,
    prNumber: row.prNumber,
    status: row.status as ReviewStatus,
    mode: row.mode as ReviewMode,
    summary: row.summary ?? '',
    findings: (row.findings ?? []) as Finding[],
    createdAt: row.createdAt.toISOString(),
    ...(typeof coverageComplete === 'boolean' ? { coverageComplete } : {}),
  };
}

export function createReviewsRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/reviews ────────────────────────────────────────
  router.get('/api/reviews', async (c) => {
    const user = c.get('user') as AuthUser;
    const repoFullName = c.req.query('repo');
    const page = parseInt(c.req.query('page') ?? '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
    const offset = (page - 1) * limit;

    try {
      // ── No repo specified → "All repositories": list reviews across every
      // repository belonging to the caller's installations. Strictly scoped by
      // user.installationIds so a caller never sees another tenant's reviews.
      if (!repoFullName) {
        if (user.installationIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, offset, total: 0 } });
        }

        const [reviews, total] = await Promise.all([
          getReviewsByInstallationIds(db, user.installationIds, { limit, offset }),
          countReviewsByInstallationIds(db, user.installationIds),
        ]);

        return c.json({
          // Each joined row carries its repository fullName → wire `repo`.
          // Destructured so the compiler resolves `fullName` from the real
          // query row type (ReviewWithRepo), not the structural ReviewRow.
          data: reviews.map(({ fullName, ...row }) => toReviewDto(row, fullName)),
          pagination: { page, limit, offset, total },
        });
      }

      const repo = await getRepoByFullName(db, repoFullName);

      if (!repo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      if (!user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      const [reviews, total] = await Promise.all([
        getReviewsByRepoId(db, repo.id, { limit, offset }),
        countReviewsByRepoId(db, repo.id),
      ]);

      return c.json({
        // All rows belong to `repo` (validated above) — compose its canonical
        // fullName instead of re-joining repositories per row in the query.
        data: reviews.map((row) => toReviewDto(row, repo.fullName)),
        pagination: { page, limit, offset, total },
      });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, repo: repoFullName, user: user.githubLogin },
        'Failed to fetch reviews',
      );
      return c.json({ error: 'FETCH_FAILED', message: 'Failed to fetch reviews', errorId }, 500);
    }
  });

  // ── GET /api/stats ──────────────────────────────────────────
  router.get('/api/stats', async (c) => {
    const user = c.get('user') as AuthUser;
    const repoFullName = c.req.query('repo');

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

      const [raw, reviewsByDay] = await Promise.all([
        getReviewStats(db, repo.id),
        getReviewsByDay(db, repo.id),
      ]);

      // Map DB shape to dashboard Stats type
      const total = raw.total ?? 0;
      const passed = raw.passed ?? 0;
      const failed = raw.failed ?? 0;
      const skipped = raw.skipped ?? 0;
      const needsHumanReview = total - passed - failed - skipped;

      return c.json({
        data: {
          totalReviews: total,
          passed,
          failed,
          needsHumanReview,
          skipped,
          passRate: total > 0 ? (passed / total) * 100 : 0,
          reviewsByDay,
        },
      });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, repo: repoFullName, user: user.githubLogin },
        'Failed to fetch stats',
      );
      return c.json({ error: 'FETCH_FAILED', message: 'Failed to fetch stats', errorId }, 500);
    }
  });

  // ── DELETE /api/reviews/batch ─────────────────────────────────
  // Registered BEFORE :repoFullName to ensure literal match first.
  const batchReviewsSchema = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(100),
  });

  router.delete('/api/reviews/batch', async (c) => {
    const user = c.get('user') as AuthUser;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }

    const parsed = batchReviewsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        400,
      );
    }

    try {
      let deletedCount = 0;
      for (const installationId of user.installationIds) {
        deletedCount += await deleteReviewsByIds(db, installationId, parsed.data.ids);
      }
      return c.json({ data: { deletedCount } });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, user: user.githubLogin }, 'Failed to batch delete reviews');
      return c.json(
        { error: 'DELETE_FAILED', message: 'Failed to batch delete reviews', errorId },
        500,
      );
    }
  });

  // ── DELETE /api/reviews/:param ────────────────────────────────
  // Combined handler: numeric param → delete single review by ID,
  // non-numeric param → delete reviews by repo full name (URL-encoded).
  router.delete('/api/reviews/:param', async (c) => {
    const user = c.get('user') as AuthUser;
    const rawParam = c.req.param('param');

    // ── Numeric → single review delete by ID ──
    if (/^\d+$/.test(rawParam)) {
      const reviewId = parseInt(rawParam, 10);

      try {
        for (const installationId of user.installationIds) {
          const deleted = await deleteReviewById(db, installationId, reviewId);
          if (deleted) {
            return c.json({ data: { deleted: true } });
          }
        }
        return c.json({ error: 'NOT_FOUND', message: 'Review not found' }, 404);
      } catch (err) {
        const errorId = generateErrorId();
        logger.error({ err, errorId, user: user.githubLogin }, 'Failed to delete review');
        return c.json({ error: 'DELETE_FAILED', message: 'Failed to delete review', errorId }, 500);
      }
    }

    // ── Non-numeric → delete reviews by repo full name ──
    const repoFullName = decodeURIComponent(rawParam);
    const includeMemory = c.req.query('includeMemory') === 'true';

    try {
      const repo = await getRepoByFullName(db, repoFullName);

      if (!repo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      if (!user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      const deletedReviews = await deleteReviewsByRepoId(db, repo.id);

      let clearedMemory: number | null = null;
      if (includeMemory) {
        clearedMemory = await clearMemoryObservationsByProject(
          db,
          repo.installationId,
          repoFullName,
        );
      }

      return c.json({
        data: { deletedReviews, clearedMemory },
      });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error(
        { err, errorId, repo: repoFullName, user: user.githubLogin },
        'Failed to delete reviews',
      );
      return c.json({ error: 'DELETE_FAILED', message: 'Failed to delete reviews', errorId }, 500);
    }
  });

  return router;
}
