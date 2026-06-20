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

/** A parsed GitLab remote: the host (for the API base) + the project path. */
export interface ParsedGitLabRemote {
  /**
   * The GitLab HOST (e.g. `gitlab.com` or `gitlab.example.com`). Drives the API
   * base (`https://<host>/api/v4`). For SSH remotes that carry a non-default port
   * (`ssh://git@host:2222/...`) the port is STRIPPED — the API is HTTPS on the
   * web host, not the SSH port.
   */
  host: string;
  /**
   * The MUTABLE group/project path (e.g. `acme/widgets` or
   * `group/subgroup/project`). Used to RESOLVE the canonical numeric project id
   * (via `GET /projects/:url-encoded-path`), never as the identity key itself
   * (R-GITLAB).
   */
  projectPath: string;
}

/**
 * Parse the host + group/project path from a GitLab git remote URL.
 *
 * Supports HTTPS, SSH (git@), and ssh:// protocol formats against ANY GitLab
 * host (gitlab.com OR a self-managed instance like `gitlab.example.com`). GitLab
 * supports NESTED groups (e.g. `group/subgroup/project`), so the path segment is
 * captured greedily (everything after the host, minus a trailing `.git`).
 *
 * DISAMBIGUATION: a generic git host cannot be told apart from GitHub by URL
 * shape alone. The `--mr` flag is the EXPLICIT signal that the remote is GitLab;
 * this parser is only reached on that path, so it accepts any host. It still
 * rejects the well-known `github.com` host to catch an obvious `--mr` misuse on a
 * GitHub remote early with a clear error.
 *
 * @throws if the remote is not a recognizable git remote URL, or is github.com.
 */
export function parseGitLabRemote(remoteUrl: string): ParsedGitLabRemote {
  const trimmed = remoteUrl.trim();

  // HTTPS: https://<host>/group/subgroup/repo.git
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return finalize(stripUserInfo(httpsMatch[1]), httpsMatch[2], trimmed);
  }

  // SSH protocol: ssh://git@<host>[:port]/group/subgroup/repo.git
  // (checked BEFORE the scp form so the `:port` is not mis-parsed as the path).
  const sshProtoMatch = trimmed.match(/^ssh:\/\/[^@\s]+@([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshProtoMatch?.[1] && sshProtoMatch[2]) {
    return finalize(stripPort(sshProtoMatch[1]), sshProtoMatch[2], trimmed);
  }

  // SSH (scp-style): git@<host>:group/subgroup/repo.git — no `://` scheme.
  const sshMatch = trimmed.match(/^[^@\s:]+@([^:/]+):(.+?)(?:\.git)?$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return finalize(sshMatch[1], sshMatch[2], trimmed);
  }

  throw new Error(`Not a GitLab remote URL: "${trimmed}"`);
}

/** Drop a `user:pass@` / `user@` prefix that may ride on an HTTPS host. */
function stripUserInfo(host: string): string {
  const at = host.lastIndexOf('@');
  return at === -1 ? host : host.slice(at + 1);
}

/** Drop a trailing `:port` from a host (the API rides on HTTPS, not the SSH port). */
function stripPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

/** Reject github.com (obvious --mr misuse) and assemble the parsed remote. */
function finalize(host: string, projectPath: string, original: string): ParsedGitLabRemote {
  const cleanHost = stripPort(host);
  if (cleanHost.toLowerCase() === 'github.com') {
    throw new Error(`Not a GitLab remote URL (looks like GitHub): "${original}"`);
  }
  return { host: cleanHost, projectPath };
}
