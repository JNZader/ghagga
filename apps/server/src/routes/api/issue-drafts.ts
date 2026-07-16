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
 *     depth). EXACTLY-ONCE POSTING is enforced by a CAS posting-lock: approve
 *     atomically claims the draft (DRAFT → APPROVED) BEFORE calling postComment,
 *     so of N concurrent approvers only ONE ever reaches GitHub; the losers get
 *     a 409 before any side effect. On a successful post the claim resolves
 *     forward (APPROVED → POSTED); on a failed post it reverts (APPROVED →
 *     DRAFT) so a human can retry. APPROVED is a TRANSIENT "posting" state.
 *
 *     Lifecycle: DRAFT → APPROVED (posting) → POSTED   (or → DRAFT on failure).
 *
 *   - The worker NEVER posts; posting only ever happens here, on human approval.
 *
 *   EXISTENCE ORACLE: a draft the caller does not own is reported as 404 (not
 *   403) on detail/edit/approve/reject, so a user cannot enumerate which draft
 *   ids exist in other tenants by distinguishing "exists but not yours" from
 *   "doesn't exist".
 */

import type { Database } from 'ghagga-db';
import {
  claimIssueDraftForPosting,
  getInstallationById,
  getIssueDraftById,
  getReposByInstallationId,
  getRepositoryById,
  ISSUE_DRAFT_STATUSES,
  type IssueDraftStatus,
  listIssueDrafts,
  markIssueDraftPosted,
  rejectIssueDraft,
  releaseIssueDraftClaim,
  updateIssueDraftBody,
} from 'ghagga-db';
import { Hono } from 'hono';
import { z } from 'zod';
// getInstallationToken stays directly importable (NOT a forge-adapter fn). The
// comment POST goes through the composition-root factory's sanctioned
// `postIssueComment` — the forge-boundary lint forbids importing the @internal
// `postComment` directly outside that factory.
import { getInstallationToken } from '../../github/client.js';
import { postIssueComment } from '../../github/forge-adapter-factory.js';
import type { AuthUser } from '../../middleware/auth.js';
import { generateErrorId, logger } from './utils.js';

/**
 * Max BYTE length for an edited draft body — bounds what gets posted to GitHub
 * (GitHub's comment limit is ~65536 BYTES, not UTF-16 code units). We validate
 * actual UTF-8 byte length below so multibyte content can't smuggle past a
 * char-count cap.
 */
const MAX_DRAFT_BODY_BYTES = 60_000;

/**
 * POST-SUCCEEDED recovery: once the GitHub comment is LIVE, recording the POSTED
 * transition must NOT be abandoned on the first transient DB error — abandoning
 * (or releasing the claim) would either strand a live comment as an un-POSTED
 * draft or let a retry post a SECOND comment. We retry the mark a bounded number
 * of times before giving up and leaving the draft APPROVED with the comment live.
 */
const MARK_POSTED_MAX_ATTEMPTS = 3;
const MARK_POSTED_RETRY_DELAY_MS = 100;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const editBodySchema = z.object({
  body: z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_DRAFT_BODY_BYTES, {
      message: `Body exceeds ${MAX_DRAFT_BODY_BYTES} bytes`,
    }),
});

/**
 * Parse a `:id` path param STRICTLY. `parseInt('9abc', 10)` silently truncates
 * to 9; `Number('9abc')` is NaN, so a partial-number id is rejected. Returns the
 * positive integer id, or `null` when the param is not a clean positive integer.
 */
function parseIdParam(param: string | undefined): number | null {
  if (param === undefined) return null;
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : null;
}

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
    const id = parseIdParam(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid draft id' }, 400);
    }

    try {
      const draft = await getIssueDraftById(db, id);
      const repoIds = await resolveCallerRepoIds(db, user);
      // EXISTENCE ORACLE: a missing draft AND a foreign draft both return 404 —
      // a caller cannot tell "exists but not yours" from "doesn't exist".
      if (!draft || !repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
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
    const id = parseIdParam(c.req.param('id'));
    if (id === null) {
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
      const repoIds = await resolveCallerRepoIds(db, user);
      // EXISTENCE ORACLE: missing OR foreign → 404 (no tenant id enumeration).
      if (!draft || !repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
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
  // Posts the (edited) draft body to the GitHub issue exactly once.
  //
  // EXACTLY-ONCE POSTING: we CLAIM the draft (CAS DRAFT → APPROVED) BEFORE
  // calling postComment. Of N concurrent approvers only ONE wins the claim and
  // reaches GitHub; the rest get `undefined` from the claim and a 409 BEFORE any
  // side effect — so postComment fires at most once. On success the claim
  // resolves forward (APPROVED → POSTED); on a post FAILURE we revert (APPROVED
  // → DRAFT) so the human can retry. Repo ownership is re-verified before the
  // claim. Lifecycle: DRAFT → APPROVED (posting) → POSTED  (or → DRAFT on fail).
  router.post('/api/issue-drafts/:id/approve', async (c) => {
    const user = c.get('user') as AuthUser;
    const id = parseIdParam(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid draft id' }, 400);
    }

    try {
      const draft = await getIssueDraftById(db, id);

      // RE-AUTHORIZATION before any side effect: the caller MUST own the draft's
      // repo. EXISTENCE ORACLE: missing OR foreign → 404 (no tenant id leak).
      const repoIds = await resolveCallerRepoIds(db, user);
      if (!draft || !repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
      }

      // Early lifecycle hint: a non-DRAFT draft can never be claimed, so 409 now
      // and skip the repo/token work. (The CAS claim below is the AUTHORITATIVE
      // guard against the concurrent race — this only avoids needless work.)
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

      // ── POSTING LOCK (CAS): claim DRAFT → APPROVED BEFORE posting ──
      // EXACTLY ONE concurrent approver wins this; the losers get undefined and
      // bail with 409 here, so postComment is never called twice for one draft.
      const claimed = await claimIssueDraftForPosting(db, id);
      if (!claimed) {
        logger.warn(
          { id, user: user.githubLogin },
          'Lost the posting claim (concurrent approve already claimed this draft)',
        );
        return c.json({ error: 'CONFLICT', message: 'Draft is already being processed' }, 409);
      }

      const [owner, repoName] = repo.fullName.split('/') as [string, string];

      // From here we OWN the claim. The `posted` pivot separates two failure
      // regimes with OPPOSITE recovery rules:
      //   • PRE-POST (token exchange OR postComment throws before returning a
      //     comment): nothing is live on GitHub → RELEASE the claim (APPROVED →
      //     DRAFT) so a human can retry.
      //   • POST-SUCCEEDED (the comment is live, but recording POSTED fails):
      //     NEVER release — a retry would post a SECOND comment. Retry the mark,
      //     and if it still fails leave the draft APPROVED with the live comment.
      // getInstallationToken is INSIDE this boundary precisely because a token
      // failure is pre-post and safe to release.
      let posted: Awaited<ReturnType<typeof postIssueComment>> | undefined;
      try {
        // Token is for the github installation id (NOT our internal row id).
        const token = await getInstallationToken(
          installation.githubInstallationId,
          appId,
          privateKey,
        );
        posted = await postIssueComment(
          { owner, repo: repoName, token },
          claimed.issueNumber,
          claimed.body,
        );
      } catch (postErr) {
        // PRE-POST failure (token exchange or postComment threw before a comment
        // was created) → revert the claim so a human can retry, then surface 502.
        await releaseIssueDraftClaim(db, id);
        const errorId = generateErrorId();
        logger.error(
          { err: postErr, errorId, id, user: user.githubLogin },
          'token exchange or postComment failed during approve; reverted claim to DRAFT',
        );
        return c.json(
          { error: 'POST_FAILED', message: 'Failed to post the comment to GitHub', errorId },
          502,
        );
      }

      // ── POST SUCCEEDED — the GitHub comment is now LIVE ──
      // Record the post: CAS APPROVED → POSTED. Because the comment ALREADY
      // EXISTS, a failure here must NEVER release the claim (a retry would
      // double-post). Retry the mark a bounded number of times against a
      // transient DB error before giving up.
      let updated: Awaited<ReturnType<typeof markIssueDraftPosted>> | undefined;
      let markErr: unknown;
      for (let attempt = 1; attempt <= MARK_POSTED_MAX_ATTEMPTS; attempt++) {
        try {
          updated = await markIssueDraftPosted(db, id, posted.id);
          markErr = undefined;
          break;
        } catch (err) {
          markErr = err;
          if (attempt < MARK_POSTED_MAX_ATTEMPTS) {
            await delay(MARK_POSTED_RETRY_DELAY_MS);
          }
        }
      }

      if (markErr !== undefined) {
        // The comment is LIVE but we could not persist POSTED after retries. DO
        // NOT release — the draft stays APPROVED with the comment posted. Log at
        // ERROR with BOTH the draft id AND the comment id so the state is
        // reconcilable, and return a NON-retryable error (the comment is live).
        const errorId = generateErrorId();
        logger.error(
          { err: markErr, errorId, id, commentId: posted.id, user: user.githubLogin },
          'CRITICAL: comment posted to GitHub but recording POSTED failed after retries; draft left APPROVED — comment is LIVE, do NOT retry the post',
        );
        return c.json(
          {
            error: 'POST_RECORDING_FAILED',
            message:
              'The comment was posted to GitHub, but recording it failed. No retry is needed — a maintainer will reconcile the draft state.',
            errorId,
            commentId: posted.id,
          },
          500,
        );
      }

      if (!updated) {
        // Defensive: the CAS matched ZERO rows (someone moved the row out of
        // APPROVED). The comment WAS already posted, so do NOT release.
        logger.warn(
          { id, commentId: posted.id, user: user.githubLogin },
          'Draft was no longer APPROVED at POSTED transition (comment already posted)',
        );
        return c.json({ error: 'CONFLICT', message: 'Draft was already decided' }, 409);
      }

      logger.info(
        { id, commentId: posted.id, repo: repo.fullName, issue: claimed.issueNumber },
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
    const id = parseIdParam(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid draft id' }, 400);
    }

    try {
      const draft = await getIssueDraftById(db, id);
      const repoIds = await resolveCallerRepoIds(db, user);
      // EXISTENCE ORACLE: missing OR foreign → 404 (no tenant id enumeration).
      if (!draft || !repoIds.has(draft.repositoryId)) {
        return c.json({ error: 'NOT_FOUND', message: 'Draft not found' }, 404);
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
