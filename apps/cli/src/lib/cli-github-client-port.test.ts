/**
 * resolveGitHubRepoId — numeric repo id resolution for RepoRef.nativeId.
 *
 * The CLI `--pr` flow resolves the IMMUTABLE numeric GitHub repo id once before
 * the post-back (mirroring the GitLab `--mr` flow's resolveGitLabProjectId). We
 * mock ONLY `fetch` (the network seam) so this exercises the genuine GET
 * /repos/{owner}/{repo} → .id call + its error handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGitHubRepoId } from './cli-github-client-port.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as Response;
}

describe('resolveGitHubRepoId (numeric repo id resolution → RepoRef.nativeId)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('GET /repos/{owner}/{repo} → numeric id as string', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { id: 555000111, full_name: 'acme/widgets' }),
    );
    const id = await resolveGitHubRepoId('acme', 'widgets', 'ghp');
    // Stringified to match RepoRef.nativeId's string type (consistent with GitLab).
    expect(id).toBe('555000111');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/widgets');
  });

  it('passes an AbortSignal (timeout) so CI cannot hang', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 1 }));
    await resolveGitHubRepoId('acme', 'widgets', 'ghp');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a non-ok response (e.g. 404)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }));
    await expect(resolveGitHubRepoId('nope', 'nope', 'ghp')).rejects.toThrow(/resolving repo id/);
  });

  it('throws when the response has no numeric "id"', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { full_name: 'acme/widgets' }));
    await expect(resolveGitHubRepoId('acme', 'widgets', 'ghp')).rejects.toThrow(/no numeric "id"/);
  });
});
