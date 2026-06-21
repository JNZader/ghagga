/**
 * P4 task 4.3 — MANUAL / E2E acceptance gate for the GitLab MR summary post-back
 * (R-GITLAB). This is the ONLY test in the suite that talks to a LIVE GitLab
 * instance. It is `skipIf(!process.env.GITLAB_PAT)` so CI ALWAYS skips it — CI
 * coverage of the GitLab REST surface lives in `cli-gitlab-client-port.test.ts`
 * (fetch-mocked). This file is the real-instance sign-off the spec mandates.
 *
 * ENVIRONMENT VARIABLES
 * ---------------------
 * REQUIRED:
 *   GITLAB_PAT          a Personal Access Token with the `api` scope.
 *   GITLAB_E2E_PROJECT  the `group/project` path (nested groups OK,
 *                       e.g. `group/subgroup/project`).
 *   GITLAB_E2E_MR       the iid of an OPEN, throwaway MR in that project. The
 *                       test posts and sweeps notes on it, so it MUST be a
 *                       disposable MR you control — never a real review.
 * OPTIONAL (self-hosted GitLab — gitlab.com is the default):
 *   GITLAB_HOST         a host-only override (e.g. `gitlab.example.com`) when the
 *                       API host differs from gitlab.com.
 *   GITLAB_API_BASE     a FULL `.../api/v4` base override, required for a
 *                       self-managed GitLab served under a subpath
 *                       (e.g. `https://example.com/gitlab/api/v4`). Wins over
 *                       GITLAB_HOST. Both are resolved through the SAME
 *                       production helper (`resolveGitLabApiBase`) the `--mr`
 *                       command path uses, so this test exercises the real
 *                       self-hosted resolution — not a test-only shortcut.
 *
 * HOW TO RUN IT MANUALLY
 * ----------------------
 * Against a throwaway GitLab project + OPEN, disposable MR you control:
 *
 *   export GITLAB_PAT=glpat-xxxxxxxxxxxxxxxxxxxx   # PAT with `api` scope
 *   export GITLAB_E2E_PROJECT=group/your-project   # group/project path
 *   export GITLAB_E2E_MR=1                          # an OPEN, throwaway MR iid
 *   # optional self-hosted: export GITLAB_HOST=gitlab.example.com
 *   pnpm --filter ghagga exec vitest run src/lib/gitlab-e2e.manual.test.ts
 *
 * It will: resolve the numeric project id from the path, post (idempotently
 * upsert) a marker-tagged summary note to the MR, assert the returned id is a
 * positive number AND that the SPECIFIC note production just created
 * (first.createdNativeId) is live on the MR carrying MARKER.html, then run a
 * SECOND upsert and assert (a) the first note's id is in deletedNativeIds and
 * (b) against the real MR state exactly ONE marker note remains and it is the
 * second note — proving the find→delete→repost idempotency FOLD against the
 * live API. An `afterAll` ATTEMPTS to leave zero leftover notes (best-effort; a
 * transient GitLab failure may leave one, which the next run's sweep removes).
 *
 * MARKER OWNERSHIP NOTE: the marker is OWNED BY THE CALLER, not the adapter —
 * the test renders it into `body` (see where `body` is built below). Production
 * never injects it; `upsertSummaryComment` only USES `marker.html` to FILTER
 * which notes to sweep (gitlab-forge-adapter.ts:182). So the anchored assertion
 * below simply verifies that the note production created persists with the
 * marker on live GitLab; the "exactly one marker note after the repost" check
 * is what actually proves the idempotency fold against real MR state.
 */

import { type GitLabClientPort, GitLabForgeAdapter } from 'ghagga-forge';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createCliGitLabClientPort,
  resolveGitLabApiBase,
  resolveGitLabProjectId,
} from './cli-gitlab-client-port.js';
import { postSummaryComment } from './pr-postback.js';

const PAT = process.env.GITLAB_PAT;
const PROJECT_PATH = process.env.GITLAB_E2E_PROJECT ?? '';
const MR_IID = Number.parseInt(process.env.GITLAB_E2E_MR ?? '', 10);
const MARKER = { html: '<!-- ghagga-review -->' };

/**
 * Resolve the API base the SAME way the production `--mr` command path does:
 * feed gitlab.com as the remote-derived host and let GITLAB_HOST / GITLAB_API_BASE
 * override it (resolveGitLabApiBase precedence). With no override this is exactly
 * the gitlab.com default the back-compat callers use.
 */
const API_BASE = resolveGitLabApiBase('gitlab.com');

describe('GitLab MR summary post-back — LIVE E2E (manual gate, R-GITLAB)', () => {
  // Note ids created during the test, swept best-effort in afterAll so the
  // throwaway MR is left clean. Only populated when the test actually runs
  // (it is empty when skipped without a PAT, so afterAll is a no-op).
  const createdNoteIds: number[] = [];
  let client: GitLabClientPort | undefined;
  let projectId: string | undefined;
  const token = PAT as string;

  afterAll(async () => {
    // Best-effort cleanup: tolerate a per-note failure (404 / already gone /
    // transient) so a delete error never fails the suite. Skipped entirely when
    // the test did not run (no client / projectId resolved → nothing created).
    if (!PAT || client == null || projectId == null) return;
    for (const noteId of createdNoteIds) {
      try {
        await client.deleteMrNote(projectId, MR_IID, noteId, token);
      } catch {
        // Tolerate: leaving a stray note is better than failing the suite on
        // cleanup. The next manual run's sweep removes it anyway.
      }
    }
  });

  it.skipIf(!PAT)(
    'resolves numeric project id + posts a marker-tagged note + sweeps the stale one on re-run',
    async () => {
      expect(PROJECT_PATH, 'set GITLAB_E2E_PROJECT=group/project').not.toBe('');
      expect(Number.isInteger(MR_IID) && MR_IID > 0, 'set GITLAB_E2E_MR=<open MR iid>').toBe(true);

      projectId = await resolveGitLabProjectId(PROJECT_PATH, token, API_BASE);
      expect(projectId).toMatch(/^\d+$/); // numeric project id (R-GITLAB nativeId)

      client = createCliGitLabClientPort(API_BASE);
      const adapter = new GitLabForgeAdapter({ client, token, projectId });
      const ref = {
        repo: { kind: 'gitlab' as const, nativeId: projectId, path: PROJECT_PATH },
        iid: MR_IID,
      };
      const body = `${MARKER.html}\n## GHAGGA E2E\nposted at ${new Date().toISOString()}`;

      // First upsert: posts a fresh note.
      const first = await postSummaryComment(adapter, ref, body, MARKER);
      expect(first.createdNativeId).toBeGreaterThan(0);
      createdNoteIds.push(first.createdNativeId);

      // Marker persistence: anchor the assertion to the note PRODUCTION created
      // (first.createdNativeId === GitLabNote.id), not to "any note that happens
      // to carry the marker". This proves the specific note the upsert posted is
      // live on the MR AND still carries the marker the adapter's sweep filters
      // on (gitlab-forge-adapter.ts:182).
      const afterFirst = await client.listMrNotes(projectId, MR_IID, token);
      const createdNote = afterFirst.find((n) => n.id === first.createdNativeId);
      expect(
        createdNote,
        'the note created by upsert must appear in the live listing',
      ).toBeDefined();
      expect(
        createdNote?.body.includes(MARKER.html),
        'the created note must carry the marker the sweep filters on',
      ).toBe(true);

      // Second upsert: must SWEEP the first (idempotency) and repost.
      const second = await postSummaryComment(adapter, ref, body, MARKER);
      expect(second.createdNativeId).toBeGreaterThan(0);
      createdNoteIds.push(second.createdNativeId);
      expect(second.deletedNativeIds).toContain(first.createdNativeId);

      // Idempotency FOLD against the REAL MR state (not just the return value):
      // after the repost exactly ONE marker note must remain, and it must be the
      // note the SECOND upsert created. This is the invariant the sweep exists to
      // hold — complements the `deletedNativeIds toContain first` return-value check.
      const afterSecond = await client.listMrNotes(projectId, MR_IID, token);
      const markerNotes = afterSecond.filter((n) => n.body.includes(MARKER.html));
      expect(markerNotes.length, 'the sweep must leave exactly one note carrying the marker').toBe(
        1,
      );
      expect(markerNotes[0]?.id).toBe(second.createdNativeId);
    },
    30_000,
  );
});
