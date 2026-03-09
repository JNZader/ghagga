/**
 * Inngest durable function for orchestrating delegated CI jobs.
 *
 * Triggered by the 'ghagga/delegated-ci.requested' event when a PR
 * webhook evaluates the repository's delegated CI policy and finds
 * approved jobs to run.
 *
 * For each approved job:
 *   1. Create a run record in the database (state: approved)
 *   2. Dispatch the runner workflow via GitHub Actions
 *   3. Wait for the callback event from the runner
 *   4. Finalize the run record with the result or timeout
 *
 * Jobs are processed sequentially within the function for MVP safety.
 * Inngest handles durable execution, retries, and state management.
 */

import { createDatabaseFromEnv, createDelegatedCiRun, updateDelegatedCiRunState } from 'ghagga-db';
import { getInstallationToken } from '../github/client.js';
import { buildDelegatedCiDescriptor, dispatchRunnerWorkflow } from '../github/runner.js';
import { logger as rootLogger } from '../lib/logger.js';
import type { DelegatedCiCallbackData } from './client.js';
import { inngest } from './client.js';

const logger = rootLogger.child({ module: 'delegated-ci' });

export const delegatedCiFunction = inngest.createFunction(
  {
    id: 'ghagga-delegated-ci',
    name: 'GHAGGA Delegated CI',
    retries: 1, // Less retries than review — delegated CI is more sensitive
  },
  { event: 'ghagga/delegated-ci.requested' },
  async ({ event, step }) => {
    const {
      installationId,
      repositoryId,
      repoFullName,
      prNumber,
      headSha,
      baseBranch,
      approvedJobs,
    } = event.data;
    const [owner] = repoFullName.split('/') as [string, string];
    const log = logger.child({ repoFullName, prNumber });

    const results: Array<{ jobKey: string; callbackId: string }> = [];

    // Process approved jobs sequentially (MVP — can parallelize later)
    for (const job of approvedJobs) {
      // Step 1: Create run record
      const run = await step.run(`create-run-${job.jobKey}`, async () => {
        const db = createDatabaseFromEnv();
        return createDelegatedCiRun(db, {
          repositoryId,
          prNumber,
          jobKey: job.jobKey,
          classification: 'safe/delegable',
          state: 'approved',
          profile: job.profile,
        });
      });

      // Step 2: Dispatch to runner
      const callbackId = await step.run(`dispatch-${job.jobKey}`, async () => {
        const appId = process.env.GITHUB_APP_ID;
        const privateKey = process.env.GITHUB_PRIVATE_KEY;
        if (!appId || !privateKey) throw new Error('Missing app credentials');

        const token = await getInstallationToken(installationId, appId, privateKey);
        const serverUrl =
          process.env.RENDER_EXTERNAL_URL ??
          process.env.SERVER_URL ??
          `http://localhost:${process.env.PORT ?? '3000'}`;
        const callbackUrl = `${serverUrl}/runner/callback`;

        const descriptor = buildDelegatedCiDescriptor({
          ownerLogin: owner,
          repoFullName,
          prNumber,
          headSha,
          baseBranch,
          callbackUrl,
          jobKey: job.jobKey,
          profile: job.profile,
          allowArtifacts: job.allowArtifacts,
          allowCache: job.allowCache,
          maxDurationMinutes: job.maxDurationMinutes,
          token,
        });

        const cid = await dispatchRunnerWorkflow(descriptor, owner, token);

        // Update run state to dispatched
        const db = createDatabaseFromEnv();
        await updateDelegatedCiRunState(db, run.id, {
          state: 'dispatched',
          callbackId: cid,
        });

        log.info({ callbackId: cid, jobKey: job.jobKey }, 'Delegated CI job dispatched');
        return cid;
      });

      // Step 3: Wait for callback
      const callbackEvent = await step.waitForEvent(`wait-callback-${job.jobKey}`, {
        event: 'ghagga/delegated-ci.callback',
        if: `async.data.callbackId == '${callbackId}'`,
        timeout: '15m',
      });

      // Step 4: Update final state
      await step.run(`finalize-${job.jobKey}`, async () => {
        const db = createDatabaseFromEnv();
        if (callbackEvent) {
          const data = callbackEvent.data as DelegatedCiCallbackData;
          await updateDelegatedCiRunState(db, run.id, {
            state: data.state === 'running' ? 'running' : data.state,
            summary: data.summary,
            startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
            completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
          });
          log.info(
            { jobKey: job.jobKey, state: data.state, outcome: data.outcome },
            'Delegated CI job finalized',
          );
        } else {
          // Timeout
          await updateDelegatedCiRunState(db, run.id, {
            state: 'timed_out',
            reasonCode: 'callback_timeout',
            reasonDetail: 'No callback received within 15 minutes',
          });
          log.warn({ jobKey: job.jobKey, callbackId }, 'Delegated CI job timed out');
        }
      });

      results.push({ jobKey: job.jobKey, callbackId });
    }

    return { repoFullName, prNumber, jobsProcessed: results.length };
  },
);
