/**
 * CLI-side implementation of the forge `GitLabClientPort` + numeric-project-id
 * resolution for the `ghagga review --mr N` MR summary post-back.
 *
 * The `GitLabForgeAdapter` (packages/forge) depends on an injected
 * {@link GitLabClientPort} (dependency inversion — forge MUST NOT import any
 * concrete HTTP client). The CLI provides the real native-fetch implementation
 * here, on the same `AbortSignal.timeout` + error-class pattern as
 * `cli-github-client-port.ts`.
 *
 * AUTH: we send ONLY the `PRIVATE-TOKEN: <pat>` header — GitLab's recommended
 * header for Personal/Project/Group Access Tokens (the kind `ghagga` uses). We do
 * NOT also send `Authorization: Bearer`, which is for OAuth2 access tokens; mixing
 * both is unnecessary and the PAT header is the canonical PAT auth path.
 *
 * HOST: the API base is derived from the resolved GitLab host
 * (`https://<host>/api/v4`) so self-managed instances work, with a `GITLAB_HOST`
 * env override for the rare case the API host differs from the git remote host.
 *
 * SCOPE (P4 — MR summary post-back): the four note members the adapter's
 * `upsertSummaryComment` folds over (list/create/delete/update) plus
 * `publishInline` (create). All four route through the NUMERIC project id (the
 * canonical R-GITLAB identity). `resolveGitLabProjectId` is the pre-construction
 * step that turns the mutable group/project path into that numeric id.
 */

import type { GitLabClientPort, GitLabNote } from 'ghagga-forge';
import { GitLabApiError } from './gitlab-api.js';

/**
 * Per-request timeout for the CLI's GitLab fetch calls. Mirrors the GitHub CLI
 * port's `AbortSignal.timeout(10_000)` so a slow/hung GitLab can never hang a CI
 * job indefinitely.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Resolve the GitLab API base (`https://<host>/api/v4`) for a remote host.
 *
 * Precedence:
 *   1. `GITLAB_API_BASE` — a FULL API base override. Required for a self-managed
 *      GitLab served under a SUBPATH (e.g. `https://example.com/gitlab`), where a
 *      host-only value cannot express the `/gitlab` prefix. Used verbatim (only a
 *      trailing slash is trimmed); supply the complete `.../api/v4` URL.
 *   2. `GITLAB_HOST` — a host-only override (for when the API host differs from
 *      the git remote host, e.g. a reverse proxy on a different hostname).
 *   3. the host parsed from the git remote.
 * For (2)/(3) a bare host is expected; a stray scheme/trailing slash is tolerated.
 */
export function resolveGitLabApiBase(host: string, env: NodeJS.ProcessEnv = process.env): string {
  const apiBaseOverride = env.GITLAB_API_BASE?.trim();
  if (apiBaseOverride) {
    return apiBaseOverride.replace(/\/+$/, '');
  }
  const hostOverride = env.GITLAB_HOST?.trim();
  const chosen = hostOverride || host;
  // Tolerate an override that includes a scheme and/or trailing slash.
  const bare = chosen.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${bare}/api/v4`;
}

/** Auth headers — PRIVATE-TOKEN only (GitLab's recommended header for PATs). */
function apiHeaders(token: string): Record<string, string> {
  return {
    'PRIVATE-TOKEN': token,
    'Content-Type': 'application/json',
  };
}

async function failOn(res: Response, action: string): Promise<never> {
  const body = await res.text();
  throw new GitLabApiError(
    `GitLab API error ${action}: ${res.status} ${res.statusText}`,
    res.status,
    body,
  );
}

/** Encode a path segment that itself contains slashes (group/subgroup/project). */
function encodeProjectPath(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Resolve the GitLab NUMERIC project id from a group/project path (R-GITLAB).
 *
 * `GET /projects/:url-encoded-path` → `.id`. The path is mutable, so the numeric
 * id is the canonical `RepoRef.nativeId`. This runs ONCE before constructing the
 * adapter; it is NOT part of the {@link GitLabClientPort} (the adapter only ever
 * speaks numeric ids).
 *
 * @param apiBase the resolved API base (`https://<host>/api/v4`) — see
 *   {@link resolveGitLabApiBase}. Defaults to gitlab.com for back-compat callers.
 * @returns the numeric project id as a STRING (RepoRef.nativeId is a string).
 */
export async function resolveGitLabProjectId(
  path: string,
  token: string,
  apiBase = 'https://gitlab.com/api/v4',
): Promise<string> {
  const url = `${apiBase}/projects/${encodeProjectPath(path)}`;
  const res = await fetch(url, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await failOn(res, 'resolving project id');
  const data = (await res.json()) as { id: number };
  if (typeof data.id !== 'number') {
    throw new GitLabApiError(
      `GitLab API error resolving project id: response had no numeric "id" for path "${path}"`,
      res.status,
      JSON.stringify(data),
    );
  }
  return String(data.id);
}

/**
 * Build a {@link GitLabClientPort} backed by native fetch for the CLI `--mr`
 * post-back. All members route through the numeric project id.
 *
 * @param apiBase the resolved API base (`https://<host>/api/v4`) — see
 *   {@link resolveGitLabApiBase}. Defaults to gitlab.com for back-compat callers.
 */
export function createCliGitLabClientPort(apiBase = 'https://gitlab.com/api/v4'): GitLabClientPort {
  return {
    async listMrNotes(projectId, mrIid, token): Promise<GitLabNote[]> {
      // Paginate until exhausted (a page with < 100 items is the last page),
      // like the GitHub port. MAX_PAGES is a safety upper bound (50 × 100 = 5000
      // notes) so a pathological MR can't loop forever; if hit we log rather
      // than silently truncate, since a stale marker beyond the bound would
      // yield a DUPLICATE note. (Was 5 pages / 500 items — backlog #6.)
      const baseUrl = `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/notes`;
      const MAX_PAGES = 50;
      const out: GitLabNote[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${baseUrl}?per_page=100&page=${page}&sort=asc&order_by=created_at`;
        const res = await fetch(url, {
          headers: apiHeaders(token),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) await failOn(res, 'listing MR notes');
        const notes = (await res.json()) as Array<{ id: number; body: string }>;
        for (const note of notes) {
          out.push({ id: note.id, body: note.body });
        }
        if (notes.length < 100) break;
        if (page === MAX_PAGES) {
          console.warn(
            `[ghagga] listMrNotes hit MAX_PAGES (${MAX_PAGES}) for project ${projectId} MR !${mrIid}; note listing may be truncated`,
          );
        }
      }
      return out;
    },

    async createMrNote(projectId, mrIid, body, token): Promise<{ id: number }> {
      const url = `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/notes`;
      const res = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(token),
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) await failOn(res, 'creating MR note');
      const data = (await res.json()) as { id: number };
      return { id: data.id };
    },

    async deleteMrNote(projectId, mrIid, noteId, token): Promise<void> {
      const url = `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: apiHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // The adapter's upsert tolerates delete failures (best-effort), but we
      // still surface a non-2xx (except 404) so `deleted[]` only reflects
      // genuinely-removed ids.
      if (!res.ok && res.status !== 404) await failOn(res, 'deleting MR note');
    },

    async createMrDiscussion(projectId, mrIid, body, position, token): Promise<{ id: number }> {
      // True diff-anchored discussion: POST /merge_requests/:iid/discussions with
      // position[position_type]=text + the three SHAs + old/new path + line(s).
      const url = `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/discussions`;
      const payload: Record<string, unknown> = {
        body,
        position: {
          position_type: 'text',
          base_sha: position.baseSha,
          head_sha: position.headSha,
          start_sha: position.startSha,
          old_path: position.oldPath,
          new_path: position.newPath,
          ...(position.oldLine != null ? { old_line: position.oldLine } : {}),
          ...(position.newLine != null ? { new_line: position.newLine } : {}),
        },
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(token),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) await failOn(res, 'creating MR discussion');
      // The discussion response nests its notes; box the FIRST note's id so the
      // result matches the createMrNote contract ({ id: number }).
      const data = (await res.json()) as { notes?: Array<{ id: number }> };
      const firstNoteId = data.notes?.[0]?.id;
      if (typeof firstNoteId !== 'number') {
        throw new GitLabApiError(
          'GitLab API error creating MR discussion: response had no numeric notes[0].id',
          res.status,
          JSON.stringify(data),
        );
      }
      return { id: firstNoteId };
    },

    async updateMrNote(projectId, mrIid, noteId, body, token): Promise<void> {
      const url = `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: apiHeaders(token),
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) await failOn(res, 'updating MR note');
    },
  };
}
