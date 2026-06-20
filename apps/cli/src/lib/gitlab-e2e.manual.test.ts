/**
 * P4 task 4.3 — MANUAL / E2E acceptance gate for the GitLab MR summary post-back
 * (R-GITLAB). This is the ONLY test in the suite that talks to a LIVE GitLab
 * instance. It is `skipIf(!process.env.GITLAB_PAT)` so CI ALWAYS skips it — CI
 * coverage of the GitLab REST surface lives in `cli-gitlab-client-port.test.ts`
 * (fetch-mocked). This file is the real-instance sign-off the spec mandates.
 *
 * HOW TO RUN IT MANUALLY
 * ----------------------
 * Against a throwaway GitLab project + open MR you control:
 *
 *   export GITLAB_PAT=glpat-xxxxxxxxxxxxxxxxxxxx   # PAT with `api` scope
 *   export GITLAB_E2E_PROJECT=group/your-project   # group/project path
 *   export GITLAB_E2E_MR=1                          # an OPEN MR iid in it
 *   pnpm --filter ghagga exec vitest run src/lib/gitlab-e2e.manual.test.ts
 *
 * It will: resolve the numeric project id from the path, post (idempotently
 * upsert) a marker-tagged summary note to the MR, assert the returned id is a
 * positive number, then run a SECOND upsert and assert the first note was swept
 * (deletedNativeIds non-empty) — proving the find→delete→repost idempotency
 * against the live API. Inspect the MR afterwards: exactly ONE GHAGGA note.
 */

import { GitLabForgeAdapter } from 'ghagga-forge';
import { describe, expect, it } from 'vitest';
import { createCliGitLabClientPort, resolveGitLabProjectId } from './cli-gitlab-client-port.js';
import { postSummaryComment } from './pr-postback.js';

const PAT = process.env.GITLAB_PAT;
const PROJECT_PATH = process.env.GITLAB_E2E_PROJECT ?? '';
const MR_IID = Number.parseInt(process.env.GITLAB_E2E_MR ?? '', 10);
const MARKER = { html: '<!-- ghagga-review -->' };

describe('GitLab MR summary post-back — LIVE E2E (manual gate, R-GITLAB)', () => {
  it.skipIf(!PAT)(
    'resolves numeric project id + posts a summary note + sweeps the stale one on re-run',
    async () => {
      expect(PROJECT_PATH, 'set GITLAB_E2E_PROJECT=group/project').not.toBe('');
      expect(Number.isInteger(MR_IID) && MR_IID > 0, 'set GITLAB_E2E_MR=<open MR iid>').toBe(true);

      const token = PAT as string;
      const projectId = await resolveGitLabProjectId(PROJECT_PATH, token);
      expect(projectId).toMatch(/^\d+$/); // numeric project id (R-GITLAB nativeId)

      const adapter = new GitLabForgeAdapter({
        client: createCliGitLabClientPort(),
        token,
        projectId,
      });
      const ref = {
        repo: { kind: 'gitlab' as const, nativeId: projectId, path: PROJECT_PATH },
        iid: MR_IID,
      };
      const body = `${MARKER.html}\n## GHAGGA E2E\nposted at ${new Date().toISOString()}`;

      // First upsert: posts a fresh note.
      const first = await postSummaryComment(adapter, ref, body, MARKER);
      expect(first.createdNativeId).toBeGreaterThan(0);

      // Second upsert: must SWEEP the first (idempotency) and repost.
      const second = await postSummaryComment(adapter, ref, body, MARKER);
      expect(second.createdNativeId).toBeGreaterThan(0);
      expect(second.deletedNativeIds).toContain(first.createdNativeId);
    },
    30_000,
  );
});
