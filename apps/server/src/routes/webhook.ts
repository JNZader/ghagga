/**
 * GitHub webhook handler.
 *
 * Processes incoming webhook events:
 *   - pull_request: Dispatch review via Inngest
 *   - issue_comment: Re-trigger review on "ghagga review" keyword
 *   - installation: Track app installations
 *   - installation_repositories: Track repo additions/removals
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'ghagga-db';
import {
  createDelegatedCiRun,
  deactivateInstallation,
  deleteMappingsByInstallationId,
  getDelegatedCiPolicy,
  getEffectiveRepoSettings,
  getInstallationByGitHubId,
  getRepoByGithubId,
  upsertInstallation,
  upsertRepository,
} from 'ghagga-db';
import { Hono } from 'hono';
import { evaluateAllJobs, normalizePolicy } from '../delegated-ci/policy.js';
import {
  addCommentReaction,
  fetchPRDetails,
  getInstallationToken,
  verifyWebhookSignature,
} from '../github/client.js';
import { inngest } from '../inngest/client.js';
import { logger as rootLogger } from '../lib/logger.js';

const logger = rootLogger.child({ module: 'webhook' });

// ─── Minimal Webhook Event Types ────────────────────────────────

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: {
    number: number;
    head: { sha: string };
    base: { ref: string };
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

/** Associations allowed to trigger reviews via comment keyword */
const ALLOWED_ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIMER',
  'FIRST_TIME_CONTRIBUTOR',
]);

/** Regex to detect "ghagga review" keyword (case-insensitive, allows leading whitespace/punctuation) */
const REVIEW_TRIGGER_REGEX = /\bghagga\s+review\b/i;

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
  // We'll do the full file check in the Inngest function,
  // but we can skip dispatch if the repo has very broad patterns.
  // For now, dispatch unconditionally and let the pipeline handle filtering.

  // Resolve effective settings (global vs per-repo)
  const effective = await getEffectiveRepoSettings(db, repo);

  // Dispatch review to Inngest
  await inngest.send({
    name: 'ghagga/review.requested',
    data: {
      reviewId,
      installationId: payload.installation.id,
      repoFullName: payload.repository.full_name,
      prNumber: payload.number,
      repositoryId: repo.id,
      headSha: payload.pull_request.head.sha,
      baseBranch: payload.pull_request.base.ref,
      // Resolved provider chain (from global or repo)
      providerChain: effective.providerChain,
      aiReviewEnabled: effective.aiReviewEnabled,
      // Legacy flat fields (kept for backward compat during transition)
      llmProvider: repo.llmProvider,
      llmModel: repo.llmModel ?? 'gpt-4o-mini',
      reviewMode: effective.reviewMode,
      encryptedApiKey: repo.encryptedApiKey,
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
      },
    },
  });

  logger.info(
    { repo: payload.repository.full_name, pr: payload.number, reviewId },
    'Review dispatched',
  );

  // ── Delegated CI evaluation (non-critical) ──────────────────
  try {
    const rawPolicy = await getDelegatedCiPolicy(db, repo.id);
    const normalizedPolicy = normalizePolicy(rawPolicy);

    if (normalizedPolicy && normalizedPolicy.enabled) {
      const evaluations = evaluateAllJobs(normalizedPolicy);
      const approvedJobs = evaluations.filter((e) => e.approved);
      const rejectedJobs = evaluations.filter((e) => !e.approved);

      // Record rejected runs for audit trail
      for (const rejected of rejectedJobs) {
        await createDelegatedCiRun(db, {
          repositoryId: repo.id,
          prNumber: payload.number,
          jobKey: rejected.jobKey,
          classification: rejected.classification ?? 'sensitive/no-delegable',
          state: 'rejected',
          profile: rejected.profile ?? 'unknown',
          reasonCode: rejected.reasonCode ?? undefined,
          reasonDetail: rejected.reasonDetail ?? undefined,
        });
      }

      if (approvedJobs.length > 0) {
        // Dispatch Inngest event for approved jobs
        await inngest.send({
          name: 'ghagga/delegated-ci.requested',
          data: {
            installationId: payload.installation.id,
            repositoryId: repo.id,
            repoFullName: payload.repository.full_name,
            prNumber: payload.number,
            headSha: payload.pull_request.head.sha,
            baseBranch: payload.pull_request.base.ref,
            approvedJobs: approvedJobs.map((j) => {
              const policyJob = normalizedPolicy.jobs.find((pj) => pj.jobKey === j.jobKey);
              return {
                jobKey: j.jobKey,
                profile: j.profile!,
                allowArtifacts: policyJob?.allowArtifacts ?? false,
                allowCache: policyJob?.allowCache ?? false,
                maxDurationMinutes: policyJob?.maxDurationMinutes ?? 10,
              };
            }),
          },
        });
      }

      logger.info(
        {
          repo: payload.repository.full_name,
          pr: payload.number,
          approved: approvedJobs.length,
          rejected: rejectedJobs.length,
        },
        'Delegated CI evaluation complete',
      );
    }
  } catch (error) {
    // Delegated CI is non-critical — don't fail the webhook
    logger.warn(
      { error: String(error), repo: payload.repository.full_name },
      'Delegated CI evaluation failed — continuing with review only',
    );
  }

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

  // Only handle comments on PRs (not regular issues)
  if (!payload.issue.pull_request) {
    return c.json({ message: 'Comment is not on a pull request' }, 200);
  }

  // Skip bot comments to prevent self-triggering loops
  if (payload.comment.user.type === 'Bot') {
    return c.json({ message: 'Bot comment ignored' }, 200);
  }

  // Check for the trigger keyword
  if (!REVIEW_TRIGGER_REGEX.test(payload.comment.body)) {
    return c.json({ message: 'No review trigger keyword found' }, 200);
  }

  // Check author association (only contributors/members can trigger)
  if (!ALLOWED_ASSOCIATIONS.has(payload.comment.author_association)) {
    logger.info(
      {
        user: payload.comment.user.login,
        association: payload.comment.author_association,
        repo: payload.repository.full_name,
      },
      'Review trigger rejected: insufficient permissions',
    );
    return c.json({ message: 'Insufficient permissions to trigger review' }, 200);
  }

  if (!payload.installation?.id) {
    return c.json({ error: 'Missing installation ID' }, 400);
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

  await inngest.send({
    name: 'ghagga/review.requested',
    data: {
      reviewId,
      installationId: payload.installation.id,
      repoFullName: payload.repository.full_name,
      prNumber,
      repositoryId: repo.id,
      triggerCommentId: payload.comment.id,
      headSha,
      baseBranch,
      providerChain: effective.providerChain,
      aiReviewEnabled: effective.aiReviewEnabled,
      llmProvider: repo.llmProvider,
      llmModel: repo.llmModel ?? 'gpt-4o-mini',
      reviewMode: effective.reviewMode,
      encryptedApiKey: repo.encryptedApiKey,
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
      },
    },
  });

  logger.info(
    {
      repo: payload.repository.full_name,
      pr: prNumber,
      triggeredBy: payload.comment.user.login,
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
    if (payload.repositories) {
      for (const repo of payload.repositories) {
        await upsertRepository(db, {
          githubRepoId: repo.id,
          installationId: inst.id,
          fullName: repo.full_name,
        });
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
  if (payload.repositories_added) {
    for (const repo of payload.repositories_added) {
      await upsertRepository(db, {
        githubRepoId: repo.id,
        installationId: inst.id,
        fullName: repo.full_name,
      });
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
