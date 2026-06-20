/**
 * GitHub API client utilities.
 *
 * Uses native fetch for all HTTP calls and Node.js crypto for
 * JWT creation and webhook signature verification. No extra deps.
 *
 * ─── FORGE-ADAPTER BOUNDARY (SDD forge-agnostic 1.5/1.6) ─────────
 *
 * The 11 forge-adapter functions in this module are INTERNAL. They are tagged
 * `@internal` individually and MUST be consumed via `GitHubForgeAdapter`, built
 * through the composition root at
 * `apps/server/src/github/forge-adapter-factory.ts` (`makeGitHubAdapter`). Do
 * NOT import these directly anywhere in `apps/server` outside that factory — the
 * forge-boundary lint (`noRestrictedImports` in biome.json) enforces this.
 *
 * The 11 forge-adapter fns:
 *   fetchPRDiff, fetchPRDetails, getPRFileList, getPRCommitMessages,
 *   postComment, findExistingComment, deleteComment, updateComment,
 *   addCommentReaction, fetchGraphFromBranch, fetchGraphMetadata.
 *
 * NOT forge-adapter fns (remain directly importable everywhere):
 *   - getInstallationToken — the auth/token-mint seam
 *   - verifyWebhookSignature — webhook signature check
 *   plus any shared constants/types exported from this module.
 */

import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { githubCircuitBreaker } from '../lib/circuit-breaker.js';

// ─── Errors ─────────────────────────────────────────────────────

/**
 * An error from a GitHub REST call, carrying the HTTP `status`.
 *
 * The forge boundary (GitHubForgeAdapter) inspects this `status` to reclassify
 * 401/403 failures as a `ForgeAuthError` so the worker can drive the in-job
 * token re-mint + retry (P2 401-recovery seam). Non-2xx errors that are NOT
 * 401/403 stay plain failures — the status is still attached for logging.
 *
 * The message is preserved byte-for-byte from the previous plain-Error throws
 * (`GitHub API error <op>: <status> <statusText>`) so existing message-based
 * assertions and logs are unaffected.
 */
export class GitHubApiError extends Error {
  /** The HTTP status of the failed GitHub response. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    Object.setPrototypeOf(this, GitHubApiError.prototype);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Decode and format GitHub App private key from environment variable.
 * Supports:
 *   - Raw PEM with proper newlines
 *   - Base64-encoded PEM
 *   - PEM with spaces instead of newlines
 *   - PEM wrapped in quotes
 */
function decodePrivateKey(key: string): string {
  // Remove surrounding quotes if present
  let cleanKey = key.trim();
  if (cleanKey.startsWith('"') && cleanKey.endsWith('"')) {
    cleanKey = cleanKey.slice(1, -1);
  }

  // Replace any escaped newline sequences with real newlines.
  // Coolify/Docker can multi-escape: \n → \\n → \\\\n in env vars.
  // Match one or more backslashes followed by 'n' and replace with real newline.
  cleanKey = cleanKey.replace(/\\+n/g, '\n');

  // If key has proper newlines, return as-is
  if (cleanKey.includes('-----BEGIN') && cleanKey.includes('\n')) {
    return cleanKey;
  }

  // If key has spaces instead of newlines, fix it
  if (cleanKey.includes(' ') && !cleanKey.includes('\n')) {
    // Split by spaces and reconstruct with newlines
    const parts = cleanKey.split(' ');
    const result: string[] = [];
    let currentLine = '';

    for (const part of parts) {
      if (part === '-----BEGIN' || part === '-----END' || part.includes('KEY-----')) {
        // These are headers/footers - keep them as separate lines
        if (currentLine) {
          result.push(currentLine);
          currentLine = '';
        }
        result.push(part);
      } else {
        // This is key data - add to current line
        currentLine += part;
        // Standard PEM lines are 64 chars
        if (currentLine.length >= 64) {
          result.push(currentLine);
          currentLine = '';
        }
      }
    }

    // Don't forget the last line
    if (currentLine) {
      result.push(currentLine);
    }

    // Join with newlines
    return result.join('\n');
  }

  return cleanKey;
}

// ─── PR Data ────────────────────────────────────────────────────

/**
 * Fetch pull request details (head SHA, base branch, etc.).
 * Used by the issue_comment handler to enrich the BullMQ job.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchPRDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ headSha: string; baseBranch: string; prAuthor: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  const data = await githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error fetching PR details: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as {
      head: { sha: string };
      base: { ref: string };
      user: { login: string };
    };
  });

  return { headSha: data.head.sha, baseBranch: data.base.ref, prAuthor: data.user.login };
}

/**
 * Fetch the unified diff for a pull request.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchPRDiff(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  return githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.diff',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error fetching diff: ${response.status} ${response.statusText}`,
      );
    }

    return response.text();
  });
}

/**
 * Post a markdown comment to a pull request via the issues comments API.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function postComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<{ id: number }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  return githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error posting comment: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { id: number };
    return { id: data.id };
  });
}

/**
 * Find an existing GHAGGA review comment on a PR.
 * Returns the comment ID if found, or null if no previous review comment exists.
 *
 * Searches for the `<!-- ghagga-review -->` marker in issue comments.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function findExistingComment(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ latestId: number; staleIds: number[] } | null> {
  const MARKER = '<!-- ghagga-review -->';
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  // Paginate until exhausted (a page with < 100 items is the last page). The cap
  // is a safety upper bound so a pathological PR can't loop forever: 50 pages ×
  // 100/page = 5000 comments. If hit, we log rather than silently truncate — a
  // stale marker beyond the bound could otherwise produce a DUPLICATE comment.
  // (Was 5 pages / 500 items; raised to close that duplicate edge — backlog #6.)
  const MAX_PAGES = 50;
  // WALL-CLOCK BUDGET (server only): each page fetch can take up to 10s
  // (AbortSignal.timeout(10_000)), so 50 pages worst-case ≈ 500s. The BullMQ
  // review worker lock is `lockDuration: 300_000` (5 min) — see
  // apps/server/src/queues/review.ts createReviewWorker. If pagination alone
  // exceeded ~300s the job would lose its lock mid-run and look stalled →
  // retried/duplicated. We therefore cap total paging at 90s, leaving ~210s of
  // the 5-min lock for the rest of the job (fetch diff + dispatch + poll +
  // postback). On budget exhaustion we stop, warn (non-silent), and proceed with
  // what we found — a missed stale on a 5000-comment PR is acceptable vs. blowing
  // the worker lock. MAX_PAGES stays as belt-and-suspenders.
  // (CLI ports have NO worker lock and keep paging to MAX_PAGES.)
  const PAGINATION_BUDGET_MS = 90_000;
  const deadline = Date.now() + PAGINATION_BUDGET_MS;

  return githubCircuitBreaker.execute(async () => {
    const allMatchIds: number[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      // Budget guard: only AFTER page 1 (the common single-page case always gets
      // its one fetch, baseline byte-identical). If we've already spent the
      // budget, stop paging rather than risk the worker lock.
      if (page > 1 && Date.now() >= deadline) {
        console.warn(
          `[ghagga] findExistingComment hit the ${PAGINATION_BUDGET_MS}ms pagination budget for ${owner}/${repo}#${prNumber} at page ${page}; comment listing truncated to stay under the worker lock`,
        );
        break;
      }

      const url = `${baseUrl}?per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API error listing comments: ${response.status} ${response.statusText}`,
        );
      }

      const comments = (await response.json()) as Array<{ id: number; body: string }>;

      for (const comment of comments) {
        if (comment.body.includes(MARKER)) {
          allMatchIds.push(comment.id);
        }
      }

      if (comments.length < 100) break;

      if (page === MAX_PAGES) {
        // Reached the safety bound with a still-full last page: there may be
        // more comments (and a stale marker) we did not scan. Surface it so a
        // duplicate-comment outcome is at least observable, not silent.
        console.warn(
          `[ghagga] findExistingComment hit MAX_PAGES (${MAX_PAGES}) for ${owner}/${repo}#${prNumber}; comment listing may be truncated`,
        );
      }
    }

    if (allMatchIds.length === 0) return null;

    // Latest = last in chronological order (GitHub returns oldest first)
    const latestId = allMatchIds[allMatchIds.length - 1];
    if (!latestId) return null;
    const staleIds = allMatchIds.slice(0, -1); // all except the last

    return { latestId, staleIds };
  });
}

/**
 * Delete a comment from a pull request.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function deleteComment(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;

  await githubCircuitBreaker.execute(async () => {
    await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
  });
}

/**
 * Update an existing comment on a pull request.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function updateComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;

  await githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API error updating comment: ${response.status} ${response.statusText}`,
      );
    }
  });
}

/**
 * Fetch commit messages for a pull request.
 * Paginates through all pages (max 5 pages / 500 commits).
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function getPRCommitMessages(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits`;
  const MAX_PAGES = 5;

  return githubCircuitBreaker.execute(async () => {
    const allMessages: string[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${baseUrl}?per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API error fetching commits: ${response.status} ${response.statusText}`,
        );
      }

      const commits = (await response.json()) as Array<{
        commit: { message: string };
      }>;
      allMessages.push(...commits.map((c) => c.commit.message));

      if (commits.length < 100) break;
    }

    return allMessages;
  });
}

/**
 * Fetch the list of changed file paths for a pull request.
 * Paginates through all pages (max 10 pages / 1000 files).
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function getPRFileList(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;
  const MAX_PAGES = 10;

  return githubCircuitBreaker.execute(async () => {
    const allFiles: string[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${baseUrl}?per_page=100&page=${page}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `GitHub API error fetching files: ${response.status} ${response.statusText}`,
        );
      }

      const files = (await response.json()) as Array<{ filename: string }>;
      allFiles.push(...files.map((f) => f.filename));

      if (files.length < 100) break;
    }

    return allFiles;
  });
}

// ─── Dependency Graph ───────────────────────────────────────────

/**
 * Fetch the dependency graph from the ghagga/graph orphan branch.
 * Returns null if the branch or file doesn't exist.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchGraphFromBranch(
  owner: string,
  repo: string,
  token: string,
): Promise<import('ghagga-core').DependencyGraph | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.ghagga/graph.json?ref=ghagga/graph`;

  try {
    const response = await githubCircuitBreaker.execute(async () => {
      return fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5_000),
      });
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`[ghagga] Failed to fetch graph: ${response.status}`);
      return null;
    }

    const json: unknown = await response.json();
    // Inline validation — avoids dynamic import issues in test
    return validateGraphJson(json);
  } catch {
    return null;
  }
}

/**
 * Fetch the dependency graph metadata from the ghagga/graph orphan branch.
 * Returns null if the branch or file doesn't exist.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function fetchGraphMetadata(
  owner: string,
  repo: string,
  token: string,
): Promise<import('ghagga-core').GraphMetadata | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.ghagga/metadata.json?ref=ghagga/graph`;

  try {
    const response = await githubCircuitBreaker.execute(async () => {
      return fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(5_000),
      });
    });

    if (response.status === 404) return null;
    if (!response.ok) return null;

    const json: unknown = await response.json();
    return validateMetadataJson(json);
  } catch {
    return null;
  }
}

// ─── Graph Validation (inline to avoid dynamic imports) ─────────

const GRAPH_VERSION = 1;

function validateGraphJson(json: unknown): import('ghagga-core').DependencyGraph | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.version !== 'number' || obj.version !== GRAPH_VERSION) return null;
  if (typeof obj.rootDir !== 'string') return null;
  if (!obj.nodes || typeof obj.nodes !== 'object') return null;
  return json as import('ghagga-core').DependencyGraph;
}

function validateMetadataJson(json: unknown): import('ghagga-core').GraphMetadata | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.lastIndexedCommit !== 'string') return null;
  if (typeof obj.lastIndexedAt !== 'string') return null;
  if (typeof obj.schemaVersion !== 'number') return null;
  if (typeof obj.fileCount !== 'number') return null;
  if (!Array.isArray(obj.languages)) return null;
  if (typeof obj.indexDurationMs !== 'number') return null;
  return json as import('ghagga-core').GraphMetadata;
}

// ─── Reactions ──────────────────────────────────────────────────

/**
 * Add a reaction emoji to an issue comment.
 * Used for acknowledging "ghagga review" trigger comments.
 *
 * @internal INTERNAL — consume via GitHubForgeAdapter
 * (apps/server/src/github/forge-adapter-factory.ts). Do NOT import directly;
 * the forge-boundary lint enforces this. getInstallationToken/
 * verifyWebhookSignature are NOT forge-adapter fns and remain directly importable.
 */
export async function addCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  reaction: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`;

  try {
    await githubCircuitBreaker.execute(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ content: reaction }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(
          `GitHub API error adding reaction: ${response.status} ${response.statusText}`,
        );
      }
    });
  } catch {
    // Non-critical — log but don't throw
    console.warn(`[ghagga] Failed to add reaction`);
  }
}

// ─── Webhook Verification ───────────────────────────────────────

/**
 * Verify a GitHub webhook signature using HMAC-SHA256
 * with constant-time comparison.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  // GitHub sends: sha256=<hex>
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) return false;

  const signatureHex = signature.slice(expectedPrefix.length);

  const computed = createHmac('sha256', secret).update(payload).digest('hex');

  // Constant-time comparison
  try {
    const sigBuffer = Buffer.from(signatureHex, 'hex');
    const computedBuffer = Buffer.from(computed, 'hex');

    if (sigBuffer.length !== computedBuffer.length) return false;

    return timingSafeEqual(sigBuffer, computedBuffer);
  } catch {
    return false;
  }
}

// ─── Installation Token ─────────────────────────────────────────

/**
 * A minted installation token plus its absolute expiry (epoch millis).
 *
 * Structurally matches `MintedInstallationToken` from `ghagga-forge` — the
 * P2 `GitHubAppCredentialProvider` consumes this shape (via the injected
 * expiry-carrying mint) to drive its TTL cache. Declared locally to avoid a
 * value import that would couple the client to the forge package.
 */
export interface InstallationTokenResult {
  /** The installation access token string. */
  token: string;
  /** Absolute expiry, epoch millis (comparable to {@link Date.now}). */
  expiresAtMs: number;
}

/**
 * Conservative fallback installation-token lifetime (ms) used ONLY when the
 * GitHub access-token response omits or returns an unparseable `expires_at`.
 * GitHub installation tokens live ~1h; 55min leaves margin under that.
 */
const FALLBACK_INSTALLATION_TOKEN_TTL_MS = 55 * 60 * 1000;

/**
 * Create a JWT for GitHub App authentication and exchange it for an installation
 * access token, returning the token AND its expiry (P2).
 *
 * The GitHub access-token response includes an ISO-8601 `expires_at`; this reads
 * it into an epoch-millis timestamp so the credential provider can TTL-cache.
 * If `expires_at` is missing/unparseable, falls back to a conservative TTL so the
 * provider never treats a token as longer-lived than GitHub actually grants.
 *
 * JWT is created manually using Node.js crypto (RS256).
 */
export async function getInstallationTokenWithExpiry(
  installationId: number,
  appId: string,
  privateKey: string,
  options?: { repositoryIds?: number[] },
): Promise<InstallationTokenResult> {
  const now = Math.floor(Date.now() / 1000);

  // Create JWT header + payload
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // 60 seconds in the past for clock skew
    exp: now + 600, // 10 minutes
    iss: appId,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Decode and sign with RS256
  const decodedKey = decodePrivateKey(privateKey);
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signatureBuffer = signer.sign(decodedKey);
  const encodedSignature = base64url(signatureBuffer);

  const jwt = `${signingInput}.${encodedSignature}`;

  // Exchange JWT for installation access token
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;

  // Build request body — optionally scope token to specific repositories
  const body: Record<string, unknown> = {};
  if (options?.repositoryIds && options.repositoryIds.length > 0) {
    body.repository_ids = options.repositoryIds;
  }

  return githubCircuitBreaker.execute(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
      ...(Object.keys(body).length > 0 && { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error getting installation token: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { token: string; expires_at?: string };
    const parsed = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
    const expiresAtMs = Number.isNaN(parsed)
      ? Date.now() + FALLBACK_INSTALLATION_TOKEN_TTL_MS
      : parsed;
    return { token: data.token, expiresAtMs };
  });
}

/**
 * Mint an installation access token (token string only).
 *
 * Back-compat thin wrapper over {@link getInstallationTokenWithExpiry} that
 * discards the expiry — preserves the original `Promise<string>` signature for
 * the direct callers that don't TTL-cache (webhook handlers, workflow injection).
 */
export async function getInstallationToken(
  installationId: number,
  appId: string,
  privateKey: string,
  options?: { repositoryIds?: number[] },
): Promise<string> {
  const { token } = await getInstallationTokenWithExpiry(
    installationId,
    appId,
    privateKey,
    options,
  );
  return token;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Base64url encode (RFC 4648 §5) — works with strings and Buffers.
 */
function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}
