/**
 * GitHub webhook handler.
 *
 * Processes incoming webhook events:
 *   - pull_request: Dispatch review via BullMQ queue
 *   - issue_comment: Re-trigger review on "ghagga review" keyword
 *   - installation: Track app installations
 *   - installation_repositories: Track repo additions/removals
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'ghagga-db';
import {
  deactivateInstallation,
  deleteMappingsByInstallationId,
  getEffectiveRepoSettings,
  getInstallationByGitHubId,
  getRepoByGithubId,
  updateWorkflowStatus,
  upsertInstallation,
  upsertRepository,
} from 'ghagga-db';
import { Hono } from 'hono';
import {
  addCommentReaction,
  fetchPRDetails,
  getInstallationToken,
  getIssue,
  listIssueComments,
  verifyWebhookSignature,
} from '../github/client.js';
import { injectWorkflow } from '../github/runner.js';
import { logger as rootLogger } from '../lib/logger.js';
import { enqueueIssueAnalysis } from '../queues/issue-analysis.js';
import { enqueueReview } from '../queues/review.js';

const logger = rootLogger.child({ module: 'webhook' });

// ─── Minimal Webhook Event Types ────────────────────────────────

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    number: number;
    head: { sha: string };
    base: { ref: string };
    user: { login: string };
  };
  repository: {
    id: number;
    full_name: string;
  };
  installation?: { id: number };
}

interface IssueCommentEvent {
  action: string;
  comment: {
    id: number;
    body: string;
    user: {
      login: string;
      type: string; // "User" | "Bot"
    };
    author_association: string;
  };
  issue: {
    number: number;
    pull_request?: { url: string }; // Present only if the issue is a PR
  };
  repository: {
    id: number;
    full_name: string;
  };
  installation?: { id: number };
}

/**
 * Associations allowed to trigger a PR REVIEW via comment keyword.
 *
 * This is the SHARED, INTENTIONALLY-LENIENT gate for the diff-review path: a PR
 * is a deliberate code contribution, so even a CONTRIBUTOR / FIRST_TIMER asking
 * for a review on their own PR is acceptable (review only reads the diff, never
 * writes). The triage path is STRICTER — see TRIAGE_ALLOWED_ASSOCIATIONS.
 */
const ALLOWED_ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIMER',
  'FIRST_TIME_CONTRIBUTOR',
]);

/**
 * Associations allowed to trigger `/ghagga triage` — STRICTLY write-association.
 *
 * Issues are openable (and commentable) by ANYONE, so triage — which fetches
 * untrusted issue text and spends LLM tokens — must be gated to TRUE maintainers
 * (write access). This is a SEPARATE, stricter gate layered ON TOP of the shared
 * ALLOWED_ASSOCIATIONS check; the lenient PR-review associations (CONTRIBUTOR /
 * FIRST_TIMER / FIRST_TIME_CONTRIBUTOR) are deliberately EXCLUDED here so they
 * can still trigger a review but NOT a triage.
 */
const TRIAGE_ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// ─── Comment Command Parsing ───────────────────────────────────

/**
 * Valid slash commands that can be triggered from a comment.
 *
 * `review`/`security`/`perf`/`describe`/`fan-out` target a PR (the diff-review
 * path). `triage` targets a PLAIN (non-PR) issue (the issue-triage path) — it is
 * routed to the `issue-analysis` queue, never `enqueueReview`.
 */
type CommentCommand = 'review' | 'security' | 'perf' | 'describe' | 'fan-out' | 'triage';

/** Parsed result from a comment command */
interface ParsedCommand {
  /** The recognized command */
  command: CommentCommand;
  /** Review mode override (null = use repo default) */
  reviewMode: string | null;
}

/**
 * Maps each command to a review mode override. null = use repo's effective
 * settings. `triage` is NOT a review-mode command — it routes to the
 * issue-analysis queue — so its value here is null and unused by the PR path.
 */
const COMMAND_MODE_MAP: Record<CommentCommand, string | null> = {
  review: null,
  security: 'workflow',
  perf: 'workflow',
  describe: 'simple',
  'fan-out': 'fan-out',
  triage: null,
};

const VALID_COMMANDS = new Set<string>(Object.keys(COMMAND_MODE_MAP));

/**
 * Regex to detect "/ghagga <command>" or "ghagga <command>" in a comment body.
 * Case-insensitive. The leading slash is optional for backward compatibility.
 * Captures the command word in group 1.
 *
 * KNOWN LOW follow-up (NOT fixed here — see 5vr deferral): this regex is NOT
 * line-anchored, so a maintainer QUOTING an attacker's comment (e.g. a markdown
 * "> /ghagga triage" quote) can trigger a command. This is LOW: it still requires
 * a maintainer (write association) to post the quoting comment, and the triage
 * path is additionally token-cost-capped. It is shared with the PR-review trigger,
 * so anchoring it would change review-trigger behavior too — left untouched on
 * purpose. Track as a later hardening pass (line-anchor + per-path regexes).
 */
const COMMAND_REGEX = /\/?ghagga\s+(\w+)/i;

/**
 * Parse a PR comment body for a ghagga command.
 *
 * @returns ParsedCommand if a valid command is found, 'unknown' if ghagga was
 *          mentioned with an unrecognized command, or null if no trigger at all.
 */
export function parseCommentCommand(body: string): ParsedCommand | 'unknown' | null {
  const match = COMMAND_REGEX.exec(body);
  if (!match?.[1]) return null;

  const command = match[1].toLowerCase();
  if (!VALID_COMMANDS.has(command)) return 'unknown';

  return {
    command: command as CommentCommand,
    reviewMode: COMMAND_MODE_MAP[command as CommentCommand],
  };
}

// ─── Issue-Triage Payload Caps (DoS / unbounded-Redis-payload defense) ─────────
//
// The `/ghagga triage` path fetches UNTRUSTED issue title/body/comments from
// GitHub and packs them into a BullMQ (Redis) job payload. Those fields are NOT
// size-bounded by GitHub, so without caps a single giant issue (huge body +
// hundreds of long comments) would land an unbounded blob in `job.data` BEFORE
// the worker's defensive cap ever runs. We therefore cap BOTH the comment COUNT
// and the total serialized byte SIZE at this fetch/enqueue boundary.

/** Max number of (most-recent) issue comments fetched + included in a triage job. */
export const MAX_TRIAGE_COMMENTS = 20;

/** Max bytes for the issue body carried in the job payload (truncated past this). */
export const MAX_TRIAGE_BODY_BYTES = 32_768; // 32 KiB

/** Max bytes for a single comment body carried in the job payload. */
export const MAX_TRIAGE_COMMENT_BYTES = 4_096; // 4 KiB

/** Max number of labels carried in the job payload. GitHub allows up to 100. */
export const MAX_TRIAGE_LABELS = 50;

/** Max bytes for a single label name (labels are short; this is a paranoia cap). */
export const MAX_TRIAGE_LABEL_BYTES = 256;

/**
 * Total byte budget for the assembled untrusted text (body + all comment bodies
 * + all label names). Once reached, remaining comments are dropped so the
 * enqueued payload stays bounded regardless of how the per-field caps combine.
 * Labels are counted toward this budget too (a label-stuffed issue can otherwise
 * push the serialized payload well past the stated ceiling).
 */
export const MAX_TRIAGE_TOTAL_BYTES = 131_072; // 128 KiB

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes INCLUDING the ellipsis we
 * append on truncation — so the returned string is ALWAYS ≤ maxBytes (the stated
 * contract). The ellipsis '…' is 3 UTF-8 bytes, so we slice the source to
 * `maxBytes - 3` before appending it.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  const ELLIPSIS = '…';
  const ellipsisBytes = Buffer.byteLength(ELLIPSIS, 'utf8'); // 3
  // Reserve room for the ellipsis so the final output never exceeds maxBytes.
  // If maxBytes is too small to hold even the ellipsis, slice hard with no marker.
  const sliceTo = Math.max(0, maxBytes - ellipsisBytes);
  // Slice on a byte boundary, then drop a trailing partial codepoint by decoding
  // leniently — Buffer.toString replaces an incomplete tail with U+FFFD, which we
  // strip so we never emit a stray replacement char from truncation.
  let truncated = buf.subarray(0, sliceTo).toString('utf8');
  if (truncated.endsWith('�')) truncated = truncated.slice(0, -1);
  return sliceTo === 0 ? '' : `${truncated}${ELLIPSIS}`;
}

/**
 * Build a SIZE- and COUNT-bounded issue-triage payload from freshly fetched
 * (untrusted) issue data. Guarantees (each output field is ≤ its stated bound,
 * ellipsis-inclusive — see truncateToBytes):
 *   - issue title ≤ 500 bytes
 *   - issue body ≤ MAX_TRIAGE_BODY_BYTES
 *   - comments ≤ MAX_TRIAGE_COMMENTS (caller should already cap the fetch count;
 *     this re-enforces as a belt-and-suspenders against an over-long list)
 *   - each comment body ≤ MAX_TRIAGE_COMMENT_BYTES
 *   - labels ≤ MAX_TRIAGE_LABELS, each label ≤ MAX_TRIAGE_LABEL_BYTES
 *   - total carried untrusted bytes (body + comment bodies + label names)
 *     ≤ MAX_TRIAGE_TOTAL_BYTES
 *
 * The title is independently capped (issue_drafts.issueTitle is varchar(500) and
 * the worker re-slices to 500; we cap here so the Redis payload itself is bounded).
 */
export function buildBoundedTriagePayload(input: {
  issueTitle: string;
  issueBody: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
}): {
  issueTitle: string;
  issueBody: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
} {
  const issueTitle = truncateToBytes(input.issueTitle, 500);
  const issueBody = truncateToBytes(input.issueBody, MAX_TRIAGE_BODY_BYTES);

  // Bound labels: cap count, cap each name's bytes, and charge them to the budget.
  const labels: string[] = [];
  let remaining = MAX_TRIAGE_TOTAL_BYTES - Buffer.byteLength(issueBody, 'utf8');
  for (const label of input.labels.slice(0, MAX_TRIAGE_LABELS)) {
    if (remaining <= 0) break;
    const capped = truncateToBytes(label, Math.min(MAX_TRIAGE_LABEL_BYTES, remaining));
    labels.push(capped);
    remaining -= Buffer.byteLength(capped, 'utf8');
  }

  const comments: Array<{ author: string; body: string }> = [];
  for (const c of input.comments.slice(0, MAX_TRIAGE_COMMENTS)) {
    if (remaining <= 0) break;
    const perComment = Math.min(MAX_TRIAGE_COMMENT_BYTES, remaining);
    const body = truncateToBytes(c.body, perComment);
    comments.push({ author: c.author, body });
    remaining -= Buffer.byteLength(body, 'utf8');
  }

  return { issueTitle, issueBody, labels, comments };
}

interface InstallationEvent {
  action: string;
  installation: {
    id: number;
    account: {
      login: string;
      type: string;
    };
  };
  repositories?: Array<{
    id: number;
    full_name: string;
  }>;
}

interface InstallationRepositoriesEvent {
  action: string;
  installation: {
    id: number;
    account: {
      login: string;
      type: string;
    };
  };
  repositories_added?: Array<{
    id: number;
    full_name: string;
  }>;
  repositories_removed?: Array<{
    id: number;
    full_name: string;
  }>;
}

// ─── Ignore Pattern Matching ────────────────────────────────────

/**
 * Simple glob pattern match (supports * and ** wildcards).
 * Used to check if files should be ignored.
 */
function matchesPattern(file: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(file);
}

function _allFilesIgnored(files: string[], patterns: string[]): boolean {
  if (files.length === 0) return true;
  return files.every((file) => patterns.some((pattern) => matchesPattern(file, pattern)));
}

// ─── Route Factory ──────────────────────────────────────────────

export function createWebhookRouter(db: Database) {
  const router = new Hono();

  router.post('/webhook', async (c) => {
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!webhookSecret) {
      const errorId = randomUUID().slice(0, 8);
      logger.error({ errorId }, 'GITHUB_WEBHOOK_SECRET is not set');
      return c.json({ error: 'INTERNAL_ERROR', message: 'Server misconfiguration', errorId }, 500);
    }

    // Read raw body for signature verification
    const rawBody = await c.req.text();
    const signature = c.req.header('x-hub-signature-256') ?? null;

    // Verify signature
    const isValid = await verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    const eventType = c.req.header('x-github-event');

    if (!eventType) {
      return c.json({ error: 'Missing x-github-event header' }, 400);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    try {
      switch (eventType) {
        case 'pull_request':
          return await handlePullRequest(c, db, payload as PullRequestEvent);

        case 'issue_comment':
          return await handleIssueComment(c, db, payload as IssueCommentEvent);

        case 'installation':
          return await handleInstallation(c, db, payload as InstallationEvent);

        case 'installation_repositories':
          return await handleInstallationRepositories(
            c,
            db,
            payload as InstallationRepositoriesEvent,
          );

        default:
          return c.json({ message: `Event ${eventType} ignored` }, 200);
      }
    } catch (error) {
      const errorId = randomUUID().slice(0, 8);
      logger.error({ eventType, errorId, error: String(error) }, 'Error handling webhook event');
      return c.json({ error: 'INTERNAL_ERROR', message: 'Internal server error', errorId }, 500);
    }
  });

  return router;
}

// ─── Event Handlers ─────────────────────────────────────────────

async function handlePullRequest(
  c: { json: (data: unknown, status?: number) => Response },
  db: Database,
  payload: PullRequestEvent,
) {
  const validActions = ['opened', 'synchronize', 'reopened'];

  if (!validActions.includes(payload.action)) {
    return c.json({ message: `Action ${payload.action} ignored` }, 200);
  }

  if (!payload.installation?.id) {
    return c.json({ error: 'Missing installation ID' }, 400);
  }

  // Generate correlation ID for end-to-end review tracing
  const reviewId = randomUUID().slice(0, 8);

  // Look up the repository in our database
  const repo = await getRepoByGithubId(db, payload.repository.id);

  if (!repo) {
    logger.warn({ repo: payload.repository.full_name }, 'Received PR webhook for unknown repo');
    return c.json({ message: 'Repository not tracked' }, 200);
  }

  // Check if all changed files match ignore patterns
  // We'll do the full file check in the BullMQ queue,
  // but we can skip dispatch if the repo has very broad patterns.
  // For now, dispatch unconditionally and let the pipeline handle filtering.

  // Resolve effective settings (global vs per-repo)
  const effective = await getEffectiveRepoSettings(db, repo);

  // Dispatch review to BullMQ queue
  await enqueueReview({
    reviewId,
    installationId: payload.installation.id,
    repoFullName: payload.repository.full_name,
    prNumber: payload.number,
    repositoryId: repo.id,
    headSha: payload.pull_request.head.sha,
    baseBranch: payload.pull_request.base.ref,
    prAuthor: payload.pull_request.user.login,
    aiReviewEnabled: effective.aiReviewEnabled,
    // Legacy flat fields (kept for backward compat during transition)
    llmProvider: repo.llmProvider,
    llmModel: repo.llmModel ?? 'gpt-4o-mini',
    reviewMode: effective.reviewMode,
    // SECURITY: encrypted credentials (providerChain entries + encryptedApiKey)
    // are intentionally NOT enqueued. The worker re-fetches them from the DB by
    // repositoryId at processing time so secrets never live in the Redis payload.
    settings: {
      enableSemgrep: effective.settings.enableSemgrep,
      enableTrivy: effective.settings.enableTrivy,
      enableCpd: effective.settings.enableCpd,
      enableMemory: effective.settings.enableMemory,
      customRules: effective.settings.customRules,
      ignorePatterns: effective.settings.ignorePatterns,
      reviewLevel: effective.settings.reviewLevel,
      enabledTools: effective.settings.enabledTools,
      disabledTools: effective.settings.disabledTools,
      enableBlastRadius: effective.settings.enableBlastRadius,
    },
  });

  logger.info(
    { repo: payload.repository.full_name, pr: payload.number, reviewId },
    'Review dispatched',
  );

  return c.json(
    {
      message: 'Review dispatched',
      pr: payload.number,
      repo: payload.repository.full_name,
      reviewId,
    },
    202,
  );
}

async function handleIssueComment(
  c: { json: (data: unknown, status?: number) => Response },
  db: Database,
  payload: IssueCommentEvent,
) {
  // Only handle new comments (not edits or deletions)
  if (payload.action !== 'created') {
    return c.json({ message: `Comment action ${payload.action} ignored` }, 200);
  }

  // Skip bot comments to prevent self-triggering loops. Checked FIRST (before
  // the PR-vs-issue split) so a bot comment is rejected on BOTH paths — a bot
  // must never trigger triage either.
  if (payload.comment.user.type === 'Bot') {
    return c.json({ message: 'Bot comment ignored' }, 200);
  }

  // Parse comment for a ghagga command. Done BEFORE the PR check so a `/ghagga
  // triage` command on a PLAIN issue (no payload.issue.pull_request) is routed
  // instead of being unconditionally dropped (the old behavior at this point).
  const parsed = parseCommentCommand(payload.comment.body);
  if (parsed === null) {
    return c.json({ message: 'No review trigger keyword found' }, 200);
  }
  if (parsed === 'unknown') {
    return c.json(
      {
        message: 'Unknown ghagga command. Valid commands: review, security, perf, describe, triage',
      },
      200,
    );
  }

  const isPullRequest = Boolean(payload.issue.pull_request);

  // SHARED SECURITY GATE (applies to EVERY command, BEFORE any fetch / enqueue /
  // LLM): the comment author must be in ALLOWED_ASSOCIATIONS. This is the LENIENT
  // review-path gate — it INCLUDES CONTRIBUTOR / FIRST_TIMER / FIRST_TIME_CONTRIBUTOR
  // (not just write-association maintainers), because requesting a review on a PR
  // is a benign read-only action. The `triage` path applies an ADDITIONAL,
  // STRICTER write-only gate (TRIAGE_ALLOWED_ASSOCIATIONS) inside handleIssueTriage,
  // so a CONTRIBUTOR clears this gate for review but is rejected for triage.
  // Bot-skip above + this check together mean no unauthorized or automated
  // comment can enqueue work.
  if (!ALLOWED_ASSOCIATIONS.has(payload.comment.author_association)) {
    logger.info(
      {
        user: payload.comment.user.login,
        association: payload.comment.author_association,
        repo: payload.repository.full_name,
        command: parsed.command,
      },
      'Comment trigger rejected: insufficient permissions',
    );
    return c.json({ message: 'Insufficient permissions to trigger review' }, 200);
  }

  if (!payload.installation?.id) {
    return c.json({ error: 'Missing installation ID' }, 400);
  }

  // ── Route: `triage` on a plain issue → issue-analysis queue ─────────────────
  if (parsed.command === 'triage') {
    if (isPullRequest) {
      // `triage` targets plain issues only; on a PR it is a no-op (use the
      // review commands for PR diffs). Reject AFTER the association gate so we
      // never reveal routing to unauthorized callers.
      return c.json({ message: 'triage is only for issues, not pull requests' }, 200);
    }
    // installation.id is non-null here (checked just above), narrowed for the
    // handler so it needs no redundant re-check.
    return await handleIssueTriage(c, db, payload.installation.id, payload);
  }

  // ── Route: non-triage command must target a PR ──────────────────────────────
  // A non-PR comment carrying a review command is dropped (review needs a diff).
  if (!isPullRequest) {
    return c.json({ message: 'Comment is not on a pull request' }, 200);
  }

  // Generate correlation ID for end-to-end review tracing
  const reviewId = randomUUID().slice(0, 8);

  // Look up the repository
  const repo = await getRepoByGithubId(db, payload.repository.id);

  if (!repo) {
    logger.warn({ repo: payload.repository.full_name }, 'Comment trigger for unknown repo');
    return c.json({ message: 'Repository not tracked' }, 200);
  }

  // React with 👀 to acknowledge the trigger and fetch PR details
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  const [owner, repoName] = payload.repository.full_name.split('/') as [string, string];
  const prNumber = payload.issue.number;

  let installationToken: string | undefined;
  let headSha: string | undefined;
  let baseBranch: string | undefined;
  let prAuthor: string | undefined;

  if (appId && privateKey) {
    try {
      installationToken = await getInstallationToken(payload.installation.id, appId, privateKey);
      await addCommentReaction(owner, repoName, payload.comment.id, 'eyes', installationToken);
    } catch (error) {
      // Non-critical — don't fail the review
      logger.warn(
        { repo: payload.repository.full_name, error: String(error) },
        'Failed to add acknowledgment reaction',
      );
    }

    // Fetch PR details to get headSha and baseBranch
    if (installationToken) {
      try {
        const prDetails = await fetchPRDetails(owner, repoName, prNumber, installationToken);
        headSha = prDetails.headSha;
        baseBranch = prDetails.baseBranch;
        prAuthor = prDetails.prAuthor;
      } catch (error) {
        // Non-critical — review will proceed without headSha/baseBranch
        logger.warn(
          { repo: payload.repository.full_name, pr: prNumber, error: String(error) },
          'Failed to fetch PR details for comment trigger',
        );
      }
    }
  }

  // Resolve effective settings and dispatch review
  const effective = await getEffectiveRepoSettings(db, repo);

  await enqueueReview({
    reviewId,
    installationId: payload.installation.id,
    repoFullName: payload.repository.full_name,
    prNumber,
    repositoryId: repo.id,
    triggerCommentId: payload.comment.id,
    headSha,
    baseBranch,
    prAuthor,
    reviewTriggeredBy: payload.comment.user.login,
    aiReviewEnabled: effective.aiReviewEnabled,
    llmProvider: repo.llmProvider,
    llmModel: repo.llmModel ?? 'gpt-4o-mini',
    reviewMode: parsed.reviewMode ?? effective.reviewMode,
    // SECURITY: encrypted credentials (providerChain entries + encryptedApiKey)
    // are intentionally NOT enqueued. The worker re-fetches them from the DB by
    // repositoryId at processing time so secrets never live in the Redis payload.
    settings: {
      enableSemgrep: effective.settings.enableSemgrep,
      enableTrivy: effective.settings.enableTrivy,
      enableCpd: effective.settings.enableCpd,
      enableMemory: effective.settings.enableMemory,
      customRules: effective.settings.customRules,
      ignorePatterns: effective.settings.ignorePatterns,
      reviewLevel: effective.settings.reviewLevel,
      enabledTools: effective.settings.enabledTools,
      disabledTools: effective.settings.disabledTools,
      enableBlastRadius: effective.settings.enableBlastRadius,
    },
  });

  logger.info(
    {
      repo: payload.repository.full_name,
      pr: prNumber,
      triggeredBy: payload.comment.user.login,
      command: parsed.command,
      reviewId,
    },
    'Review re-triggered via comment',
  );

  return c.json(
    {
      message: 'Review dispatched (comment trigger)',
      pr: prNumber,
      repo: payload.repository.full_name,
      triggeredBy: payload.comment.user.login,
      command: parsed.command,
      reviewId,
    },
    202,
  );
}

/**
 * Handle a `/ghagga triage` command on a PLAIN (non-PR) issue.
 *
 * Preconditions (already enforced by the caller, BEFORE this is reached):
 *   - action === 'created', not a bot comment
 *   - command parsed === 'triage'
 *   - author_association ∈ ALLOWED_ASSOCIATIONS (the LENIENT shared review gate)
 *   - payload.issue.pull_request is absent (a real issue, not a PR)
 *   - payload.installation.id is present
 *
 * Responsibilities (the worker does NOT fetch — this is the fetch boundary):
 *   0. Apply the STRICTER triage-only write-association gate
 *      (TRIAGE_ALLOWED_ASSOCIATIONS). A CONTRIBUTOR/FIRST_TIMER clears the shared
 *      gate (for review) but is REJECTED here — no fetch, no enqueue.
 *   1. Look up the tracked repo (untracked → 200, no work).
 *   2. Acknowledge with a 👀 reaction (best-effort, like the review path).
 *   3. Fetch the issue (title/body/labels) + most-recent comments (COUNT-capped).
 *      A failed ISSUE fetch ABORTS triage (no useless empty-issue job); a failed
 *      COMMENTS fetch DEGRADES to `[]` (comments are optional context) + a warn.
 *   4. Bound the payload SIZE (body + comment-body byte budget) — DoS defense.
 *   5. Enqueue an `issue-analysis` job. The worker persists a DRAFT; nothing is
 *      posted here (analysis is human-approved later in the dashboard).
 */
async function handleIssueTriage(
  c: { json: (data: unknown, status?: number) => Response },
  db: Database,
  // installationId is narrowed by the caller and re-passed explicitly so this
  // handler needs no redundant null-check on payload.installation.
  installationId: number,
  payload: IssueCommentEvent,
) {
  // STRICTER triage-only gate (write association). Layered ON TOP of the shared
  // ALLOWED_ASSOCIATIONS check the caller already passed: a CONTRIBUTOR/FIRST_TIMER
  // is allowed to trigger a PR review but must NOT trigger a triage (which fetches
  // untrusted issue text + spends LLM tokens). Rejected here = 200, no fetch, no
  // enqueue — before any token exchange or GitHub read.
  if (!TRIAGE_ALLOWED_ASSOCIATIONS.has(payload.comment.author_association)) {
    logger.info(
      {
        user: payload.comment.user.login,
        association: payload.comment.author_association,
        repo: payload.repository.full_name,
      },
      'Triage trigger rejected: requires a write association (OWNER/MEMBER/COLLABORATOR)',
    );
    return c.json({ message: 'Insufficient permissions to trigger triage' }, 200);
  }

  const reviewId = randomUUID().slice(0, 8);

  const repo = await getRepoByGithubId(db, payload.repository.id);
  if (!repo) {
    logger.warn({ repo: payload.repository.full_name }, 'Triage trigger for unknown repo');
    return c.json({ message: 'Repository not tracked' }, 200);
  }

  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  const [owner, repoName] = payload.repository.full_name.split('/') as [string, string];
  const issueNumber = payload.issue.number;

  // Fetch the issue snapshot. The issue title/body is the PRIMARY input to the
  // triage agent, so a failed/absent issue fetch ABORTS (we never enqueue a
  // useless empty-issue analysis). Comments are OPTIONAL context — a failed
  // comment fetch degrades to `[]` (with a warn) but still enqueues.
  if (!appId || !privateKey) {
    // Without app credentials we cannot read the issue at all — abort rather than
    // enqueue a job that would analyze nothing.
    logger.warn(
      { repo: payload.repository.full_name, issue: issueNumber },
      'GitHub App credentials not configured — aborting triage (cannot fetch issue)',
    );
    return c.json({ message: 'Triage unavailable: GitHub App not configured' }, 200);
  }

  let installationToken: string | undefined;
  try {
    installationToken = await getInstallationToken(installationId, appId, privateKey);
    await addCommentReaction(owner, repoName, payload.comment.id, 'eyes', installationToken);
  } catch (error) {
    // Non-critical — acknowledgment (reaction) failure must not block triage.
    // installationToken may still be set if only the reaction call threw.
    logger.warn(
      { repo: payload.repository.full_name, error: String(error) },
      'Failed to add triage acknowledgment reaction',
    );
  }

  if (!installationToken) {
    // Token exchange failed → we cannot fetch the issue → abort (no empty job).
    logger.warn(
      { repo: payload.repository.full_name, issue: issueNumber },
      'Failed to obtain installation token — aborting triage (cannot fetch issue)',
    );
    return c.json({ message: 'Triage unavailable: could not authenticate to GitHub' }, 200);
  }

  // PRIMARY fetch: the issue itself. Failure ABORTS — no empty-issue enqueue.
  let issueTitle: string;
  let issueBody: string;
  let labels: string[];
  try {
    const issue = await getIssue(owner, repoName, issueNumber, installationToken);
    issueTitle = issue.title;
    issueBody = issue.body;
    labels = issue.labels;
  } catch (error) {
    logger.warn(
      { repo: payload.repository.full_name, issue: issueNumber, error: String(error) },
      'Failed to fetch issue for triage — aborting (no enqueue of empty analysis)',
    );
    return c.json({ message: 'Triage aborted: failed to fetch issue' }, 200);
  }

  // OPTIONAL context: most-recent comments, COUNT-capped at the source. A failed
  // fetch DEGRADES to `[]` (no longer silent — a warn distinguishes "no comments"
  // from "fetch failed") and triage proceeds with title+body only.
  let fetchedComments: Array<{ author: string; body: string }> = [];
  try {
    fetchedComments = await listIssueComments(
      owner,
      repoName,
      issueNumber,
      installationToken,
      MAX_TRIAGE_COMMENTS,
    );
  } catch (error) {
    logger.warn(
      { repo: payload.repository.full_name, issue: issueNumber, error: String(error) },
      'Failed to fetch issue comments for triage — proceeding with title+body only',
    );
  }

  // SIZE cap: bound body + comment bodies so the enqueued Redis payload stays
  // under a sane byte budget even for a giant issue (huge body + many long
  // comments). This is the authoritative DoS guard — the worker-side cap runs
  // only AFTER the payload already landed in Redis.
  const bounded = buildBoundedTriagePayload({
    issueTitle,
    issueBody,
    labels,
    comments: fetchedComments,
  });

  await enqueueIssueAnalysis({
    reviewId,
    installationId,
    repositoryId: repo.id,
    repoFullName: payload.repository.full_name,
    issueNumber,
    issueTitle: bounded.issueTitle,
    issueBody: bounded.issueBody,
    labels: bounded.labels,
    comments: bounded.comments,
    triggerCommentId: payload.comment.id,
  });

  logger.info(
    {
      repo: payload.repository.full_name,
      issue: issueNumber,
      triggeredBy: payload.comment.user.login,
      reviewId,
      commentCount: bounded.comments.length,
    },
    'Issue triage enqueued',
  );

  return c.json(
    {
      message: 'Triage dispatched',
      issue: issueNumber,
      repo: payload.repository.full_name,
      triggeredBy: payload.comment.user.login,
      reviewId,
    },
    202,
  );
}

async function handleInstallation(
  c: { json: (data: unknown, status?: number) => Response },
  db: Database,
  payload: InstallationEvent,
) {
  const { action, installation } = payload;

  if (action === 'created') {
    // Upsert installation record
    const inst = await upsertInstallation(db, {
      githubInstallationId: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
    });

    // Upsert any repositories included in the installation event
    if (payload.repositories && payload.repositories.length > 0) {
      const appId = process.env.GITHUB_APP_ID;
      const privateKey = process.env.GITHUB_PRIVATE_KEY;
      let installationToken: string | undefined;

      if (appId && privateKey) {
        try {
          installationToken = await getInstallationToken(installation.id, appId, privateKey);
        } catch (err) {
          logger.warn(
            { installationId: installation.id, error: String(err) },
            'Failed to get installation token for workflow injection — skipping injection',
          );
        }
      }

      const results = await Promise.allSettled(
        payload.repositories.map(async (repo) => {
          const dbRepo = await upsertRepository(db, {
            githubRepoId: repo.id,
            installationId: inst.id,
            fullName: repo.full_name,
          });

          if (installationToken) {
            const [owner, repoName] = repo.full_name.split('/') as [string, string];
            try {
              const injectionResult = await injectWorkflow(owner, repoName, installationToken);
              await updateWorkflowStatus(db, dbRepo.id, {
                workflowSha: injectionResult.sha,
                workflowInstalledAt: new Date(),
              });
              logger.info(
                {
                  repo: repo.full_name,
                  sha: injectionResult.sha,
                  created: injectionResult.created,
                },
                'Workflow injected on installation.created',
              );
            } catch (err) {
              logger.error(
                { repo: repo.full_name, error: String(err) },
                'Failed to inject workflow on installation.created — continuing with other repos',
              );
            }
          }
        }),
      );

      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        logger.warn(
          { count: failed.length },
          'Some repos failed during installation.created processing',
        );
      }
    }

    logger.info(
      { account: installation.account.login, installationId: installation.id },
      'Installation created',
    );

    return c.json({ message: 'Installation tracked' }, 200);
  }

  if (action === 'deleted') {
    await deactivateInstallation(db, installation.id);

    // Clean up user-installation mappings for this installation
    const inst = await getInstallationByGitHubId(db, installation.id);
    if (inst) {
      await deleteMappingsByInstallationId(db, inst.id);
      logger.info(
        {
          account: installation.account.login,
          installationId: installation.id,
          internalId: inst.id,
        },
        'Installation deactivated and user mappings cleaned up',
      );
    } else {
      logger.warn(
        { account: installation.account.login, installationId: installation.id },
        'Installation deactivated but internal record not found for mapping cleanup',
      );
    }

    return c.json({ message: 'Installation deactivated' }, 200);
  }

  return c.json({ message: `Installation action ${action} ignored` }, 200);
}

async function handleInstallationRepositories(
  c: { json: (data: unknown, status?: number) => Response },
  db: Database,
  payload: InstallationRepositoriesEvent,
) {
  const { installation } = payload;

  // First ensure the installation exists
  const inst = await upsertInstallation(db, {
    githubInstallationId: installation.id,
    accountLogin: installation.account.login,
    accountType: installation.account.type,
  });

  // Handle added repositories
  if (payload.repositories_added && payload.repositories_added.length > 0) {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY;
    let installationToken: string | undefined;

    if (appId && privateKey) {
      try {
        installationToken = await getInstallationToken(installation.id, appId, privateKey);
      } catch (err) {
        logger.warn(
          { installationId: installation.id, error: String(err) },
          'Failed to get installation token for workflow injection — skipping injection',
        );
      }
    }

    const results = await Promise.allSettled(
      payload.repositories_added.map(async (repo) => {
        const dbRepo = await upsertRepository(db, {
          githubRepoId: repo.id,
          installationId: inst.id,
          fullName: repo.full_name,
        });

        if (installationToken) {
          const [owner, repoName] = repo.full_name.split('/') as [string, string];
          try {
            const injectionResult = await injectWorkflow(owner, repoName, installationToken);
            await updateWorkflowStatus(db, dbRepo.id, {
              workflowSha: injectionResult.sha,
              workflowInstalledAt: new Date(),
            });
            logger.info(
              { repo: repo.full_name, sha: injectionResult.sha, created: injectionResult.created },
              'Workflow injected on installation_repositories.added',
            );
          } catch (err) {
            logger.error(
              { repo: repo.full_name, error: String(err) },
              'Failed to inject workflow on repo add — continuing with other repos',
            );
          }
        }
      }),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      logger.warn(
        { count: failed.length },
        'Some repos failed during installation_repositories processing',
      );
    }

    logger.info(
      { installationId: installation.id, count: payload.repositories_added.length },
      'Repositories added to installation',
    );
  }

  // Handle removed repositories
  if (payload.repositories_removed) {
    for (const repo of payload.repositories_removed) {
      // We mark as inactive by looking up the repo first
      const existing = await getRepoByGithubId(db, repo.id);
      if (existing) {
        // We don't have a dedicated deactivateRepository function,
        // but we can update settings to mark it
        // For now, just log — the repo will still exist but won't receive webhooks
        logger.info(
          { repo: repo.full_name, installationId: installation.id },
          'Repo removed from installation',
        );
      }
    }
  }

  return c.json({ message: 'Repositories updated' }, 200);
}
