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
 * AUTH: GitLab accepts a PAT via either `Authorization: Bearer <pat>` OR the
 * `PRIVATE-TOKEN: <pat>` header. We send BOTH so the same PAT works for
 * project/group access tokens and personal access tokens alike.
 *
 * SCOPE (P4 — MR summary post-back): the four note members the adapter's
 * `upsertSummaryComment` folds over (list/create/delete/update) plus
 * `publishInline` (create). All four route through the NUMERIC project id (the
 * canonical R-GITLAB identity). `resolveGitLabProjectId` is the pre-construction
 * step that turns the mutable group/project path into that numeric id.
 */

import type { GitLabClientPort, GitLabNote } from 'ghagga-forge';
import { GitLabApiError } from './gitlab-api.js';

const API_BASE = 'https://gitlab.com/api/v4';

/**
 * Per-request timeout for the CLI's GitLab fetch calls. Mirrors the GitHub CLI
 * port's `AbortSignal.timeout(10_000)` so a slow/hung GitLab can never hang a CI
 * job indefinitely.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Auth headers — send BOTH Bearer and PRIVATE-TOKEN so any PAT kind works. */
function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
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
 * @returns the numeric project id as a STRING (RepoRef.nativeId is a string).
 */
export async function resolveGitLabProjectId(path: string, token: string): Promise<string> {
  const url = `${API_BASE}/projects/${encodeProjectPath(path)}`;
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
 */
export function createCliGitLabClientPort(): GitLabClientPort {
  return {
    async listMrNotes(projectId, mrIid, token): Promise<GitLabNote[]> {
      // Paginate defensively (100/page, up to 5 pages) like the GitHub port.
      const baseUrl = `${API_BASE}/projects/${projectId}/merge_requests/${mrIid}/notes`;
      const MAX_PAGES = 5;
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
      }
      return out;
    },

    async createMrNote(projectId, mrIid, body, token): Promise<{ id: number }> {
      const url = `${API_BASE}/projects/${projectId}/merge_requests/${mrIid}/notes`;
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
      const url = `${API_BASE}/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`;
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

    async updateMrNote(projectId, mrIid, noteId, body, token): Promise<void> {
      const url = `${API_BASE}/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`;
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
