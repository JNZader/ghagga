/**
 * codedb_remote — query public GitHub repos without cloning.
 *
 * Provides two utilities:
 *  - fetchRemoteFile:   fetch a single file by path via raw.githubusercontent.com
 *  - searchRemoteCode: search for code patterns via the GitHub Search API
 *
 * Both functions NEVER throw; they return null / [] on any error instead.
 */

export interface RemoteQueryOptions {
  owner: string;
  repo: string;
  /** Git ref to target. Defaults to "HEAD". */
  ref?: string;
}

/**
 * Fetch a single file from a public (or token-accessible) GitHub repository.
 *
 * @param path   - Path to the file relative to the repo root (e.g. "src/index.ts")
 * @param opts   - Owner, repo, and optional ref
 * @param token  - Optional GitHub personal-access token or installation token
 * @returns      File contents as a string, or null on any error (4xx, 5xx, network, etc.)
 */
export async function fetchRemoteFile(
  path: string,
  opts: RemoteQueryOptions,
  token?: string,
): Promise<string | null> {
  const ref = opts.ref ?? 'HEAD';
  const url = `https://raw.githubusercontent.com/${opts.owner}/${opts.repo}/${ref}/${path}`;

  try {
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

// ─── GitHub Search API types ───────────────────────────────────

interface GitHubSearchTextMatch {
  fragment: string;
}

interface GitHubSearchItem {
  path: string;
  text_matches?: GitHubSearchTextMatch[];
}

interface GitHubSearchResponse {
  items: GitHubSearchItem[];
}

/**
 * Search for code matching a query inside a GitHub repository.
 *
 * Uses the GitHub Code Search API with text-match fragments enabled.
 * Rate-limited: unauthenticated = 10 req/min, authenticated = 30 req/min.
 *
 * @param query  - Search query (will be scoped to the repo automatically)
 * @param opts   - Owner and repo to search in (ref is not used by GitHub's search API)
 * @param token  - Optional GitHub token; strongly recommended to avoid rate-limit errors
 * @returns      Array of { path, snippet } objects, or [] on any error
 */
export async function searchRemoteCode(
  query: string,
  opts: RemoteQueryOptions,
  token?: string,
): Promise<Array<{ path: string; snippet: string }>> {
  const scopedQuery = `${query} repo:${opts.owner}/${opts.repo}`;
  const url = `https://api.github.com/search/code?q=${encodeURIComponent(scopedQuery)}`;

  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.text-match+json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as GitHubSearchResponse;
    return (data.items ?? []).map((item) => ({
      path: item.path,
      snippet: item.text_matches?.[0]?.fragment ?? '',
    }));
  } catch {
    return [];
  }
}
