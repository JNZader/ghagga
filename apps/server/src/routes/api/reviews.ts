/**
 * Review-related API routes:
 *   GET  /api/reviews
 *   GET  /api/stats
 *   DELETE /api/reviews/batch
 *   DELETE /api/reviews/:param  (numeric → single review by ID, non-numeric → by repo full name)
 */

import type { Finding, Review, ReviewFinding, ReviewMode, ReviewStatus } from '@ghagga/types';
import type { Database } from 'ghagga-db';
import {
  clearMemoryObservationsByProject,
  countReviewsByInstallationIds,
  countReviewsByRepoId,
  deleteReviewById,
  deleteReviewsByIds,
  deleteReviewsByRepoId,
  eq,
  getRepoByFullName,
  getReviewStats,
  getReviewsByDay,
  getReviewsByInstallationIds,
  getReviewsByRepoId,
  type ReviewWithRepo,
  repositories,
  reviews as reviewsTable,
  sql,
} from 'ghagga-db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthUser } from '../../middleware/auth.js';
import { generateErrorId, logger } from './utils.js';

/** SQL condition chunk (eq(...) and sql`...` both produce this shape). */
type SqlCondition = ReturnType<typeof eq>;

/** Valid persisted review statuses (mirrors ReviewStatus in ghagga-core). */
const REVIEW_STATUSES = ['PASSED', 'FAILED', 'NEEDS_HUMAN_REVIEW', 'SKIPPED', 'PARTIAL'] as const;

/**
 * Runtime validation for GET /api/reviews query params (PRODOPS-007).
 *
 * `page`/`limit` are coerced and constrained (positive finite integers, sane
 * defaults, hard max) so a negative offset, NaN, or an enormous limit can never
 * reach the database. Filters (`status`, `q`) are validated so server-side
 * filtering (PRODOPS-005) runs on trusted input.
 */
const listReviewsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  // Positive finite integer; values above the cap are clamped (preserving the
  // prior Math.min behaviour) rather than rejected.
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(50)
    .transform((n) => Math.min(n, 100)),
  status: z.enum(REVIEW_STATUSES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

/** Combine conditions with AND (never called empty — a base condition is always present). */
function combineAnd(conds: SqlCondition[]): SqlCondition {
  return conds.reduce((acc, cond) => sql`${acc} AND ${cond}`);
}

/**
 * Build a LIKE pattern from raw user input, escaping the ILIKE wildcard
 * metacharacters (`%`, `_`, `\`) so a search term is matched literally and can't
 * inject wildcards.
 */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/**
 * Case-insensitive search across a review's summary and PR number, optionally
 * including the repository full name (cross-repository listing only).
 */
function reviewSearchCondition(
  term: string,
  fullNameColumn?: typeof repositories.fullName,
): SqlCondition {
  const like = likePattern(term);
  const parts: SqlCondition[] = [
    sql`${reviewsTable.summary} ILIKE ${like}`,
    sql`${reviewsTable.prNumber}::text ILIKE ${like}`,
  ];
  if (fullNameColumn) parts.push(sql`${fullNameColumn} ILIKE ${like}`);
  const ored = parts.reduce((acc, part) => sql`${acc} OR ${part}`);
  return sql`(${ored})`;
}

interface ReviewFilters {
  limit: number;
  offset: number;
  status?: (typeof REVIEW_STATUSES)[number];
  q?: string;
}

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
 * Project a persisted `ReviewFinding` to the wire `Finding` shape, dropping the
 * AI-internal detail fields the HTTP API must not expose: raw LLM reasoning
 * (`filterReason`) and the internal repo paths inside `exploitabilityDetail` /
 * `usageDetail` (importSites, reachableFrom, filesScanned, …). Labels and
 * signals (`exploitability`, `usageLabel`, `aiFiltered`, `aiPriority`) are kept.
 * The local CLI/ACP outputs still emit the full `ReviewFinding` — only this
 * auth-gated HTTP endpoint, reachable by any installation-token holder, projects.
 */
function toWireFinding(raw: unknown): Finding {
  const finding = { ...(raw as ReviewFinding) };
  delete finding.filterReason;
  delete finding.exploitabilityDetail;
  delete finding.usageDetail;
  return finding;
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
    // Drop any non-object entries (corrupt jsonb) before projecting — a
    // primitive would spread into an indexed-char object on the wire. Real
    // rows are always ReviewFinding[]; this is fail-closed defense in depth.
    findings: (row.findings ?? [])
      .filter(
        (f): f is Record<string, unknown> =>
          typeof f === 'object' && f !== null && !Array.isArray(f),
      )
      .map(toWireFinding),
    createdAt: row.createdAt.toISOString(),
    ...(typeof coverageComplete === 'boolean' ? { coverageComplete } : {}),
  };
}

/**
 * Filtered per-repository listing (PRODOPS-005). Filters are applied in SQL
 * BEFORE pagination, and the total is counted over the SAME filtered predicate.
 */
async function listFilteredRepoReviews(
  db: Database,
  repositoryId: number,
  filters: ReviewFilters,
): Promise<{ rows: ReviewRow[]; total: number }> {
  const conds: SqlCondition[] = [eq(reviewsTable.repositoryId, repositoryId)];
  if (filters.status) conds.push(eq(reviewsTable.status, filters.status));
  if (filters.q) conds.push(reviewSearchCondition(filters.q));
  const where = combineAnd(conds);

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(reviewsTable)
      .where(where)
      .orderBy(sql`${reviewsTable.createdAt} DESC`)
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(reviewsTable).where(where),
  ]);
  return { rows: rows as ReviewRow[], total: countRows[0]?.total ?? 0 };
}

/**
 * Filtered cross-installation listing (PRODOPS-005). Same predicate for the page
 * and the total. Cross-tenant isolation is enforced by the `= ANY(installationIds)`
 * base condition; the caller guarantees `installationIds` is non-empty.
 */
async function listFilteredInstallationReviews(
  db: Database,
  installationIds: number[],
  filters: ReviewFilters,
): Promise<{ rows: ReviewWithRepo[]; total: number }> {
  const conds: SqlCondition[] = [sql`${repositories.installationId} = ANY(${installationIds})`];
  if (filters.status) conds.push(eq(reviewsTable.status, filters.status));
  if (filters.q) conds.push(reviewSearchCondition(filters.q, repositories.fullName));
  const where = combineAnd(conds);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: reviewsTable.id,
        repositoryId: reviewsTable.repositoryId,
        prNumber: reviewsTable.prNumber,
        status: reviewsTable.status,
        mode: reviewsTable.mode,
        summary: reviewsTable.summary,
        findings: reviewsTable.findings,
        tokensUsed: reviewsTable.tokensUsed,
        executionTimeMs: reviewsTable.executionTimeMs,
        metadata: reviewsTable.metadata,
        createdAt: reviewsTable.createdAt,
        fullName: repositories.fullName,
      })
      .from(reviewsTable)
      .innerJoin(repositories, eq(repositories.id, reviewsTable.repositoryId))
      .where(where)
      .orderBy(sql`${reviewsTable.createdAt} DESC`)
      .limit(filters.limit)
      .offset(filters.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(reviewsTable)
      .innerJoin(repositories, eq(repositories.id, reviewsTable.repositoryId))
      .where(where),
  ]);
  return { rows: rows as ReviewWithRepo[], total: countRows[0]?.total ?? 0 };
}

export function createReviewsRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/reviews ────────────────────────────────────────
  router.get('/api/reviews', async (c) => {
    const user = c.get('user') as AuthUser;
    const repoFullName = c.req.query('repo');

    // PRODOPS-007: validate pagination + filter params before touching the DB.
    const parsedQuery = listReviewsQuerySchema.safeParse({
      page: c.req.query('page'),
      limit: c.req.query('limit'),
      status: c.req.query('status'),
      q: c.req.query('q'),
    });
    if (!parsedQuery.success) {
      return c.json(
        {
          error: 'VALIDATION_ERROR',
          message: parsedQuery.error.issues[0]?.message ?? 'Invalid query parameters',
        },
        400,
      );
    }
    const { page, limit, status, q } = parsedQuery.data;
    const offset = (page - 1) * limit;
    const hasFilters = status !== undefined || q !== undefined;
    const filters: ReviewFilters = { limit, offset, status, q };

    try {
      // ── No repo specified → "All repositories": list reviews across every
      // repository belonging to the caller's installations. Strictly scoped by
      // user.installationIds so a caller never sees another tenant's reviews.
      if (!repoFullName) {
        if (user.installationIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, offset, total: 0 } });
        }

        // PRODOPS-005: when filters are active, filter server-side BEFORE
        // pagination and count over the filtered set. Otherwise keep the exact
        // tested default path (getReviewsByInstallationIds + count).
        const { rows, total } = hasFilters
          ? await listFilteredInstallationReviews(db, user.installationIds, filters)
          : {
              rows: await getReviewsByInstallationIds(db, user.installationIds, { limit, offset }),
              total: await countReviewsByInstallationIds(db, user.installationIds),
            };

        return c.json({
          // Each joined row carries its repository fullName → wire `repo`.
          // Destructured so the compiler resolves `fullName` from the real
          // query row type (ReviewWithRepo), not the structural ReviewRow.
          data: rows.map(({ fullName, ...row }) => toReviewDto(row, fullName)),
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

      // PRODOPS-005: server-side filter + filtered total; default path unchanged.
      const { rows, total } = hasFilters
        ? await listFilteredRepoReviews(db, repo.id, filters)
        : {
            rows: await getReviewsByRepoId(db, repo.id, { limit, offset }),
            total: await countReviewsByRepoId(db, repo.id),
          };

      return c.json({
        // All rows belong to `repo` (validated above) — compose its canonical
        // fullName instead of re-joining repositories per row in the query.
        data: rows.map((row) => toReviewDto(row, repo.fullName)),
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
