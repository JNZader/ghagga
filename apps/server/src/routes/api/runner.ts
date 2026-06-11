/**
 * Workflow installation API routes:
 *   GET  /api/runner/install-workflow/status/:owner/:repo
 *   POST /api/runner/install-workflow/:owner/:repo
 */

import type { Database } from 'ghagga-db';
import { getRepoByFullName, updateWorkflowStatus } from 'ghagga-db';
import { Hono } from 'hono';
import { getInstallationToken } from '../../github/client.js';
import { injectWorkflow } from '../../github/runner.js';
import type { AuthUser } from '../../middleware/auth.js';
import { logger } from './utils.js';

export function createRunnerRouter(db: Database) {
  const router = new Hono();

  // ── GET /api/runner/install-workflow/status/:owner/:repo ────────
  router.get('/api/runner/install-workflow/status/:owner/:repo', async (c) => {
    const user = c.get('user') as AuthUser;
    const owner = c.req.param('owner');
    const repo = c.req.param('repo');
    const fullName = `${owner}/${repo}`;

    try {
      const dbRepo = await getRepoByFullName(db, fullName);

      if (!dbRepo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      // Installation-scope guard: only users belonging to the repo's GitHub App
      // installation may query workflow status. We deliberately return 404 (the
      // exact same response as "repo not tracked") instead of the 403 used by
      // sibling routes — a 403 here would be an existence oracle letting any
      // authenticated user enumerate which repos are tracked by GHAGGA.
      if (!user.installationIds.includes(dbRepo.installationId)) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      return c.json({
        data: {
          installed: dbRepo.workflowInstalledAt !== null,
          workflowInstalledAt: dbRepo.workflowInstalledAt ?? null,
          workflowSha: dbRepo.workflowSha ?? null,
        },
      });
    } catch (err) {
      logger.error({ err, fullName }, 'Failed to check workflow installation status');
      return c.json({ error: 'INTERNAL_ERROR', message: 'Failed to check workflow status' }, 500);
    }
  });

  // ── POST /api/runner/install-workflow/:owner/:repo ──────────────
  router.post('/api/runner/install-workflow/:owner/:repo', async (c) => {
    const user = c.get('user') as AuthUser;
    const owner = c.req.param('owner');
    const repo = c.req.param('repo');
    const fullName = `${owner}/${repo}`;

    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_PRIVATE_KEY;

    if (!appId || !privateKey) {
      return c.json({ error: 'INTERNAL_ERROR', message: 'Server misconfiguration' }, 500);
    }

    try {
      const dbRepo = await getRepoByFullName(db, fullName);

      if (!dbRepo) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not tracked' }, 404);
      }

      // Installation-scope guard: without this, ANY authenticated user could
      // commit .github/workflows/ghagga.yml to ANY tracked repo using the
      // victim installation's token. We deliberately return 404 (identical to
      // the "repo not tracked" response) instead of the 403 used by sibling
      // routes — a 403 would be an existence oracle for tracked repos.
      if (!user.installationIds.includes(dbRepo.installationId)) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not tracked' }, 404);
      }

      const token = await getInstallationToken(dbRepo.installationId, appId, privateKey);
      const result = await injectWorkflow(owner, repo, token, dbRepo.workflowSha ?? undefined);

      await updateWorkflowStatus(db, dbRepo.id, {
        workflowSha: result.sha,
        workflowInstalledAt: new Date(),
      });

      logger.info(
        { user: user.githubLogin, repo: fullName, sha: result.sha, created: result.created },
        'Workflow manually installed via API',
      );

      return c.json({
        data: {
          installed: true,
          sha: result.sha,
          created: result.created,
        },
      });
    } catch (err) {
      const message = String(err);
      if (message.includes('branch_protection')) {
        return c.json(
          {
            error: 'BRANCH_PROTECTION',
            message:
              'Cannot install workflow — repository has branch protection rules preventing direct pushes.',
          },
          403,
        );
      }
      logger.error({ err, user: user.githubLogin, repo: fullName }, 'Failed to install workflow');
      return c.json({ error: 'WORKFLOW_ERROR', message: 'Failed to install workflow' }, 502);
    }
  });

  return router;
}
