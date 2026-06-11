/**
 * Review-related API routes:
 *   GET  /api/reviews
 *   GET  /api/stats
 *   DELETE /api/reviews/batch
 *   DELETE /api/reviews/:param  (numeric → single review by ID, non-numeric → by repo full name)
 */

import type { Database } from 'ghagga-db';
import {
  clearMemoryObservationsByProject,
  countReviewsByRepoId,
  deleteReviewById,
  deleteReviewsByIds,
  deleteReviewsByRepoId,
  getRepoByFullName,
  getReviewStats,
  getReviewsByDay,
  getReviewsByRepoId,
} from 'ghagga-db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthUser } from '../../middleware/auth.js';
import { generateErrorId, logger } from './utils.js';

export function createReviewsRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/reviews ────────────────────────────────────────
  router.get('/api/reviews', async (c) => {
    const user = c.get('user') as AuthUser;
    const repoFullName = c.req.query('repo');
    const page = parseInt(c.req.query('page') ?? '1', 10);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
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

      const [reviews, total] = await Promise.all([
        getReviewsByRepoId(db, repo.id, { limit, offset }),
        countReviewsByRepoId(db, repo.id),
      ]);

      return c.json({
        data: reviews,
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
