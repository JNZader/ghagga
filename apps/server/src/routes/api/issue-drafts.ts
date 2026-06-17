/**
 * Issue-draft approval API routes (issue-triage agent, Phase 6).
 *
 *   GET   /api/issue-drafts            list pending drafts (scoped to caller)
 *   GET   /api/issue-drafts/:id        draft detail (scoped)
 *   PATCH /api/issue-drafts/:id        edit the draft body (DRAFT-only)
 *   POST  /api/issue-drafts/:id/approve  post the (edited) body to the issue + POSTED
 *   POST  /api/issue-drafts/:id/reject   → REJECTED, never posts
 *
 * SECURITY MODEL (mirrors reviews.ts):
 *   - Every route resolves the caller's repository set from `user.installationIds`
 *     (auth middleware) and scopes draft access to THAT set. A user can never
 *     read or act on a draft whose `repositoryId` is outside their repos.
 *   - The approve path RE-VERIFIES repo ownership BEFORE posting (defense in
 *     depth), and the POSTED transition is the DB-level idempotency guard: a
 *     duplicate/concurrent approve matches zero DRAFT rows and does NOT re-post.
 *   - The worker NEVER posts; posting only ever happens here, on human approval.
 */

import type { Database } from 'ghagga-db';
import {
  getInstallationById,
  getIssueDraftById,
  getReposByInstallationId,
  getRepositoryById,
  ISSUE_DRAFT_STATUSES,
  type IssueDraftStatus,
  listIssueDrafts,
  markIssueDraftPosted,
  rejectIssueDraft,
  updateIssueDraftBody,
} from 'ghagga-db';
import { Hono } from 'hono';
import { z } from 'zod';
import { getInstallationToken, postComment } from '../../github/client.js';
import type { AuthUser } from '../../middleware/auth.js';
import { generateErrorId, logger } from './utils.js';

/** Max length for an edited draft body — bounds what gets posted to GitHub. */
const MAX_DRAFT_BODY_BYTES = 60_000;

const editBodySchema = z.object({
  body: z.string().min(1).max(MAX_DRAFT_BODY_BYTES),
});

/**
 * Resolve the INTERNAL repository ids the caller may access, from their
 * installation membership. Returns a Set for O(1) ownership checks. Empty when
 * the user has no installations (→ they see/act on nothing).
 */
async function resolveCallerRepoIds(db: Database, user: AuthUser): Promise<Set<number>> {
  const repoIds = new Set<number>();
  for (const installationId of user.installationIds) {
    const repos = await getReposByInstallationId(db, installationId);
    for (const repo of repos) repoIds.add(repo.id);
  }
  return repoIds;
}

/** Project a draft row to the wire shape (serializes timestamps). */
function toDraftDto(row: Awaited<ReturnType<typeof getIssueDraftById>>) {
  if (!row) return null;
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    issueNumber: row.issueNumber,
    issueTitle: row.issueTitle,
    status: row.status,
    draftKind: row.draftKind,
    body: row.body,
    sources: row.sources ?? [],
    dedupMatches: row.dedupMatches ?? [],
    tokensUsed: row.tokensUsed,
    postedCommentId: row.postedCommentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createIssueDraftsRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/issue-drafts ───────────────────────────────────
  router.get('/api/issue-drafts', async (c) => {
    const user = c.get('user') as AuthUser;
    const statusParam = c.req.query('status');
    const page = Math.max(parseInt(c.req.query('page') ?? '1', 10), 1);
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
    const offset = (page - 1) * limit;

    // Validate the optional status filter against the known union.
    let status: IssueDraftStatus | undefined;
    if (statusParam) {
      if (!(ISSUE_DRAFT_STATUSES as readonly string[]).includes(statusParam)) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid status filter' }, 400);
      }
      status = statusParam as IssueDraftStatus;
    }

    try {
      const repoIds = await resolveCallerRepoIds(db, user);
      // listIssueDrafts short-circuits to [] on an empty id set — a caller with
      // no repos never sees another tenant's drafts.
      const drafts = await listIssueDrafts(db, Array.from(repoIds), { status, limit, offset });
      return c.json({ data: drafts.map(toDraftDto) });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, user: user.githubLogin }, 'Failed to list issue drafts');
      return c.json(
        { error: 'FETCH_FAILED', message: 'Failed to list issue drafts', errorId },
        500,
      );
    }
  });

  // ── GET /api/issue-drafts/:id ───────────────────────────────
  router.get('/api/issue-drafts/:id', async (c) => {
    const user = c.get('user') as AuthUser;
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid draft id' }, 400);
    }

    try {
      const draft = await getIssueDraftById(db, id);
      if (!draft) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
      }
      const repoIds = await resolveCallerRepoIds(db, user);
      if (!repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }
      return c.json({ data: toDraftDto(draft) });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, id, user: user.githubLogin }, 'Failed to fetch issue draft');
      return c.json(
        { error: 'FETCH_FAILED', message: 'Failed to fetch issue draft', errorId },
        500,
      );
    }
  });

  // ── PATCH /api/issue-drafts/:id (edit body) ─────────────────
  router.patch('/api/issue-drafts/:id', async (c) => {
    const user = c.get('user') as AuthUser;
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid draft id' }, 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid JSON body' }, 400);
    }
    const parsed = editBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid input' },
        400,
      );
    }

    try {
      const draft = await getIssueDraftById(db, id);
      if (!draft) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
      }
      const repoIds = await resolveCallerRepoIds(db, user);
      if (!repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }
      // DRAFT-only update — a decided draft cannot be edited (returns undefined).
      const updated = await updateIssueDraftBody(db, id, parsed.data.body);
      if (!updated) {
        return c.json(
          { error: 'CONFLICT', message: 'Only a draft in DRAFT status can be edited' },
          409,
        );
      }
      return c.json({ data: toDraftDto(updated) });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, id, user: user.githubLogin }, 'Failed to edit issue draft');
      return c.json(
        { error: 'UPDATE_FAILED', message: 'Failed to edit issue draft', errorId },
        500,
      );
    }
  });

  // ── POST /api/issue-drafts/:id/approve ──────────────────────
  // Posts the (edited) draft body to the GitHub issue, then transitions to
  // POSTED. Re-verifies repo ownership BEFORE posting; the POSTED transition is
  // the DB-level idempotency guard (a double-click / redelivery matches no DRAFT
  // row and does NOT re-post).
  router.post('/api/issue-drafts/:id/approve', async (c) => {
    const user = c.get('user') as AuthUser;
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid draft id' }, 400);
    }

    try {
      const draft = await getIssueDraftById(db, id);
      if (!draft) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
      }

      // RE-AUTHORIZATION before any side effect: the caller MUST own the draft's
      // repo. Without this a user could post to an issue in a repo they don't own.
      const repoIds = await resolveCallerRepoIds(db, user);
      if (!repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }

      // Lifecycle guard: only a DRAFT can be posted. A POSTED/REJECTED/APPROVED
      // draft must not re-post. (The DB transition re-checks this atomically; this
      // early check avoids a needless GitHub call + gives a clear 409.)
      if (draft.status !== 'DRAFT') {
        return c.json({ error: 'CONFLICT', message: `Draft is already ${draft.status}` }, 409);
      }

      // Resolve owner/repo + the GitHub installation token for THIS repo.
      const repo = await getRepositoryById(db, draft.repositoryId);
      if (!repo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }
      const installation = await getInstallationById(db, repo.installationId);
      if (!installation) {
        return c.json({ error: 'NOT_FOUND', message: 'Installation not found' }, 404);
      }

      const appId = process.env.GITHUB_APP_ID;
      const privateKey = process.env.GITHUB_PRIVATE_KEY;
      if (!appId || !privateKey) {
        const errorId = generateErrorId();
        logger.error({ errorId }, 'GITHUB_APP_ID / GITHUB_PRIVATE_KEY not configured');
        return c.json(
          { error: 'CONFIG_ERROR', message: 'GitHub App is not configured', errorId },
          500,
        );
      }

      const [owner, repoName] = repo.fullName.split('/') as [string, string];
      // Token is for the github installation id (NOT our internal row id).
      const token = await getInstallationToken(
        installation.githubInstallationId,
        appId,
        privateKey,
      );
      const posted = await postComment(owner, repoName, draft.issueNumber, draft.body, token);

      // IDEMPOTENCY: pins status='DRAFT'. If another approve already POSTED this
      // draft, this matches zero rows and returns undefined — surface a 409 and do
      // NOT pretend we re-posted. (The comment above was posted in THIS request;
      // the only way to reach the undefined branch is a concurrent approve that
      // won the race, which is the intended "exactly one wins" guard.)
      const updated = await markIssueDraftPosted(db, id, posted.id);
      if (!updated) {
        logger.warn(
          { id, user: user.githubLogin },
          'Draft transitioned out of DRAFT during approve',
        );
        return c.json({ error: 'CONFLICT', message: 'Draft was already decided' }, 409);
      }

      logger.info(
        { id, commentId: posted.id, repo: repo.fullName, issue: draft.issueNumber },
        'Issue draft approved and posted',
      );
      return c.json({ data: toDraftDto(updated) });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, id, user: user.githubLogin }, 'Failed to approve issue draft');
      return c.json(
        { error: 'APPROVE_FAILED', message: 'Failed to approve issue draft', errorId },
        500,
      );
    }
  });

  // ── POST /api/issue-drafts/:id/reject ───────────────────────
  router.post('/api/issue-drafts/:id/reject', async (c) => {
    const user = c.get('user') as AuthUser;
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid draft id' }, 400);
    }

    try {
      const draft = await getIssueDraftById(db, id);
      if (!draft) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
      }
      const repoIds = await resolveCallerRepoIds(db, user);
      if (!repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'FORBIDDEN', message: 'Forbidden' }, 403);
      }
      // DRAFT-only — a decided draft cannot be re-rejected. NEVER posts.
      const updated = await rejectIssueDraft(db, id);
      if (!updated) {
        return c.json({ error: 'CONFLICT', message: `Draft is already ${draft.status}` }, 409);
      }
      return c.json({ data: toDraftDto(updated) });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, id, user: user.githubLogin }, 'Failed to reject issue draft');
      return c.json(
        { error: 'REJECT_FAILED', message: 'Failed to reject issue draft', errorId },
        500,
      );
    }
  });

  return router;
}
