/**
 * R-GITLAB / R-LEAK-PUBLISH: the `--mr` post-back routes through the REAL
 * GitLabForgeAdapter folding over the CLI's own GitLabClientPort. We mock ONLY
 * `fetch` (the network seam), so this exercises the genuine adapter
 * find→delete→repost idempotency AND the genuine CLI port REST calls — a
 * faithful simulation against a mocked GitLab.
 */

import { GitLabForgeAdapter } from 'ghagga-forge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCliGitLabClientPort,
  resolveGitLabApiBase,
  resolveGitLabProjectId,
} from './cli-gitlab-client-port.js';
import { postSummaryComment } from './pr-postback.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'ERR',
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

const MARKER = { html: '<!-- ghagga-review -->' };
const PROJECT_ID = '12345';
const REF = {
  repo: { kind: 'gitlab' as const, nativeId: PROJECT_ID, path: 'acme/widgets' },
  iid: 7,
};

function buildAdapter(token = 'glpat'): GitLabForgeAdapter {
  return new GitLabForgeAdapter({
    client: createCliGitLabClientPort(),
    token,
    projectId: PROJECT_ID,
  });
}

describe('resolveGitLabProjectId (numeric project id resolution, R-GITLAB)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('GET /projects/:url-encoded-path → numeric id as string', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { id: 12345, path_with_namespace: 'acme/widgets' }),
    );
    const id = await resolveGitLabProjectId('acme/widgets', 'glpat');
    expect(id).toBe('12345');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    // path is URL-encoded (nested-group safe).
    expect(url).toBe('https://gitlab.com/api/v4/projects/acme%2Fwidgets');
  });

  it('URL-encodes nested-group paths', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 99 }));
    await resolveGitLabProjectId('group/subgroup/project', 'glpat');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('projects/group%2Fsubgroup%2Fproject');
  });

  it('throws on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { message: '404 Project Not Found' }));
    await expect(resolveGitLabProjectId('nope/nope', 'glpat')).rejects.toThrow(
      /resolving project id/,
    );
  });
});

describe('postSummaryComment via CLI GitLab port + GitLabForgeAdapter', () => {
  beforeEach(() => mockFetch.mockReset());

  it('creates a fresh note when none exists (no stale to delete)', async () => {
    // listMrNotes: empty
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    // createMrNote → { id }
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 9001 }));

    const adapter = buildAdapter();
    const body = `${MARKER.html}\n## body`;
    const result = await postSummaryComment(adapter, REF, body, MARKER);

    expect(result.createdNativeId).toBe(9001);
    expect(result.deletedNativeIds).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [listUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toContain('/projects/12345/merge_requests/7/notes');

    const [postUrl, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe('https://gitlab.com/api/v4/projects/12345/merge_requests/7/notes');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({ body });
  });

  it('finds stale by marker → updates latest IN PLACE → prunes only stale duplicates (idempotent upsert)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, [
        { id: 100, body: `old ${MARKER.html}` },
        { id: 200, body: 'someone else' },
        { id: 300, body: `newer ${MARKER.html}` },
      ]),
    );
    // FORGE-UPSERT-005: updateMrNote(latest=300) IN PLACE (PUT) first...
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 300 }));
    // ...then delete stale=100 only after the update confirms success.
    mockFetch.mockResolvedValueOnce(jsonResponse(204, {}));

    const adapter = buildAdapter();
    const result = await postSummaryComment(adapter, REF, 'body', MARKER);

    // "created" now carries the updated latest note (300), not a freshly created one.
    expect(result.createdNativeId).toBe(300);
    // The latest (300) is updated, never deleted; only the stale duplicate (100) is pruned.
    expect(result.deletedNativeIds).toEqual([100]);

    // Update happens in place (PUT) on the latest, before any delete.
    const updateCall = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(updateCall[0]).toContain('/notes/300');
    expect(updateCall[1].method).toBe('PUT');
    expect(JSON.parse(updateCall[1].body as string)).toEqual({ body: 'body' });
    const del = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(del[0]).toContain('/notes/100');
    expect(del[1].method).toBe('DELETE');
    // The latest (300) is never the target of a DELETE.
    const deleteUrls = mockFetch.mock.calls
      .filter((c) => (c[1] as RequestInit).method === 'DELETE')
      .map((c) => c[0] as string);
    expect(deleteUrls.some((u) => u.includes('/notes/300'))).toBe(false);
    // foreign note 200 never touched; no fresh POST on the replace path.
    const allUrls = mockFetch.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allUrls).not.toContain('/notes/200');
    const methods = mockFetch.mock.calls.map((c) => (c[1] as RequestInit).method);
    expect(methods).not.toContain('POST');
  });

  it('sends ONLY PRIVATE-TOKEN (no Bearer) + an AbortSignal (FIX E)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 1 }));
    const adapter = buildAdapter('secret-pat');
    await postSummaryComment(adapter, REF, 'body', MARKER);
    const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = postInit.headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('secret-pat');
    expect(headers.Authorization).toBeUndefined();
    for (const call of mockFetch.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('a 401 with the static PAT is fatal (no retry loop)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(401, { message: '401 Unauthorized' }));
    const adapter = buildAdapter();
    await expect(postSummaryComment(adapter, REF, 'body', MARKER)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('CLI GitLab port — publishInline partial failure end-to-end (R-LEAK-PUBLISH)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('5 inline notes, 3 fail (500) → posted 2, failed 3, never aborts', async () => {
    // create calls in order: ok, 500, 500, ok, 500
    mockFetch
      .mockResolvedValueOnce(jsonResponse(201, { id: 11 }))
      .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }))
      .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 14 }))
      .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));

    const adapter = buildAdapter();
    const report = await adapter.publishInline(REF, [
      { path: 'a.ts', line: 1, body: 'c0' },
      { path: 'b.ts', line: 2, body: 'c1' },
      { path: 'c.ts', line: 3, body: 'c2' },
      { path: 'd.ts', line: 4, body: 'c3' },
      { path: 'e.ts', line: 5, body: 'c4' },
    ]);

    expect(report.posted).toEqual([
      { kind: 'gitlab', raw: '11' },
      { kind: 'gitlab', raw: '14' },
    ]);
    expect(report.failed.map((f) => f.index)).toEqual([1, 2, 4]);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

describe('resolveGitLabApiBase (FIX A — derive API base from host + env overrides)', () => {
  it('defaults to https://<host>/api/v4 for the parsed remote host', () => {
    expect(resolveGitLabApiBase('gitlab.com', {} as NodeJS.ProcessEnv)).toBe(
      'https://gitlab.com/api/v4',
    );
    expect(resolveGitLabApiBase('gitlab.example.com', {} as NodeJS.ProcessEnv)).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });

  it('GITLAB_HOST overrides the remote host', () => {
    expect(
      resolveGitLabApiBase('gitlab.com', { GITLAB_HOST: 'api.internal' } as NodeJS.ProcessEnv),
    ).toBe('https://api.internal/api/v4');
  });

  it('GITLAB_API_BASE is a full override (subpath self-hosted)', () => {
    expect(
      resolveGitLabApiBase('gitlab.com', {
        GITLAB_API_BASE: 'https://example.com/gitlab/api/v4',
      } as NodeJS.ProcessEnv),
    ).toBe('https://example.com/gitlab/api/v4');
  });

  it('GITLAB_API_BASE wins over GITLAB_HOST + trims trailing slash', () => {
    expect(
      resolveGitLabApiBase('gitlab.com', {
        GITLAB_HOST: 'ignored.example',
        GITLAB_API_BASE: 'https://example.com/gitlab/api/v4/',
      } as NodeJS.ProcessEnv),
    ).toBe('https://example.com/gitlab/api/v4');
  });
});

describe('CLI GitLab port — self-hosted API base (FIX A)', () => {
  beforeEach(() => mockFetch.mockReset());

  function buildSelfHostedAdapter(): GitLabForgeAdapter {
    return new GitLabForgeAdapter({
      client: createCliGitLabClientPort('https://gitlab.example.com/api/v4'),
      token: 'glpat',
      projectId: PROJECT_ID,
    });
  }

  it('routes note calls + project-id resolution against the self-hosted host', async () => {
    // resolveGitLabProjectId against the self-hosted base.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 12345 }));
    const id = await resolveGitLabProjectId(
      'team/repo',
      'glpat',
      'https://gitlab.example.com/api/v4',
    );
    expect(id).toBe('12345');
    const [idUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(idUrl).toBe('https://gitlab.example.com/api/v4/projects/team%2Frepo');

    mockFetch.mockReset();
    // upsert against the self-hosted base.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, []));
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 9001 }));
    const adapter = buildSelfHostedAdapter();
    await postSummaryComment(adapter, REF, 'body', MARKER);
    const [postUrl, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe('https://gitlab.example.com/api/v4/projects/12345/merge_requests/7/notes');
    // PRIVATE-TOKEN only.
    const headers = postInit.headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('glpat');
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('CLI GitLab port — listMrNotes pagination (backlog #6)', () => {
  beforeEach(() => mockFetch.mockReset());

  function makeNotes(count: number, startId = 0, markerAt?: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: startId + i,
      body: i === markerAt ? `summary ${startId + i} ${MARKER.html}` : `noise ${startId + i}`,
    }));
  }

  it('single page (< 100 notes) → exactly one list call, no extra fetch', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, makeNotes(20, 0)));
    const port = createCliGitLabClientPort();
    const notes = await port.listMrNotes('12345', 7, 'glpat');
    expect(notes).toHaveLength(20);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('page=1');
  });

  it('multi-page → full page 1 forces page 2 fetch; stale-on-page-2 found + updated in place (no duplicate)', async () => {
    // page 1: 100 notes, NO marker → must fetch page 2; page 2 carries the sole marker.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, makeNotes(100, 0)));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, makeNotes(15, 100, 5))); // marker id 105
    // FORGE-UPSERT-005: single GHAGGA note → update it in place (PUT), nothing to prune.
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 105 })); // update 105

    const adapter = buildAdapter();
    const result = await postSummaryComment(adapter, REF, 'body', MARKER);

    // Sole note (105) is updated in place: it carries the body, nothing is deleted.
    expect(result.deletedNativeIds).toEqual([]);
    expect(result.createdNativeId).toBe(105);
    // page 1 + page 2 list calls happened.
    expect(mockFetch.mock.calls[0][0] as string).toContain('page=1');
    expect(mockFetch.mock.calls[1][0] as string).toContain('page=2');
    const updateCall = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(updateCall[0]).toContain('/notes/105');
    expect(updateCall[1].method).toBe('PUT');
    // No DELETE and no POST — the sole note is updated, not replaced.
    const methods = mockFetch.mock.calls.map((c) => (c[1] as RequestInit).method);
    expect(methods).not.toContain('DELETE');
    expect(methods).not.toContain('POST');
  });

  it('safety bound → stops at MAX_PAGES (50) and warns instead of looping forever', async () => {
    for (let page = 0; page < 50; page++) {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, makeNotes(100, page * 100)));
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = createCliGitLabClientPort();
    const notes = await port.listMrNotes('12345', 7, 'glpat');
    expect(notes).toHaveLength(5000);
    expect(mockFetch).toHaveBeenCalledTimes(50);
    expect(mockFetch.mock.calls[49][0] as string).toContain('page=50');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MAX_PAGES (50)'));
    warnSpy.mockRestore();
  });
});

describe('CLI GitLab port — createMrDiscussion (FIX C true positioning)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('posts a positioned inline comment to /discussions and boxes notes[0].id', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(201, { id: 'disc-1', notes: [{ id: 555 }] }));
    const adapter = buildAdapter();
    const report = await adapter.publishInline(REF, [
      {
        path: 'src/x.ts',
        line: 4,
        side: 'new',
        body: 'anchored',
        position: { baseSha: 'B', headSha: 'H', startSha: 'S', newLine: 4 },
      },
    ]);
    expect(report.posted).toEqual([{ kind: 'gitlab', raw: '555' }]);
    const [discUrl, discInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(discUrl).toBe('https://gitlab.com/api/v4/projects/12345/merge_requests/7/discussions');
    expect(discInit.method).toBe('POST');
    const payload = JSON.parse(discInit.body as string) as Record<string, unknown>;
    expect(payload.body).toBe('anchored');
    expect(payload.position).toEqual({
      position_type: 'text',
      base_sha: 'B',
      head_sha: 'H',
      start_sha: 'S',
      old_path: 'src/x.ts',
      new_path: 'src/x.ts',
      new_line: 4,
    });
  });
});
