/**
 * Minimal GitLab REST helpers for the CLI MR summary post-back (`ghagga review
 * --mr N`).
 *
 * Scope (P4): parse the GitLab remote → group/project path, and the GitLab API
 * error type. The fetch-backed note client lives in `cli-gitlab-client-port.ts`;
 * this module owns the remote-URL parsing + the shared error class, mirroring
 * `github-api.ts`'s `parseGitHubRemote` / `GitHubApiError`.
 */

// ─── Error ──────────────────────────────────────────────────────

/** Thrown by the CLI GitLab fetch calls; carries the HTTP status + raw body. */
export class GitLabApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'GitLabApiError';
  }
}

// ─── Remote URL Parsing ─────────────────────────────────────────

/**
 * Parse the group/project path from a GitLab git remote URL.
 *
 * Supports HTTPS, SSH (git@), and ssh:// protocol formats. GitLab supports
 * NESTED groups (e.g. `group/subgroup/project`), so the path segment is captured
 * greedily (everything after the host, minus a trailing `.git`).
 *
 * The returned `path` is the MUTABLE group/project path — it is used to RESOLVE
 * the canonical numeric project id (via `GET /projects/:url-encoded-path`), never
 * as the identity key itself (R-GITLAB).
 *
 * @throws if the remote is not a gitlab.com URL.
 */
export function parseGitLabRemote(remoteUrl: string): { path: string } {
  const trimmed = remoteUrl.trim();

  // HTTPS: https://gitlab.com/group/subgroup/repo.git
  const httpsMatch = trimmed.match(/^https?:\/\/gitlab\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch?.[1]) {
    return { path: httpsMatch[1] };
  }

  // SSH: git@gitlab.com:group/subgroup/repo.git
  const sshMatch = trimmed.match(/^git@gitlab\.com:(.+?)(?:\.git)?$/);
  if (sshMatch?.[1]) {
    return { path: sshMatch[1] };
  }

  // SSH protocol: ssh://git@gitlab.com/group/subgroup/repo.git
  const sshProtoMatch = trimmed.match(/^ssh:\/\/git@gitlab\.com\/(.+?)(?:\.git)?$/);
  if (sshProtoMatch?.[1]) {
    return { path: sshProtoMatch[1] };
  }

  throw new Error(`Not a GitLab remote URL: "${trimmed}"`);
}
